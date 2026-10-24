import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { resolveExecutable } from "./executable.js";

export type GitResult =
  | { ok: true; stdout: string }
  /**
   * `notARepository` is true only when git ran and reported that `cwd` is outside any repository.
   * `status` is git's exit code, or null when git did not run or did not exit on its own.
   */
  | { ok: false; notARepository: boolean; status: number | null; stderr: string; detail: string };

// git's own message; LC_ALL=C below keeps it untranslated.
const NOT_A_REPOSITORY = "fatal: not a git repository";
const GIT_NOT_FOUND = "ENOENT: git was not found in any absolute PATH entry";
const DEFAULT_ASYNC_TIMEOUT_MS = 5_000;

const execFileAsync = promisify(execFile);

/** Only absolute PATH entries count, so a repository's own `./git` is never the git that runs. */
export function resolveGit(): string | null {
  return resolveExecutable("git", process.env.PATH ?? "")?.binary ?? null;
}

/** Inherited GIT_* variables are dropped so they cannot point git at another repository. */
function gitEnv(): NodeJS.ProcessEnv {
  const inherited = Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"));
  return { ...Object.fromEntries(inherited), LC_ALL: "C" };
}

function failure(error: unknown): GitResult {
  const { status, stderr, code, message } = error as {
    status?: number | null;
    code?: string | number;
    stderr?: string;
    message: string;
  };
  // execFileSync reports the exit code as `status`; promisified execFile reports it as a numeric `code`.
  const exit = typeof status === "number" ? status : typeof code === "number" ? code : null;
  const text = stderr?.trim() ?? "";
  const firstLine = text.split("\n")[0];
  return {
    ok: false,
    notARepository: exit === 128 && firstLine?.startsWith(NOT_A_REPOSITORY) === true,
    status: exit,
    stderr: text,
    detail: firstLine || (typeof code === "string" ? `${code}: ${message}` : message),
  };
}

const notFound: GitResult = { ok: false, notARepository: false, status: null, stderr: "", detail: GIT_NOT_FOUND };

export function runGit(args: string[], cwd: string): GitResult {
  const git = resolveGit();
  if (git === null) return notFound;
  try {
    return { ok: true, stdout: execFileSync(git, args, { cwd, env: gitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() };
  } catch (error) {
    return failure(error);
  }
}

export async function runGitAsync(args: string[], cwd: string, { timeoutMs = DEFAULT_ASYNC_TIMEOUT_MS } = {}): Promise<GitResult> {
  const git = resolveGit();
  if (git === null) return notFound;
  try {
    const { stdout } = await execFileAsync(git, args, { cwd, env: gitEnv(), encoding: "utf8", timeout: timeoutMs });
    return { ok: true, stdout: stdout.trim() };
  } catch (error) {
    return failure(error);
  }
}
