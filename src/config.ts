import { readFileSync } from "node:fs";
import path from "node:path";
import { BridgeError } from "./errors.js";

export const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface VoiceConfig {
  schema_version: 1;
  project_id: string;
  display_name: string;
  raw: Record<string, unknown>;
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

  return { schema_version: 1, project_id: raw.project_id, display_name: raw.display_name.trim(), raw };
}
