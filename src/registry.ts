import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { ProviderHomes } from "./adapters/homes.js";
import { refreshBriefing, type BriefingRefresh } from "./briefingFile.js";
import { readVoiceConfig } from "./config.js";
import { BridgeError, errorMessage } from "./errors.js";
import { runGit } from "./git.js";
import type { Reconciler } from "./reconcile.js";
import { discoverProjectSessions, type DiscoveryCounts } from "./sessions.js";
import type { ProjectStatus } from "./status.js";
import type { Store } from "./store.js";

export interface ProjectSummary {
  project_id: string;
  display_name: string;
  canonical_path: string;
}

export interface RegisterResult extends ProjectSummary, DiscoveryCounts {
  created: boolean;
}

export interface OpenedProject extends ProjectSummary {
  freshness: ProjectStatus["freshness"];
  /** True when the facts below may be out of date (`lagging` or `unverified`); a reconcile pass is under way. */
  uncertain: boolean;
  last_confirmed_activity: ProjectStatus["last_confirmed_activity"];
  /** The same text that is in the project's briefing file. */
  briefing: string;
  briefing_write: BriefingRefresh["write"];
  briefing_write_error: string | null;
}

function canonicalRepoRoot(inputPath: string): string {
  if (!inputPath || !path.isAbsolute(inputPath)) {
    throw new BridgeError("invalid_path", "path must be a non-empty absolute path");
  }
  let canonical: string;
  try {
    canonical = realpathSync.native(inputPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new BridgeError("path_not_found", `${inputPath} does not exist`);
    }
    throw error;
  }
  if (!statSync(canonical).isDirectory()) {
    throw new BridgeError("invalid_path", `${canonical} is not a directory`);
  }
  const git = runGit(["rev-parse", "--show-toplevel"], canonical);
  if (!git.ok) {
    if (git.notARepository) {
      throw new BridgeError("not_a_git_work_tree", `${canonical} is not inside a Git work tree`);
    }
    throw new BridgeError("git_failed", `git could not inspect ${canonical}: ${git.detail}`);
  }
  const toplevel = git.stdout;
  if (realpathSync.native(toplevel) !== canonical) {
    throw new BridgeError("not_work_tree_root", `${canonical} is not the root of its Git work tree (${toplevel})`);
  }
  return canonical;
}

/**
 * Path and config checks run before the write, and the store rejects id/path conflicts, so a
 * rejected registration stores nothing. Session discovery runs after the write: if it fails,
 * the project stays registered and the error says why its sessions could not be read.
 */
export async function registerProject(store: Store, inputPath: string, homes: ProviderHomes): Promise<RegisterResult> {
  const canonical = canonicalRepoRoot(inputPath);
  const config = readVoiceConfig(canonical);

  const { project, created } = store.upsert({
    project_id: config.project_id,
    display_name: config.display_name,
    canonical_path: canonical,
  });
  const discovered = await discoverProjectSessions(store, project, homes);
  return {
    project_id: project.project_id,
    display_name: project.display_name,
    canonical_path: project.canonical_path,
    created,
    ...discovered,
  };
}

export function listProjects(store: Store): ProjectSummary[] {
  return store.list().map(({ project_id, display_name, canonical_path }) => ({
    project_id,
    display_name,
    canonical_path,
  }));
}

/**
 * Answers from the store's last confirmed facts at once and starts a reconcile pass in the background;
 * it never waits on Git and never starts an agent.
 */
export function openProject(store: Store, projectId: string, reconciler: Reconciler): OpenedProject {
  const project = store.getById(projectId);
  if (!project) throw new BridgeError("project_not_found", `no project registered with id ${projectId}`);
  const briefing = refreshBriefing(store, projectId);
  reconciler.reconcile(projectId).catch((error: unknown) => {
    console.error(`voice-bridge: reconcile failed for ${projectId}: ${errorMessage(error)}`);
  });
  const { freshness } = briefing.status;
  return {
    project_id: project.project_id,
    display_name: project.display_name,
    canonical_path: project.canonical_path,
    freshness,
    uncertain: freshness === "lagging" || freshness === "unverified",
    last_confirmed_activity: briefing.status.last_confirmed_activity,
    briefing: briefing.text,
    briefing_write: briefing.write,
    briefing_write_error: briefing.error,
  };
}
