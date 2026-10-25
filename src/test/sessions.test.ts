import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { startBridge, type RunningBridge } from "../app.js";
import { runGit } from "../git.js";
import { reconcileControlledSessions } from "../lease.js";
import { openStore } from "../store.js";
import { readClientToken } from "../token.js";
import {
  call,
  fixtureHomes,
  makeRepo,
  PRD_SAMPLE,
  removeTempDirs,
  tempDir,
  writeClaudeSession,
  writeCodexSession,
  writeVoiceConfig,
} from "./helpers.js";

const NO_CAPABILITIES = {
  live_attach: false,
  next_turn: false,
  steer_active_turn: false,
  answer_pending_question: false,
  subscribe_events: false,
};

/** Every file under `dir` with its mtime and SHA-256, so any write, touch or new file shows up. */
function snapshot(dir: string): Record<string, { mtimeMs: number; sha256: string }> {
  const files: Record<string, { mtimeMs: number; sha256: string }> = {};
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    files[file] = { mtimeMs: statSync(file).mtimeMs, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") };
  }
  return files;
}

describe("saved session discovery", () => {
  let bridge: RunningBridge;
  let dataDir: string;
  let token: string;
  let codexHome: string;
  let claudeHome: string;
  let repoA: string;
  let repoB: string;
  let repoW: string;
  let worktreeW: string;
  let fixturesBefore: { codex: ReturnType<typeof snapshot>; claude: ReturnType<typeof snapshot> };

  const project = (id: string) => ({ ...PRD_SAMPLE, project_id: id, display_name: id });
  const sessions = async (projectId: string) => {
    const response = await call(bridge.port, token, "list_sessions", { project_id: projectId });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body as { project_id: string; sessions: any[]; skipped_records: number };
  };
  const storedIds = (projectId: string) => {
    const store = openStore(dataDir);
    try {
      return store.listSessions(projectId).map((s) => s.native_session_id).sort();
    } finally {
      store.close();
    }
  };
  const ids = (body: { sessions: { native_session_id: string }[] }) => body.sessions.map((s) => s.native_session_id).sort();

  before(async () => {
    const homes = fixtureHomes();
    codexHome = homes.VOICE_BRIDGE_CODEX_HOME;
    claudeHome = homes.VOICE_BRIDGE_CLAUDE_HOME;
    dataDir = tempDir();
    bridge = await startBridge({ dataDir, port: 0, env: homes });
    token = readClientToken(dataDir);

    repoA = makeRepo(project("repo-a"));
    repoB = makeRepo(project("repo-b"));
    const repoAOld = `${repoA}-old`;
    mkdirSync(repoAOld);
    const linkToA = path.join(tempDir(), "link-to-a");
    symlinkSync(repoA, linkToA, "dir");

    repoW = makeRepo(project("repo-w"));
    const commit = runGit(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "init"], repoW);
    assert.ok(commit.ok, !commit.ok ? commit.detail : "");
    const worktreeDir = `${repoW}-wt`;
    const added = runGit(["worktree", "add", "-q", worktreeDir, "-b", "wt"], repoW);
    assert.ok(added.ok, !added.ok ? added.detail : "");
    worktreeW = realpathSync(worktreeDir);

    writeClaudeSession(claudeHome, repoA, "claude-a-1");
    writeClaudeSession(claudeHome, repoA, "claude-a-2");
    writeCodexSession(codexHome, linkToA, "codex-a-1");
    writeCodexSession(codexHome, repoB, "codex-b-1");
    writeClaudeSession(claudeHome, repoAOld, "claude-a-old");
    writeCodexSession(codexHome, repoW, "codex-w-1");
    writeCodexSession(codexHome, worktreeDir, "codex-w-wt");

    fixturesBefore = { codex: snapshot(codexHome), claude: snapshot(claudeHome) };
    for (const repo of [repoA, repoB, repoW]) {
      const registered = await call(bridge.port, token, "register_project", { path: repo });
      assert.equal(registered.status, 200, JSON.stringify(registered.body));
    }
  });

  after(async () => {
    await bridge.close();
    removeTempDirs();
  });

  // First, before later tests add fixtures: registration plus repeated discovery must leave the homes byte-identical.
  test("discovery never writes to, touches or adds the providers' files", async () => {
    for (const projectId of ["repo-a", "repo-b", "repo-w", "repo-a"]) await sessions(projectId);
    assert.deepEqual({ codex: snapshot(codexHome), claude: snapshot(claudeHome) }, fixturesBefore);
  });

  test("a project gets exactly the sessions whose cwd is its root, never a similarly named folder", async () => {
    const a = await sessions("repo-a");
    const b = await sessions("repo-b");
    assert.deepEqual(ids(a), ["claude-a-1", "claude-a-2", "codex-a-1"]);
    assert.ok(a.sessions.every((s) => s.worktree_id === repoA));
    assert.deepEqual(ids(b), ["codex-b-1"]);
    assert.equal(b.sessions[0].worktree_id, repoB);
    assert.doesNotMatch(JSON.stringify([a, b]), /claude-a-old/);
  });

  test("a session in a linked worktree belongs to the project, under that worktree's id", async () => {
    const w = await sessions("repo-w");
    assert.deepEqual(ids(w), ["codex-w-1", "codex-w-wt"]);
    assert.equal(w.sessions.find((s) => s.native_session_id === "codex-w-1").worktree_id, repoW);
    assert.equal(w.sessions.find((s) => s.native_session_id === "codex-w-wt").worktree_id, worktreeW);
  });

  test("a project registered at a linked worktree claims only that worktree, so no session is listed twice", async () => {
    const main = makeRepo(project("split-main"));
    const commit = runGit(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "init"], main);
    assert.ok(commit.ok, !commit.ok ? commit.detail : "");
    const linked = ["one", "two"].map((name) => {
      const dir = `${main}-${name}`;
      const added = runGit(["worktree", "add", "-q", dir, "-b", name], main);
      assert.ok(added.ok, !added.ok ? added.detail : "");
      writeVoiceConfig(dir, project(`split-${name}`));
      return realpathSync(dir);
    });
    writeCodexSession(codexHome, main, "codex-split-main");
    writeCodexSession(codexHome, linked[0], "codex-split-one");
    writeCodexSession(codexHome, linked[1], "codex-split-two");
    const register = async (dir: string) =>
      assert.equal((await call(bridge.port, token, "register_project", { path: dir })).status, 200);

    await register(linked[0]);
    assert.deepEqual(ids(await sessions("split-one")), ["codex-split-one"]);

    await register(main);
    assert.deepEqual(ids(await sessions("split-main")), ["codex-split-main", "codex-split-two"]);
    assert.deepEqual(ids(await sessions("split-one")), ["codex-split-one"]);

    await register(linked[1]);
    assert.deepEqual(ids(await sessions("split-main")), ["codex-split-main"]);
    assert.deepEqual(ids(await sessions("split-two")), ["codex-split-two"]);
  });

  test("a session saved twice is stored once, as its most recent copy", async () => {
    const repo = makeRepo(project("twice"));
    const older = writeCodexSession(codexHome, repo, "codex-twice");
    const newer = writeCodexSession(codexHome, repo, "codex-twice", { zstd: true });
    utimesSync(older, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    utimesSync(newer, new Date("2026-02-01T00:00:00Z"), new Date("2026-02-01T00:00:00Z"));
    try {
      assert.equal((await call(bridge.port, token, "register_project", { path: repo })).status, 200);
      const twice = await sessions("twice");
      assert.equal(twice.sessions.length, 1);
      assert.equal(twice.sessions[0].last_activity_at, "2026-02-01T00:00:00.000Z");
    } finally {
      rmSync(older);
      rmSync(newer);
    }
  });

  test("a missing provider home set in the environment fails loudly and keeps the stored sessions", async () => {
    const stored = storedIds("repo-b");
    assert.notDeepEqual(stored, []);
    const moved = `${codexHome}-moved`;
    renameSync(codexHome, moved);
    try {
      const response = await call(bridge.port, token, "list_sessions", { project_id: "repo-b" });
      assert.equal(response.status, 500);
      assert.equal(response.body.error.code, "session_discovery_failed");
      assert.deepEqual(storedIds("repo-b"), stored);
    } finally {
      renameSync(moved, codexHome);
    }
  });

  test("a provider folder that cannot be read fails loudly and keeps the stored sessions", { skip: process.getuid?.() === 0 && "root reads any folder" }, async () => {
    const stored = storedIds("repo-b");
    assert.notDeepEqual(stored, []);
    const dir = path.join(codexHome, "sessions");
    chmodSync(dir, 0o000);
    try {
      const response = await call(bridge.port, token, "list_sessions", { project_id: "repo-b" });
      assert.equal(response.status, 500);
      assert.equal(response.body.error.code, "session_discovery_failed");
      assert.deepEqual(storedIds("repo-b"), stored);
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  test("every discovered session is saved, with every capability false", async () => {
    for (const projectId of ["repo-a", "repo-b", "repo-w"]) {
      for (const session of (await sessions(projectId)).sessions) {
        assert.equal(session.observed_state, "saved");
        assert.deepEqual(session.capabilities, NO_CAPABILITIES);
        assert.equal(session.session_id, `${session.provider}:${session.native_session_id}`);
        assert.equal(typeof session.last_activity_at, "string");
      }
    }
  });

  test("register_project reports the sessions it found", async () => {
    const again = await call(bridge.port, token, "register_project", { path: repoB });
    assert.equal(again.status, 200);
    assert.equal(again.body.created, false);
    assert.equal(again.body.sessions, 1);
    assert.equal(typeof again.body.skipped_records, "number");
  });

  test("only providers in allowed_providers are associated, as the config says now", async () => {
    const repo = makeRepo({ ...project("codex-only"), allowed_providers: ["codex"] });
    writeClaudeSession(claudeHome, repo, "claude-codex-only");
    writeCodexSession(codexHome, repo, "codex-codex-only");
    assert.equal((await call(bridge.port, token, "register_project", { path: repo })).status, 200);
    assert.deepEqual(ids(await sessions("codex-only")), ["codex-codex-only"]);

    writeVoiceConfig(repo, { ...project("codex-only"), allowed_providers: ["codex", "claude-code"] });
    assert.deepEqual(ids(await sessions("codex-only")), ["claude-codex-only", "codex-codex-only"]);
  });

  test("an unknown provider in allowed_providers rejects the registration and stores nothing", async () => {
    const before = (await call(bridge.port, token, "list_projects")).body.projects;
    const repo = makeRepo({ ...project("gemini"), allowed_providers: ["gemini"] });
    const response = await call(bridge.port, token, "register_project", { path: repo });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid_allowed_providers");
    assert.deepEqual((await call(bridge.port, token, "list_projects")).body.projects, before);
  });

  test("a malformed record is counted in skipped_records and fails nothing", async () => {
    const before = await sessions("repo-a");
    const badClaude = path.join(claudeHome, "projects", "broken", "broken-claude.jsonl");
    mkdirSync(path.dirname(badClaude), { recursive: true });
    writeFileSync(badClaude, '{not json\n{"cwd":"/nowhere"}\n');
    try {
      const withBadClaude = await sessions("repo-a");
      assert.equal(withBadClaude.skipped_records, before.skipped_records + 1);
      assert.equal(withBadClaude.sessions.length, before.sessions.length);

      const emptyCodex = path.join(codexHome, "sessions", "2026", "10", "24", "rollout-2026-10-24T00-00-00-empty.jsonl");
      writeFileSync(emptyCodex, "");
      try {
        const withEmptyCodex = await sessions("repo-a");
        assert.equal(withEmptyCodex.skipped_records, before.skipped_records + 2);
        assert.equal(withEmptyCodex.sessions.length, before.sessions.length);
      } finally {
        rmSync(emptyCodex);
      }
    } finally {
      rmSync(path.dirname(badClaude), { recursive: true });
    }
  });

  test("a zstd-compressed Codex record is discovered", async () => {
    const repo = makeRepo(project("zstd"));
    const file = writeCodexSession(codexHome, repo, "codex-zstd", { zstd: true });
    try {
      assert.equal((await call(bridge.port, token, "register_project", { path: repo })).status, 200);
      assert.deepEqual(ids(await sessions("zstd")), ["codex-zstd"]);
    } finally {
      rmSync(file);
    }
  });

  test("rediscovery is idempotent and drops a record that is gone", async () => {
    const first = await sessions("repo-b");
    const second = await sessions("repo-b");
    assert.deepEqual(second.sessions, first.sessions);

    const extra = writeClaudeSession(claudeHome, repoB, "claude-b-extra");
    assert.equal((await sessions("repo-b")).sessions.length, first.sessions.length + 1);
    rmSync(extra);
    assert.deepEqual((await sessions("repo-b")).sessions, first.sessions);
  });

  test("list_sessions with an unknown id is a 404", async () => {
    const response = await call(bridge.port, token, "list_sessions", { project_id: "nope" });
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "project_not_found");
  });
});

test("a controlled session whose host process is gone is ended, and its lease is kept for the next start to judge", () => {
  const store = openStore(tempDir());
  try {
    store.upsert({ project_id: "p", display_name: "P", canonical_path: "/x/p" });
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    const controlled = (sessionId: string, holderPid: number, worktreeId: string) => {
      store.acquireLease({ worktree_id: worktreeId, project_id: "p", holder_pid: holderPid, at: "2026-10-24T12:00:00.000Z" }, () => true);
      store.connectControlledSession({
        session_id: sessionId,
        project_id: "p",
        provider: "codex",
        native_session_id: sessionId.slice("codex:".length),
        worktree_id: worktreeId,
        observed_state: "connected_running",
        last_activity_at: "2026-10-24T12:00:00.000Z",
        capabilities: { ...NO_CAPABILITIES, next_turn: true },
        holder_pid: holderPid,
        provider_pgid: holderPid,
        started_at: "2026-10-24T12:00:00.000Z",
      });
    };
    controlled("codex:dead", deadPid, "/x/p");
    controlled("codex:live", process.pid, "/x/p/linked");

    reconcileControlledSessions(store, "p", "2026-10-24T12:01:00.000Z");
    assert.deepEqual(store.listLiveControlledSessions("p").map((s) => s.session_id), ["codex:live"]);
    assert.equal(store.getLease("/x/p")?.owner_session_id, "codex:dead");
  } finally {
    store.close();
  }
});
