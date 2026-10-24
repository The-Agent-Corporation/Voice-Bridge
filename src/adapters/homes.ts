import { statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { BridgeError } from "../errors.js";
import type { Provider } from "./types.js";

/** `explicit` marks a home named by an environment variable rather than the default under `~`. */
export interface ProviderHome {
  path: string;
  explicit: boolean;
}

export type ProviderHomes = Record<Provider, ProviderHome>;

export function resolveProviderHomes(env: NodeJS.ProcessEnv = process.env): ProviderHomes {
  const resolve = (override: string | undefined, fallback: string): ProviderHome =>
    override ? { path: path.resolve(override), explicit: true } : { path: path.join(homedir(), fallback), explicit: false };
  return {
    codex: resolve(env.VOICE_BRIDGE_CODEX_HOME, ".codex"),
    "claude-code": resolve(env.VOICE_BRIDGE_CLAUDE_HOME, ".claude"),
  };
}

/**
 * The folder to read a provider's saved records from. A missing default home is a provider
 * never used here and reads as empty; a missing home someone named explicitly is a typo or
 * an unmounted volume, so it fails rather than erasing the project's stored sessions.
 */
export function providerHomeDir(provider: Provider, home: ProviderHome): string {
  if (home.explicit && !statSync(home.path, { throwIfNoEntry: false })?.isDirectory()) {
    throw new BridgeError("session_discovery_failed", `the ${provider} home ${home.path} set in the environment is not a folder`);
  }
  return home.path;
}
