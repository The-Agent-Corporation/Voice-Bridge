import { createReadStream, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { createZstdDecompress } from "node:zlib";
import { BridgeError } from "../errors.js";
import type { DiscoveredSession, Provider, SessionCapabilities, Worktree } from "./types.js";

/** One saved session as a provider's store describes it, before it is tied to a project. */
export interface SavedRecord {
  native_session_id: string;
  cwd: string;
  last_activity_at: string;
}

const NO_CAPABILITIES: SessionCapabilities = {
  live_attach: false,
  next_turn: false,
  steer_active_turn: false,
  answer_pending_question: false,
  subscribe_events: false,
};

function canonical(dir: string): string | undefined {
  try {
    return realpathSync.native(dir);
  } catch {
    return undefined;
  }
}

/**
 * Keeps the records whose cwd resolves to exactly one of `worktrees`. Equality of
 * canonical paths is the only rule: a sibling such as `/x/app-old` never matches `/x/app`.
 * A cwd that no longer exists is a readable record of a folder that is gone, so it is
 * dropped rather than counted as skipped.
 */
export function associate(provider: Provider, records: readonly SavedRecord[], worktrees: readonly Worktree[]): DiscoveredSession[] {
  const byPath = new Map(worktrees.map((worktree) => [worktree.path, worktree]));
  const sessions: DiscoveredSession[] = [];
  for (const record of records) {
    const resolved = canonical(record.cwd);
    const worktree = resolved === undefined ? undefined : byPath.get(resolved);
    if (!worktree) continue;
    sessions.push({
      provider,
      native_session_id: record.native_session_id,
      worktree_id: worktree.id,
      observed_state: "saved",
      last_activity_at: record.last_activity_at,
      capabilities: { ...NO_CAPABILITIES },
    });
  }
  return sessions;
}

/**
 * Lists a provider directory. A directory that does not exist is a provider that was never
 * used here, so it lists as empty; any other failure is loud, so "could not look" is never
 * reported as "found nothing".
 */
export function listProviderDir(dir: string, recursive = false): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true, recursive });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new BridgeError("session_discovery_failed", `could not list ${dir}: ${(error as Error).message}`);
  }
}

/**
 * Reads each file's session id and cwd with `identify`. A file it cannot identify, or that
 * fails to read, is counted as skipped. The file's mtime is when the provider last wrote it.
 */
export async function readRecords(
  files: readonly string[],
  identify: (file: string) => Promise<{ id: string; cwd: string } | undefined>,
): Promise<{ records: SavedRecord[]; skipped: number }> {
  const records: SavedRecord[] = [];
  let skipped = 0;
  for (const file of files) {
    try {
      const identity = await identify(file);
      if (identity) {
        records.push({ native_session_id: identity.id, cwd: identity.cwd, last_activity_at: statSync(file).mtime.toISOString() });
        continue;
      }
    } catch {
      // Unreadable (permissions, a corrupt archive): counted below like an unparseable record.
    }
    skipped++;
  }
  return { records, skipped };
}

/** Yields a saved record's lines. The file is only ever opened read-only; returning early closes it. */
export async function* readLines(file: string, { zstd = false } = {}): AsyncGenerator<string> {
  const raw = createReadStream(file, { flags: "r" });
  const input: Readable = zstd ? raw.pipe(createZstdDecompress()) : raw;
  if (zstd) raw.once("error", (error) => input.destroy(error));
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) yield line;
  } finally {
    lines.close();
    raw.destroy();
    input.destroy();
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
