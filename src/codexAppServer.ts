import { realpathSync } from "node:fs";
import {
  evidenceOf,
  surfaceOf,
  uniformSurface,
  unprovable,
  type Capability,
  type Evidence,
  type SurfaceReport,
  type Verdict,
} from "./probe.js";
import { startSession, type ChildRecord, type LaunchOptions, type Session } from "./providerProcess.js";

const RPC_TIMEOUT_MS = 5_000;
const NOTIFICATION_WAIT_MS = 3_000;
const SESSION_DEADLINE_MS = 30_000;
const METHOD_NOT_FOUND = -32601;
const PROBE_INPUT = [{ type: "text", text: "voice-bridge probe" }];

type Outcome =
  | { kind: "result"; value: unknown }
  | { kind: "error"; code: unknown; message: unknown }
  | { kind: "timeout"; ms: number }
  | { kind: "closed" };

interface Notification {
  method: string;
  params: unknown;
}

/** Reads a nested field of untyped JSON, e.g. `field(result, "thread", "id")`. */
function field(value: unknown, ...keys: string[]): unknown {
  for (const key of keys) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function describe(method: string, outcome: Outcome): string {
  switch (outcome.kind) {
    case "result":
      return `${method} → result`;
    case "error":
      return `${method} → error ${String(outcome.code)}: ${String(outcome.message)}`;
    case "timeout":
      return `${method} → no response within ${outcome.ms} ms`;
    case "closed":
      return `${method} → stdout closed before a response`;
  }
}

/**
 * A minimal line-delimited JSON-RPC client. Requests the server sends to us (approvals,
 * `item/tool/requestUserInput`) are recorded and never answered, so the probe never
 * fabricates an approval.
 */
class RpcClient {
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<number, (outcome: Outcome) => void>();
  private readonly waiters = new Set<() => void>();
  readonly notifications: Notification[] = [];
  readonly serverRequests: string[] = [];
  readonly strayLines: string[] = [];
  private readonly deadline = Date.now() + SESSION_DEADLINE_MS;

  constructor(private readonly session: Session) {
    session.onLine((line) => this.receive(line));
    session.onClosed(() => {
      this.closed = true;
      for (const settle of this.pending.values()) settle({ kind: "closed" });
      this.pending.clear();
    });
  }

  private receive(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      if (line.trim() !== "") this.strayLines.push(line.trim());
      return;
    }
    const id = field(message, "id");
    const method = field(message, "method");
    if (typeof method === "string" && id !== undefined) {
      this.serverRequests.push(method);
    } else if (typeof method === "string") {
      this.notifications.push({ method, params: field(message, "params") });
      for (const wake of this.waiters) wake();
    } else if (typeof id === "number" && this.pending.has(id)) {
      const settle = this.pending.get(id)!;
      this.pending.delete(id);
      const error = field(message, "error");
      settle(
        error === undefined
          ? { kind: "result", value: field(message, "result") }
          : { kind: "error", code: field(error, "code"), message: field(error, "message") },
      );
    }
  }

  private budget(ms: number): number {
    return Math.max(0, Math.min(ms, this.deadline - Date.now()));
  }

  request(method: string, params: unknown): Promise<Outcome> {
    if (this.closed) return Promise.resolve({ kind: "closed" });
    const id = this.nextId++;
    const ms = this.budget(RPC_TIMEOUT_MS);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ kind: "timeout", ms });
      }, ms);
      this.pending.set(id, (outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      });
      this.session.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.session.write({ jsonrpc: "2.0", method, params });
  }

  /** Resolves true once a notification matching `matches` has arrived, false after the wait. */
  waitFor(matches: (notification: Notification) => boolean): Promise<boolean> {
    if (this.notifications.some(matches)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const wake = () => {
        if (!this.notifications.some(matches)) return;
        finish(true);
      };
      const finish = (seen: boolean) => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve(seen);
      };
      const timer = setTimeout(() => finish(false), this.budget(NOTIFICATION_WAIT_MS));
      this.waiters.add(wake);
    });
  }
}

/** A verdict and the request it rests on. */
interface Finding {
  verdict: Verdict;
  rpc?: string;
}

const proved = (detail: string, rpc: string): Finding => ({ verdict: { status: "supported", reason: "proved", detail }, rpc });
const failed = (detail: string, rpc?: string): Finding => ({ verdict: { status: "unverified", reason: "check_failed", detail }, rpc });

/** `unsupported` only for the provider's own "method not found"; any other answer is not proof either way. */
function judge(method: string, outcome: Outcome, proof: (value: unknown) => string | null): Finding {
  const rpc = describe(method, outcome);
  if (outcome.kind === "error" && outcome.code === METHOD_NOT_FOUND) {
    return { verdict: { status: "unsupported", reason: "method_not_found", detail: `${method} is not a method of this app-server` }, rpc };
  }
  if (outcome.kind !== "result") return failed(rpc, rpc);
  const detail = proof(outcome.value);
  return detail === null ? failed(`${method} returned a result without the expected proof`, rpc) : proved(detail, rpc);
}

function sameDirectory(reported: unknown, expected: string): boolean {
  if (typeof reported !== "string") return false;
  try {
    return realpathSync(reported) === realpathSync(expected);
  } catch {
    return false;
  }
}

type Checks =
  /** The session could not be trusted or used at all; every capability gets this one finding. */
  | { aborted: Finding }
  | { findings: Partial<Record<Capability, Finding>> };

