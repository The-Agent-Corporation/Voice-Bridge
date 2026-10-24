import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, test } from "node:test";
import type { AgentAdapter, SessionCapabilities } from "../adapters/types.js";
import { cancelMessage, getMessage, MESSAGE_TTL_MS, planSend, submitMessage, type SendRequest } from "../messages.js";
import type { PrimaryRoute } from "../primary.js";
import { openStore, type Store, type StoredSession } from "../store.js";
import { removeTempDirs, tempDir } from "./helpers.js";

after(removeTempDirs);

const NOW = new Date("2026-10-24T12:00:00.000Z");
const clock = () => NOW;

function route(fields: Partial<PrimaryRoute>): PrimaryRoute {
  return {
    primary_session_id: "codex:s1",
    connected_session_id: null,
    workspace_owner_session_id: null,
    route: "recent_saved_read_only",
    mutating_allowed: false,
    available: false,
    reason: "read-only",
    ...fields,
  };
}

const AMBIGUOUS = route({ route: "ambiguous", primary_session_id: null, reason: "two connected sessions" });
const SAVED = route({});
const CONNECTED = route({ route: "sole_connected", connected_session_id: "codex:s1", mutating_allowed: true, available: true });

describe("planSend", () => {
  const outcome = (r: PrimaryRoute, mode: "next_turn" | "steer", approveQueue: boolean, canSend: boolean) => {
    const decision = planSend(r, mode, approveQueue, canSend);
    return decision.deliverable ? "deliver" : `${decision.state}/${decision.reason}`;
  };

  test("a steer is refused for every route, even with approve_queue", () => {
    for (const r of [AMBIGUOUS, SAVED, CONNECTED]) {
      for (const approveQueue of [false, true]) {
        assert.equal(outcome(r, "steer", approveQueue, true), "failed/unsupported_capability");
      }
    }
  });

  test("an ambiguous owner is refused, or queued with approve_queue", () => {
    assert.equal(outcome(AMBIGUOUS, "next_turn", false, true), "failed/ambiguous_owner");
    assert.equal(outcome(AMBIGUOUS, "next_turn", true, true), "queued/awaiting_controllable_session");
  });

  test("a route that does not allow mutating is refused, or queued with approve_queue", () => {
    assert.equal(outcome(SAVED, "next_turn", false, true), "failed/not_controllable");
    assert.equal(outcome(SAVED, "next_turn", true, true), "queued/awaiting_controllable_session");
  });

  test("a controllable primary that cannot take a next turn is refused, or queued with approve_queue", () => {
    assert.equal(outcome(CONNECTED, "next_turn", false, false), "failed/unsupported_capability");
    assert.equal(outcome(CONNECTED, "next_turn", true, false), "queued/awaiting_controllable_session");
  });

  test("a controllable primary that can take a next turn is delivered to", () => {
    assert.equal(outcome(CONNECTED, "next_turn", false, true), "deliver");
  });
});

