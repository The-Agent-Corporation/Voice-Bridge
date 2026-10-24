import { accessSync, constants, realpathSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Finds `name` on `pathValue` the way a shell would, but only in absolute entries: a
 * relative entry resolves against whatever the cwd is, which the caller controls.
 * Returns the PATH hit and its realpath, which is what callers execute.
 */
export function resolveExecutable(name: string, pathValue: string): { found_on_path: string; binary: string } | null {
  for (const entry of pathValue.split(path.delimiter)) {
    if (!path.isAbsolute(entry)) continue;
    const candidate = path.join(entry, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return { found_on_path: candidate, binary: realpathSync(candidate) };
    } catch {
      continue;
    }
  }
  return null;
}
