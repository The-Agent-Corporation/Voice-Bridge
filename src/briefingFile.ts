import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomicFile.js";
import { loadBriefingState, renderBriefing, type BriefingState } from "./briefing.js";
import { DEFAULT_MAX_BRIEFING_TOKENS, readVoiceConfig, type VoiceConfig } from "./config.js";
import { BridgeError } from "./errors.js";
import type { HeadCheck } from "./head.js";
import type { ProjectStatus } from "./status.js";
import type { Project, Store } from "./store.js";

/** The generation time the content hash is rendered with, so the wall clock never changes the hash. */
const HASH_GENERATED_AT = new Date(0).toISOString();

export interface BriefingRefresh {
  text: string;
  write: "written" | "unchanged" | "failed";
  /** Why the file was not written, when `write` is `failed`. */
  error: string | null;
  /** The status the text was rendered from, so callers report the same freshness the text states. */
  status: BriefingState["status"];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readFileIfPresent(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function requireProject(store: Store, projectId: string): Project {
  const project = store.getById(projectId);
  if (!project) throw new BridgeError("project_not_found", `no project registered with id ${projectId}`);
  return project;
}

/** The project's configured budget, or the default when its config cannot be read. */
function readBudget(project: Project): { config: VoiceConfig } | { config: null; error: string } {
  try {
    return { config: readVoiceConfig(project.canonical_path) };
  } catch (error) {
    return { config: null, error: errorMessage(error) };
  }
}

/**
 * Renders the project's briefing from the store and writes it to `<repo>/<briefing_file>`, unless the
 * stored content hash matches and the file still holds the stored text. The file is written before the
 * record is saved, so a crash between the two only causes a harmless rewrite on the next refresh.
 * Every outcome that rendered, including a failed write, records the highest event it rendered from:
 * a failed write is reported on its own, not as events still waiting for a refresh.
 *
 * The daemon is the only writer, and every step here is synchronous, so one refresh runs to completion
 * before any other request's refresh starts: that is what serializes updates per project. If any step
 * ever becomes asynchronous, refreshes must go through an explicit per-project queue instead.
 */
export function refreshBriefing(store: Store, projectId: string, options: { head?: HeadCheck } = {}): BriefingRefresh {
  const project = requireProject(store, projectId);
  const state = loadBriefingState(store, project, options);
  const { status } = state;
  const rendered = (refresh: BriefingRefresh): BriefingRefresh => {
    if (state.highest_event_id !== null) store.saveRefreshMark(projectId, state.highest_event_id);
    return refresh;
  };

  const budget = readBudget(project);
  if (budget.config === null) {
    // With no readable config there is no file to write, but open_project can still answer.
    const text = renderBriefing(state, { maxTokens: DEFAULT_MAX_BRIEFING_TOKENS, generatedAt: new Date().toISOString() });
    return rendered({ text, write: "failed", error: budget.error, status });
  }
  const { config } = budget;

  const render = (generatedAt: string) => renderBriefing(state, { maxTokens: config.max_briefing_tokens, generatedAt });
  const contentHash = createHash("sha256").update(render(HASH_GENERATED_AT)).digest("hex");

  const stored = store.getBriefing(projectId);
  const file = path.join(project.canonical_path, config.briefing_file);
  if (stored?.content_hash === contentHash && readFileIfPresent(file) === stored.text) {
    return rendered({ text: stored.text, write: "unchanged", error: null, status });
  }

  const generatedAt = new Date().toISOString();
  const text = render(generatedAt);
  try {
    writeFileAtomic(file, text);
  } catch (error) {
    return rendered({ text, write: "failed", error: errorMessage(error), status });
  }
  store.saveBriefing({ project_id: projectId, content_hash: contentHash, text, generated_at: generatedAt });
  return rendered({ text, write: "written", error: null, status });
}

/** The briefing text as it stands, stating `status`, without writing the file or marking anything refreshed. */
export function previewBriefing(store: Store, projectId: string, status: ProjectStatus): string {
  const project = requireProject(store, projectId);
  const state = { ...loadBriefingState(store, project), status };
  const maxTokens = readBudget(project).config?.max_briefing_tokens ?? DEFAULT_MAX_BRIEFING_TOKENS;
  return renderBriefing(state, { maxTokens, generatedAt: new Date().toISOString() });
}
