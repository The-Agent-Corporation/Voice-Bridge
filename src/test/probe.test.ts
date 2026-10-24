import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { CAPABILITIES, resolveExecutable, type CapabilityResult, type ProbeReport } from "../probe.js";
import { CLI_ENTRY, removeTempDirs, tempDir } from "./helpers.js";

after(removeTempDirs);

/** A temp dir holding each of `files` as an executable; stubs see only the probe's scrubbed env, so paths they need are baked in. */
function stubDir(files: Record<string, string>): string {
  const dir = tempDir("voice-bridge-stubs-");
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), text);
    chmodSync(path.join(dir, name), 0o755);
  }
  return dir;
}

const runProbe = (env: Record<string, string>) =>
  new Promise<{ status: number | null; report: ProbeReport; stderr: string }>((resolve, reject) => {
    const child = execFile(process.execPath, [CLI_ENTRY, "probe"], { env, timeout: 60_000 }, (_error, stdout, stderr) => {
      try {
        resolve({ status: child.exitCode, report: JSON.parse(stdout) as ProbeReport, stderr });
      } catch (error) {
        reject(new Error(`probe printed no JSON (exit ${child.exitCode}): ${stderr}`, { cause: error }));
      }
    });
  });

function cells(report: ProbeReport): { where: string; cell: CapabilityResult }[] {
  return report.providers.flatMap((provider) =>
    Object.entries(provider.surfaces).flatMap(([surface, capabilities]) =>
      Object.entries(capabilities as Record<string, CapabilityResult>).map(([capability, cell]) => ({
        where: `${provider.provider}/${surface}/${capability}`,
        cell,
      })),
    ),
  );
}

function assertGone(pid: number): void {
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, `pid ${pid} is still alive`);
}

const versionStub = (version: string) => `#!/bin/sh\necho "${version}"\nexit 0\n`;

/** A Codex stand-in that serves line-delimited JSON-RPC on `app-server` and logs each method it receives. */
function fakeCodex(log: string, { codexHome, steer }: { codexHome?: string; steer: "result" | "method_not_found" }): string {
  return `#!${process.execPath}
const { appendFileSync, realpathSync } = require("node:fs");
const argv = process.argv.slice(2);
if (argv.includes("--version")) { console.log("codex-cli 9.9.9-fake"); process.exit(0); }
if (!argv.includes("app-server")) process.exit(3);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const codexHome = ${JSON.stringify(codexHome ?? null)} ?? realpathSync(process.env.CODEX_HOME);
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  appendFileSync(${JSON.stringify(log)}, message.method + "\\n");
  if (message.id === undefined) return;
  const reply = (result) => send({ jsonrpc: "2.0", id: message.id, result });
  switch (message.method) {
    case "initialize": return reply({ codexHome });
    case "thread/list": return reply({ data: [], nextCursor: null });
    case "thread/start":
      reply({ thread: { id: "t1" } });
      return send({ jsonrpc: "2.0", method: "thread/started", params: { thread: { id: "t1" } } });
    case "thread/read": return reply({ thread: { id: "t1" } });
    case "turn/start":
      reply({ turn: { id: "u1", status: "inProgress" } });
      return send({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "t1", turn: { id: "u1" } } });
    case "turn/steer":
      ${steer === "result" ? `return reply({ turnId: "u1" });` : `return send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } });`}
    case "turn/interrupt": return reply({});
  }
}).on("close", () => process.exit(0));
`;
}

