import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { after, test } from "node:test";
import { PACKAGE_ROOT } from "../buildId.js";
import { runGit } from "../git.js";
import { tokenPath } from "../token.js";
import { call, fixtureHomes, makeRepo, removeTempDirs, spawnDaemon, tempDir } from "./helpers.js";

after(removeTempDirs);

function daemonEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const { FACTORY_RUNTIME_CANDIDATE: _ignored, ...env } = process.env;
  return { ...env, VOICE_BRIDGE_DATA_DIR: tempDir(), ...fixtureHomes(), ...extra };
}

async function getText(port: number, route: string): Promise<{ status: number; text: string }> {
  const response = await fetch(`http://127.0.0.1:${port}${route}`);
  return { status: response.status, text: await response.text() };
}

test("GET /health answers 200 {\"status\":\"ok\"} on a 127.0.0.1 listener", async (t) => {
  const daemon = await spawnDaemon(daemonEnv());
  t.after(() => daemon.stop());
  assert.equal(daemon.address, "127.0.0.1");
  assert.deepEqual(await getText(daemon.port, "/health"), { status: 200, text: '{"status":"ok"}' });
});

test("GET /build-id reports FACTORY_RUNTIME_CANDIDATE exactly when set", async (t) => {
  const daemon = await spawnDaemon(daemonEnv({ FACTORY_RUNTIME_CANDIDATE: "abc123" }));
  t.after(() => daemon.stop());
  assert.deepEqual(await getText(daemon.port, "/build-id"), { status: 200, text: "abc123" });
});

test("GET /build-id falls back to git rev-parse HEAD when the candidate is unset or empty", async (t) => {
  const git = runGit(["rev-parse", "HEAD"], PACKAGE_ROOT);
  assert.ok(git.ok, "the package root must be a Git checkout for this test");
  const head = git.stdout;
  for (const env of [daemonEnv(), daemonEnv({ FACTORY_RUNTIME_CANDIDATE: "" })]) {
    const daemon = await spawnDaemon(env);
    t.after(() => daemon.stop());
    assert.deepEqual(await getText(daemon.port, "/build-id"), { status: 200, text: head });
  }
});

test("registered projects and the client token survive a restart", async () => {
  const env = daemonEnv();
  const dataDir = env.VOICE_BRIDGE_DATA_DIR!;
  const repo = makeRepo();

  const first = await spawnDaemon(env);
  const token = readFileSync(tokenPath(dataDir), "utf8");
  try {
    assert.equal((await call(first.port, token, "register_project", { path: repo })).status, 200);
  } finally {
    await first.stop();
  }

  const second = await spawnDaemon(env);
  try {
    assert.equal(readFileSync(tokenPath(dataDir), "utf8"), token);
    if (process.platform !== "win32") assert.equal(statSync(tokenPath(dataDir)).mode & 0o777, 0o600);
    const { body } = await call(second.port, token, "list_projects");
    assert.deepEqual(body.projects, [{ project_id: "desktop-agent", display_name: "Desktop Agent", canonical_path: repo }]);
  } finally {
    await second.stop();
  }
});
