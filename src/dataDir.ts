import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const APP_DIR_NAME = "voice-bridge";

export function resolveDataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const override = env.VOICE_BRIDGE_DATA_DIR;
  if (override) return path.resolve(override);
  if (platform === "darwin") return path.join(homedir(), "Library", "Application Support", APP_DIR_NAME);
  if (platform === "win32" && env.APPDATA) return path.join(env.APPDATA, APP_DIR_NAME);
  const xdg = env.XDG_DATA_HOME;
  return path.join(xdg ? xdg : path.join(homedir(), ".local", "share"), APP_DIR_NAME);
}

export function ensureDataDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}
