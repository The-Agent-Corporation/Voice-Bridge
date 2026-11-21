import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PROJECT_ID_PATTERN } from "./config.js";
import {
  listRegisteredFolders,
  readRegisteredFolder,
  removeRegisteredFolder,
  writeRegisteredFolder,
} from "./folders.js";
import { buildManifest, FolderError, manifestPath, parseManifest, readManifest, type VoiceManifest } from "./manifest.js";
import { checkVoiceMd, findSecrets, renderStarterVoiceMd, VOICE_MD_FILE } from "./voiceMd.js";

export interface InitResult {
  folder_id: string;
  name: string;
  folder: string;
  manifest: "created" | "kept";
  voice_md: "created" | "kept";
  voice_md_ok: boolean;
  registered: "created" | "replaced" | "unchanged";
  /** The folder that held the id before a `replaced` registration. */
  displaced?: string;
}

const errnoCode = (error: unknown) => (error as NodeJS.ErrnoException).code;

function canonicalFolder(input: string): string {
  let canonical: string;
  try {
    canonical = realpathSync.native(input);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") throw new FolderError("path_not_found", `${input} does not exist`);
    throw error;
  }
  if (!statSync(canonical).isDirectory()) throw new FolderError("invalid_path", `${canonical} is not a directory`);
  return canonical;
}

/** True when something, even a dangling symlink, already sits at `file`. */
function occupied(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return false;
    throw error;
  }
}

/** A folder's spoken name: its basename with whitespace and control characters folded to single spaces. */
function nameOf(folder: string): string {
  return path.basename(folder).replace(/[\s\p{Cc}]+/gu, " ").trim();
}

function slugOf(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

function newManifest(folder: string, id: string | undefined): VoiceManifest & { text: string } {
  const derived = nameOf(folder);
  const folderId = id ?? slugOf(derived);
  if (!PROJECT_ID_PATTERN.test(folderId)) {
    throw new FolderError(
      "invalid_folder_id",
      `${JSON.stringify(folderId)} is not a folder id: use 1-64 lowercase letters, digits or hyphens, starting with a letter or digit; pass --id <folder_id>`,
    );
  }
  const manifest = buildManifest({ folderId, name: derived || folderId });
  return { ...manifest, text: `${JSON.stringify(manifest, null, 2)}\n` };
}

function passesCheck(file: string): boolean {
  try {
    return statSync(file).isFile() && checkVoiceMd(readFileSync(file, "utf8")).ok;
  } catch {
    return false;
  }
}

/**
 * Another folder still holding a manifest for `folderId` owns the id; a moved or uninstalled one, or one whose
 * manifest now names another id, does not. A manifest that cannot be read or parsed proves neither, so it owns.
 */
function stillOwns(otherFolder: string, folderId: string): boolean {
  let text: string;
  try {
    text = readFileSync(manifestPath(otherFolder), "utf8");
  } catch (error) {
    const code = errnoCode(error);
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
  try {
    return parseManifest(text).folder_id === folderId;
  } catch {
    return true;
  }
}

/** Each leaf of the manifest's JSON as a `key: value` line, so prose secret rules see JSON keys and values. */
function manifestEntries(value: unknown, at = ""): { at: string; line: string }[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => manifestEntries(item, `${at}[${index}]`));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, item]) =>
      typeof item === "object" && item !== null
        ? manifestEntries(item, at ? `${at}.${key}` : key)
        : [{ at: at ? `${at}.${key}` : key, line: `${key}: ${String(item)}` }],
    );
  }
  return [{ at, line: String(value) }];
}

function manifestSecrets(text: string): string[] {
  return manifestEntries(JSON.parse(text)).flatMap(({ at, line }) =>
    findSecrets(line).map((problem) => `${at}: ${problem.message}`),
  );
}

/** Creates `file` only if nothing is there; returns false when something got there first. */
function createExclusive(file: string, text: string): boolean {
  try {
    writeFileSync(file, text, { flag: "wx" });
    return true;
  } catch (error) {
    if (errnoCode(error) === "EEXIST") return false;
    throw error;
  }
}

/**
 * Installs the plug-in in `folder`: `.voice/manifest.json`, a starter `voice.md` and the registry entry.
 * Everything is decided and validated before the first write, and nothing that exists is overwritten.
 */
export function initFolder({
  folder: input,
  dataDir,
  id,
  now = new Date(),
}: {
  folder: string;
  dataDir: string;
  id?: string;
  now?: Date;
}): InitResult {
  const folder = canonicalFolder(input);
  const manifestFile = manifestPath(folder);
  const manifestExists = occupied(manifestFile);
  const manifest = manifestExists ? readManifest(manifestFile) : newManifest(folder, id);
  const folderId = manifest.folder_id;
  if (manifestExists && id !== undefined && id !== folderId) {
    throw new FolderError("manifest_id_mismatch", `${manifestFile} already names folder_id ${folderId}, not ${id}`);
  }

  const leaks = manifestSecrets(manifest.text);
  if (leaks.length > 0) {
    throw new FolderError("manifest_has_secret", `the manifest for ${folder} would hold a secret (${leaks.join("; ")})`);
  }

  const voiceMdFile = path.join(folder, VOICE_MD_FILE);
  const starter = occupied(voiceMdFile)
    ? undefined
    : renderStarterVoiceMd({ name: manifest.name, agentId: manifest.agent.id, updatedAt: now.toISOString() });
  if (starter !== undefined) {
    const check = checkVoiceMd(starter);
    if (!check.ok) {
      const codes = [...new Set(check.problems.map((p) => p.code))].join(", ");
      throw new FolderError("starter_voice_md_invalid", `the starter voice.md for ${folder} would not pass check (${codes})`);
    }
  }

  const existing = readRegisteredFolder(dataDir, folderId);
  let registered: InitResult["registered"] = "created";
  if (existing?.path === folder) {
    registered = "unchanged";
  } else if (existing) {
    if (stillOwns(existing.path, folderId)) {
      const fix = manifestExists ? `change folder_id in ${manifestFile}` : "pass --id <other-id>";
      throw new FolderError("folder_id_conflict", `${folderId} is already registered for ${existing.path}; ${fix}`);
    }
    registered = "replaced";
  }

  if (!manifestExists) {
    mkdirSync(path.dirname(manifestFile), { recursive: true });
    // Losing this race would register an id the folder's manifest may not hold, so it fails instead.
    if (!createExclusive(manifestFile, manifest.text)) {
      throw new FolderError("manifest_invalid", `${manifestFile} appeared while init ran; run init again`);
    }
  }
  const voiceMdCreated = starter !== undefined && createExclusive(voiceMdFile, starter);
  if (registered !== "unchanged") {
    writeRegisteredFolder(dataDir, { folder_id: folderId, path: folder, registered_at: now.toISOString() });
  }
  for (const entry of listRegisteredFolders(dataDir)) {
    if (entry.path === folder && entry.folder_id !== folderId) removeRegisteredFolder(dataDir, entry.folder_id);
  }

  return {
    folder_id: folderId,
    name: manifest.name,
    folder,
    manifest: manifestExists ? "kept" : "created",
    voice_md: voiceMdCreated ? "created" : "kept",
    voice_md_ok: voiceMdCreated || passesCheck(voiceMdFile),
    registered,
    ...(registered === "replaced" && existing ? { displaced: existing.path } : {}),
  };
}
