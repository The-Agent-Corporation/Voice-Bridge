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
  seed.exec("PRAGMA user_version = 2;");
  seed.close();

  assert.throws(() => openStore(dataDir), { code: "store_version_unsupported" });

  const db = new DatabaseSync(file);
  try {
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_master").all(), []);
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
  } finally {
    db.close();
  }
});
