import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { startBridge, type RunningBridge } from "../app.js";
import { TOOLS } from "../server.js";
import { readClientToken } from "../token.js";
import { call, fixtureHomes, makeRepo, PRD_SAMPLE, removeTempDirs, tempDir, writeVoiceConfig } from "./helpers.js";

function subdirectoryOf(dir: string): string {
  const sub = path.join(dir, "sub");
  mkdirSync(sub);
  return sub;
}

describe("bridge API", () => {
  let bridge: RunningBridge;
  let token: string;
  let repo: string;

  before(async () => {
    const dataDir = tempDir();
    bridge = await startBridge({ dataDir, port: 0, env: fixtureHomes() });
    token = readClientToken(dataDir);
    repo = makeRepo();
  });

  after(async () => {
    await bridge.close();
    removeTempDirs();
  });

  const list = async () => (await call(bridge.port, token, "list_projects")).body.projects;

  test("listens on 127.0.0.1 only", () => {
    assert.equal(bridge.address, "127.0.0.1");
    assert.equal((bridge.server.address() as { address: string }).address, "127.0.0.1");
  });

  test("tools reject a missing, wrong or non-Bearer token with 401 and no data", async () => {
    for (const authorization of [undefined, "Bearer wrong", `Basic ${token}`]) {
      const response = await call(bridge.port, null, "list_projects", {}, authorization);
      assert.equal(response.status, 401, `authorization ${authorization}`);
      assert.deepEqual(Object.keys(response.body), ["error"]);
      assert.equal(response.body.error.code, "unauthorized");
    }
  });

  test("registers the PRD sample repo and lists exactly that project", async () => {
    const configBefore = readFileSync(path.join(repo, ".voice", "config.json"));

    const response = await call(bridge.port, token, "register_project", { path: repo });
    assert.equal(response.status, 200);
    assert.equal(response.body.project_id, "desktop-agent");
    assert.equal(response.body.created, true);
    assert.deepEqual(await list(), [{ project_id: "desktop-agent", display_name: "Desktop Agent", canonical_path: repo }]);

    assert.deepEqual(readFileSync(path.join(repo, ".voice", "config.json")), configBefore);
    assert.equal(existsSync(path.join(repo, "VOICE.md")), false);
  });

  test("registering again, or through a symlink, keeps one project at the canonical path", async () => {
    const again = await call(bridge.port, token, "register_project", { path: repo });
    assert.equal(again.status, 200);
    assert.equal(again.body.created, false);

    const link = path.join(tempDir(), "linked-repo");
    symlinkSync(repo, link, "dir");
    const viaLink = await call(bridge.port, token, "register_project", { path: link });
    assert.equal(viaLink.status, 200);
    assert.equal(viaLink.body.canonical_path, repo);

    const projects = await list();
    assert.equal(projects.length, 1);
    assert.equal(projects[0].canonical_path, repo);
  });

  test("registering through a differently-cased spelling keeps the on-disk path", async (t) => {
    const recased = repo.toUpperCase();
    if (recased === repo || !existsSync(recased)) return t.skip("this file system is case-sensitive");
    const response = await call(bridge.port, token, "register_project", { path: recased });
    assert.equal(response.status, 200);
    assert.equal(response.body.created, false);
    assert.equal(response.body.canonical_path, repo);
    assert.equal((await list()).length, 1);
  });

  test("rejects bad registrations with a cause-naming 400 and stores nothing", async () => {
    const { project_id: _omitted, ...withoutId } = PRD_SAMPLE;
    const cases = [
      { code: "invalid_schema_version", path: makeRepo({ ...PRD_SAMPLE, schema_version: 2, project_id: "v2" }) },
      { code: "missing_project_id", path: makeRepo(withoutId) },
      { code: "not_a_git_work_tree", path: makeRepo({ ...PRD_SAMPLE, project_id: "no-git" }, { git: false }) },
      { code: "project_id_conflict", path: makeRepo(PRD_SAMPLE) },
      { code: "invalid_path", path: "relative/path" },
      { code: "not_work_tree_root", path: subdirectoryOf(makeRepo({ ...PRD_SAMPLE, project_id: "sub" })) },
    ];
    const before = await list();
    for (const { code, path: target } of cases) {
      const response = await call(bridge.port, token, "register_project", { path: target });
      assert.equal(response.status, 400, code);
      assert.equal(response.body.error.code, code);
      assert.deepEqual(await list(), before, `${code} stored something`);
    }
    assert.equal(before[0].canonical_path, repo);
  });

  test("a git that cannot run is a 500 git_failed naming the cause, not a user error", async () => {
    const before = await list();
    const target = makeRepo({ ...PRD_SAMPLE, project_id: "no-git-binary" });
    const savedPath = process.env.PATH;
    process.env.PATH = tempDir();
    let response;
    try {
      response = await call(bridge.port, token, "register_project", { path: target });
    } finally {
      process.env.PATH = savedPath;
    }
    assert.equal(response.status, 500);
    assert.equal(response.body.error.code, "git_failed");
    assert.match(response.body.error.message, /ENOENT/);
    assert.deepEqual(await list(), before);
  });

  test("tools answer malformed JSON with 400, a wrong method with 405 and an oversized body with 413", async () => {
    const post = (body: string) =>
      fetch(`http://127.0.0.1:${bridge.port}/tools/list_projects`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body,
      });
    const malformed = await post("{");
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error.code, "invalid_request");

    const wrongMethod = await fetch(`http://127.0.0.1:${bridge.port}/tools/list_projects`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(wrongMethod.status, 405);
    assert.equal((await wrongMethod.json()).error.code, "method_not_allowed");

    const oversized = await post(JSON.stringify({ padding: "x".repeat(64 * 1024) }));
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).error.code, "request_too_large");
  });

  test("rejects registering a known path under a new project_id and stores nothing", async () => {
    const before = await list();
    writeVoiceConfig(repo, { ...PRD_SAMPLE, project_id: "renamed" });
    try {
      const response = await call(bridge.port, token, "register_project", { path: repo });
      assert.equal(response.status, 400);
      assert.equal(response.body.error.code, "path_already_registered");
      assert.match(response.body.error.message, /desktop-agent/);
      assert.deepEqual(await list(), before);
    } finally {
      writeVoiceConfig(repo, PRD_SAMPLE);
    }
  });

  test("open_project returns an honest, unverified briefing", async () => {
    const response = await call(bridge.port, token, "open_project", { project_id: "desktop-agent" });
    assert.equal(response.status, 200);
    assert.equal(response.body.project_id, "desktop-agent");
    assert.equal(response.body.display_name, "Desktop Agent");
    assert.equal(response.body.freshness, "unverified");
    assert.equal(response.body.last_confirmed_activity, null);
    assert.match(response.body.briefing, /Desktop Agent/);
    assert.doesNotMatch(response.body.briefing, /working/i);
  });

  test("open_project with an unknown id is a 404", async () => {
    const response = await call(bridge.port, token, "open_project", { project_id: "nope" });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "project_not_found");
  });
});

test("the tool API offers no way to start, resume or fork a session", () => {
  assert.deepEqual(Object.keys(TOOLS).sort(), [
    "cancel_message",
    "dismiss_inbox_question",
    "get_message",
    "get_primary_session",
    "get_project_status",
    "ingest_event",
    "list_inbox",
    "list_projects",
    "list_sessions",
    "open_project",
    "pin_primary",
    "register_project",
    "send_to_primary",
    "unpin_primary",
  ]);
});
