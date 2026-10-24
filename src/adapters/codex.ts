// Layout read on 2026-10-24 from codex-cli 0.145.0: each saved session is
// <home>/sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl, older ones zstd-compressed as
// .jsonl.zst, and line 1 is {"type":"session_meta","payload":{"id","cwd",…}}.
// archived_sessions/ holds sessions the user archived and is not read.
import path from "node:path";
import { associate, isObject, listProviderDir, nonEmptyString, readLines, readRecords } from "./savedRecords.js";
import type { AgentAdapter } from "./types.js";

const ROLLOUT = /^rollout-.*\.jsonl(\.zst)?$/;

async function readSessionMeta(file: string): Promise<{ id: string; cwd: string } | undefined> {
  for await (const line of readLines(file, { zstd: file.endsWith(".zst") })) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return undefined;
    }
    if (!isObject(parsed) || parsed.type !== "session_meta" || !isObject(parsed.payload)) return undefined;
    const { id, cwd } = parsed.payload;
    return nonEmptyString(id) && nonEmptyString(cwd) ? { id, cwd } : undefined;
  }
  return undefined;
}

export function createCodexAdapter(home: string): AgentAdapter {
  return {
    provider: "codex",
    async discoverSessions(worktrees) {
      const files = listProviderDir(path.join(home, "sessions"), true)
        .filter((entry) => entry.isFile() && ROLLOUT.test(entry.name))
        .map((entry) => path.join(entry.parentPath, entry.name));
      const { records, skipped } = await readRecords(files, readSessionMeta);
      return { sessions: associate("codex", records, worktrees), skipped_records: skipped };
    },
  };
}
