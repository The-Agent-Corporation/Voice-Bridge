import { execFileSync } from "node:child_process";

export type GitResult =
  | { ok: true; stdout: string }
  /** `notARepository` is true only when git ran and reported that `cwd` is outside any repository. */
  | { ok: false; notARepository: boolean; detail: string };

// git's own message; LC_ALL=C below keeps it untranslated.
const NOT_A_REPOSITORY = "fatal: not a git repository";

/** Runs git in `cwd`, ignoring inherited GIT_* variables that would point it at another repository. */
export function runGit(args: string[], cwd: string): GitResult {
  const inherited = Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"));
  const env = { ...Object.fromEntries(inherited), LC_ALL: "C" };
  try {
    return { ok: true, stdout: execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() };
  } catch (error) {
    const { status, stderr, code, message } = error as { status?: number | null; stderr?: string; code?: string; message: string };
    const firstLine = stderr?.trim().split("\n")[0];
    return {
      ok: false,
      notARepository: status === 128 && firstLine?.startsWith(NOT_A_REPOSITORY) === true,
      detail: firstLine || (code ? `${code}: ${message}` : message),
    };
  }
}
