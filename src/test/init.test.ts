import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { foldersDir, readRegisteredFolder } from "../folders.js";
import { initFolder } from "../init.js";
import { buildManifest, manifestPath } from "../manifest.js";
import { checkVoiceMd } from "../voiceMd.js";
import { removeTempDirs, tempDir } from "./helpers.js";

after(removeTempDirs);

/** A new empty folder called `name` inside a fresh temp dir. */
function folderNamed(name: string): string {
  const folder = path.join(tempDir(), name);
  mkdirSync(folder);
  return folder;
}

const readManifest = (folder: string) => JSON.parse(readFileSync(manifestPath(folder), "utf8")) as Record<string, unknown>;
const voiceMd = (folder: string) => path.join(folder, "voice.md");
const entries = (dataDir: string) => (existsSync(foldersDir(dataDir)) ? readdirSync(foldersDir(dataDir)).sort() : []);

const assertNothingWritten = (folder: string, dataDir: string) => {
  assert.equal(existsSync(voiceMd(folder)), false);
  assert.deepEqual(entries(dataDir), []);
};

test("a fresh folder gets the manifest, a voice.md that passes check, and a registry entry", () => {
  const folder = folderNamed("Roscoe");
  const dataDir = tempDir();

  const result = initFolder({ folder, dataDir });

  assert.deepEqual(readManifest(folder), {
    schema: "voice-manifest/0.1",
    folder_id: "roscoe",
    name: "Roscoe",
    aliases: ["roscoe"],
    briefing: "voice.md",
    agent: { id: "roscoe-main", kind: "codex", follow_along: false },
  });
  assert.equal(checkVoiceMd(readFileSync(voiceMd(folder), "utf8")).ok, true);
  assert.equal(readRegisteredFolder(dataDir, "roscoe")?.path, folder);
  assert.deepEqual(
    [result.folder_id, result.manifest, result.voice_md, result.voice_md_ok, result.registered],
    ["roscoe", "created", "created", true, "created"],
  );
});

test("the id is a slug of the name, and a name with no slug needs --id", () => {
  const dataDir = tempDir();
  const app = initFolder({ folder: folderNamed("My App!"), dataDir });
  assert.deepEqual([app.folder_id, app.name], ["my-app", "My App!"]);
  assert.deepEqual(readManifest(app.folder).aliases, ["my app!"]);

  const nihon = folderNamed("日本");
  assert.throws(() => initFolder({ folder: nihon, dataDir }), { code: "invalid_folder_id", message: /--id/ });
  assert.equal(existsSync(path.join(nihon, ".voice")), false);
  assert.equal(initFolder({ folder: nihon, dataDir, id: "nihon" }).folder_id, "nihon");
});

test("re-running keeps an edited manifest and voice.md byte for byte", () => {
  const folder = folderNamed("roscoe");
  const dataDir = tempDir();
  initFolder({ folder, dataDir });
  const manifest = readFileSync(manifestPath(folder), "utf8").replace('"follow_along": false', '"follow_along": true');
  writeFileSync(manifestPath(folder), manifest);
  const edited = readFileSync(voiceMd(folder), "utf8").replace("Nothing reported yet.", "Invoices went out.");
  writeFileSync(voiceMd(folder), edited);

  const again = initFolder({ folder, dataDir });
  assert.deepEqual([again.manifest, again.voice_md, again.voice_md_ok, again.registered], ["kept", "kept", true, "unchanged"]);
  assert.equal(readFileSync(manifestPath(folder), "utf8"), manifest);
  assert.equal(readFileSync(voiceMd(folder), "utf8"), edited);

  writeFileSync(voiceMd(folder), "notes\n");
  assert.equal(initFolder({ folder, dataDir }).voice_md_ok, false);
  assert.equal(readFileSync(voiceMd(folder), "utf8"), "notes\n");
});

test("an invalid existing manifest is refused and nothing is written", () => {
  for (const change of [{ briefing: "../x.md" }, { schema: "other" }]) {
    const folder = folderNamed("roscoe");
    const dataDir = tempDir();
    mkdirSync(path.join(folder, ".voice"));
    const manifest = {
      schema: "voice-manifest/0.1",
      folder_id: "roscoe",
      name: "Roscoe",
      aliases: ["roscoe"],
      briefing: "voice.md",
      agent: { id: "roscoe-main", kind: "codex", follow_along: false },
      ...change,
    };
    writeFileSync(manifestPath(folder), JSON.stringify(manifest));
    assert.throws(() => initFolder({ folder, dataDir }), { code: "manifest_invalid" }, JSON.stringify(change));
    assertNothingWritten(folder, dataDir);
  }
});

