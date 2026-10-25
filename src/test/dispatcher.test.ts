import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, test } from "node:test";
import { createDispatcher, TargetClosed, type NextTurnTarget } from "../dispatcher.js";
import { openStore, type NewMessage, type Store } from "../store.js";
import { removeTempDirs, tempDir } from "./helpers.js";

after(removeTempDirs);

const SESSION = "codex:t1";
const clock = () => new Date("2026-10-24T12:00:00.000Z");

describe("dispatcher", () => {
  let store: Store;
  let sent: string[];
  let replies: (() => Promise<{ provider_ref: string }>)[];
  let logged: string[];
  let fatal: unknown[];

  /** Answers each send with the next queued reply, or with turn `u<n>`. */
  const target: NextTurnTarget = {
    sendNextTurn(text) {
      sent.push(text);
      return replies.shift()?.() ?? Promise.resolve({ provider_ref: `u${sent.length}` });
    },
  };
  const dispatcher = () => createDispatcher({ store, sessionId: SESSION, target, clock, log: (line) => logged.push(line), onFatal: (error) => fatal.push(error) });
  const queue = (key: string, overrides: Partial<NewMessage> = {}) =>
    store.createMessage({
      message_id: `m-${key}`,
      project_id: "p",
      session_id: SESSION,
      mode: "next_turn",
      body: key,
      approve_queue: false,
      idempotency_key: key,
      decision: { deliverable: true },
      created_at: "2026-10-24T12:00:00.000Z",
      expires_at: "2026-10-25T12:00:00.000Z",
      ...overrides,
    });
  const states = (key: string) => store.getMessage(`m-${key}`)!.transitions.map((t) => t.state);
  const stateOf = (key: string) => {
    const message = store.getMessage(`m-${key}`)!;
    return `${message.state}/${message.reason}`;
  };

  beforeEach(() => {
    store = openStore(tempDir());
    store.upsert({ project_id: "p", display_name: "P", canonical_path: "/x/p" });
    sent = [];
    replies = [];
    logged = [];
    fatal = [];
  });

  afterEach(() => store.close());

  test("delivers in sequence order, one turn at a time, only while idle", async () => {
    queue("a");
    queue("b");
    const d = dispatcher();
    await d.kick();
    assert.deepEqual(sent, ["a"]);
    d.turnStarted("u1");
    assert.equal(d.state, "connected_running");
    await d.kick();
    assert.deepEqual(sent, ["a"]);
    assert.equal(stateOf("b"), "queued/awaiting_earlier_messages");

    d.turnCompleted("u1", "completed", null);
    await d.kick();
    assert.deepEqual(sent, ["a", "b"]);
    assert.deepEqual(states("a"), ["accepted", "queued", "delivering", "delivered", "started", "completed"]);
    assert.equal(store.getMessage("m-a")!.provider_ref, "u1");
    assert.equal(stateOf("b"), "delivered/adapter_receipt");
  });

  test("turn events that arrive before the turn/start answer are applied once it names the turn", async () => {
    queue("a");
    queue("b");
    const d = dispatcher();
    let answer!: () => void;
    replies.push(() => new Promise((resolve) => (answer = () => resolve({ provider_ref: "u1" }))));
    const kicked = d.kick();
    d.turnStarted("u1");
    d.turnCompleted("u1", "completed", null);
    answer();
    await kicked;
    assert.deepEqual(states("a"), ["accepted", "queued", "delivering", "delivered", "started", "completed"]);
    assert.deepEqual(sent, ["a", "b"]);
  });

  test("a turn that completes without turn/started goes from delivered to completed; other statuses fail it", async () => {
    queue("a");
    queue("b");
    const d = dispatcher();
    await d.kick();
    d.turnCompleted("u1", "completed", null);
    await d.kick();
    assert.deepEqual(states("a"), ["accepted", "queued", "delivering", "delivered", "completed"]);
    d.turnStarted("u2");
    d.turnCompleted("u2", "failed", "model unavailable");
    assert.equal(stateOf("b"), "failed/turn_failed");
    assert.match(store.getMessage("m-b")!.detail, /failed: model unavailable/);
  });

  test("a refused turn/start fails that message and the next one still goes", async () => {
    queue("a");
    queue("b");
    replies.push(() => Promise.reject(new Error("invalid params")));
    await dispatcher().kick();
    assert.equal(stateOf("a"), "failed/delivery_failed");
    assert.equal(store.getMessage("m-a")!.detail, "invalid params");
    assert.deepEqual(sent, ["a", "b"]);
  });

  test("a closed provider leaves the message delivering for the session's end to judge", async () => {
    queue("a");
    replies.push(() => Promise.reject(new TargetClosed("gone")));
    await dispatcher().kick();
    assert.equal(stateOf("a"), "delivering/handed_to_adapter");
  });

  test("a cancelled message is skipped and a message left delivering is never sent again", async () => {
    queue("stuck");
    store.transitionMessage("m-stuck", "queued", { state: "delivering", reason: "handed_to_adapter", detail: "crashed" }, "2026-10-24T12:00:00.000Z");
    queue("cancelled");
    store.transitionMessage("m-cancelled", "queued", { state: "cancelled", reason: "cancelled_by_user", detail: "x" }, "2026-10-24T12:00:00.000Z");
    queue("c");
    await dispatcher().kick();
    assert.deepEqual(sent, ["c"]);
    assert.equal(stateOf("stuck"), "delivering/handed_to_adapter");
  });

  test("a head message queued for another reason blocks later ones and is not sent", async () => {
    queue("approved", { decision: { deliverable: false, state: "queued", reason: "awaiting_controllable_session", detail: "x" } });
    queue("b");
    const d = dispatcher();
    await d.kick();
    await d.kick();
    assert.deepEqual(sent, []);
    assert.equal(logged.filter((line) => line.includes("m-approved")).length, 1);
  });

  test("a provider request makes the session waiting_user, and nothing is sent until the turn completes", async () => {
    queue("a");
    queue("b");
    const d = dispatcher();
    await d.kick();
    d.turnStarted("u1");
    d.serverRequest("item/commandExecution/requestApproval");
    assert.equal(d.state, "waiting_user");
    await d.kick();
    assert.deepEqual(sent, ["a"]);
    d.turnCompleted("u1", "completed", null);
    await d.kick();
    assert.deepEqual(sent, ["a", "b"]);
  });

  test("events for a turn no message started are ignored", async () => {
    queue("a");
    const d = dispatcher();
    await d.kick();
    d.turnCompleted("u-other", "completed", null);
    assert.equal(stateOf("a"), "delivered/adapter_receipt");
    assert.ok(logged.some((line) => line.includes("u-other")));
  });

  test("a store failure on a provider event stops the dispatcher and reaches onFatal instead of throwing", async () => {
    queue("a");
    queue("b");
    const d = dispatcher();
    await d.kick();
    const broken = new Error("SQLITE_BUSY: database is locked");
    store.transitionMessage = () => {
      throw broken;
    };
    d.turnStarted("u1");
    d.turnCompleted("u1", "completed", null);
    await d.kick();
    assert.deepEqual(fatal, [broken]);
    assert.deepEqual(sent, ["a"]);
  });

  test("a store failure in the pass a completed turn starts reaches onFatal, not an unhandled rejection", async () => {
    queue("a");
    queue("b");
    const d = dispatcher();
    await d.kick();
    const broken = new Error("SQLITE_BUSY: database is locked");
    store.expireMessages = () => {
      throw broken;
    };
    d.turnCompleted("u1", "completed", null);
    await d.kick();
    assert.deepEqual(fatal, [broken]);
    assert.deepEqual(sent, ["a"]);
  });

  test("after stop nothing is picked or recorded", async () => {
    queue("a");
    const d = dispatcher();
    d.stop();
    await d.kick();
    assert.deepEqual(sent, []);
    assert.equal(stateOf("a"), "queued/awaiting_delivery");
  });
});
