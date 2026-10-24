import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { after, before, describe, test } from "node:test";
import { startBridge, type RunningBridge } from "../app.js";
import { CLI_ENTRY, makeRepo, removeTempDirs, tempDir } from "./helpers.js";

describe("voice-bridge CLI", () => {
  let bridge: RunningBridge;
  let dataDir: string;

  before(async () => {
    dataDir = tempDir();
    bridge = await startBridge({ dataDir, port: 0, env: {} });
  });

  after(async () => {
    await bridge.close();
    removeTempDirs();
  });

  // Asynchronous on purpose: a blocking spawn would stall the in-process daemon the CLI calls.
  const cli = (...args: string[]) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = execFile(
        process.execPath,
        [CLI_ENTRY, ...args],
        { env: { ...process.env, VOICE_BRIDGE_DATA_DIR: dataDir }, timeout: 10_000 },
        (_error, stdout, stderr) => resolve({ status: child.exitCode, stdout, stderr }),
      );
    });

  test("register, projects and open talk to the running daemon", async () => {
    const repo = makeRepo();

    const registered = await cli("register", repo);
    assert.equal(registered.status, 0, registered.stderr);
    assert.equal(registered.stdout, `registered desktop-agent (Desktop Agent) at ${repo}\n`);

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

  test("bad usage exits 2", async () => {
    assert.equal((await cli("unregister")).status, 2);
  });
});
