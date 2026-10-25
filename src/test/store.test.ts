import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { resolveStoredPrimary } from "../primary.js";
import {
  BRIEFING_EVENTS_PER_TYPE,
  openStore,
  STORE_FILE,
  type EventType,
  type NewEvent,
  type NewMessage,
  type Store,
} from "../store.js";
import { removeTempDirs, tempDir } from "./helpers.js";

after(removeTempDirs);

const ALL_TABLES = [
  "briefings",
  "events",
  "inbox_items",
  "inbox_notifications",
  "message_transitions",
  "messages",
  "pin_audit",
  "primary_pins",
  "projects",
  "sessions",
  "source_watermarks",
];

test("a store with an unknown schema version refuses to open and is left untouched", () => {
  const dataDir = tempDir();
  const file = path.join(dataDir, STORE_FILE);
  const seed = new DatabaseSync(file);
  seed.exec("PRAGMA user_version = 8;");
  seed.close();

  assert.throws(() => openStore(dataDir), { code: "store_version_unsupported" });

  const db = new DatabaseSync(file);
  try {
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master").all(), []);
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 8);
  } finally {
    db.close();
  }
});

test("a version 1 store gains the sessions, pin, event, briefing and inbox tables and keeps its projects", () => {
  const dataDir = tempDir();
  const file = path.join(dataDir, STORE_FILE);
  const seed = new DatabaseSync(file);
  seed.exec(`
    CREATE TABLE projects (
      project_id     TEXT PRIMARY KEY,
      canonical_path TEXT NOT NULL UNIQUE,
      display_name   TEXT NOT NULL,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
    INSERT INTO projects VALUES ('kept', '/x/kept', 'Kept', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    PRAGMA user_version = 1;
  `);
  seed.close();

  for (let open = 0; open < 2; open++) {
    const store = openStore(dataDir);
    try {
      assert.equal(store.getById("kept")?.canonical_path, "/x/kept");
      assert.deepEqual(store.listSessions("kept"), []);
    } finally {
      store.close();
    }
  }

  const db = new DatabaseSync(file);
  try {
    assert.equal(userVersion(db), 7);
    assert.deepEqual(tableNames(db), ALL_TABLES);
  } finally {
    db.close();
  }
});

function userVersion(db: DatabaseSync): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

function tableNames(db: DatabaseSync): unknown[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
}

test("a version 2 store gains the pin, event, briefing and inbox tables and keeps its projects and sessions", () => {
  const dataDir = tempDir();
  const file = path.join(dataDir, STORE_FILE);
  const seed = new DatabaseSync(file);
  seed.exec(`
    CREATE TABLE projects (
      project_id     TEXT PRIMARY KEY,
      canonical_path TEXT NOT NULL UNIQUE,
      display_name   TEXT NOT NULL,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
    CREATE TABLE sessions (
      project_id        TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
      session_id        TEXT NOT NULL,
      provider          TEXT NOT NULL,
      native_session_id TEXT NOT NULL,
      worktree_id       TEXT NOT NULL,
      observed_state    TEXT NOT NULL,
      last_activity_at  TEXT,
      capabilities      TEXT NOT NULL,
      PRIMARY KEY (project_id, session_id)
    );
    INSERT INTO projects VALUES ('kept', '/x/kept', 'Kept', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO sessions VALUES ('kept', 'codex:s1', 'codex', 's1', '/x/kept', 'saved', NULL, '{}');
    PRAGMA user_version = 2;
  `);
  seed.close();

  for (let open = 0; open < 2; open++) {
    const store = openStore(dataDir);
    try {
      assert.equal(store.getById("kept")?.canonical_path, "/x/kept");
      assert.deepEqual(store.listSessions("kept").map((s) => s.session_id), ["codex:s1"]);
      assert.equal(store.getPin("kept"), undefined);
    } finally {
      store.close();
    }
  }

  const db = new DatabaseSync(file);
  try {
    assert.equal(userVersion(db), 7);
    assert.deepEqual(tableNames(db), ALL_TABLES);
  } finally {
    db.close();
  }
});

