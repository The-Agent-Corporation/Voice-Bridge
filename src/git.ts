import { execFile, execFileSync } from "node:child_process";
import { resolveExecutable } from "./executable.js";

export type GitResult =
  | { ok: true; stdout: string }
  /** `notARepository` is true only when git ran and reported that `cwd` is outside any repository. */
  | { ok: false; notARepository: boolean; detail: string };

/** `head` is null in a repository with no commits yet. */
export type HeadRead = { ok: true; head: string | null } | { ok: false; detail: string };

export const GIT_HEAD_TIMEOUT_MS = 5_000;

// git's own message; LC_ALL=C below keeps it untranslated.
const NOT_A_REPOSITORY = "fatal: not a git repository";
const GIT_NOT_FOUND = "git was not found in any absolute PATH entry";
export const READ_HEAD_ARGS = ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"] as const;

/** Resolved on every call, from absolute PATH entries only, so a stale or caller-relative git never runs. */
export function gitBinary(): string | null {
  return resolveExecutable("git", process.env.PATH ?? "")?.binary ?? null;
}

/** Inherited GIT_* variables would point git at another repository. */
function gitEnv(): NodeJS.ProcessEnv {
  const inherited = Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"));
  return { ...Object.fromEntries(inherited), LC_ALL: "C" };
}

interface GitFailure {
  status?: number | null;
  stderr?: string;
  code?: string | number;
  message: string;
}

function failureDetail({ stderr, code, message }: GitFailure): string {
  return stderr?.trim().split("\n")[0] || (code ? `${code}: ${message}` : message);
}

/** Runs git in `cwd`, ignoring inherited GIT_* variables. */
export function runGit(args: string[], cwd: string): GitResult {
  const binary = gitBinary();
  if (binary === null) return { ok: false, notARepository: false, detail: GIT_NOT_FOUND };
  try {
    return { ok: true, stdout: execFileSync(binary, args, { cwd, env: gitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() };
  } catch (error) {
    const failure = error as GitFailure;
    return {
      ok: false,
      notARepository: failure.status === 128 && failure.stderr?.trim().startsWith(NOT_A_REPOSITORY) === true,
      detail: failureDetail(failure),
    };
  }
}

/** Asynchronous, so the daemon keeps serving while it runs; read-only. */
export function readHead(cwd: string): Promise<HeadRead> {
  const binary = gitBinary();
  if (binary === null) return Promise.resolve({ ok: false, detail: GIT_NOT_FOUND });
  return new Promise((resolve) => {
    execFile(
      binary,
      [...READ_HEAD_ARGS],
      { cwd, env: gitEnv(), encoding: "utf8", timeout: GIT_HEAD_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (!error) return resolve({ ok: true, head: stdout.trim() });
        // --verify --quiet exits 1 silently when HEAD names no commit: an unborn branch.
        if (error.code === 1 && !stdout.trim() && !stderr.trim()) return resolve({ ok: true, head: null });
        resolve({ ok: false, detail: failureDetail({ stderr, code: error.killed ? "timeout" : error.code, message: error.message }) });
      },
    );
  });
}
