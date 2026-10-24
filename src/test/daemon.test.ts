import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { after, test } from "node:test";
import { PACKAGE_ROOT } from "../buildId.js";
import { runGit } from "../git.js";
import { tokenPath } from "../token.js";
import { call, fixtureHomes, makeRepo, removeTempDirs, spawnDaemon, tempDir, writeClaudeSession } from "./helpers.js";

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

test("a pinned primary session survives a restart", async () => {
  const env = daemonEnv();
  const dataDir = env.VOICE_BRIDGE_DATA_DIR!;
  const repo = makeRepo();
  writeClaudeSession(env.VOICE_BRIDGE_CLAUDE_HOME!, repo, "claude-1");
  const pin = { project_id: "desktop-agent", session_id: "claude-code:claude-1" };

  const first = await spawnDaemon(env);
  const token = readFileSync(tokenPath(dataDir), "utf8");
  try {
    assert.equal((await call(first.port, token, "register_project", { path: repo })).status, 200);
    assert.equal((await call(first.port, token, "pin_primary", pin)).body.route, "pinned");
  } finally {
    await first.stop();
  }

  const second = await spawnDaemon(env);
  try {
    const { body } = await call(second.port, token, "get_primary_session", { project_id: "desktop-agent" });
    assert.equal(body.route, "pinned");
    assert.equal(body.primary_session_id, pin.session_id);
  } finally {
    await second.stop();
  }
});

test("events and watermarks survive a restart", async () => {
  const env = daemonEnv();
  const dataDir = env.VOICE_BRIDGE_DATA_DIR!;
  const event = (n: number) => ({
    project_id: "desktop-agent",
    source: "hook",
    source_event_id: `e${n}`,
    source_sequence: n,
    type: "progress",
    payload: { n },
    observed_at: `2026-10-24T12:00:0${n}.000Z`,
  });

  const first = await spawnDaemon(env);
  const token = readFileSync(tokenPath(dataDir), "utf8");
  let lastEventId: number;
  try {
    assert.equal((await call(first.port, token, "register_project", { path: makeRepo() })).status, 200);
    assert.equal((await call(first.port, token, "ingest_event", event(1))).status, 200);
    lastEventId = (await call(first.port, token, "ingest_event", event(2))).body.event_id;
  } finally {
    await first.stop();
  }

  const second = await spawnDaemon(env);
  try {
    const { body } = await call(second.port, token, "get_project_status", { project_id: "desktop-agent" });
    assert.equal(body.freshness, "current");
    assert.deepEqual(body.watermarks, { hook: 2 });
    assert.equal(body.last_event_id, lastEventId);
    assert.deepEqual((await call(second.port, token, "ingest_event", event(2))).body, {
      event_id: lastEventId,
      duplicate: true,
    });
  } finally {
    await second.stop();
  }
});