test("a version 3 store gains the event, briefing and inbox tables and keeps its projects, sessions and pin", () => {
  const dataDir = tempDir();
  const file = path.join(dataDir, STORE_FILE);
  const seed = new DatabaseSync(file);
  seed.exec(`
    CREATE TABLE projects (
      project_id     TEXT PRIMARY KEY,
      canonical_path TEXT NOT NULL UNIQUE,
      display_name   TEXT NOT NULL,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
    CREATE TABLE sessions (
      project_id        TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
      session_id        TEXT NOT NULL,
      provider          TEXT NOT NULL,
      native_session_id TEXT NOT NULL,
      worktree_id       TEXT NOT NULL,
      observed_state    TEXT NOT NULL,
      last_activity_at  TEXT,
      capabilities      TEXT NOT NULL,
      PRIMARY KEY (project_id, session_id)
    );
    CREATE TABLE primary_pins (
      project_id TEXT PRIMARY KEY REFERENCES projects(project_id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      pinned_at  TEXT NOT NULL
    );
    CREATE TABLE pin_audit (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      action     TEXT NOT NULL CHECK (action IN ('pin', 'unpin')),
      at         TEXT NOT NULL
    );
    INSERT INTO projects VALUES ('kept', '/x/kept', 'Kept', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO sessions VALUES ('kept', 'codex:s1', 'codex', 's1', '/x/kept', 'saved', NULL, '{}');
    INSERT INTO primary_pins VALUES ('kept', 'codex:s1', '2026-01-02T00:00:00.000Z');
    PRAGMA user_version = 3;
  `);
  seed.close();

  for (let open = 0; open < 2; open++) {
    const store = openStore(dataDir);
    try {
      assert.equal(store.getById("kept")?.canonical_path, "/x/kept");
      assert.deepEqual(store.listSessions("kept").map((s) => s.session_id), ["codex:s1"]);
      assert.equal(store.getPin("kept")?.session_id, "codex:s1");
      assert.deepEqual(store.listWatermarks("kept"), []);
    } finally {
      store.close();
    }
  }

  const db = new DatabaseSync(file);
  try {
    assert.equal(userVersion(db), 7);
    assert.deepEqual(tableNames(db), ALL_TABLES);
  } finally {
    db.close();
  }
});

test("a version 4 store gains the briefings and inbox tables and keeps its events and watermarks", () => {
  const dataDir = tempDir();
  const file = path.join(dataDir, STORE_FILE);
  const seeded = openStore(dataDir);
  seeded.upsert({ project_id: "kept", display_name: "Kept", canonical_path: "/x/kept" });
  seeded.ingestEvent(storedEvent("kept", 1));
  seeded.close();
  const seed = new DatabaseSync(file);
  seed.exec("DROP TABLE briefings; PRAGMA user_version = 4;");
  seed.close();

  for (let open = 0; open < 2; open++) {
    const store = openStore(dataDir);
    try {
      assert.deepEqual(store.listWatermarks("kept").map((row) => ({ ...row })), [
        { source: "hook", watermark: 1, highest_stored: 1 },
      ]);
      assert.equal(store.highestProcessedEventId("kept"), 1);
      assert.equal(store.getBriefing("kept"), undefined);
    } finally {
      store.close();
    }
  }

  const db = new DatabaseSync(file);
  try {
    assert.equal(userVersion(db), 7);
    assert.deepEqual(tableNames(db), ALL_TABLES);
  } finally {
    db.close();
  }
});

test("a version 5 store gains the inbox tables and keeps its events and briefing", () => {
  const dataDir = tempDir();
  const file = path.join(dataDir, STORE_FILE);
  const seeded = openStore(dataDir);
  seeded.upsert({ project_id: "kept", display_name: "Kept", canonical_path: "/x/kept" });
  seeded.ingestEvent(storedEvent("kept", 1));
  const briefing = { project_id: "kept", content_hash: "abc", text: "# Kept", generated_at: "2026-10-24T12:00:00.000Z" };
  seeded.saveBriefing(briefing);
  seeded.close();
  const seed = new DatabaseSync(file);
  seed.exec("DROP TABLE inbox_notifications; DROP TABLE inbox_items; PRAGMA user_version = 5;");
  seed.close();

  for (let open = 0; open < 2; open++) {
    const store = openStore(dataDir);
    try {
      assert.equal(store.highestProcessedEventId("kept"), 1);
      assert.deepEqual(store.getBriefing("kept"), briefing);
      assert.deepEqual(store.listInbox({}), []);
    } finally {
      store.close();
    }
  }

  const db = new DatabaseSync(file);
  try {
    assert.equal(userVersion(db), 7);
    assert.deepEqual(tableNames(db), ALL_TABLES);
  } finally {
    db.close();
  }
});

test("a version 6 store gains the message tables and keeps its inbox", () => {
  const dataDir = tempDir();
  const file = path.join(dataDir, STORE_FILE);
  const seeded = openStore(dataDir);
  seeded.upsert({ project_id: "kept", display_name: "Kept", canonical_path: "/x/kept" });
  seeded.ingestEvent(storedEvent("kept", 1, "user_question"), {
    origin_question_id: null,
    summary: "Ship it?",
    type: null,
    priority: null,
    withdrawn: false,
  });
  seeded.close();
  const seed = new DatabaseSync(file);
  seed.exec("DROP TABLE message_transitions; DROP TABLE messages; PRAGMA user_version = 6;");
  seed.close();

  for (let open = 0; open < 2; open++) {
    const store = openStore(dataDir);
    try {
      assert.deepEqual(store.listInbox({}).map((item) => item.summary), ["Ship it?"]);
      assert.equal(store.findMessageByKey("k"), undefined);
    } finally {
      store.close();
    }
  }

  const db = new DatabaseSync(file);
  try {
    assert.equal(userVersion(db), 7);
    assert.deepEqual(tableNames(db), ALL_TABLES);
  } finally {
    db.close();
  }
});

