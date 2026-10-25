import { TargetClosed, type NextTurnTarget } from "../dispatcher.js";
import { BridgeError } from "../errors.js";
import { describe, field, RpcClient, type Outcome } from "../jsonRpc.js";
import { startSession, type ChildRecord, type Ended, type Session } from "../providerProcess.js";

export const HANDSHAKE_TIMEOUT_MS = 5_000;

/** A live thread on a bridge-owned `codex app-server`, as docs/decisions/0001-reference-delivery-path.md proposes. */
export interface CodexAppServerSession extends NextTurnTarget {
  readonly pid: number;
  readonly threadId: string;
  onTurnStarted(listener: (turnId: string) => void): void;
  onTurnCompleted(listener: (turnId: string, status: string, error: string | null) => void): void;
  /** A request the provider sent us, such as an approval; it is never answered. */
  onServerRequest(listener: (method: string) => void): void;
  /** Fires once, when the provider process exits or its stdout closes. */
  onGone(listener: () => void): void;
  /** Closes stdin, waits a bounded time for exit, then reaps the provider's process group. */
  close(): Promise<Ended>;
}

async function handshake(rpc: RpcClient, cwd: string): Promise<string> {
  const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
  const left = () => Math.max(0, deadline - Date.now());
  const step = async (method: string, params: unknown): Promise<unknown> => {
    const outcome: Outcome = await rpc.request(method, params, left());
    if (outcome.kind !== "result") throw new Error(describe(method, outcome));
    return outcome.value;
  };

  await step("initialize", { clientInfo: { name: "voice-bridge", version: "0.1.0" } });
  rpc.notify("initialized", {});
  const threadId = field(await step("thread/start", { cwd }), "thread", "id");
  if (typeof threadId !== "string") throw new Error("thread/start → result without a thread id");
  const started = await rpc.waitFor((n) => n.method === "thread/started" && field(n.params, "thread", "id") === threadId, left());
  if (!started) throw new Error(`no thread/started notification for ${threadId} within ${HANDSHAKE_TIMEOUT_MS} ms`);
  return threadId;
}

function startFailure(reason: string, ended: Ended): BridgeError {
  const stderr = ended.spawn_error ?? ended.stderr.trim();
  return new BridgeError("provider_start_failed", `codex app-server did not start a thread: ${reason}${stderr ? `; ${stderr}` : ""}`);
}

/**
 * Starts `codex app-server` over stdio in `cwd` with `env` as given, and starts one thread. Nothing is
 * added to the provider's configuration: its own approval and sandbox settings stay in force.
 */
export async function openCodexAppServerSession({
  binary,
  cwd,
  env,
  children,
}: {
  binary: string;
  cwd: string;
  env: Record<string, string>;
  children: ChildRecord[];
}): Promise<CodexAppServerSession> {
  const session: Session = startSession([binary, "app-server", "--listen", "stdio://"], { env, cwd }, children);
  const rpc = new RpcClient(session);
  let threadId: string;
  try {
    threadId = await handshake(rpc, cwd);
  } catch (error) {
    throw startFailure(error instanceof Error ? error.message : String(error), await session.finish());
  }
  if (session.pid === null) throw startFailure("the provider process has no pid", await session.finish());
  rpc.forgetHistory();

  const ours = (params: unknown) => field(params, "threadId") === threadId;
  const turnIdOf = (params: unknown) => {
    const id = field(params, "turn", "id");
    return typeof id === "string" ? id : undefined;
  };
  const gone = new Promise<void>((resolve) => {
    rpc.onClosed(resolve);
    void session.exited.then(resolve);
  });

  return {
    pid: session.pid,
    threadId,
    async sendNextTurn(text) {
      const outcome = await rpc.request("turn/start", { threadId, input: [{ type: "text", text }] });
      if (outcome.kind === "closed") throw new TargetClosed("the provider exited before answering turn/start");
      if (outcome.kind !== "result") throw new Error(describe("turn/start", outcome));
      const turnId = turnIdOf(outcome.value);
      if (turnId === undefined) throw new Error("turn/start → result without a turn id");
      return { provider_ref: turnId };
    },
    onTurnStarted(listener) {
      rpc.onNotification(({ method, params }) => {
        const turnId = turnIdOf(params);
        if (method === "turn/started" && ours(params) && turnId !== undefined) listener(turnId);
      });
    },
    onTurnCompleted(listener) {
      rpc.onNotification(({ method, params }) => {
        const turnId = turnIdOf(params);
        if (method !== "turn/completed" || !ours(params) || turnId === undefined) return;
        const status = field(params, "turn", "status");
        const error = field(params, "turn", "error", "message");
        listener(turnId, typeof status === "string" ? status : "unknown", typeof error === "string" ? error : null);
      });
    },
    onServerRequest: (listener) => rpc.onServerRequest(listener),
    onGone: (listener) => void gone.then(listener),
    close: () => session.finish(),
  };
}
