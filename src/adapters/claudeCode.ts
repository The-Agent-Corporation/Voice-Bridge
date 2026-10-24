// Layout read on 2026-10-24 from Claude Code 2.1.289: each saved session is
// <home>/projects/<encoded cwd>/<session id>.jsonl. Its first lines carry no cwd; a later
// line does. The folder name encodes the cwd lossily, so it is never decoded or matched.
import path from "node:path";
import { associate, isObject, listProviderDir, nonEmptyString, readLines, readRecords } from "./savedRecords.js";
import type { AgentAdapter } from "./types.js";

const SESSION_SUFFIX = ".jsonl";

/** The cwd from the first line that names one; undefined if a line before it is not a JSON object. */
async function readCwd(file: string): Promise<string | undefined> {
  for await (const line of readLines(file)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return undefined;
    }
    if (!isObject(parsed)) return undefined;
    if (nonEmptyString(parsed.cwd)) return parsed.cwd;
  }
  return undefined;
}

/** Only the top-level .jsonl files of each project folder are sessions; subfolders hold other data. */
function sessionFiles(home: string): string[] {
  const projectsDir = path.join(home, "projects");
  return listProviderDir(projectsDir)
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const dir = path.join(projectsDir, entry.name);
      return listProviderDir(dir)
        .filter((file) => file.isFile() && file.name.endsWith(SESSION_SUFFIX))
        .map((file) => path.join(dir, file.name));
    });
}

export function createClaudeCodeAdapter(home: string): AgentAdapter {
  return {
    provider: "claude-code",
    async discoverSessions(worktrees) {
      const { records, skipped } = await readRecords(sessionFiles(home), async (file) => {
        const cwd = await readCwd(file);
        return cwd === undefined ? undefined : { id: path.basename(file, SESSION_SUFFIX), cwd };
      });
      return { sessions: associate("claude-code", records, worktrees), skipped_records: skipped };
    },
  };
}
