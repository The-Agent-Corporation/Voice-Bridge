#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { daemonInfoPath, LISTEN_ADDRESS, type DaemonInfo } from "./app.js";
import { Conversation } from "./chat.js";
import { resolveDataDir } from "./dataDir.js";
import type { PrimaryResult } from "./primary.js";
import { runProbe } from "./probe.js";
import type { OpenedProject, ProjectSummary, RegisterResult } from "./registry.js";
import { runSessionHost } from "./sessionHost.js";
import type { SessionList } from "./sessions.js";
import type { ProjectStatus } from "./status.js";
import type { InboxItem } from "./store.js";
import { readClientToken } from "./token.js";

const USAGE = `usage:
  voice-bridge --help | -h | help
  voice-bridge register <path>
  voice-bridge projects
  voice-bridge open <project_id>
  voice-bridge sessions <project_id>
  voice-bridge primary <project_id>
  voice-bridge primary <project_id> --pin <session_id>
  voice-bridge primary <project_id> --unpin
  voice-bridge status <project_id> [--why]
  voice-bridge inbox [--project <project_id>] [--status <status>]
  voice-bridge probe
  voice-bridge session start <project_id> --provider <provider>
  voice-bridge chat`;

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

function primaryRequest(projectId: string, rest: string[]): { tool: string; body: Record<string, string> } | undefined {
  if (rest.length === 0) return { tool: "get_primary_session", body: { project_id: projectId } };
  if (rest.length === 1 && rest[0] === "--unpin") return { tool: "unpin_primary", body: { project_id: projectId } };
  if (rest.length === 2 && rest[0] === "--pin" && rest[1]) {
    return { tool: "pin_primary", body: { project_id: projectId, session_id: rest[1] } };
  }
  return undefined;
}

const INBOX_FLAGS: Record<string, string> = { "--project": "project_id", "--status": "status" };

function inboxRequest(args: string[]): Record<string, string> | undefined {
  const body: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const field = Object.hasOwn(INBOX_FLAGS, args[i]!) ? INBOX_FLAGS[args[i]!] : undefined;
    const value = args[i + 1];
    if (!field || !value || Object.hasOwn(body, field)) return undefined;
    body[field] = value;
  }
  return body;
}

function describeError(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  const message = error instanceof Error ? error.message : String(error);
  return `voice-bridge: ${typeof code === "string" ? `${code}: ` : ""}${message}`;
}

/**
 * One line in, one reply out, in order. A failed tool call is reported and the conversation goes
 * on, but the session then exits 1, so a scripted run against a dead daemon does not pass as success.
 */
async function runChat(): Promise<number> {
  const conversation = new Conversation(callTool);
  let failed = false;
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    try {
      console.log(await conversation.reply(line));
    } catch (error) {
      failed = true;
      console.error(describeError(error));
    }
  }
  return failed ? 1 : 0;
}

const HELP_ALIASES = new Set(["--help", "-h", "help"]);

async function run(args: string[]): Promise<number> {
  const [command, arg, ...rest] = args;
  if (args.length === 1 && HELP_ALIASES.has(command!)) {
    console.log(USAGE);
    return 0;
  }
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
    if (project.briefing_write === "failed") console.error(`VOICE.md not written: ${project.briefing_write_error}`);
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
  const primary = command === "primary" && arg ? primaryRequest(arg, rest) : undefined;
  if (primary) {
    const result = await callTool<PrimaryResult>(primary.tool, primary.body);
    console.log(`route: ${result.route}`);
    console.log(`primary: ${result.primary_session_id ?? "-"}`);
    console.log(`connected: ${result.connected_session_id ?? "-"}`);
    console.log(`available: ${result.available}\tmutating_allowed: ${result.mutating_allowed}`);
    console.log(`reason: ${result.reason}`);
    if (result.skipped_records > 0) console.log(`skipped_records: ${result.skipped_records}`);
    return 0;
  }
  const why = rest.length === 1 && rest[0] === "--why";
  if (command === "status" && arg && (rest.length === 0 || why)) {
    const status = await callTool<ProjectStatus>("get_project_status", { project_id: arg });
    const activity = status.last_confirmed_activity;
    console.log(`freshness: ${status.freshness}`);
    console.log(`last_confirmed_activity: ${activity ? `${activity.type} at ${activity.observed_at}` : "-"}`);
    if (why) {
      console.log(`reasons: ${status.freshness_reasons.join(", ") || "-"}`);
      for (const [source, watermark] of Object.entries(status.watermarks)) console.log(`watermark\t${source}\t${watermark}`);
      console.log(`last_event_id: ${status.last_event_id ?? "-"}`);
    }
    return 0;
  }
  const inbox = command === "inbox" ? inboxRequest(args.slice(1)) : undefined;
  if (inbox) {
    const { items } = await callTool<{ items: InboxItem[] }>("list_inbox", inbox);
    if (items.length === 0) console.log("inbox is empty");
    for (const q of items) {
      console.log([q.question_id, q.project_id, q.status, q.priority ?? "-", q.created_at, q.summary || "(no summary)"].join("\t"));
    }
    return 0;
  }
  if (command === "probe" && arg === undefined) {
    const report = await runProbe();
    console.log(JSON.stringify(report, null, 2));
    // A provider process that outlived the probe is a broken guarantee, so it fails the command.
    return report.children.every((child) => child.reaped) ? 0 : 1;
  }
  if (command === "session" && arg === "start" && rest.length === 3 && rest[0] && rest[1] === "--provider" && rest[2]) {
    return runSessionHost({ projectId: rest[0], provider: rest[2], env: process.env, dataDir: resolveDataDir(process.env) });
  }
  if (command === "chat" && arg === undefined) return runChat();
  console.error(USAGE);
  return 2;
}

run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(describeError(error));
    process.exit(1);
  },
);
