import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { loadBriefingState, renderBriefing } from "../briefing.js";
import { questionFields } from "../inbox.js";
import { openStore, type NewEvent, type QuestionFields, type Store } from "../store.js";
import { removeTempDirs, tempDir } from "./helpers.js";

after(removeTempDirs);

let store: Store;
let sequence = 0;

beforeEach(() => {
  store?.close();
  store = openStore(tempDir());
  sequence = 0;
  for (const id of ["a", "b"]) store.upsert({ project_id: id, display_name: id, canonical_path: `/x/${id}` });
});

after(() => store.close());

/** Ingests one `user_question` observed `second` seconds after noon; returns its event_id. */
function ask(payload: Record<string, unknown>, { second = 0, session = "s1" as string | null, project = "a" } = {}): number {
  sequence++;
  const event: NewEvent = {
    project_id: project,
    session_id: session,
    source: "hook",
    source_event_id: `hook-${sequence}`,
    source_sequence: sequence,
    type: "user_question",
    payload: JSON.stringify(payload),
    observed_at: new Date(Date.UTC(2026, 9, 24, 12, 0, second)).toISOString(),
  };
  return store.ingestEvent(event, questionFields(payload)).event_id;
}

const items = () => store.listInbox({});
const notificationCount = () => store.listInboxNotifications().length;

test("an update older than the item's newest event leaves the item unchanged", () => {
  const first = ask({ question_id: "q", summary: "first" }, { second: 1 });
  ask({ question_id: "q", summary: "newest" }, { second: 5 });
  ask({ question_id: "q", summary: "late" }, { second: 3 });
  assert.equal(items().length, 1);
  assert.equal(items()[0]!.question_id, `q-${first}`);
  assert.equal(items()[0]!.summary, "newest");
  assert.equal(items()[0]!.updated_at, "2026-10-24T12:00:05.000Z");
});

test("a withdrawal seen first leaves an obsolete placeholder the late original cannot reopen or notify", () => {
  ask({ question_id: "q", withdrawn: true }, { second: 5 });
  assert.deepEqual(items().map((item) => item.status), ["obsolete"]);
  assert.equal(notificationCount(), 0);
  ask({ question_id: "q", summary: "original" }, { second: 1 });
  assert.deepEqual(items().map((item) => item.status), ["obsolete"]);
  assert.equal(notificationCount(), 0);
});

test("withdrawn: true makes an open item obsolete and notifies nothing", () => {
  ask({ question_id: "q", summary: "ask" }, { second: 1 });
  ask({ question_id: "q", withdrawn: true }, { second: 2 });
  assert.equal(items()[0]!.status, "obsolete");
  assert.equal(items()[0]!.summary, "ask");
  assert.equal(notificationCount(), 1);
});

test("a dismissed item asked again stays cancelled, takes the new summary and does not notify", () => {
  const id = ask({ question_id: "q", summary: "old" }, { second: 1 });
  const dismissed = store.dismissInboxQuestion(`q-${id}`)!;
  assert.equal(dismissed.dismissed, true);
  ask({ question_id: "q", summary: "new" }, { second: 2 });
  assert.equal(items()[0]!.status, "cancelled");
  assert.equal(items()[0]!.summary, "new");
  assert.equal(items()[0]!.dismissed_at, dismissed.item.dismissed_at);
  assert.equal(notificationCount(), 1);
});

test("a field an update leaves out keeps its last known value", () => {
  ask({ question_id: "q", summary: "ask", type: "choice", priority: "high" }, { second: 1 });
  ask({ question_id: "q", priority: "low" }, { second: 2 });
  assert.deepEqual(
    items().map(({ summary, type, priority }) => ({ summary, type, priority })),
    [{ summary: "ask", type: "choice", priority: "low" }],
  );
});

test("questions without a question_id each stand alone, and withdrawing one without an id creates nothing", () => {
  ask({ summary: "one" }, { second: 1 });
  ask({ summary: "one" }, { second: 2 });
  ask({ withdrawn: true }, { second: 3 });
  assert.equal(items().length, 2);
  assert.equal(notificationCount(), 2);
});

test("identity is project, session and question_id; a null session is one identity", () => {
  ask({ question_id: "q" }, { session: "s1" });
  ask({ question_id: "q" }, { session: "s2" });
  ask({ question_id: "q" }, { project: "b" });
  ask({ question_id: "q" }, { session: null, second: 1 });
  ask({ question_id: "q" }, { session: null, second: 2 });
  assert.deepEqual(
    items().map((item) => `${item.project_id}/${item.origin_session_id}`).sort(),
    ["a/null", "a/s1", "a/s2", "b/s1"],
  );
});

test("a user_question rejected as event_conflict leaves no inbox item", () => {
  ask({ question_id: "q", summary: "kept" });
  const conflicting: NewEvent = {
    project_id: "a",
    session_id: "s1",
    source: "hook",
    source_event_id: "fresh",
    source_sequence: sequence,
    type: "user_question",
    payload: "{}",
    observed_at: "2026-10-24T13:00:00.000Z",
  };
  assert.throws(() => store.ingestEvent(conflicting, questionFields({ question_id: "other" })), { code: "event_conflict" });
  assert.deepEqual(items().map((item) => item.origin_question_id), ["q"]);
});

