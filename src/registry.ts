import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { buildBriefing, type Briefing } from "./briefing.js";
import { readVoiceConfig } from "./config.js";
import { BridgeError } from "./errors.js";
import { runGit } from "./git.js";
import type { Store } from "./store.js";

export interface ProjectSummary {
  project_id: string;
  display_name: string;
  canonical_path: string;
}

export interface RegisterResult extends ProjectSummary {
  created: boolean;
}

export interface OpenedProject extends ProjectSummary {
  freshness: Briefing["freshness"];
  last_confirmed_activity: Briefing["last_confirmed_activity"];
  briefing: string;
}

function canonicalRepoRoot(inputPath: string): string {
  if (!inputPath || !path.isAbsolute(inputPath)) {
    throw new BridgeError("invalid_path", "path must be a non-empty absolute path");
  }
  let canonical: string;
  try {
    canonical = realpathSync(inputPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new BridgeError("path_not_found", `${inputPath} does not exist`);
    }
    throw error;
  }
  if (!statSync(canonical).isDirectory()) {
    throw new BridgeError("invalid_path", `${canonical} is not a directory`);
  }
  const toplevel = runGit(["rev-parse", "--show-toplevel"], canonical);
  if (!toplevel) {
    throw new BridgeError("not_a_git_work_tree", `${canonical} is not inside a Git work tree`);
  }
  if (realpathSync(toplevel) !== canonical) {
    throw new BridgeError("not_work_tree_root", `${canonical} is not the root of its Git work tree (${toplevel})`);
  }
  return canonical;
}

/** Every check runs before the single write, so a rejected registration stores nothing. */
export function registerProject(store: Store, inputPath: string): RegisterResult {
  const canonical = canonicalRepoRoot(inputPath);
  const config = readVoiceConfig(canonical);

  const sameId = store.getById(config.project_id);
  if (sameId && sameId.canonical_path !== canonical) {
    throw new BridgeError(
      "project_id_conflict",
      `project_id ${config.project_id} is already registered at ${sameId.canonical_path}`,
    );
  }
  const samePath = store.getByPath(canonical);
  if (samePath && samePath.project_id !== config.project_id) {
    throw new BridgeError(
      "path_already_registered",
      `${canonical} is already registered as ${samePath.project_id}`,
    );
  }

  const stored = store.upsert({
    project_id: config.project_id,
    display_name: config.display_name,
    canonical_path: canonical,
    config: config.raw,
  });
  return {
    project_id: stored.project_id,
    display_name: stored.display_name,
    canonical_path: stored.canonical_path,
    created: sameId === undefined,
  };
}

export function listProjects(store: Store): ProjectSummary[] {
  return store.list().map(({ project_id, display_name, canonical_path }) => ({
    project_id,
    display_name,
    canonical_path,
  }));
}

export function openProject(store: Store, projectId: string): OpenedProject {
  const project = store.getById(projectId);
  if (!project) throw new BridgeError("project_not_found", `no project registered with id ${projectId}`);
  const briefing = buildBriefing(project);
  return {
    project_id: project.project_id,
    display_name: project.display_name,
    canonical_path: project.canonical_path,
    freshness: briefing.freshness,
    last_confirmed_activity: briefing.last_confirmed_activity,
    briefing: briefing.text,
  };
}
