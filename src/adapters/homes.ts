import { homedir } from "node:os";
import path from "node:path";
import type { Provider } from "./types.js";

export type ProviderHomes = Record<Provider, string>;

export function resolveProviderHomes(env: NodeJS.ProcessEnv = process.env): ProviderHomes {
  const resolve = (override: string | undefined, fallback: string) =>
    override ? path.resolve(override) : path.join(homedir(), fallback);
  return {
    codex: resolve(env.VOICE_BRIDGE_CODEX_HOME, ".codex"),
    "claude-code": resolve(env.VOICE_BRIDGE_CLAUDE_HOME, ".claude"),
  };
}
