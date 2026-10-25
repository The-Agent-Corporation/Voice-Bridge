import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { after, afterEach, beforeEach, describe, test } from "node:test";
import { resolveProviderHomes, type ProviderHomes } from "../adapters/homes.js";
import type { ObservedState } from "../adapters/types.js";
import { createDispatcher, type NextTurnTarget } from "../dispatcher.js";
import { questionFields } from "../inbox.js";
import { answerInboxQuestion, cancelMessage, getMessage, MESSAGE_TTL_MS, submitMessage, type SendRequest } from "../messages.js";
import { resolveOrigin } from "../primary.js";
import { openStore, STORE_FILE, type InboxItem, type NewEvent, type Store, type StoredSession } from "../store.js";
import { fixtureHomes, makeRepo, PRD_SAMPLE, removeTempDirs, tempDir, writeClaudeSession } from "./helpers.js";

after(removeTempDirs);

const NOW = new Date("2026-10-24T12:00:00.000Z");
const clock = () => NOW;
const SA = "codex:sa";
const SB = "codex:sb";

let store: Store;
let dataDir: string;
let sequence = 0;

function ingest(projectId: string, sessionId: string | null, type: "user_question" | "agent_ack", payload: object) {
  sequence++;
  const event: NewEvent = {
    project_id: projectId,
    session_id: sessionId,
    source: "hook",
    source_event_id: `hook-${sequence}`,
    source_sequence: sequence,
    type,
    payload: JSON.stringify(payload),
    observed_at: new Date(NOW.getTime() + sequence * 1000).toISOString(),
  };
  const question = type === "user_question" ? questionFields(payload) : undefined;
  const acked = type === "agent_ack" ? (payload as { question_id: string }).question_id : undefined;
  return { event, ...store.ingestEvent(event, question, acked) };
}

/** Asks a question from `sessionId` in `projectId`; returns its inbox id. */
function ask(projectId: string, sessionId: string | null, payload: object = { summary: "Ship it?" }): string {
  return `q-${ingest(projectId, sessionId, "user_question", payload).event_id}`;
}

const ack = (sessionId: string | null, questionId: string, projectId = "a") =>
  ingest(projectId, sessionId, "agent_ack", { question_id: questionId });

const item = (questionId: string): InboxItem => store.getInboxItem(questionId)!;
const messageCount = () => {
  const db = new DatabaseSync(path.join(dataDir, STORE_FILE));
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
  } finally {
    db.close();
  }
};

function session(sessionId: string, observedState: ObservedState = "connected_idle", worktree = "/x/a"): StoredSession {
  return {
    session_id: sessionId,
    provider: "codex",
    native_session_id: sessionId.slice("codex:".length),
    worktree_id: worktree,
    observed_state: observedState,
    last_activity_at: null,
    capabilities: { live_attach: false, next_turn: true, steer_active_turn: false, answer_pending_question: false, subscribe_events: false },
  };
}

beforeEach(() => {
  dataDir = tempDir();
  store = openStore(dataDir);
  sequence = 0;
  for (const id of ["a", "b"]) store.upsert({ project_id: id, display_name: id, canonical_path: `/x/${id}` });
});

afterEach(() => store.close());

describe("resolveOrigin", () => {
  test("names the asking session whether or not it may be sent to", () => {
    const cases: [StoredSession[], boolean][] = [
      [[], false],
      [[session(SA, "saved")], false],
      [[session(SA), session(SB)], false],
      [[session(SA), session(SB, "unknown")], false],
      [[session(SA), session(SB, "connected_idle", "/x/other")], true],
    ];
    for (const [sessions, mutating] of cases) {
      const route = resolveOrigin(sessions, SA);
      assert.equal(route.primary_session_id, SA);
      assert.equal(route.route, "origin");
      assert.equal(route.mutating_allowed, mutating, route.reason);
    }
  });
});

