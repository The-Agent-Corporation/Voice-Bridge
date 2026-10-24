import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { daemonInfoPath, startBridge, type RunningBridge } from "../app.js";
import { ensureClientToken } from "../token.js";
import { CLI_ENTRY, fixtureHomes, makeRepo, removeTempDirs, tempDir } from "./helpers.js";

after(removeTempDirs);

// Asynchronous on purpose: a blocking spawn would stall the in-process daemon the CLI calls.
const runCli = (dataDir: string, ...args: string[]) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(
      process.execPath,
      [CLI_ENTRY, ...args],
      { env: { ...process.env, VOICE_BRIDGE_DATA_DIR: dataDir }, timeout: 10_000 },
      (_error, stdout, stderr) => resolve({ status: child.exitCode, stdout, stderr }),
    );
  });

describe("voice-bridge CLI", () => {
  let bridge: RunningBridge;
  let dataDir: string;

  before(async () => {
    dataDir = tempDir();
    bridge = await startBridge({ dataDir, port: 0, env: fixtureHomes() });
  });

  after(() => bridge.close());

  const cli = (...args: string[]) => runCli(dataDir, ...args);

  test("register, projects and open talk to the running daemon", async () => {
    const repo = makeRepo();

    const registered = await cli("register", repo);
    assert.equal(registered.status, 0, registered.stderr);
    assert.equal(registered.stdout, `registered desktop-agent (Desktop Agent) at ${repo}\nfound 0 saved session(s)\n`);

    const projects = await cli("projects");
    assert.equal(projects.status, 0, projects.stderr);
    assert.equal(projects.stdout, `desktop-agent\tDesktop Agent\t${repo}\n`);

    const opened = await cli("open", "desktop-agent");
    assert.equal(opened.status, 0, opened.stderr);
    assert.match(opened.stdout, /^Desktop Agent\nfreshness: unverified\n/);
  });

  test("open with an unknown id exits 1 naming project_not_found", async () => {
    const result = await cli("open", "nope");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /project_not_found/);
  });

  test("sessions lists a registered project's saved sessions and rejects an unknown id", async () => {
    const listed = await cli("sessions", "desktop-agent");
    assert.equal(listed.status, 0, listed.stderr);
    assert.equal(listed.stdout, "no saved sessions found\n");

    const unknown = await cli("sessions", "nope");
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /project_not_found/);
  });

  test("bad usage exits 2", async () => {
    assert.equal((await cli("unregister")).status, 2);
  });
});

describe("voice-bridge CLI without a healthy daemon", () => {
  let squatter: Server;
  let squatterPort: number;
  const seenAuthorization: (string | undefined)[] = [];

  before(async () => {
    squatter = createServer((req) => {
      seenAuthorization.push(req.headers.authorization);
      req.socket.destroy();
    });
    await new Promise<void>((resolve) => squatter.listen(0, "127.0.0.1", resolve));
    squatterPort = (squatter.address() as AddressInfo).port;
  });

  after(() => new Promise<void>((resolve) => squatter.close(() => resolve())));

  function dataDirPointingAt(port: number, pid: number): string {
    const dataDir = tempDir();
    ensureClientToken(dataDir);
    writeFileSync(daemonInfoPath(dataDir), JSON.stringify({ port, pid }));
    return dataDir;
  }

  test("a daemon.json left by a dead daemon is not running, and the token is never sent", async () => {
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    const result = await runCli(dataDirPointingAt(squatterPort, deadPid), "projects");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /daemon_not_running/);
    assert.deepEqual(seenAuthorization, []);
  });

  test("a connection dropped mid-request names the cause and says the outcome is unknown", async () => {
    const result = await runCli(dataDirPointingAt(squatterPort, process.pid), "projects");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /daemon_request_failed: .*\(.+\); it may or may not have been applied/);
  });

  test("a refused connection is reported as no daemon listening", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const result = await runCli(dataDirPointingAt(port, process.pid), "projects");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /daemon_not_running: nothing is listening/);
  });
});
