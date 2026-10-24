import path from "node:path";
import { fileURLToPath } from "node:url";
import { runGit } from "./git.js";

export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function resolveBuildId(env: NodeJS.ProcessEnv, packageRoot: string = PACKAGE_ROOT): string | null {
  const candidate = env.FACTORY_RUNTIME_CANDIDATE;
  if (candidate) return candidate;
  const head = runGit(["rev-parse", "HEAD"], packageRoot);
  return head.ok && head.stdout ? head.stdout : null;
}