function storedEvent(projectId: string, sequence: number, type: EventType = "progress"): NewEvent {
  return {
    project_id: projectId,
    session_id: null,
    source: "hook",
    source_event_id: `hook-${sequence}`,
    source_sequence: sequence,
    type,
    payload: "{}",
    observed_at: new Date(Date.UTC(2026, 9, 24, 12, 0, sequence)).toISOString(),
  };
}

test("briefing events are processed ones only, newest first and capped per type", () => {
  const dataDir = tempDir();
  const store = openStore(dataDir);
  try {
    store.upsert({ project_id: "p", display_name: "P", canonical_path: "/x/p" });
    const total = BRIEFING_EVENTS_PER_TYPE + 5;
    for (let sequence = 1; sequence <= total; sequence++) store.ingestEvent(storedEvent("p", sequence));
    store.ingestEvent(storedEvent("p", total + 1, "blocker"));
    store.ingestEvent(storedEvent("p", total + 3, "blocker"));

    const events = store.recentBriefingEvents("p");
    const progress = events.filter((event) => event.type === "progress");
    assert.equal(progress.length, BRIEFING_EVENTS_PER_TYPE);
    assert.equal(progress[0]!.event_id, total);
    assert.deepEqual(events.filter((event) => event.type === "blocker").map((event) => event.event_id), [total + 1]);
    assert.equal(events[0]!.type, "blocker");
    assert.equal(store.highestProcessedEventId("p"), total + 1);
  } finally {
    store.close();
  }
});

const NO_CAPABILITIES = {
  live_attach: false,
  next_turn: false,
  steer_active_turn: false,
  answer_pending_question: false,
  subscribe_events: false,
};

function seededStore(): { store: Store; dataDir: string } {
  const dataDir = tempDir();
  const store = openStore(dataDir);
  store.upsert({ project_id: "p", display_name: "P", canonical_path: "/x/p" });
  store.replaceSessions("p", [
    {
      provider: "codex",
      native_session_id: "s1",
      worktree_id: "/x/p",
      observed_state: "unreachable",
      last_activity_at: "2026-10-01T00:00:00.000Z",
      capabilities: NO_CAPABILITIES,
    },
  ]);
  return { store, dataDir };
}

test("a pinned unreachable session stays primary and the pin row is left unchanged", () => {
  const { store } = seededStore();
  try {
    const pin = store.setPin("p", "codex:s1");
    const project = store.getById("p")!;
    for (let resolve = 0; resolve < 2; resolve++) {
      const route = resolveStoredPrimary(store, project);
      assert.equal(route.route, "pinned");
      assert.equal(route.primary_session_id, "codex:s1");
      assert.equal(route.available, false);
      assert.equal(route.mutating_allowed, false);
    }
    assert.deepEqual({ ...store.getPin("p") }, pin);
  } finally {
    store.close();
  }
});

test("the pin outlives rediscovery, which replaces every session row", () => {
  const { store } = seededStore();
  try {
    const pin = store.setPin("p", "codex:s1");
    store.replaceSessions("p", []);
    assert.deepEqual({ ...store.getPin("p") }, pin);
  } finally {
    store.close();
  }
});

test("pin then unpin write exactly two audit rows, and unpinning nothing writes none", () => {
  const { store, dataDir } = seededStore();
  try {
    store.setPin("p", "codex:s1");
    assert.equal(store.clearPin("p")?.session_id, "codex:s1");
    assert.equal(store.getPin("p"), undefined);
    assert.equal(store.clearPin("p"), undefined);
  } finally {
    store.close();
  }

  const db = new DatabaseSync(path.join(dataDir, STORE_FILE));
  try {
    const rows = db.prepare("SELECT project_id, session_id, action FROM pin_audit ORDER BY id").all();
    assert.deepEqual(
      rows.map((row) => ({ ...row })),
      [
        { project_id: "p", session_id: "codex:s1", action: "pin" },
        { project_id: "p", session_id: "codex:s1", action: "unpin" },
      ],
    );
  } finally {
    db.close();
  }
});

