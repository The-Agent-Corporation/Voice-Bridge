import assert from "node:assert/strict";
import { utimesSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, describe, test } from "node:test";
import { startBridge, type RunningBridge } from "../app.js";
import { STORE_FILE } from "../store.js";
import { readClientToken } from "../token.js";
import { call, fixtureHomes, makeRepo, PRD_SAMPLE, removeTempDirs, tempDir, writeClaudeSession } from "./helpers.js";

describe("primary session tools", () => {
  let bridge: RunningBridge;
  let dataDir: string;
  let token: string;

  const project = (id: string) => ({ ...PRD_SAMPLE, project_id: id, display_name: id });
  const tool = (name: string, body: unknown) => call(bridge.port, token, name, body);
  const auditRows = () => {
    const db = new DatabaseSync(path.join(dataDir, STORE_FILE));
    try {
      return db.prepare("SELECT project_id, session_id, action FROM pin_audit ORDER BY id").all().map((row) => ({ ...row }));
    } finally {
      db.close();
    }
  };

  before(async () => {
    const homes = fixtureHomes();
    dataDir = tempDir();
    bridge = await startBridge({ dataDir, port: 0, env: homes });
    token = readClientToken(dataDir);
    const repoA = makeRepo(project("repo-a"));
    const repoB = makeRepo(project("repo-b"));
    writeClaudeSession(homes.VOICE_BRIDGE_CLAUDE_HOME, repoA, "claude-a-1");
    const older = new Date("2026-01-01T00:00:00.000Z");
    utimesSync(writeClaudeSession(homes.VOICE_BRIDGE_CLAUDE_HOME, repoA, "claude-a-2"), older, older);
    writeClaudeSession(homes.VOICE_BRIDGE_CLAUDE_HOME, repoB, "claude-b-1");
    for (const repo of [repoA, repoB]) assert.equal((await tool("register_project", { path: repo })).status, 200);
  });

  beforeEach(async () => {
    await tool("unpin_primary", { project_id: "repo-a" });
    const db = new DatabaseSync(path.join(dataDir, STORE_FILE));
    try {
      db.exec("DELETE FROM pin_audit");
    } finally {
      db.close();
    }
  });

  after(async () => {
    await bridge.close();
    removeTempDirs();
  });

  test("get_primary_session reports the saved session as read-only", async () => {
    const { status, body } = await tool("get_primary_session", { project_id: "repo-a" });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.project_id, "repo-a");
    assert.equal(body.route, "recent_saved_read_only");
    assert.equal(body.primary_session_id, "claude-code:claude-a-1");
    assert.equal(body.mutating_allowed, false);
    assert.equal(body.workspace_owner_session_id, null);
    assert.equal(body.skipped_records, 0);
  });

  test("re-pinning moves the primary to the new session and audits both pins", async () => {
    assert.equal((await tool("pin_primary", { project_id: "repo-a", session_id: "claude-code:claude-a-1" })).status, 200);
    const repinned = await tool("pin_primary", { project_id: "repo-a", session_id: "claude-code:claude-a-2" });
    assert.equal(repinned.status, 200, JSON.stringify(repinned.body));
    assert.equal(repinned.body.route, "pinned");
    assert.equal(repinned.body.primary_session_id, "claude-code:claude-a-2");
    assert.equal((await tool("get_primary_session", { project_id: "repo-a" })).body.primary_session_id, "claude-code:claude-a-2");
    assert.deepEqual(auditRows(), [
      { project_id: "repo-a", session_id: "claude-code:claude-a-1", action: "pin" },
      { project_id: "repo-a", session_id: "claude-code:claude-a-2", action: "pin" },
    ]);
  });

  test("pin then unpin route through the pin and leave exactly two audit rows", async () => {
    const pinned = await tool("pin_primary", { project_id: "repo-a", session_id: "claude-code:claude-a-1" });
    assert.equal(pinned.status, 200, JSON.stringify(pinned.body));
    assert.equal(pinned.body.route, "pinned");
    assert.equal(pinned.body.primary_session_id, "claude-code:claude-a-1");
    assert.equal((await tool("get_primary_session", { project_id: "repo-a" })).body.route, "pinned");

    const unpinned = await tool("unpin_primary", { project_id: "repo-a" });
    assert.equal(unpinned.status, 200, JSON.stringify(unpinned.body));
    assert.equal(unpinned.body.route, "recent_saved_read_only");

    assert.deepEqual(auditRows(), [
      { project_id: "repo-a", session_id: "claude-code:claude-a-1", action: "pin" },
      { project_id: "repo-a", session_id: "claude-code:claude-a-1", action: "unpin" },
    ]);
  });

  test("pinning another project's session is a 400 and stores nothing", async () => {
    const { status, body } = await tool("pin_primary", { project_id: "repo-a", session_id: "claude-code:claude-b-1" });
    assert.equal(status, 400);
    assert.equal(body.error.code, "session_not_in_project");
    assert.notEqual((await tool("get_primary_session", { project_id: "repo-a" })).body.route, "pinned");
    assert.deepEqual(auditRows(), []);
  });

  test("an unknown project is a 404 and a missing session_id a 400", async () => {
    const unknown = await tool("pin_primary", { project_id: "nope", session_id: "claude-code:claude-a-1" });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, "project_not_found");
    for (const name of ["get_primary_session", "unpin_primary"]) {
      assert.equal((await tool(name, { project_id: "nope" })).body.error.code, "project_not_found");
    }
    const missing = await tool("pin_primary", { project_id: "repo-a" });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, "invalid_request");
  });
});
