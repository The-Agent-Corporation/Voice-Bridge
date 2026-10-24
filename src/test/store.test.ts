import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { openStore, STORE_FILE } from "../store.js";
import { removeTempDirs, tempDir } from "./helpers.js";

after(removeTempDirs);

test("a store with an unknown schema version refuses to open and is left untouched", () => {
  const dataDir = tempDir();
  const file = path.join(dataDir, STORE_FILE);
  const seed = new DatabaseSync(file);
  seed.exec("PRAGMA user_version = 3;");
  seed.close();

  assert.throws(() => openStore(dataDir), { code: "store_version_unsupported" });

  const db = new DatabaseSync(file);
  try {
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master").all(), []);
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 3);
  } finally {
    db.close();
  }
});

test("a version 1 store gains the sessions table and keeps its projects", () => {
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
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    assert.deepEqual(tables.map((row) => row.name), ["projects", "sessions"]);
  } finally {
    db.close();
  }
});
