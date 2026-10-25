import type { ObservedState } from "./adapters/types.js";
import type { Clock } from "./messages.js";
import type { MessageChange, MessageReason, MessageState, Store } from "./store.js";

/** Thrown by a target whose provider connection is gone; the outcome of the send is unknown. */
export class TargetClosed extends Error {}

export interface NextTurnTarget {
  /** Resolves with the provider's id for the turn it accepted; rejects when it refused it. */
  sendNextTurn(text: string, idempotencyKey: string): Promise<{ provider_ref: string }>;
}

export interface Dispatcher {
  /** Delivers the session's next queued message if the session is idle with nothing in flight; resolves once that pass is done. */
  kick(): Promise<void>;
  turnStarted(turnId: string): void;
  turnCompleted(turnId: string, status: string, error: string | null): void;
  serverRequest(method: string): void;
  /** Stops picking messages and ignores every later outcome; the caller ends the session. */
  stop(): void;
  readonly state: ObservedState;
}

type TurnEvent = { kind: "started" } | { kind: "completed"; status: string; error: string | null };

interface InFlight {
  message_id: string;
  /** Null until the provider has answered `turn/start`. */
  provider_ref: string | null;
  /** Turn events that arrived before that answer, replayed once it names the turn. */
  early: { turnId: string; event: TurnEvent }[];
}

/** The reasons a dispatcher sends a queued message for; any other blocks the queue rather than being skipped. */
const SENDABLE: ReadonlySet<MessageReason> = new Set(["awaiting_delivery", "awaiting_earlier_messages"]);

/**
 * Delivers one bridge-controlled session's queued messages in sequence order, one turn at a time.
 * Every state comes from a provider event; nothing here reads a timer. A message is committed
 * `delivering` before it is sent and only `queued` messages are picked, so a message is sent at most
 * once even across a crash or restart.
 */
export function createDispatcher({
  store,
  sessionId,
  target,
  clock = () => new Date(),
  log = (line: string) => console.error(line),
}: {
  store: Store;
  sessionId: string;
  target: NextTurnTarget;
  clock?: Clock;
  log?: (line: string) => void;
}): Dispatcher {
  let state: ObservedState = "connected_idle";
  let inFlight: InFlight | null = null;
  let stopped = false;
  let running: Promise<void> | null = null;
  let rerun = false;
  const blockedLogged = new Set<string>();

  const now = () => clock().toISOString();
  const record = (messageId: string, from: MessageState, to: MessageChange) => store.transitionMessage(messageId, from, to, now());
  const setState = (next: ObservedState) => {
    if (state === next) return;
    state = next;
    store.setControlledState(sessionId, next, now());
  };

  const apply = (message: InFlight, turnId: string, event: TurnEvent) => {
    if (event.kind === "started") {
      record(message.message_id, "delivered", { state: "started", reason: "turn_started", detail: `turn ${turnId} started` });
      setState("connected_running");
      return;
    }
    const to: MessageChange =
      event.status === "completed"
        ? { state: "completed", reason: "turn_completed", detail: `turn ${turnId} completed` }
        : {
            state: "failed",
            reason: "turn_failed",
            detail: `turn ${turnId} ended ${event.status}${event.error === null ? "" : `: ${event.error}`}`,
          };
    if (!record(message.message_id, "started", to)?.changed) record(message.message_id, "delivered", to);
    inFlight = null;
    setState("connected_idle");
    void kick();
  };

  const route = (turnId: string, event: TurnEvent) => {
    if (stopped) return;
    if (inFlight !== null && inFlight.provider_ref === turnId) return apply(inFlight, turnId, event);
    if (inFlight !== null && inFlight.provider_ref === null) {
      inFlight.early.push({ turnId, event });
      return;
    }
    log(`voice-bridge: ignoring turn ${event.kind} for ${turnId}, a turn no message here started`);
  };

  const pass = async () => {
    while (!stopped && state === "connected_idle" && inFlight === null) {
      store.expireMessages(now());
      const next = store.nextQueuedMessage(sessionId);
      if (!next) return;
      if (!SENDABLE.has(next.reason)) {
        if (!blockedLogged.has(next.message_id)) {
          blockedLogged.add(next.message_id);
          log(`voice-bridge: message ${next.message_id} is queued as ${next.reason}; later messages wait behind it`);
        }
        return;
      }
      const claim: MessageChange = { state: "delivering", reason: "handed_to_adapter", detail: `handing the message to ${sessionId}` };
      if (!record(next.message_id, "queued", claim)?.changed) continue;

      const message: InFlight = { message_id: next.message_id, provider_ref: null, early: [] };
      inFlight = message;
      try {
        const { provider_ref } = await target.sendNextTurn(next.body, next.idempotency_key);
        if (stopped) return;
        message.provider_ref = provider_ref;
        record(message.message_id, "delivering", {
          state: "delivered",
          reason: "adapter_receipt",
          detail: `turn ${provider_ref} accepted by ${sessionId}`,
          provider_ref,
        });
        for (const { turnId, event } of message.early.splice(0)) route(turnId, event);
      } catch (error) {
        // Left `delivering`: ending the session records that its outcome is unknown.
        if (stopped || error instanceof TargetClosed) return;
        const detail = error instanceof Error ? error.message : String(error);
        log(`voice-bridge: message ${message.message_id} not delivered to ${sessionId}: ${detail}`);
        record(message.message_id, "delivering", { state: "failed", reason: "delivery_failed", detail });
        inFlight = null;
      }
    }
  };

  /** A kick during a pass makes that pass run again and resolves with it, so passes never overlap. */
  const kick = (): Promise<void> => {
    if (running) {
      rerun = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          rerun = false;
          await pass();
        } while (rerun);
      } finally {
        running = null;
      }
    })();
    return running;
  };

  return {
    kick,
    turnStarted: (turnId) => route(turnId, { kind: "started" }),
    turnCompleted: (turnId, status, error) => route(turnId, { kind: "completed", status, error }),
    serverRequest(method) {
      if (stopped) return;
      log(`voice-bridge: ${sessionId} asked ${method}; the bridge does not answer provider requests`);
      if (inFlight !== null) setState("waiting_user");
    },
    stop() {
      stopped = true;
    },
    get state() {
      return state;
    },
  };
}
