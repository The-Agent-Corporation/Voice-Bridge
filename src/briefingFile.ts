import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./atomicFile.js";
import { loadBriefingState, renderBriefing, type BriefingState } from "./briefing.js";
import { DEFAULT_MAX_BRIEFING_TOKENS, readVoiceConfig, type VoiceConfig } from "./config.js";
import { BridgeError } from "./errors.js";
import type { Store } from "./store.js";

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

/**
 * Renders the project's briefing from the store and writes it to `<repo>/<briefing_file>`, unless the
 * stored content hash matches and the file still holds the stored text. The file is written before the
 * record is saved, so a crash between the two only causes a harmless rewrite on the next refresh.
 *
 * The daemon is the only writer, and every step here is synchronous, so one refresh runs to completion
 * before any other request's refresh starts: that is what serializes updates per project. If any step
 * ever becomes asynchronous, refreshes must go through an explicit per-project queue instead.
 */
export function refreshBriefing(store: Store, projectId: string): BriefingRefresh {
  const project = store.getById(projectId);
  if (!project) throw new BridgeError("project_not_found", `no project registered with id ${projectId}`);

  const state = loadBriefingState(store, project);
  const { status } = state;
  let config: VoiceConfig;
  try {
    config = readVoiceConfig(project.canonical_path);
  } catch (error) {
    // With no readable config there is no file to write, but open_project can still answer.
    const text = renderBriefing(state, { maxTokens: DEFAULT_MAX_BRIEFING_TOKENS, generatedAt: new Date().toISOString() });
    return { text, write: "failed", error: errorMessage(error), status };
  }

  const render = (generatedAt: string) => renderBriefing(state, { maxTokens: config.max_briefing_tokens, generatedAt });
  const contentHash = createHash("sha256").update(render(HASH_GENERATED_AT)).digest("hex");

  const stored = store.getBriefing(projectId);
  const file = path.join(project.canonical_path, config.briefing_file);
  if (stored?.content_hash === contentHash && readFileIfPresent(file) === stored.text) {
    return { text: stored.text, write: "unchanged", error: null, status };
  }

  const generatedAt = new Date().toISOString();
  const text = render(generatedAt);
  try {
    writeFileAtomic(file, text);
  } catch (error) {
    return { text, write: "failed", error: errorMessage(error), status };
  }
  store.saveBriefing({ project_id: projectId, content_hash: contentHash, text, generated_at: generatedAt });
  return { text, write: "written", error: null, status };
}
