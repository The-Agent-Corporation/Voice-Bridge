import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

/** One provider process the probe started, as `probe` reports it. `reaped` is true once its whole process group is gone. */
export interface ChildRecord {
  pid: number;
  command: string[];
  reaped: boolean;
}

/** How a provider process ended. `pid` is null when it never started. */
export interface Ended {
  command: string[];
  pid: number | null;
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  stdout: string;
  stderr: string;
  /** Why the process could not be started, such as EACCES. */
  spawn_error?: string;
}

export interface LaunchOptions {
  env: Record<string, string>;
  cwd: string;
}

const REAP_DEADLINE_MS = 3_000;
const REAP_POLL_MS = 25;
const STDIO_CLOSE_WAIT_MS = 1_000;
const EXIT_WAIT_MS = 5_000;

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    // EPERM means a member exists that we may not signal: alive, and not ours to call gone.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * SIGKILLs the process group `pgid` and polls until no member is left. Waiting on the
 * leader is not enough: Codex's app-server leaves a grandchild running after it exits.
 */
export async function reapGroup(pgid: number): Promise<boolean> {
  try {
    process.kill(-pgid, "SIGKILL");
  } catch {
    // ESRCH: already gone. EPERM is caught by the poll below.
  }
  const deadline = Date.now() + REAP_DEADLINE_MS;
  while (groupAlive(pgid)) {
    if (Date.now() >= deadline) return false;
    await delay(REAP_POLL_MS);
  }
  return true;
}

/** `promise`'s value, or undefined once `ms` has passed. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    void promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

class Launched {
  readonly child: ChildProcess;
  readonly exited: Promise<void>;
  readonly stdioClosed: Promise<void>;
  exitCode: number | null = null;
  signal: string | null = null;
  spawnError: string | undefined;
  stdout = "";
  stderr = "";

  /** Every child leads its own process group (`detached`), so `reapGroup` can take its descendants with it. */
  constructor(readonly command: string[], { env, cwd }: LaunchOptions, withStdin: boolean) {
    const [file, ...args] = command;
    if (file === undefined || !file.startsWith("/")) throw new Error(`refusing to run a provider by bare name: ${file}`);
    this.child = spawn(file, args, { env, cwd, detached: true, stdio: [withStdin ? "pipe" : "ignore", "pipe", "pipe"] });
    this.child.stdin?.on("error", () => {
      // EPIPE once the provider has exited; the exit is what gets reported.
    });
    this.child.stderr!.on("data", (chunk: Buffer) => (this.stderr += chunk.toString()));
    this.exited = new Promise((resolve) => {
      this.child.once("exit", (code, signal) => {
        this.exitCode = code;
        this.signal = signal;
        resolve();
      });
      this.child.once("error", (error) => {
        this.spawnError ??= error.message;
        if (this.child.pid === undefined) resolve();
      });
    });
    this.stdioClosed = new Promise((resolve) => this.child.once("close", () => resolve()));
  }

  /**
   * Waits up to `waitMs` for the leader to exit, then always reaps the group and records
   * the child. Waits on `exit`, not `close`: a grandchild holding stdout open would keep
   * `close` from ever firing.
   */
  async settle(waitMs: number, children: ChildRecord[]): Promise<Ended> {
    const timedOut = (await within(this.exited.then(() => true), waitMs)) === undefined;
    const pid = this.child.pid ?? null;
    if (pid !== null) {
      const reaped = await reapGroup(pid);
      await within(this.exited, STDIO_CLOSE_WAIT_MS);
      await within(this.stdioClosed, STDIO_CLOSE_WAIT_MS);
      children.push({ pid, command: this.command, reaped });
    }
    return {
      command: this.command,
      pid,
      exit_code: this.exitCode,
      signal: this.signal,
      timed_out: pid !== null && timedOut,
      stdout: this.stdout,
      stderr: this.stderr,
      ...(this.spawnError === undefined ? {} : { spawn_error: this.spawnError }),
    };
  }
}

/** Runs `command` (absolute argv) with stdin closed until it exits or `timeoutMs` passes, then reaps its group. */
export function runToExit(
  command: string[],
  options: LaunchOptions & { timeoutMs: number },
  children: ChildRecord[],
): Promise<Ended> {
  const launched = new Launched(command, options, false);
  launched.child.stdout!.on("data", (chunk: Buffer) => (launched.stdout += chunk.toString()));
  return launched.settle(options.timeoutMs, children);
}

/** A long-lived provider process spoken to line by line over stdio. */
export interface Session {
  onLine(listener: (line: string) => void): void;
  /** Fires once stdout has ended, or the process could not start. */
  onClosed(listener: () => void): void;
  write(message: unknown): void;
  /** Closes stdin, waits a bounded time for exit, then reaps the group. */
  finish(): Promise<Ended>;
}

export function startSession(command: string[], options: LaunchOptions, children: ChildRecord[]): Session {
  const launched = new Launched(command, options, true);
  const lines = createInterface({ input: launched.child.stdout! });
  const closed = new Promise<void>((resolve) => lines.once("close", () => resolve()));
  return {
    onLine: (listener) => lines.on("line", listener),
    onClosed: (listener) => void closed.then(listener),
    write: (message) => {
      if (launched.child.stdin?.writable) launched.child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    finish: () => {
      launched.child.stdin?.end();
      return launched.settle(EXIT_WAIT_MS, children);
    },
  };
}
