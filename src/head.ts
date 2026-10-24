import { runGitAsync } from "./git.js";
import type { BriefingEventRow } from "./store.js";

/** A hook may post a short hash, so 7 hex digits is the shortest commit a `git_commit` payload is read as. */
const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/;

export type HeadRead =
  | { state: "commit"; commit: string }
  /** A repository with no commits yet. */
  | { state: "unborn" }
  | { state: "unreadable"; detail: string };

export type HeadReader = (repoRoot: string) => Promise<HeadRead>;

/** How the repository's HEAD compares with the last commit the store recorded. */
export type HeadCheck = "matches" | "moved" | "unreadable";

export const readHead: HeadReader = async (repoRoot) => {
  const result = await runGitAsync(["rev-parse", "--verify", "-q", "HEAD^{commit}"], repoRoot);
  if (result.ok) return { state: "commit", commit: result.stdout };
  // With -q, an unborn HEAD is a silent exit 1; anything else (128, a timeout, no git) is a failure to read.
  if (result.status === 1 && result.stderr === "") return { state: "unborn" };
  return { state: "unreadable", detail: result.detail };
};

/** The newest `git_commit` event's commit, from events ordered newest first; the briefing's Provenance shows the same one. */
export function latestRecordedCommit(events: readonly Pick<BriefingEventRow, "type" | "payload">[]): string | null {
  for (const event of events) {
    if (event.type !== "git_commit") continue;
    const commit = commitOf(event.payload);
    if (commit !== null) return commit;
  }
  return null;
}

function commitOf(payload: string): string | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    const commit = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>).commit : undefined;
    return typeof commit === "string" && COMMIT_PATTERN.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

export function compareHead(head: HeadRead, recorded: string | null): HeadCheck {
  switch (head.state) {
    case "unreadable":
      return "unreadable";
    case "unborn":
      return recorded === null ? "matches" : "moved";
    case "commit":
      return recorded !== null && head.commit.startsWith(recorded) ? "matches" : "moved";
  }
}
