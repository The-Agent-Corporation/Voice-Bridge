import { realpathSync } from "node:fs";
import { createClaudeCodeAdapter } from "./adapters/claudeCode.js";
import { createCodexAdapter } from "./adapters/codex.js";
import type { ProviderHomes } from "./adapters/homes.js";
import type { AgentAdapter, DiscoveredSession, Provider, Worktree } from "./adapters/types.js";
import { readVoiceConfig } from "./config.js";
import { BridgeError } from "./errors.js";
import { runGit } from "./git.js";
import { sessionId, type Project, type Store, type StoredSession } from "./store.js";

const ADAPTERS: Record<Provider, (home: string) => AgentAdapter> = {
  codex: createCodexAdapter,
  "claude-code": createClaudeCodeAdapter,
};

export interface DiscoveryCounts {
  sessions: number;
  skipped_records: number;
}

export interface SessionList {
  project_id: string;
  sessions: StoredSession[];
  skipped_records: number;
}

/** Paths of the non-bare work trees in `git worktree list --porcelain -z` output. */
function worktreePaths(porcelain: string): string[] {
  const paths: string[] = [];
  let current: string | undefined;
  let bare = false;
  for (const field of [...porcelain.split("\0"), ""]) {
    if (field === "") {
      if (current !== undefined && !bare) paths.push(current);
      current = undefined;
      bare = false;
    } else if (field.startsWith("worktree ")) {
      current = field.slice("worktree ".length);
    } else if (field === "bare") {
      bare = true;
    }
  }
  return paths;
}

/**
 * The project's own root plus its linked Git worktrees, each identified by its canonical
 * root. A worktree registered as a project of its own is left to that project.
 */
export function projectWorktrees(store: Store, project: Project): Worktree[] {
  const git = runGit(["worktree", "list", "--porcelain", "-z"], project.canonical_path);
  if (!git.ok) throw new BridgeError("git_failed", `git could not list worktrees of ${project.canonical_path}: ${git.detail}`);

  const otherRoots = new Set(store.list().map((p) => p.canonical_path));
  otherRoots.delete(project.canonical_path);
  const roots = new Set([project.canonical_path]);
  for (const listed of worktreePaths(git.stdout)) {
    let root: string;
    try {
      root = realpathSync.native(listed);
    } catch {
      continue; // A worktree git still lists but whose folder is gone.
    }
    if (!otherRoots.has(root)) roots.add(root);
  }
  return [...roots].map((root) => ({ id: root, path: root }));
}

/** One row per session id; a record saved twice keeps its most recent copy. */
function uniqueSessions(sessions: DiscoveredSession[]): DiscoveredSession[] {
  const byId = new Map<string, DiscoveredSession>();
  for (const session of sessions) {
    const id = sessionId(session.provider, session.native_session_id);
    const kept = byId.get(id);
    if (!kept || (session.last_activity_at ?? "") > (kept.last_activity_at ?? "")) byId.set(id, session);
  }
  return [...byId.values()];
}

/**
 * Reads the allowed providers' saved records and replaces the project's stored sessions
 * with the ones that belong to it. Nothing is stored unless every provider was read.
 */
export async function discoverProjectSessions(store: Store, project: Project, homes: ProviderHomes): Promise<DiscoveryCounts> {
  const config = readVoiceConfig(project.canonical_path);
  const worktrees = projectWorktrees(store, project);
  const results = await Promise.all(
    config.allowed_providers.map((provider) => ADAPTERS[provider](homes[provider]).discoverSessions(worktrees)),
  );
  const sessions = uniqueSessions(results.flatMap((result) => result.sessions));
  store.replaceSessions(project.project_id, sessions);
  return {
    sessions: sessions.length,
    skipped_records: results.reduce((sum, result) => sum + result.skipped_records, 0),
  };
}

export async function listSessions(store: Store, projectId: string, homes: ProviderHomes): Promise<SessionList> {
  const project = store.getById(projectId);
  if (!project) throw new BridgeError("project_not_found", `no project registered with id ${projectId}`);
  const { skipped_records } = await discoverProjectSessions(store, project, homes);
  return { project_id: project.project_id, sessions: store.listSessions(project.project_id), skipped_records };
}
