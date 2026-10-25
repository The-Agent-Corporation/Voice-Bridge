import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, test } from "node:test";
import type { SessionCapabilities } from "../adapters/types.js";
import { getMessage, MESSAGE_TTL_MS, planSend, submitMessage, type SendRequest } from "../messages.js";
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
  });

  afterEach(() => store.close());

  test("a sole connected session that can take a next turn gets the message queued for its dispatcher", () => {
    const receipt = submitMessage(store, request("k"), CONNECTED, session(true), clock);
    assert.equal(receipt.state, "queued");
    assert.equal(receipt.reason, "awaiting_delivery");
    assert.equal(receipt.session_id, "codex:s1");
    assert.deepEqual(receipt.transitions.map((t) => t.state), ["accepted", "queued"]);
  });

  test("a retry under the same key is a duplicate of the stored message", () => {
    const first = submitMessage(store, request("k"), CONNECTED, session(true), clock);
    const retry = submitMessage(store, request("k"), CONNECTED, session(true), clock);
    assert.equal(retry.duplicate, true);
    assert.equal(retry.message_id, first.message_id);
  });

  test("a second deliverable message to the same session waits behind the first", () => {
    submitMessage(store, request("first"), CONNECTED, session(true), clock);
    const receipt = submitMessage(store, request("second"), CONNECTED, session(true), clock);
    assert.equal(receipt.state, "queued");
    assert.equal(receipt.reason, "awaiting_earlier_messages");
  });

  test("a session without the next_turn capability is refused", () => {
    const receipt = submitMessage(store, request("k"), CONNECTED, session(false), clock);
    assert.equal(receipt.state, "failed");
    assert.equal(receipt.reason, "unsupported_capability");
  });

  test("a message behind an earlier queued one to the same session waits", () => {
    submitMessage(store, request("first", true), SAVED, session(false), clock);
    const receipt = submitMessage(store, request("second"), CONNECTED, session(true), clock);
    assert.equal(receipt.state, "queued");
    assert.equal(receipt.reason, "awaiting_earlier_messages");
  });

  test("a queued message reads as expired once its 24 hours have passed", () => {
    const { message_id, expires_at } = submitMessage(store, request("k", true), SAVED, session(false), clock);
    assert.equal(expires_at, new Date(NOW.getTime() + MESSAGE_TTL_MS).toISOString());
    assert.equal(getMessage(store, { message_id }, () => new Date(NOW.getTime() + MESSAGE_TTL_MS - 1)).state, "queued");
    const expired = getMessage(store, { message_id }, () => new Date(NOW.getTime() + MESSAGE_TTL_MS + 1));
    assert.equal(expired.state, "expired");
    assert.equal(expired.reason, "expired_unsent");
  });
});