describe("submitMessage", () => {
  let store: Store;
  let calls: [string, string, string][];

  const capabilities = (nextTurn: boolean): SessionCapabilities => ({
    live_attach: false,
    next_turn: nextTurn,
    steer_active_turn: false,
    answer_pending_question: false,
    subscribe_events: false,
  });
  const session = (nextTurn: boolean): StoredSession => ({
    session_id: "codex:s1",
    provider: "codex",
    native_session_id: "s1",
    worktree_id: "/x/p",
    observed_state: "connected_idle",
    last_activity_at: null,
    capabilities: capabilities(nextTurn),
  });
  const adapter = (send: () => Promise<{ provider_ref: string }>): AgentAdapter => ({
    provider: "codex",
    discoverSessions: async () => ({ sessions: [], skipped_records: 0 }),
    async sendNextTurn(nativeSessionId, text, key) {
      calls.push([nativeSessionId, text, key]);
      return send();
    },
  });
  const accepting = () => adapter(async () => ({ provider_ref: "turn-1" }));
  const request = (key: string, approveQueue = false): SendRequest => ({
    project_id: "p",
    text: "run the tests",
    mode: "next_turn",
    idempotency_key: key,
    approve_queue: approveQueue,
  });

  beforeEach(() => {
    store = openStore(tempDir());
    store.upsert({ project_id: "p", display_name: "P", canonical_path: "/x/p" });
    calls = [];
  });

  afterEach(() => store.close());

  test("a sole connected session that can take a next turn is delivered to once", async () => {
    const receipt = await submitMessage(store, request("k"), CONNECTED, session(true), accepting(), clock);
    assert.deepEqual(calls, [["s1", "run the tests", "k"]]);
    assert.equal(receipt.state, "delivered");
    assert.equal(receipt.reason, "adapter_receipt");
    assert.equal(receipt.provider_ref, "turn-1");
    assert.deepEqual(receipt.transitions.map((t) => t.state), ["accepted", "queued", "delivering", "delivered"]);
  });

  test("a cancel or expiry during the adapter call cannot hide its outcome", async () => {
    let release!: () => void;
    const held = adapter(() => new Promise((resolve) => (release = () => resolve({ provider_ref: "turn-1" }))));
    const sending = submitMessage(store, request("k"), CONNECTED, session(true), held, clock);
    const { message_id } = store.findMessageByKey("k")!;
    const cancel = cancelMessage(store, { message_id }, clock);
    assert.equal(cancel.cancelled, false);
    assert.equal(cancel.state, "delivering");
    assert.equal(getMessage(store, { message_id }, () => new Date(NOW.getTime() + MESSAGE_TTL_MS + 1)).state, "delivering");
    release();
    const receipt = await sending;
    assert.equal(receipt.state, "delivered");
    assert.equal(receipt.provider_ref, "turn-1");
  });

  test("a retry under the same key during the adapter call is a duplicate and is not sent again", async () => {
    const pending: (() => void)[] = [];
    const held = adapter(() => new Promise((resolve) => pending.push(() => resolve({ provider_ref: "turn-1" }))));
    const first = submitMessage(store, request("k"), CONNECTED, session(true), held, clock);
    const retrying = submitMessage(store, request("k"), CONNECTED, session(true), held, clock);
    assert.equal(calls.length, 1);
    for (const release of pending) release();
    const [delivered, retry] = await Promise.all([first, retrying]);
    assert.equal(retry.duplicate, true);
    assert.equal(retry.state, "delivering");
    assert.equal(retry.message_id, delivered.message_id);
    assert.equal(delivered.state, "delivered");
  });

  test("a session without the next_turn capability is never called", async () => {
    const receipt = await submitMessage(store, request("k"), CONNECTED, session(false), accepting(), clock);
    assert.deepEqual(calls, []);
    assert.equal(receipt.state, "failed");
    assert.equal(receipt.reason, "unsupported_capability");
  });

  test("a message behind an earlier queued one waits and is not delivered", async () => {
    await submitMessage(store, request("first", true), SAVED, session(false), accepting(), clock);
    const receipt = await submitMessage(store, request("second"), CONNECTED, session(true), accepting(), clock);
    assert.deepEqual(calls, []);
    assert.equal(receipt.state, "queued");
    assert.equal(receipt.reason, "awaiting_earlier_messages");
  });

  test("a rejected delivery fails the message with the adapter's reason", async () => {
    const failing = adapter(async () => {
      throw new Error("session went away");
    });
    const receipt = await submitMessage(store, request("k"), CONNECTED, session(true), failing, clock);
    assert.equal(receipt.state, "failed");
    assert.equal(receipt.reason, "delivery_failed");
    assert.equal(receipt.detail, "session went away");
  });

  test("a queued message reads as expired once its 24 hours have passed", async () => {
    const { message_id, expires_at } = await submitMessage(store, request("k", true), SAVED, session(false), undefined, clock);
    assert.equal(expires_at, new Date(NOW.getTime() + MESSAGE_TTL_MS).toISOString());
    assert.equal(getMessage(store, { message_id }, () => new Date(NOW.getTime() + MESSAGE_TTL_MS - 1)).state, "queued");
    const expired = getMessage(store, { message_id }, () => new Date(NOW.getTime() + MESSAGE_TTL_MS + 1));
    assert.equal(expired.state, "expired");
    assert.equal(expired.reason, "expired_unsent");
  });
});
