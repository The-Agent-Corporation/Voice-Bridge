import path from "node:path";
import { PROVIDERS, type Provider } from "./adapters/types.js";
import { PROJECT_ID_PATTERN } from "./config.js";
import { VOICE_MD_FILE } from "./voiceMd.js";

/** `.voice/manifest.json`, the checked-in file that installs the plug-in in a folder (MISSION.md). */
export const MANIFEST_SCHEMA = "voice-manifest/0.1";

export interface VoiceManifest {
  schema: typeof MANIFEST_SCHEMA;
  folder_id: string;
  name: string;
  aliases: string[];
  /** Always `voice.md`, so a manifest cannot point the voice agent outside its folder. */
  briefing: typeof VOICE_MD_FILE;
  agent: { id: string; kind: Provider; follow_along: boolean };
}

export type FolderErrorCode =
  | "path_not_found"
  | "invalid_path"
  | "invalid_folder_id"
  | "manifest_invalid"
  | "manifest_has_secret"
  | "manifest_id_mismatch"
  | "starter_voice_md_invalid"
  | "folder_id_conflict";

/** A folder that cannot be installed or read as it stands; the CLI reports it and writes nothing. */
export class FolderError extends Error {
  constructor(
    readonly code: FolderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FolderError";
  }
}

export function manifestPath(folder: string): string {
  return path.join(folder, ".voice", "manifest.json");
}

export function buildManifest({ folderId, name }: { folderId: string; name: string }): VoiceManifest {
  return {
    schema: MANIFEST_SCHEMA,
    folder_id: folderId,
    name,
    aliases: [name.toLowerCase()],
    briefing: VOICE_MD_FILE,
    agent: { id: `${folderId}-main`, kind: "codex", follow_along: false },
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** Validates a manifest's text; the first rule it breaks is the `manifest_invalid` message. */
export function parseManifest(text: string): VoiceManifest {
  const invalid = (reason: string) => new FolderError("manifest_invalid", reason);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw invalid(`not valid JSON: ${(error as Error).message}`);
  }
  if (!isObject(raw)) throw invalid("must contain a JSON object");
  if (raw.schema !== MANIFEST_SCHEMA) throw invalid(`schema must be "${MANIFEST_SCHEMA}"`);
  if (typeof raw.folder_id !== "string" || !PROJECT_ID_PATTERN.test(raw.folder_id)) {
    throw invalid("folder_id must be 1-64 lowercase letters, digits or hyphens, starting with a letter or digit");
  }
  if (!isNonEmptyString(raw.name)) throw invalid("name must be a non-empty string");
  if (!Array.isArray(raw.aliases) || !raw.aliases.every(isNonEmptyString)) {
    throw invalid("aliases must be a list of non-empty strings");
  }
  if (raw.briefing !== VOICE_MD_FILE) throw invalid(`briefing must be "${VOICE_MD_FILE}"`);
  const agent = raw.agent;
  if (!isObject(agent) || !isNonEmptyString(agent.id)) throw invalid("agent must be an object with a non-empty id");
  const kind = PROVIDERS.find((provider) => provider === agent.kind);
  if (!kind) throw invalid(`agent.kind must be one of ${PROVIDERS.join(", ")}`);
  if (typeof agent.follow_along !== "boolean") throw invalid("agent.follow_along must be true or false");
  return {
    schema: MANIFEST_SCHEMA,
    folder_id: raw.folder_id,
    name: raw.name,
    aliases: raw.aliases,
    briefing: VOICE_MD_FILE,
    agent: { id: agent.id, kind, follow_along: agent.follow_along },
  };
}