describe("answer delivery and acknowledgement", () => {
  let calls: string[];
  let release: (() => void) | undefined;

  const target = (send: () => Promise<{ provider_ref: string }>): NextTurnTarget => ({
    sendNextTurn(text) {
      calls.push(text);
      return send();
    },
  });
  const accepting = target(async () => ({ provider_ref: "turn-1" }));
  const holding = target(() => new Promise((resolve) => (release = () => resolve({ provider_ref: "turn-1" }))));
  const failing = target(async () => {
    throw new Error("session went away");
  });
  /** The asking session's host delivering what is queued for it, as src/sessionHost.ts does. */
  const deliver = (sessionId: string, via: NextTurnTarget) =>
    createDispatcher({ store, sessionId, target: via, clock, log: () => {}, onFatal: (error) => assert.fail(String(error)) }).kick();

  const request = (questionId: string, key = "k", approveQueue = false): SendRequest => ({
    project_id: "a",
    text: `Answer to your question ${questionId}: yes`,
    mode: "answer_question",
    question_id: questionId,
    idempotency_key: key,
    approve_queue: approveQueue,
  });
  const answer = (questionId: string, origin: StoredSession, approveQueue = false) =>
    submitMessage(store, request(questionId, "k", approveQueue), resolveOrigin([origin], origin.session_id), origin, clock);
  const current = (messageId: string) => store.getMessage(messageId)!;

  beforeEach(() => {
    calls = [];
    release = undefined;
  });

  test("an answer is queued for the asking session, its receipt makes the question delivered, and only that session's ack resolves it", async () => {
    const qa = ask("a", SA);
    const queued = answer(qa, session(SA));
    assert.equal(queued.state, "queued");
    assert.equal(queued.session_id, SA);
    assert.equal(queued.mode, "answer_question");
    assert.equal(queued.question_id, qa);
    assert.equal(item(qa).status, "answer_queued");
    assert.equal(item(qa).resolution_message_id, queued.message_id);

    await deliver(SB, accepting);
    assert.deepEqual(calls, []);
    await deliver(SA, accepting);
    assert.deepEqual(calls, [`Answer to your question ${qa}: yes`]);
    assert.equal(current(queued.message_id).state, "delivered");
    assert.equal(item(qa).status, "delivered");

    ack(SB, qa);
    ack(null, qa);
    ack(SA, qa, "b");
    assert.equal(item(qa).status, "delivered");

    const { event } = ack(SA, qa);
    assert.equal(item(qa).status, "resolved");
    const message = current(queued.message_id);
    assert.equal(message.state, "acknowledged");
    assert.equal(message.reason, "agent_ack");

    assert.equal(store.ingestEvent(event, undefined, qa).duplicate, true);
    assert.equal(item(qa).status, "resolved");
    assert.equal(current(queued.message_id).transitions.length, message.transitions.length);
  });

  test("an ack that arrives before the delivery receipt resolves the question once the receipt lands", async () => {
    const qa = ask("a", SA);
    const queued = answer(qa, session(SA));
    const sending = deliver(SA, holding);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(current(queued.message_id).state, "delivering");
    ack(SA, qa);
    assert.equal(item(qa).status, "acknowledged");
    release!();
    await sending;
    assert.equal(item(qa).status, "resolved");
    const message = current(queued.message_id);
    assert.equal(message.state, "acknowledged");
    assert.deepEqual(message.transitions.map((t) => t.state), ["accepted", "queued", "delivering", "delivered", "acknowledged"]);
  });

  test("a failed delivery reopens the question so it can be answered again", async () => {
    const qa = ask("a", SA);
    const queued = answer(qa, session(SA));
    await deliver(SA, failing);
    assert.equal(current(queued.message_id).state, "failed");
    assert.equal(item(qa).status, "open");
    assert.equal(item(qa).resolution_message_id, null);
  });

  test("a queued answer that is cancelled or expires reopens the question", () => {
    const saved = session(SA, "saved");
    const qa = ask("a", SA);
    const queued = answer(qa, saved, true);
    assert.equal(queued.reason, "awaiting_controllable_session");
    assert.equal(item(qa).status, "answer_queued");
    ack(SA, qa);
    assert.equal(item(qa).status, "answer_queued");
    cancelMessage(store, { message_id: queued.message_id }, clock);
    assert.deepEqual([item(qa).status, item(qa).resolution_message_id], ["open", null]);

    const again = submitMessage(store, request(qa, "k2", true), resolveOrigin([saved], SA), saved, clock);
    assert.equal(item(qa).resolution_message_id, again.message_id);
    getMessage(store, { message_id: again.message_id }, () => new Date(NOW.getTime() + MESSAGE_TTL_MS + 1));
    assert.deepEqual([item(qa).status, item(qa).resolution_message_id], ["open", null]);
  });

  test("a session that is not controllable is refused without approve_queue and the question stays open", () => {
    const qa = ask("a", SA);
    const receipt = answer(qa, session(SA, "saved"));
    assert.equal(receipt.state, "failed");
    assert.equal(receipt.reason, "not_controllable");
    assert.equal(receipt.session_id, SA);
    assert.deepEqual([item(qa).status, item(qa).resolution_message_id], ["open", null]);
  });

  test("a question that is no longer open cannot be answered and nothing is stored", () => {
    const qa = ask("a", SA);
    store.dismissInboxQuestion(qa);
    assert.throws(() => answer(qa, session(SA)), { code: "inbox_question_not_open" });
    assert.equal(store.findMessageByKey("k"), undefined);
  });
});

