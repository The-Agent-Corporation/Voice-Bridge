import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { ProviderHomes } from "./adapters/homes.js";
import { previewBriefing, refreshBriefing, type BriefingRefresh } from "./briefingFile.js";
import { readVoiceConfig } from "./config.js";
import { BridgeError } from "./errors.js";
import { runGit } from "./git.js";
import type { HeadReader } from "./head.js";
import type { Reconciler } from "./reconcile.js";
import { discoverProjectSessions, type DiscoveryCounts } from "./sessions.js";
import { getLiveHeadCheck, getProjectStatus, type ProjectStatus } from "./status.js";
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
  freshness_reasons: ProjectStatus["freshness_reasons"];
  /** True when the project is `lagging` or `unverified`: the briefing holds the last confirmed facts only. */
  uncertain: boolean;
  last_confirmed_activity: ProjectStatus["last_confirmed_activity"];
  /** The same text that is in the project's briefing file, unless `briefing_write` is `deferred`. */
  briefing: string;
  /** `deferred` when the project is uncertain: the reconciliation open started writes the file instead. */
  briefing_write: BriefingRefresh["write"] | "deferred";
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
 * Answers from what the store has confirmed. An uncertain project is answered without writing its
 * briefing, and its reconciliation is started but never awaited, so the only wait is the HEAD read.
 */
export async function openProject(
  store: Store,
  projectId: string,
  { reconciler, readHead }: { reconciler: Reconciler; readHead: HeadReader },
): Promise<OpenedProject> {
  const project = store.getById(projectId);
  if (!project) throw new BridgeError("project_not_found", `no project registered with id ${projectId}`);
  const head = await getLiveHeadCheck(store, projectId, readHead);
  const status = getProjectStatus(store, projectId, { head });
  const uncertain = status.freshness === "lagging" || status.freshness === "unverified";
  const summary = {
    project_id: project.project_id,
    display_name: project.display_name,
    canonical_path: project.canonical_path,
  };
  if (uncertain) {
    reconciler.trigger(projectId);
    return {
      ...summary,
      freshness: status.freshness,
      freshness_reasons: status.freshness_reasons,
      uncertain,
      last_confirmed_activity: status.last_confirmed_activity,
      briefing: previewBriefing(store, projectId, status),
      briefing_write: "deferred",
      briefing_write_error: null,
    };
  }
  const briefing = refreshBriefing(store, projectId, { head });
  return {
    ...summary,
    freshness: briefing.status.freshness,
    freshness_reasons: briefing.status.freshness_reasons,
    uncertain,
    last_confirmed_activity: briefing.status.last_confirmed_activity,
    briefing: briefing.text,
    briefing_write: briefing.write,
    briefing_write_error: briefing.error,
  };
}