test("a folder id held by another live folder conflicts; a stale holder is replaced", () => {
  const dataDir = tempDir();
  const first = folderNamed("app");
  initFolder({ folder: first, dataDir });
  const firstEntry = readFileSync(path.join(foldersDir(dataDir), "app.json"), "utf8");

  const second = folderNamed("app");
  assert.throws(() => initFolder({ folder: second, dataDir }), {
    code: "folder_id_conflict",
    message: new RegExp(`already registered for ${first}; pass --id`),
  });
  assert.equal(existsSync(path.join(second, ".voice")), false);
  assert.equal(existsSync(voiceMd(second)), false);
  assert.equal(readFileSync(path.join(foldersDir(dataDir), "app.json"), "utf8"), firstEntry);

  assert.equal(initFolder({ folder: second, dataDir, id: "app-b" }).registered, "created");

  rmSync(manifestPath(first));
  const third = folderNamed("app");
  const replaced = initFolder({ folder: third, dataDir });
  assert.equal(replaced.registered, "replaced");
  assert.equal(replaced.displaced, first);
  assert.equal(readRegisteredFolder(dataDir, "app")?.path, third);
});

test("a holder whose manifest cannot be read or parsed still owns its id", () => {
  const dataDir = tempDir();
  const first = folderNamed("app");
  initFolder({ folder: first, dataDir });
  const second = folderNamed("app");

  writeFileSync(manifestPath(first), "{ mid-edit");
  assert.throws(() => initFolder({ folder: second, dataDir }), { code: "folder_id_conflict" });

  rmSync(manifestPath(first));
  mkdirSync(manifestPath(first));
  assert.throws(() => initFolder({ folder: second, dataDir }), { code: "folder_id_conflict" });
  assert.equal(readRegisteredFolder(dataDir, "app")?.path, first);
  assert.equal(existsSync(path.join(second, ".voice")), false);
});

test("a folder keeps one entry when its manifest's folder_id changes, and --id must match the manifest", () => {
  const folder = folderNamed("roscoe");
  const dataDir = tempDir();
  initFolder({ folder, dataDir });
  writeFileSync(manifestPath(folder), readFileSync(manifestPath(folder), "utf8").replace('"folder_id": "roscoe"', '"folder_id": "billing"'));

  assert.equal(initFolder({ folder, dataDir }).registered, "created");
  assert.deepEqual(entries(dataDir), ["billing.json"]);
  assert.throws(() => initFolder({ folder, dataDir, id: "roscoe" }), { code: "manifest_id_mismatch" });
});

test("a manifest that would hold a secret is refused and nothing is written", () => {
  const folder = folderNamed("0f8fad5b-d9cb-469f-a165-70867728950e");
  const dataDir = tempDir();
  assert.throws(() => initFolder({ folder, dataDir }), { code: "manifest_has_secret" });
  assert.equal(existsSync(path.join(folder, ".voice")), false);
  assertNothingWritten(folder, dataDir);
});

test("a kept manifest with a credential under a JSON key is refused, naming the key but not the value", () => {
  for (const [key, value] of [["token", "hunter2hunter2"], ["api_key", "abcd1234efgh"]] as const) {
    const folder = folderNamed("roscoe");
    const dataDir = tempDir();
    mkdirSync(path.dirname(manifestPath(folder)));
    const manifest = { ...buildManifest({ folderId: "roscoe", name: "roscoe" }), [key]: value };
    writeFileSync(manifestPath(folder), JSON.stringify(manifest, null, 2));
    assert.throws(
      () => initFolder({ folder, dataDir }),
      (error: Error & { code?: string }) =>
        error.code === "manifest_has_secret" && error.message.includes(`${key}:`) && !error.message.includes(value),
    );
    assertNothingWritten(folder, dataDir);
  }
});

test("a missing path is path_not_found and a file is invalid_path", () => {
  const dir = tempDir();
  assert.throws(() => initFolder({ folder: path.join(dir, "absent"), dataDir: dir }), { code: "path_not_found" });
  const file = path.join(dir, "file");
  writeFileSync(file, "");
  assert.throws(() => initFolder({ folder: file, dataDir: dir }), { code: "invalid_path" });
});

test("a hand-edited manifest whose name would break the starter voice.md is refused before writing", () => {
  const folder = folderNamed("roscoe");
  const dataDir = tempDir();
  mkdirSync(path.join(folder, ".voice"));
  const manifest = {
    schema: "voice-manifest/0.1",
    folder_id: "roscoe",
    name: "Roscoe\n## Status now",
    aliases: ["roscoe"],
    briefing: "voice.md",
    agent: { id: "roscoe-main", kind: "codex", follow_along: false },
  };
  writeFileSync(manifestPath(folder), JSON.stringify(manifest));
  assert.throws(() => initFolder({ folder, dataDir }), { code: "starter_voice_md_invalid", message: /duplicate_section/ });
  assertNothingWritten(folder, dataDir);
});
