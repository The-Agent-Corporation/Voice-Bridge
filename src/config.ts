import { readFileSync } from "node:fs";
import path from "node:path";
import { PROVIDERS, type Provider } from "./adapters/types.js";
import { BridgeError } from "./errors.js";

export const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** A plain file name in the repository root: no separators, no `..`, no leading dot. */
const BRIEFING_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const DEFAULT_BRIEFING_FILE = "VOICE.md";
export const DEFAULT_MAX_BRIEFING_TOKENS = 800;
/** The floor leaves room for the briefing at its most cut-down render level. */
export const MIN_BRIEFING_TOKENS = 300;
export const MAX_BRIEFING_TOKENS = 8000;

export interface VoiceConfig {
  schema_version: 1;
  project_id: string;
  display_name: string;
  allowed_providers: Provider[];
  briefing_file: string;
  max_briefing_tokens: number;
}

export function voiceConfigPath(repoRoot: string): string {
  return path.join(repoRoot, ".voice", "config.json");
}

/** Reads and validates `<repoRoot>/.voice/config.json`. The file is never written. */
export function readVoiceConfig(repoRoot: string): VoiceConfig {
  const file = voiceConfigPath(repoRoot);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new BridgeError("config_not_found", `no .voice/config.json found at ${file}`);
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new BridgeError("config_invalid_json", `.voice/config.json is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BridgeError("config_invalid_json", ".voice/config.json must contain a JSON object");
  }
  const raw = parsed as Record<string, unknown>;

  if (raw.schema_version !== 1) {
    throw new BridgeError(
      "invalid_schema_version",
      `.voice/config.json schema_version must be 1, got ${JSON.stringify(raw.schema_version) ?? "nothing"}`,
    );
  }
  if (raw.project_id === undefined) {
    throw new BridgeError("missing_project_id", ".voice/config.json has no project_id");
  }
  if (typeof raw.project_id !== "string" || !PROJECT_ID_PATTERN.test(raw.project_id)) {
    throw new BridgeError(
      "invalid_project_id",
      "project_id must be 1-64 lowercase letters, digits or hyphens, starting with a letter or digit",
    );
  }
  if (typeof raw.display_name !== "string" || !raw.display_name.trim()) {
    throw new BridgeError("missing_display_name", ".voice/config.json needs a non-empty display_name");
  }

  return {
    schema_version: 1,
    project_id: raw.project_id,
    display_name: raw.display_name.trim(),
    allowed_providers: readAllowedProviders(raw.allowed_providers),
    briefing_file: readBriefingFile(raw.briefing_file),
    max_briefing_tokens: readMaxBriefingTokens(raw.max_briefing_tokens),
  };
}

function isProvider(value: unknown): value is Provider {
  return PROVIDERS.includes(value as Provider);
}

/** Absent means every V1 provider: discovery only reads saved records and grants no capability. */
function readAllowedProviders(value: unknown): Provider[] {
  if (value === undefined) return [...PROVIDERS];
  if (!Array.isArray(value) || !value.every(isProvider)) {
    throw new BridgeError(
      "invalid_allowed_providers",
      `allowed_providers must be an array of ${PROVIDERS.map((p) => JSON.stringify(p)).join(" or ")}`,
    );
  }
  return [...new Set(value)];
}

function readBriefingFile(value: unknown): string {
  if (value === undefined) return DEFAULT_BRIEFING_FILE;
  if (typeof value !== "string" || !BRIEFING_FILE_PATTERN.test(value) || value.includes("..")) {
    throw new BridgeError(
      "invalid_briefing_file",
      "briefing_file must be a plain file name in the repository root, such as \"VOICE.md\"",
    );
  }
  return value;
}

function readMaxBriefingTokens(value: unknown): number {
  if (value === undefined) return DEFAULT_MAX_BRIEFING_TOKENS;
  if (typeof value !== "number" || !Number.isInteger(value) || value < MIN_BRIEFING_TOKENS || value > MAX_BRIEFING_TOKENS) {
    throw new BridgeError(
      "invalid_max_briefing_tokens",
      `max_briefing_tokens must be an integer from ${MIN_BRIEFING_TOKENS} to ${MAX_BRIEFING_TOKENS}`,
    );
  }
  return value;
}
