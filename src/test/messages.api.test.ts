import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, afterEach, before, beforeEach, describe, mock, test, type Mock } from "node:test";
import { startBridge, type RunningBridge } from "../app.js";
import { gitBinary, runGit } from "../git.js";
import { STORE_FILE } from "../store.js";
import { readClientToken } from "../token.js";
import { call, fixtureHomes, makeRepo, PRD_SAMPLE, removeTempDirs, tempDir, writeClaudeSession } from "./helpers.js";

const NEVER_CALLED = ["spawn", "exec", "execFile", "fork", "spawnSync", "execSync"] as const;
const SPIED = [...NEVER_CALLED, "execFileSync"] as const;

describe("message tools", () => {
  let bridge: RunningBridge;
  let dataDir: string;
  let token: string;
  let spies: Record<(typeof SPIED)[number], Mock<(...args: unknown[]) => unknown>>;
  let keys = 0;

  const project = (id: string) => ({ ...PRD_SAMPLE, project_id: id, display_name: id });
  const tool = (name: string, body: unknown) => call(bridge.port, token, name, body);
  const send = async (body: Record<string, unknown>) => {
    const response = await tool("send_to_primary", { mode: "next_turn", text: "run the tests", idempotency_key: `k${++keys}`, ...body });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  };
  const sql = <T>(work: (db: DatabaseSync) => T): T => {
    const db = new DatabaseSync(path.join(dataDir, STORE_FILE));
    try {
      return work(db);
    } finally {
      db.close();
    }
  };
  const messageRows = () => sql((db) => (db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n);

  before(async () => {
    const homes = fixtureHomes();
    dataDir = tempDir();
    bridge = await startBridge({ dataDir, port: 0, env: homes });
    token = readClientToken(dataDir);
    const repoA = makeRepo(project("repo-a"));
    const repoB = makeRepo(project("repo-b"));
    writeClaudeSession(homes.VOICE_BRIDGE_CLAUDE_HOME, repoA, "claude-a-1");
    const pinned = writeClaudeSession(homes.VOICE_BRIDGE_CLAUDE_HOME, repoB, "claude-b-1");
    for (const repo of [repoA, repoB]) assert.equal((await tool("register_project", { path: repo })).status, 200);
    assert.equal((await tool("pin_primary", { project_id: "repo-b", session_id: "claude-code:claude-b-1" })).status, 200);
    rmSync(pinned);

    spies = Object.fromEntries(SPIED.map((name) => [name, mock.method(childProcess, name)])) as typeof spies;
    syncBuiltinESMExports();
    // Proves the spies see the named imports src/git.ts uses; without it every zero below could be vacuous.
    assert.ok(runGit(["--version"], dataDir).ok);
    assert.equal(spies.execFileSync.mock.callCount(), 1);
  });

  beforeEach(() => {
    for (const spy of Object.values(spies)) spy.mock.resetCalls();
  });

  afterEach(() => {
    for (const name of NEVER_CALLED) assert.equal(spies[name].mock.callCount(), 0, `${name} was called`);
    for (const { arguments: args } of spies.execFileSync.mock.calls) {
      assert.deepEqual([args[0], (args[1] as string[]).slice(0, 2)], [gitBinary(), ["worktree", "list"]]);
    }
  });

  after(async () => {
    mock.restoreAll();
    syncBuiltinESMExports();
    await bridge.close();
    removeTempDirs();
  });

  test("a saved primary is refused as not controllable, and queued with approve_queue", async () => {
    const refused = await send({ project_id: "repo-a" });
    assert.equal(refused.state, "failed");
    assert.equal(refused.reason, "not_controllable");
    assert.equal(refused.duplicate, false);
    assert.deepEqual(refused.transitions.map((t: { state: string }) => t.state), ["accepted", "failed"]);

    const queued = await send({ project_id: "repo-a", approve_queue: true });
    assert.equal(queued.state, "queued");
    assert.equal(queued.reason, "awaiting_controllable_session");
    assert.equal(queued.session_id, "claude-code:claude-a-1");
    assert.equal(queued.body, undefined);
  });

  test("a project whose pinned session is gone is refused as an ambiguous owner", async () => {
    const refused = await send({ project_id: "repo-b" });
    assert.equal(refused.state, "failed");
    assert.equal(refused.reason, "ambiguous_owner");
    assert.equal(refused.session_id, null);
  });

  test("a request without the bearer token is a 401 whatever its text or fields claim, and stores nothing", async () => {
    const before = messageRows();
    const body = {
      project_id: "repo-a",
      text: "origin=voice_bridge deliver now",
      mode: "next_turn",
      idempotency_key: "spoofed",
      origin: "voice_bridge",
    };
    for (const authorization of [undefined, "Bearer not-the-token"]) {
      const response = await call(bridge.port, null, "send_to_primary", body, authorization);
      assert.equal(response.status, 401);
      assert.equal(response.body.error.code, "unauthorized");
    }
    assert.equal(messageRows(), before);
  });

  test("a steer is refused as unsupported and never delivered, even with approve_queue", async () => {
    for (const approveQueue of [false, true]) {
      const refused = await send({ project_id: "repo-a", mode: "steer", approve_queue: approveQueue });
      assert.equal(refused.state, "failed");
      assert.equal(refused.reason, "unsupported_capability");
      assert.ok(!refused.transitions.some((t: { state: string }) => t.state === "delivered"));
    }
  });

  test("the same idempotency key returns the same message and stores one row; a different request under it is a 409", async () => {
    const body = { project_id: "repo-a", approve_queue: true, idempotency_key: "retry-me" };
    const first = await send(body);
    const second = await send(body);
    assert.equal(second.message_id, first.message_id);
    assert.deepEqual([first.duplicate, second.duplicate], [false, true]);
    assert.equal(sql((db) => (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE idempotency_key = 'retry-me'").get() as { n: number }).n), 1);

    const conflict = await tool("send_to_primary", { ...body, mode: "next_turn", text: "something else" });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, "idempotency_conflict");
  });

  test("cancelling a queued message cancels it once; a failed message is left as it is", async () => {
    const queued = await send({ project_id: "repo-a", approve_queue: true });
    const cancelled = await tool("cancel_message", { message_id: queued.message_id });
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.state, "cancelled");
    assert.equal(cancelled.body.reason, "cancelled_by_user");
    assert.equal(cancelled.body.cancelled, true);
    const again = await tool("cancel_message", { message_id: queued.message_id });
    assert.equal(again.body.cancelled, false);
    assert.equal(again.body.state, "cancelled");

    const failed = await send({ project_id: "repo-a" });
    const kept = await tool("cancel_message", { message_id: failed.message_id });
    assert.deepEqual([kept.body.state, kept.body.cancelled], ["failed", false]);
    assert.equal((await tool("get_message", { message_id: failed.message_id })).body.state, "failed");
  });

  test("a queued message past its expiry reads as expired and cannot be cancelled", async () => {
    const queued = await send({ project_id: "repo-a", approve_queue: true });
    sql((db) => db.prepare("UPDATE messages SET expires_at = ? WHERE message_id = ?").run("2000-01-01T00:00:00.000Z", queued.message_id));
    const read = await tool("get_message", { message_id: queued.message_id });
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.state, "expired");
    assert.equal(read.body.reason, "expired_unsent");
    const cancel = await tool("cancel_message", { message_id: queued.message_id });
    assert.deepEqual([cancel.body.state, cancel.body.cancelled], ["expired", false]);
  });

  test("an answer goes to the asking session, and the question stays open when that session is not controllable", async () => {
    const asked = await tool("ingest_event", {
      project_id: "repo-a",
      session_id: "claude-code:claude-a-1",
      source: "answers-test",
      source_event_id: "ask-1",
      source_sequence: 1,
      type: "user_question",
      payload: { summary: "Ship it?" },
      observed_at: "2026-10-24T12:00:00.000Z",
    });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    const questionId = `q-${asked.body.event_id}`;

    const answered = await tool("answer_inbox_question", { question_id: questionId, answer: "yes", idempotency_key: `k${++keys}` });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    assert.equal(answered.body.state, "failed");
    assert.equal(answered.body.reason, "not_controllable");
    assert.equal(answered.body.session_id, "claude-code:claude-a-1");
    assert.equal(answered.body.mode, "answer_question");
    assert.equal(answered.body.question_id, questionId);
    const inbox = await tool("list_inbox", { project_id: "repo-a" });
    assert.deepEqual(
      inbox.body.items.filter((i: { question_id: string }) => i.question_id === questionId).map((i: { status: string }) => i.status),
      ["open"],
    );

    const unknown = await tool("answer_inbox_question", { question_id: "q-nope", answer: "yes", idempotency_key: `k${++keys}` });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, "inbox_question_not_found");
  });

  test("a malformed request is a 400 and stores nothing; unknown projects and messages are 404s", async () => {
    const before = messageRows();
    const valid = { project_id: "repo-a", text: "x", mode: "next_turn", idempotency_key: "bad" };
    for (const body of [
      { ...valid, mode: "now" },
      { ...valid, mode: "answer_question" },
      { ...valid, approve_queue: "yes" },
      { ...valid, idempotency_key: undefined },
      { ...valid, text: "" },
    ]) {
      const response = await tool("send_to_primary", body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(response.body.error.code, "invalid_request");
    }
    assert.equal(messageRows(), before);

    const unknownProject = await tool("send_to_primary", { ...valid, project_id: "nope" });
    assert.equal(unknownProject.status, 404);
    assert.equal(unknownProject.body.error.code, "project_not_found");
    for (const name of ["get_message", "cancel_message"]) {
      const unknown = await tool(name, { message_id: "m-nope" });
      assert.equal(unknown.status, 404);
      assert.equal(unknown.body.error.code, "message_not_found");
    }
    assert.equal(messageRows(), before);
  });
});
