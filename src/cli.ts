#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { daemonInfoPath, LISTEN_ADDRESS, type DaemonInfo } from "./app.js";
import { resolveDataDir } from "./dataDir.js";
import { runProbe } from "./probe.js";
import type { OpenedProject, ProjectSummary, RegisterResult } from "./registry.js";
import type { SessionList } from "./sessions.js";
import { readClientToken } from "./token.js";

const USAGE = `usage:
  voice-bridge register <path>
  voice-bridge projects
  voice-bridge open <project_id>
  voice-bridge sessions <project_id>
  voice-bridge probe`;

class CliError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const REQUEST_TIMEOUT_MS = 15_000;

/** Signal 0 only probes; it fails for a dead pid, and for another user's process, which cannot be our daemon. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The port is trusted only while its recorded pid lives, so the token never goes to a port a dead daemon left behind. */
function readDaemonPort(dataDir: string): number {
  let info: Partial<DaemonInfo> = {};
  try {
    info = JSON.parse(readFileSync(daemonInfoPath(dataDir), "utf8")) as Partial<DaemonInfo>;
  } catch {
    // Treated the same as a daemon that never started.
  }
  if (typeof info.port === "number" && typeof info.pid === "number" && isRunning(info.pid)) return info.port;
  throw new CliError("daemon_not_running", `no running daemon found for ${dataDir}`);
}

function requestFailure(error: unknown, address: string): CliError {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return new CliError(
      "daemon_timeout",
      `the daemon at ${address} did not answer within ${REQUEST_TIMEOUT_MS / 1000} s; the request may still have been applied`,
    );
  }
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  if (cause?.code === "ECONNREFUSED") {
    return new CliError("daemon_not_running", `nothing is listening on ${address}`);
  }
  const reason = cause ? `${cause.code ?? "error"}: ${cause.message}` : String(error);
  return new CliError(
    "daemon_request_failed",
    `the request to ${address} failed (${reason}); it may or may not have been applied`,
  );
}

async function callTool<T>(tool: string, body: Record<string, unknown>): Promise<T> {
  const dataDir = resolveDataDir(process.env);
  const port = readDaemonPort(dataDir);
  const token = readClientToken(dataDir);
  const address = `${LISTEN_ADDRESS}:${port}`;
  let response: Response;
  let payload: T & { error?: { code: string; message: string } };
  try {
    response = await fetch(`http://${address}/tools/${tool}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    payload = (await response.json()) as typeof payload;
  } catch (error) {
    throw requestFailure(error, address);
  }
  if (!response.ok) {
    throw new CliError(payload.error?.code ?? "http_error", payload.error?.message ?? `HTTP ${response.status}`);
  }
  return payload;
}

async function run(args: string[]): Promise<number> {
  const [command, arg, ...rest] = args;
  if (command === "register" && arg && rest.length === 0) {
    const result = await callTool<RegisterResult>("register_project", { path: path.resolve(arg) });
    const verb = result.created ? "registered" : "already registered";
    console.log(`${verb} ${result.project_id} (${result.display_name}) at ${result.canonical_path}`);
    const skipped = result.skipped_records > 0 ? `, skipped ${result.skipped_records} unreadable record(s)` : "";
    console.log(`found ${result.sessions} saved session(s)${skipped}`);
    return 0;
  }
  if (command === "projects" && arg === undefined) {
    const { projects } = await callTool<{ projects: ProjectSummary[] }>("list_projects", {});
    if (projects.length === 0) console.log("no projects registered");
    for (const p of projects) console.log(`${p.project_id}\t${p.display_name}\t${p.canonical_path}`);
    return 0;
  }
  if (command === "open" && arg && rest.length === 0) {
    const project = await callTool<OpenedProject>("open_project", { project_id: arg });
    console.log(project.display_name);
    console.log(`freshness: ${project.freshness}`);
    console.log(project.briefing);
    return 0;
  }
  if (command === "sessions" && arg && rest.length === 0) {
    const { sessions, skipped_records } = await callTool<SessionList>("list_sessions", { project_id: arg });
    if (sessions.length === 0) console.log("no saved sessions found");
    for (const s of sessions) {
      console.log([s.provider, s.native_session_id, s.observed_state, s.last_activity_at ?? "-", s.worktree_id].join("\t"));
    }
    if (skipped_records > 0) console.log(`skipped_records: ${skipped_records}`);
    return 0;
  }
  if (command === "probe" && arg === undefined) {
    const report = await runProbe();
    console.log(JSON.stringify(report, null, 2));
    // A provider process that outlived the probe is a broken guarantee, so it fails the command.
    return report.children.every((child) => child.reaped) ? 0 : 1;
  }
  console.error(USAGE);
  return 2;
}

run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    const code = (error as { code?: unknown }).code;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`voice-bridge: ${typeof code === "string" ? `${code}: ` : ""}${message}`);
    process.exit(1);
  },
);