/** Drives the checks over one session; returns a finding for each capability it reached. */
async function runChecks(rpc: RpcClient, cwd: string, codexHome: string): Promise<Checks> {
  const initialize = await rpc.request("initialize", { clientInfo: { name: "voice-bridge-probe", version: "0.1.0" } });
  const initialized = describe("initialize", initialize);
  if (initialize.kind !== "result") return { aborted: failed(`initialize failed: ${initialized}`, initialized) };
  const reportedHome = field(initialize.value, "codexHome");
  // The only proof that the app-server writes into the throwaway home and not the user's session store.
  if (!sameDirectory(reportedHome, codexHome)) {
    return { aborted: failed(`codexHome mismatch: ${JSON.stringify(reportedHome)}; nothing further was sent`, initialized) };
  }
  rpc.notify("initialized", {});

  const findings: Partial<Record<Capability, Finding>> = {};
  findings.discover = judge("thread/list", await rpc.request("thread/list", {}), (value) => {
    const data = field(value, "data");
    return Array.isArray(data) ? `thread/list returned data[${data.length} items] in the isolated CODEX_HOME` : null;
  });

  const start = await rpc.request("thread/start", { cwd, ephemeral: true });
  const threadId = start.kind === "result" ? field(start.value, "thread", "id") : undefined;
  if (typeof threadId !== "string") {
    const finding = failed(`no thread to check: ${describe("thread/start", start)}`, describe("thread/start", start));
    return { findings: { ...findings, inspect: finding, events: finding, next_turn: finding, steer: finding } };
  }

  findings.inspect = judge("thread/read", await rpc.request("thread/read", { threadId }), (value) =>
    field(value, "thread", "id") === threadId ? `thread/read returned the thread thread/start created (${threadId})` : null,
  );
  const started = await rpc.waitFor((n) => n.method === "thread/started" && field(n.params, "thread", "id") === threadId);
  findings.events = started
    ? proved(`a thread/started notification arrived for ${threadId}`, "thread/started notification")
    : failed(`no thread/started notification for ${threadId} within ${NOTIFICATION_WAIT_MS} ms`);

  const turn = await rpc.request("turn/start", { threadId, input: PROBE_INPUT });
  const turnId = turn.kind === "result" ? field(turn.value, "turn", "id") : undefined;
  if (typeof turnId !== "string") {
    const finding = judge("turn/start", turn, () => null);
    return { findings: { ...findings, next_turn: finding, steer: failed(`no turn to steer: ${describe("turn/start", turn)}`) } };
  }
  // Sent before waiting on anything else: steer is only meaningful while the turn is still running.
  findings.steer = judge("turn/steer", await rpc.request("turn/steer", { threadId, expectedTurnId: turnId, input: PROBE_INPUT }), (value) =>
    typeof field(value, "turnId") === "string" ? `turn/steer accepted input for running turn ${turnId}` : null,
  );
  const turnStarted = await rpc.waitFor((n) => n.method === "turn/started" && field(n.params, "threadId") === threadId);
  findings.next_turn = turnStarted
    ? proved(`turn/start returned turn ${turnId} and a turn/started notification followed`, describe("turn/start", turn))
    : failed(`turn/start returned turn ${turnId} but no turn/started notification arrived within ${NOTIFICATION_WAIT_MS} ms`, describe("turn/start", turn));

  await rpc.request("turn/interrupt", { threadId, turnId });
  return { findings };
}

/**
 * Starts a bridge-owned `codex app-server` over stdio inside the probe's throwaway home
 * and checks what it answers. `live_attach` and `answer_question` are never checked:
 * proving them needs a session or a question the probe does not own.
 */
export async function probeCodexAppServer(
  binary: string,
  options: LaunchOptions,
  codexHome: string,
  children: ChildRecord[],
): Promise<SurfaceReport> {
  // A file credential store in an empty home: a keyring login cannot be picked up.
  const command = [binary, "-c", 'cli_auth_credentials_store="file"', "app-server", "--listen", "stdio://"];
  const session = startSession(command, options, children);
  const rpc = new RpcClient(session);
  const checks = await runChecks(rpc, options.cwd, codexHome);
  const ended = await session.finish();

  // Evidence keeps the tail of `observed`, so the short markers go last and survive a long stderr.
  const observed = [
    ended.spawn_error ?? (ended.stderr.trim() === "" ? "" : `stderr: ${ended.stderr.trim()}`),
    rpc.strayLines.length > 0 ? `non-JSON stdout: ${rpc.strayLines.join(" | ")}` : "",
    rpc.serverRequests.length > 0 ? `server requests left unanswered: ${rpc.serverRequests.join(", ")}` : "",
  ]
    .filter((part) => part !== "")
    .join("; ");
  const evidence = (step: string | undefined): Evidence[] => [evidenceOf(ended, { ...(step === undefined ? {} : { rpc: step }), observed })];

  if ("aborted" in checks) return uniformSurface("check_failed", checks.aborted.verdict.detail, evidence(checks.aborted.rpc));
  const findings: Partial<Record<Capability, Finding>> = {
    ...checks.findings,
    live_attach: { verdict: unprovable("needs_foreign_session") },
    answer_question: { verdict: unprovable("needs_pending_question") },
  };
  return surfaceOf((capability) => {
    const finding = findings[capability] ?? failed("the session ended before this check ran");
    return { ...finding.verdict, evidence: evidence(finding.rpc) };
  });
}
