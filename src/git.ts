import { execFileSync } from "node:child_process";

/** Runs git in `cwd`, ignoring inherited GIT_* variables that would point it at another repository. */
export function runGit(args: string[], cwd: string): string | null {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  try {
    return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}
