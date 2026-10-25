import { openCodexAppServerSession } from "./adapters/codexAppServerSession.js";
import { PROVIDERS, type Provider, type SessionCapabilities } from "./adapters/types.js";
import { readVoiceConfig } from "./config.js";
import { createDispatcher } from "./dispatcher.js";
import { BridgeError } from "./errors.js";
import { leaseIsLive } from "./lease.js";
import { resolveExecutable } from "./probe.js";
import { killLiveGroups, type ChildRecord } from "./providerProcess.js";
import { openStore, sessionId as sessionIdOf } from "./store.js";

const KICK_MS = 250;
const HEARTBEAT_MS = 5_000;
const LEASE_EXPIRY_MS = 30_000;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * What this session's own handshake proves: a bridge-owned live thread, on an app-server whose
 * `turn/start` the probe proved, that reports its events. Steering stays false until it is proved.
 */
const CAPABILITIES: SessionCapabilities = {
  live_attach: false,
  next_turn: true,
  steer_active_turn: false,
  answer_pending_question: false,
  subscribe_events: true,
};

type EndReason =
  | { reason: "signal"; signal: (typeof SIGNALS)[number] }
  | { reason: "provider_exited" }
  | { reason: "lease_lost" }
  | { reason: "host_error"; error: string };

function endDetail(end: EndReason): string {
  switch (end.reason) {
    case "signal":
      return `the session host stopped on ${end.signal}`;
    case "provider_exited":
      return "the provider process exited";
    case "lease_lost":
      return "the session host lost its workspace lease";
    case "host_error":
      return `the session host failed: ${end.error}`;
  }
}

function isProvider(value: string): value is Provider {
  return (PROVIDERS as readonly string[]).includes(value);
}

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

export interface SessionHostOptions {
  projectId: string;
  provider: string;
  env: NodeJS.ProcessEnv;
  dataDir: string;
  out?: (line: string) => void;
}

/**
 * `voice-bridge session start`: takes the project's workspace lease, starts the provider, and holds
 * the session in the foreground, delivering its queued messages, until a signal, the provider's
 * exit or a lost lease. It never restarts the provider. The lease is taken before anything is
 * spawned, so a refused start spawns nothing. Resolves with the exit code: 0 after a signal, else 1.
 */
export async function runSessionHost({ projectId, provider, env, dataDir, out = (line) => console.log(line) }: SessionHostOptions): Promise<number> {
  const store = openStore(dataDir);
  const children: ChildRecord[] = [];
  let held: { worktree_id: string; holder_pid: number } | undefined;
  let endWith!: (end: EndReason) => void;
  const ended = new Promise<EndReason>((resolve) => (endWith = resolve));
  const onSignal = (signal: (typeof SIGNALS)[number]) => endWith({ reason: "signal", signal });
  const now = () => new Date().toISOString();
  const expiry = () => new Date(Date.now() + LEASE_EXPIRY_MS).toISOString();

  try {
    const project = store.getById(projectId);
    if (!project) throw new BridgeError("project_not_found", `no project registered with id ${projectId}`);
    if (!isProvider(provider)) throw new BridgeError("unsupported_provider", `${provider} is not a provider; use one of ${PROVIDERS.join(", ")}`);
    if (!readVoiceConfig(project.canonical_path).allowed_providers.includes(provider)) {
      throw new BridgeError("provider_not_allowed", `${provider} is not in allowed_providers of ${project.project_id}`);
    }
    if (provider !== "codex") {
      throw new BridgeError(
        "unsupported_provider",
        `no bridge-controlled path for ${provider} in this build; see docs/decisions/0001-reference-delivery-path.md`,
      );
    }
    const codex = resolveExecutable("codex", env.PATH ?? "");
    if (!codex) throw new BridgeError("provider_not_installed", "codex was not found in any absolute PATH entry");

    const worktreeId = project.canonical_path;
    store.acquireLease({ worktree_id: worktreeId, project_id: project.project_id, holder_pid: process.pid, at: now(), expires_at: expiry() }, leaseIsLive);
    held = { worktree_id: worktreeId, holder_pid: process.pid };
    for (const signal of SIGNALS) process.on(signal, onSignal);

    const session = await openCodexAppServerSession({ binary: codex.binary, cwd: worktreeId, env: definedEnv(env), children });
    if (!store.setLeaseProvider(worktreeId, process.pid, session.pid)) {
      await session.close();
      throw new BridgeError("lease_lost", `the lease of ${worktreeId} was taken while codex started`);
    }
    const sessionId = sessionIdOf("codex", session.threadId);
    const startedAt = now();
    store.connectControlledSession({
      session_id: sessionId,
      project_id: project.project_id,
      provider: "codex",
      native_session_id: session.threadId,
      worktree_id: worktreeId,
      observed_state: "connected_idle",
      last_activity_at: startedAt,
      capabilities: CAPABILITIES,
      holder_pid: process.pid,
      provider_pgid: session.pid,
      started_at: startedAt,
    });

    const dispatcher = createDispatcher({ store, sessionId, target: session });
    const kick = () => dispatcher.kick().catch((error: unknown) => endWith({ reason: "host_error", error: String(error) }));
    session.onTurnStarted(dispatcher.turnStarted);
    session.onTurnCompleted(dispatcher.turnCompleted);
    session.onServerRequest(dispatcher.serverRequest);
    session.onGone(() => endWith({ reason: "provider_exited" }));
    out(JSON.stringify({ event: "connected", session_id: sessionId, worktree_id: worktreeId, provider_pid: session.pid }));

    // The interval only notices messages the daemon stored; every state change comes from a provider event.
    const kicker = setInterval(kick, KICK_MS);
    const heartbeat = setInterval(() => {
      if (!store.heartbeatLease(worktreeId, process.pid, now(), expiry())) endWith({ reason: "lease_lost" });
    }, HEARTBEAT_MS);
    void kick();

    const end = await ended;
    clearInterval(kicker);
    clearInterval(heartbeat);
    dispatcher.stop();
    await session.close();
    store.endControlledSession(sessionId, endDetail(end), now(), held);
    held = undefined;
    out(JSON.stringify({ event: "ended", session_id: sessionId, reason: end.reason }));
    if (end.reason !== "signal") console.error(`voice-bridge: session ${sessionId} ended: ${endDetail(end)}`);
    return end.reason === "signal" ? 0 : 1;
  } finally {
    for (const signal of SIGNALS) process.off(signal, onSignal);
    killLiveGroups();
    if (held) store.releaseLease(held.worktree_id, held.holder_pid);
    store.close();
  }
}