test("re-pinning replaces the pin and audits each pin", () => {
  const { store, dataDir } = seededStore();
  try {
    store.setPin("p", "codex:s1");
    const repinned = store.setPin("p", "codex:s2");
    assert.deepEqual({ ...store.getPin("p") }, repinned);
    assert.equal(repinned.session_id, "codex:s2");
  } finally {
    store.close();
  }

  const db = new DatabaseSync(path.join(dataDir, STORE_FILE));
  try {
    const rows = db.prepare("SELECT project_id, session_id, action FROM pin_audit ORDER BY id").all();
    assert.deepEqual(
      rows.map((row) => ({ ...row })),
      [
        { project_id: "p", session_id: "codex:s1", action: "pin" },
        { project_id: "p", session_id: "codex:s2", action: "pin" },
      ],
    );
  } finally {
    db.close();
  }
});

function newMessage(key: string, overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    message_id: `m-${key}`,
    project_id: "p",
    session_id: "codex:s1",
    mode: "next_turn",
    body: "run the tests",
    approve_queue: true,
    idempotency_key: key,
    decision: { deliverable: false, state: "queued", reason: "awaiting_controllable_session", detail: "saved" },
    created_at: "2026-10-24T12:00:00.000Z",
    expires_at: "2026-10-25T12:00:00.000Z",
    ...overrides,
  };
}

function messageRows(dataDir: string): number {
  const db = new DatabaseSync(path.join(dataDir, STORE_FILE), { readOnly: true });
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

test("a repeated idempotency key returns the stored message, and a different request under it writes nothing", () => {
  const { store, dataDir } = seededStore();
  try {
    const first = store.createMessage(newMessage("k"));
    assert.equal(first.duplicate, false);
    assert.deepEqual(
      first.message.transitions.map((t) => [t.state, t.reason]),
      [
        ["accepted", "authenticated"],
        ["queued", "awaiting_controllable_session"],
      ],
    );
    const again = store.createMessage(newMessage("k", { message_id: "m-other" }));
    assert.equal(again.duplicate, true);
    assert.equal(again.message.message_id, "m-k");
    assert.throws(() => store.createMessage(newMessage("k", { body: "something else" })), { code: "idempotency_conflict" });
    assert.equal(messageRows(dataDir), 1);
  } finally {
    store.close();
  }
});

test("message sequences count from 1 in each project", () => {
  const { store } = seededStore();
  try {
    store.upsert({ project_id: "q", display_name: "Q", canonical_path: "/x/q" });
    const sequences = ["a", "b", "c"].map((key) => store.createMessage(newMessage(key)).message.sequence);
    assert.deepEqual(sequences, [1, 2, 3]);
    assert.equal(store.createMessage(newMessage("d", { project_id: "q" })).message.sequence, 1);
  } finally {
    store.close();
  }
});

test("a deliverable message is claimed for delivery, and later ones wait behind it", () => {
  const { store } = seededStore();
  try {
    const first = store.createMessage(newMessage("a", { decision: { deliverable: true } })).message;
    assert.deepEqual(
      first.transitions.map((t) => `${t.state}/${t.reason}`),
      ["accepted/authenticated", "queued/awaiting_delivery", "delivering/handed_to_adapter"],
    );
    assert.equal(store.createMessage(newMessage("b", { decision: { deliverable: true } })).message.reason, "awaiting_earlier_messages");
    store.expireMessages("2030-01-01T00:00:00.000Z");
    assert.equal(store.getMessage("m-a")?.state, "delivering");
  } finally {
    store.close();
  }
});

test("a transition from the wrong state changes nothing and records no transition", () => {
  const { store } = seededStore();
  try {
    store.createMessage(newMessage("k"));
    const to = { state: "delivered", reason: "adapter_receipt", detail: "x" } as const;
    const result = store.transitionMessage("m-k", "failed", to, "2026-10-24T13:00:00.000Z");
    assert.equal(result?.changed, false);
    assert.equal(result?.message.state, "queued");
    assert.equal(result?.message.transitions.length, 2);
    assert.equal(store.transitionMessage("m-none", "queued", to, "2026-10-24T13:00:00.000Z"), undefined);
  } finally {
    store.close();
  }
});

test("only queued messages past their expiry expire", () => {
  const { store } = seededStore();
  try {
    store.createMessage(newMessage("due"));
    store.createMessage(newMessage("later", { expires_at: "2026-10-26T12:00:00.000Z" }));
    store.createMessage(
      newMessage("failed", { decision: { deliverable: false, state: "failed", reason: "not_controllable", detail: "saved" } }),
    );
    store.expireMessages("2026-10-25T12:00:00.000Z");
    assert.equal(store.getMessage("m-due")?.state, "expired");
    assert.equal(store.getMessage("m-due")?.reason, "expired_unsent");
    assert.deepEqual(store.getMessage("m-due")?.transitions.at(-1), {
      state: "expired",
      reason: "expired_unsent",
      at: "2026-10-25T12:00:00.000Z",
    });
    assert.equal(store.getMessage("m-later")?.state, "queued");
    assert.equal(store.getMessage("m-failed")?.state, "failed");
  } finally {
    store.close();
  }
});
