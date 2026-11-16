import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomicFile.js";
import { PROJECT_ID_PATTERN } from "./config.js";
import { ensureDataDir } from "./dataDir.js";

/**
 * The local registry of installed folders: one `<dataDir>/folders/<folder_id>.json` per folder, so two
 * `init`s never race over a shared file and a lookup by id is one read. The folder's manifest stays the
 * source of truth for everything but where the folder is.
 */
export interface RegisteredFolder {
  folder_id: string;
  path: string;
  registered_at: string;
}

export function foldersDir(dataDir: string): string {
  return path.join(dataDir, "folders");
}

const entryPath = (dataDir: string, folderId: string) => path.join(foldersDir(dataDir), `${folderId}.json`);

function parseEntry(text: string, folderId: string): RegisteredFolder | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const entry = raw as Partial<RegisteredFolder> | null;
  if (
    typeof entry !== "object" ||
    entry === null ||
    entry.folder_id !== folderId ||
    typeof entry.path !== "string" ||
    !path.isAbsolute(entry.path) ||
    typeof entry.registered_at !== "string"
  ) {
    return undefined;
  }
  return { folder_id: entry.folder_id, path: entry.path, registered_at: entry.registered_at };
}

/** The entry for `folderId`, or undefined when there is none or it is malformed. */
export function readRegisteredFolder(dataDir: string, folderId: string): RegisteredFolder | undefined {
  if (!PROJECT_ID_PATTERN.test(folderId)) return undefined;
  let text: string;
  try {
    text = readFileSync(entryPath(dataDir, folderId), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR") return undefined;
    throw error;
  }
  return parseEntry(text, folderId);
}

/** Every well-formed entry; malformed and unrelated files are skipped, not removed. */
export function listRegisteredFolders(dataDir: string): RegisteredFolder[] {
  let names: string[];
  try {
    names = readdirSync(foldersDir(dataDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => readRegisteredFolder(dataDir, name.slice(0, -".json".length)))
    .filter((entry) => entry !== undefined);
}

export function writeRegisteredFolder(dataDir: string, entry: RegisteredFolder): void {
  ensureDataDir(dataDir);
  mkdirSync(foldersDir(dataDir), { recursive: true, mode: 0o700 });
  writeFileAtomic(entryPath(dataDir, entry.folder_id), `${JSON.stringify(entry, null, 2)}\n`);
}

export function removeRegisteredFolder(dataDir: string, folderId: string): void {
  rmSync(entryPath(dataDir, folderId), { force: true });
}