test("questionFields counts a mistyped field as absent", () => {
  const none: QuestionFields = { origin_question_id: null, summary: null, type: null, priority: null, withdrawn: false };
  assert.deepEqual(questionFields({ question_id: 7, summary: ["x"], type: {}, priority: 1, withdrawn: "true" }), none);
  for (const payload of [null, "text", 3, ["question_id"]]) assert.deepEqual(questionFields(payload), none);
  assert.deepEqual(questionFields({ question_id: "", summary: "s", type: "t", priority: "p", withdrawn: true }), {
    origin_question_id: "",
    summary: "s",
    type: "t",
    priority: "p",
    withdrawn: true,
  });
});

test("the inbox and the briefing give the same events the same question ids", () => {
  ask({ question_id: "q", summary: "first" }, { second: 1 });
  ask({ question_id: "q", summary: "reworded" }, { second: 2 });
  ask({ question_id: "q", summary: "other session" }, { second: 3, session: "s2" });
  ask({ question_id: "q", summary: "no session" }, { second: 4, session: null });
  ask({ summary: "no origin id" }, { second: 5 });
  ask({ summary: "no origin id again" }, { second: 6 });
  ask({ question_id: "gone", summary: "withdraw me" }, { second: 7 });
  ask({ question_id: "gone", withdrawn: true }, { second: 8 });

  const text = renderBriefing(loadBriefingState(store, { project_id: "a", display_name: "a" }), {
    maxTokens: 2000,
    generatedAt: "2026-10-24T12:00:00.000Z",
  });
  const briefingIds = [...text.matchAll(/^- (q-\d+): /gm)].map((match) => match[1]).sort();
  const inboxIds = store.listInbox({ project_id: "a", status: "open" }).map((item) => item.question_id).sort();
  assert.equal(inboxIds.length, 5);
  assert.deepEqual(briefingIds, inboxIds);
});

test("a withdrawal observed before the item's newest event still makes it obsolete, keeping the newer fields", () => {
  ask({ question_id: "q", summary: "first" }, { second: 1 });
  ask({ question_id: "q", summary: "newest" }, { second: 5 });
  ask({ question_id: "q", withdrawn: true, summary: "late" }, { second: 3 });
  assert.deepEqual(
    items().map(({ status, summary, updated_at }) => ({ status, summary, updated_at })),
    [{ status: "obsolete", summary: "newest", updated_at: "2026-10-24T12:00:05.000Z" }],
  );
  assert.equal(notificationCount(), 1);
});

test("withdrawing a dismissed question leaves it cancelled with its dismissal", () => {
  const id = ask({ question_id: "q", summary: "ask" }, { second: 1 });
  const dismissed = store.dismissInboxQuestion(`q-${id}`)!;
  ask({ question_id: "q", withdrawn: true }, { second: 2 });
  assert.deepEqual(
    items().map(({ status, dismissed_at }) => ({ status, dismissed_at })),
    [{ status: "cancelled", dismissed_at: dismissed.item.dismissed_at }],
  );
  assert.equal(notificationCount(), 1);
});

test("dismissing a withdrawn question leaves it obsolete with no dismissal", () => {
  const id = ask({ question_id: "q", summary: "ask" }, { second: 1 });
  ask({ question_id: "q", withdrawn: true }, { second: 2 });
  const result = store.dismissInboxQuestion(`q-${id}`)!;
  assert.equal(result.dismissed, false);
  assert.equal(result.item.status, "obsolete");
  assert.equal(result.item.dismissed_at, null);
  assert.deepEqual(items().map(({ status, dismissed_at }) => ({ status, dismissed_at })), [{ status: "obsolete", dismissed_at: null }]);
});

test("a question first asked before the inbox existed keeps the briefing's id when its agent asks again", () => {
  sequence++;
  const before = store.ingestEvent({
    project_id: "a",
    session_id: "s1",
    source: "hook",
    source_event_id: `hook-${sequence}`,
    source_sequence: sequence,
    type: "user_question",
    payload: JSON.stringify({ question_id: "q", summary: "asked before the upgrade" }),
    observed_at: "2026-10-24T12:00:01.000Z",
  }).event_id;
  ask({ question_id: "q", summary: "asked again" }, { second: 3 });

  const text = renderBriefing(loadBriefingState(store, { project_id: "a", display_name: "a" }), {
    maxTokens: 2000,
    generatedAt: "2026-10-24T12:00:00.000Z",
  });
  const item = store.listInbox({}).find((each) => each.origin_question_id === "q")!;
  assert.equal(item.question_id, `q-${before}`);
  assert.equal(item.source_event_id, before);
  assert.match(text, new RegExp(`^- q-${before}: asked again$`, "m"));
  assert.equal(store.dismissInboxQuestion(`q-${before}`)!.dismissed, true);
});
