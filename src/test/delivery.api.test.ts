import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { STORE_FILE } from "../store.js";
import { tokenPath } from "../token.js";
import { readFakeLog, startHost, writeFakeCodex, type Host } from "./fakeCodexAppServer.js";
import { call, CLI_ENTRY, fixtureHomes, makeRepo, PRD_SAMPLE, removeTempDirs, spawnDaemon, tempDir, type SpawnedDaemon } from "./helpers.js";

const POLL_MS = 50;
const WAIT_MS = 10_000;

describe("delivery to a bridge-controlled session", () => {
  let env: NodeJS.ProcessEnv;
  let log: string;
  let daemon: SpawnedDaemon;
  let token: string;
  let projects = 0;
  let keys = 0;
  const hosts: Host[] = [];

  const tool = async (name: string, body: unknown) => {
    const response = await call(daemon.port, token, name, body);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  };
  const send = (projectId: string, text: string, key = `k${++keys}`) =>
    tool("send_to_primary", { project_id: projectId, text, mode: "next_turn", idempotency_key: key });
  const read = (messageId: string) => tool("get_message", { message_id: messageId });

  /** Polls until the message reaches one of `states`; a bounded wait on provider events, not a judge of them. */
  const until = async (messageId: string, ...states: string[]) => {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const message = await read(messageId);
      if (states.includes(message.state)) return message;
      if (Date.now() > deadline) assert.fail(`message ${messageId} is ${message.state}/${message.reason}, not ${states.join(" or ")}`);
      await delay(POLL_MS);
    }
  };
  const starts = () => readFakeLog(log).filter((entry) => "start" in entry).length;
  const turnStarts = () => readFakeLog(log).flatMap((entry) => ("turn_start" in entry ? [entry.turn_start] : []));
  /** Completes the provider's oldest open turn. */
  const release = (host: Host) => process.kill(host.provider_pid, "SIGUSR2");
  const project = async () => {
    const id = `delivery-${++projects}`;
    const repo = makeRepo({ ...PRD_SAMPLE, project_id: id, display_name: id });
    await tool("register_project", { path: repo });
    return id;
  };
  const host = async (projectId: string) => {
    const started = await startHost(env, projectId);
    hosts.push(started);
    return started;
  };
  const stop = async (h: Host) => {
    if (h.child.exitCode === null && h.child.signalCode === null) h.child.kill("SIGTERM");
    return h.exited;
  };
  const sessionStart = (withEnv: NodeJS.ProcessEnv, projectId: string, provider = "codex") =>
    new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [CLI_ENTRY, "session", "start", projectId, "--provider", provider], {
        env: withEnv,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      child.once("exit", (code) => resolve({ code, stderr }));
    });
  const leases = (projectId: string) => {
    const db = new DatabaseSync(path.join(env.VOICE_BRIDGE_DATA_DIR!, STORE_FILE), { readOnly: true });
    try {
      return (db.prepare("SELECT COUNT(*) AS n FROM workspace_leases WHERE project_id = ?").get(projectId) as { n: number }).n;
    } finally {
      db.close();
    }
  };

  before(async () => {
    const stubs = tempDir("voice-bridge-stubs-");
    log = path.join(tempDir(), "codex.log");
    writeFakeCodex(stubs, log);
    const { FACTORY_RUNTIME_CANDIDATE: _ignored, ...inherited } = process.env;
    env = { ...inherited, ...fixtureHomes(), VOICE_BRIDGE_DATA_DIR: tempDir(), PATH: `${stubs}${path.delimiter}${process.env.PATH}` };
    daemon = await spawnDaemon(env);
    token = readFileSync(tokenPath(env.VOICE_BRIDGE_DATA_DIR!), "utf8");
  });

  after(async () => {
    for (const h of hosts) await stop(h);
    await daemon.stop();
    removeTempDirs();
  });

  test("a sent message is delivered with receipts from provider events, all naming the session", async () => {
    const id = await project();
    const h = await host(id);
    const primary = await tool("get_primary_session", { project_id: id });
    assert.deepEqual(
      [primary.route, primary.primary_session_id, primary.workspace_owner_session_id, primary.mutating_allowed],
      ["sole_connected", h.session_id, h.session_id, true],
    );

    const sent = await send(id, "receipts");
    assert.deepEqual([sent.state, sent.session_id], ["queued", h.session_id]);
    assert.equal((await until(sent.message_id, "started")).session_id, h.session_id);
    release(h);
    const done = await until(sent.message_id, "completed");
    assert.equal(done.session_id, h.session_id);
    assert.equal(done.reason, "turn_completed");
    assert.deepEqual(
      done.transitions.map((t: { state: string }) => t.state),
      ["accepted", "queued", "delivering", "delivered", "started", "completed"],
    );
    assert.equal(await stop(h), 0);
  });

  test("a second message while the first turn runs stays queued and goes only after the first completes", async () => {
    const before = starts();
    const id = await project();
    const h = await host(id);
    const a = await send(id, "busy A");
    await until(a.message_id, "started");
    const b = await send(id, "busy B");
    assert.deepEqual([b.state, b.reason], ["queued", "awaiting_delivery"]);
    await delay(500);
    assert.equal((await read(b.message_id)).state, "queued");
    assert.deepEqual(turnStarts().filter((text) => text.startsWith("busy")), ["busy A"]);

    release(h);
    await until(a.message_id, "completed");
    await until(b.message_id, "started");
    assert.deepEqual(turnStarts().filter((text) => text.startsWith("busy")), ["busy A", "busy B"]);
    assert.equal(starts() - before, 1);
    release(h);
    await until(b.message_id, "completed");
    assert.equal(await stop(h), 0);
  });

  test("a second session start on a held worktree is refused with workspace_owned and starts nothing", async () => {
    const id = await project();
    const h = await host(id);
    const before = starts();
    const { code, stderr } = await sessionStart(env, id);
    assert.equal(code, 1);
    assert.match(stderr, /workspace_owned: .*pid \d+/);
    assert.equal(starts(), before);
    assert.equal(await stop(h), 0);
  });

  test("a killed provider leaves pending messages queued as owner_disconnected and is not restarted", async () => {
    const id = await project();
    const h = await host(id);
    const a = await send(id, "killed A");
    await until(a.message_id, "started");
    const b = await send(id, "killed B");
    const before = starts();
    process.kill(h.provider_pid, "SIGKILL");
    assert.equal(await h.exited, 1);

    const lost = await read(a.message_id);
    assert.deepEqual([lost.state, lost.reason], ["failed", "owner_disconnected"]);
    const kept = await read(b.message_id);
    assert.deepEqual([kept.state, kept.reason], ["queued", "owner_disconnected"]);
    await delay(5_000);
    assert.equal(starts(), before);
    const primary = await tool("get_primary_session", { project_id: id });
    assert.notEqual(primary.connected_session_id, h.session_id);
    assert.equal(primary.mutating_allowed, false);
    assert.equal((await read(b.message_id)).state, "queued");
  });

  test("a message recorded delivered is not sent again after the daemon and the session host restart", async () => {
    const id = await project();
    const h = await host(id);
    const key = `restart-${++keys}`;
    const a = await send(id, "restart A", key);
    await until(a.message_id, "delivered", "started");

    await daemon.stop();
    daemon = await spawnDaemon(env);
    release(h);
    await until(a.message_id, "completed");
    const retry = await send(id, "restart A", key);
    assert.deepEqual([retry.message_id, retry.duplicate, retry.state], [a.message_id, true, "completed"]);

    assert.equal(await stop(h), 0);
    assert.equal(leases(id), 0);
    const next = await host(id);
    await delay(1_000);
    assert.deepEqual(turnStarts().filter((text) => text === "restart A"), ["restart A"]);
    assert.equal(await stop(next), 0);
  });

  test("a start that cannot get a thread fails with nothing left running and the lease released", async () => {
    const id = await project();
    const refused = await sessionStart(env, id, "claude-code");
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /unsupported_provider/);
    const missing = await sessionStart({ ...env, PATH: tempDir() }, id);
    assert.match(missing.stderr, /provider_not_installed/);

    const stubs = tempDir("voice-bridge-stubs-");
    const pidFile = path.join(tempDir(), "pid");
    writeFileSync(
      path.join(stubs, "codex"),
      `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nprocess.stdin.on("end", () => process.exit(0)).resume();\n`,
    );
    chmodSync(path.join(stubs, "codex"), 0o755);
    const silent = await sessionStart({ ...env, PATH: `${stubs}${path.delimiter}${process.env.PATH}` }, id);
    assert.equal(silent.code, 1);
    assert.match(silent.stderr, /provider_start_failed: .*initialize → no response/);
    assert.throws(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0), { code: "ESRCH" });
    assert.equal(leases(id), 0);
  });
});
