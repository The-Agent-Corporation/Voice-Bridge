import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { resolveStoredPrimary } from "../primary.js";
import { openStore, STORE_FILE, type Store } from "../store.js";
import { removeTempDirs, tempDir } from "./helpers.js";

after(removeTempDirs);

test("a store with an unknown schema version refuses to open and is left untouched", () => {
  const dataDir = tempDir();
  const file = path.join(dataDir, STORE_FILE);
  const seed = new DatabaseSync(file);
  seed.exec("PRAGMA user_version = 4;");
  seed.close();

  assert.throws(() => openStore(dataDir), { code: "store_version_unsupported" });

  const db = new DatabaseSync(file);
  try {
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master").all(), []);
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 4);
  } finally {
    db.close();
  }
});

test("a version 1 store gains the sessions and pin tables and keeps its projects", () => {
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
    assert.equal(userVersion(db), 3);
    assert.deepEqual(tableNames(db), ["pin_audit", "primary_pins", "projects", "sessions"]);
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

test("a version 2 store gains the pin tables and keeps its projects and sessions", () => {
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
    assert.equal(userVersion(db), 3);
    assert.deepEqual(tableNames(db), ["pin_audit", "primary_pins", "projects", "sessions"]);
  } finally {
    db.close();
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