describe("answerInboxQuestion", () => {
  let homes: ProviderHomes;
  let repoA: string;

  const answer = (body: Record<string, unknown>) => answerInboxQuestion(store, { answer: "yes", idempotency_key: "k", ...body }, homes);

  beforeEach(() => {
    const env = fixtureHomes();
    homes = resolveProviderHomes(env);
    repoA = makeRepo({ ...PRD_SAMPLE, project_id: "repo-a" });
    writeClaudeSession(env.VOICE_BRIDGE_CLAUDE_HOME, repoA, "claude-a-1");
    store.upsert({ project_id: "repo-a", display_name: "A", canonical_path: repoA });
  });

  test("an answer goes to the asking session only and leaves every other question unchanged", async () => {
    const qa = ask("repo-a", "claude-code:claude-a-1", { question_id: "theirs", summary: "Ship it?" });
    const qb = ask("b", SB);
    const before = item(qb);
    const receipt = await answer({ question_id: qa });
    assert.equal(messageCount(), 1);
    assert.equal(receipt.session_id, "claude-code:claude-a-1");
    assert.equal(receipt.project_id, "repo-a");
    assert.equal(receipt.mode, "answer_question");
    assert.equal(receipt.question_id, qa);
    assert.equal(receipt.reason, "not_controllable");
    assert.equal(store.findMessageByKey("k")!.body, `Answer to your question ${qa} (your id theirs): yes`);
    assert.deepEqual(item(qb), before);
  });

  test("the same idempotency key twice stores one message, and another answer under it conflicts", async () => {
    const qa = ask("repo-a", "claude-code:claude-a-1");
    const first = await answer({ question_id: qa, approve_queue: true });
    const second = await answer({ question_id: qa, approve_queue: true });
    assert.equal(second.duplicate, true);
    assert.equal(second.message_id, first.message_id);
    assert.equal(messageCount(), 1);
    await assert.rejects(answer({ question_id: qa, approve_queue: true, answer: "no" }), { code: "idempotency_conflict" });
  });

  test("an approval is refused as unsupported and nothing is sent or stored", async () => {
    const qa = ask("repo-a", "claude-code:claude-a-1", { summary: "Run the migration?", type: "approval" });
    for (const approveQueue of [false, true]) {
      await assert.rejects(answer({ question_id: qa, approve_queue: approveQueue }), { code: "unsupported_capability" });
    }
    assert.equal(messageCount(), 0);
    assert.deepEqual([item(qa).status, item(qa).resolution_message_id], ["open", null]);
  });

  test("a question with no asking session or no open status is refused before anything is stored", async () => {
    const orphan = ask("repo-a", null);
    await assert.rejects(answer({ question_id: orphan }), { code: "no_origin_session" });
    const dismissed = ask("repo-a", "claude-code:claude-a-1");
    store.dismissInboxQuestion(dismissed);
    await assert.rejects(answer({ question_id: dismissed }), { code: "inbox_question_not_open" });
    await assert.rejects(answer({ question_id: "q-999" }), { code: "inbox_question_not_found" });
    assert.equal(messageCount(), 0);
  });
});