describe("voice-bridge probe", () => {
  test("with no provider on PATH, both are not_installed and every cell unverified", async () => {
    const { status, report, stderr } = await runProbe({ PATH: tempDir() });
    assert.equal(status, 0, stderr);
    for (const provider of report.providers) {
      assert.equal(provider.binary, "not_installed");
      assert.equal(provider.found_on_path, null);
      assert.equal(provider.version, null);
      for (const surface of Object.values(provider.surfaces)) assert.deepEqual(Object.keys(surface), [...CAPABILITIES]);
    }
    assert.deepEqual(Object.keys(report.providers[0].surfaces), ["cli", "app_server", "desktop", "ide"]);
    assert.deepEqual(Object.keys(report.providers[1].surfaces), ["cli", "sdk", "desktop", "ide"]);
    for (const { where, cell } of cells(report)) assert.deepEqual([cell.status, cell.reason], ["unverified", "not_installed"], where);
    assert.deepEqual(report.children, []);
  });

  test("a stub that only prints a version gets its absolute path and version recorded, and nothing supported", async () => {
    const dir = stubDir({ codex: versionStub("codex 9.9.9-stub"), claude: versionStub("claude 9.9.9-stub") });
    const { status, report, stderr } = await runProbe({ PATH: dir });
    assert.equal(status, 0, stderr);
    const [codex, claude] = report.providers;
    assert.equal(codex.binary, path.join(dir, "codex"));
    assert.equal(codex.found_on_path, path.join(dir, "codex"));
    assert.equal(codex.version, "codex 9.9.9-stub");
    assert.equal(claude.binary, path.join(dir, "claude"));
    assert.equal(claude.version, "claude 9.9.9-stub");
    for (const { where, cell } of cells(report)) {
      assert.notEqual(cell.status, "supported", where);
      for (const evidence of cell.evidence) assert.ok(path.isAbsolute(evidence.command[0]!), where);
    }
    for (const cell of Object.values(codex.surfaces.app_server)) {
      if (cell.reason !== "needs_foreign_session" && cell.reason !== "needs_pending_question") assert.equal(cell.reason, "check_failed");
    }
    assert.equal(codex.surfaces.app_server.discover.reason, "check_failed");
    assert.ok(report.children.every((child) => path.isAbsolute(child.command[0]!)));
  });

  test("no process the probe started, or anything they spawned, is alive after it returns", async () => {
    const pidFile = path.join(tempDir(), "pids");
    const dir = stubDir({
      codex: `#!/bin/sh\n/bin/sleep 300 &\necho $! >> ${JSON.stringify(pidFile)}\necho "codex 9.9.9-stub"\nexit 0\n`,
    });
    const { status, report, stderr } = await runProbe({ PATH: dir });
    assert.equal(status, 0, stderr);
    assert.equal(report.children.length, 2, "--version and app-server");
    const grandchildren = readFileSync(pidFile, "utf8").trim().split("\n").map(Number);
    assert.equal(grandchildren.length, 2);
    for (const child of report.children) {
      assert.equal(child.reaped, true);
      assertGone(child.pid);
    }
    for (const pid of grandchildren) assertGone(pid);
  });

  test("the provider sees none of the caller's environment", async () => {
    const envFile = path.join(tempDir(), "env");
    const dir = stubDir({ claude: `#!/bin/sh\n/usr/bin/env > ${JSON.stringify(envFile)}\necho "claude 9.9.9-stub"\n` });
    const { status, stderr } = await runProbe({ PATH: dir, OPENAI_API_KEY: "sk-leak", HOME: "/Users/someone" });
    assert.equal(status, 0, stderr);
    const env = Object.fromEntries(
      readFileSync(envFile, "utf8").trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.notEqual(env.HOME, "/Users/someone");
    assert.match(env.HOME!, /voice-bridge-probe-/);
    assert.match(env.CODEX_HOME!, /voice-bridge-probe-/);
    assert.match(env.CLAUDE_CONFIG_DIR!, /voice-bridge-probe-/);
  });

  test("a fake app-server's answers map to supported, unsupported and unverified", async () => {
    const log = path.join(tempDir(), "methods");
    const dir = stubDir({ codex: fakeCodex(log, { steer: "method_not_found" }) });
    const { status, report, stderr } = await runProbe({ PATH: dir });
    assert.equal(status, 0, stderr);
    const appServer = report.providers[0].surfaces.app_server;
    const summary = Object.fromEntries(Object.entries(appServer).map(([capability, cell]) => [capability, `${cell.status}/${cell.reason}`]));
    assert.deepEqual(summary, {
      discover: "supported/proved",
      inspect: "supported/proved",
      live_attach: "unverified/needs_foreign_session",
      next_turn: "supported/proved",
      steer: "unsupported/method_not_found",
      events: "supported/proved",
      answer_question: "unverified/needs_pending_question",
    });
    assert.equal(appServer.steer.evidence[0]?.rpc, "turn/steer → error -32601: method not found");
    assert.equal(appServer.discover.evidence[0]?.exit_code, 0);
    assert.ok(report.children.every((child) => child.reaped));
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [
      "initialize",
      "initialized",
      "thread/list",
      "thread/start",
      "thread/read",
      "turn/start",
      "turn/steer",
      "turn/interrupt",
    ]);
  });

  test("a steer that returns its turn id is supported", async () => {
    const dir = stubDir({ codex: fakeCodex(path.join(tempDir(), "methods"), { steer: "result" }) });
    const { report } = await runProbe({ PATH: dir });
    assert.equal(report.providers[0].surfaces.app_server.steer.status, "supported");
  });

  test("an app-server using any home but the probe's own is sent nothing after initialize", async () => {
    const log = path.join(tempDir(), "methods");
    const dir = stubDir({ codex: fakeCodex(log, { codexHome: "/elsewhere", steer: "result" }) });
    const { status, report, stderr } = await runProbe({ PATH: dir });
    assert.equal(status, 0, stderr);
    for (const [capability, cell] of Object.entries(report.providers[0].surfaces.app_server)) {
      assert.deepEqual([cell.status, cell.reason], ["unverified", "check_failed"], capability);
      assert.match(cell.detail, /codexHome mismatch: "\/elsewhere"/);
    }
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["initialize"]);
  });
});

describe("resolveExecutable", () => {
  const good = stubDir({ codex: versionStub("good") });

  test("skips relative PATH entries", () => {
    const relative = path.relative(process.cwd(), stubDir({ codex: versionStub("relative") }));
    assert.ok(!path.isAbsolute(relative));
    assert.equal(resolveExecutable("codex", [relative, good].join(path.delimiter))?.binary, path.join(good, "codex"));
  });

  test("skips non-executable files and directories", () => {
    const plain = tempDir();
    writeFileSync(path.join(plain, "codex"), "not executable");
    const withDir = tempDir();
    mkdirSync(path.join(withDir, "codex"));
    assert.equal(resolveExecutable("codex", [plain, withDir, good].join(path.delimiter))?.binary, path.join(good, "codex"));
  });

  test("returns the PATH hit and the realpath it will execute", () => {
    const linked = tempDir();
    symlinkSync(path.join(good, "codex"), path.join(linked, "codex"));
    assert.deepEqual(resolveExecutable("codex", linked), { found_on_path: path.join(linked, "codex"), binary: path.join(good, "codex") });
  });

  test("an empty PATH finds nothing", () => {
    assert.equal(resolveExecutable("codex", ""), null);
  });
});
