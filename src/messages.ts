import { randomUUID } from "node:crypto";
import type { ProviderHomes } from "./adapters/homes.js";
import { BridgeError, requireString } from "./errors.js";
import { getPrimarySession, resolveOrigin, type PrimaryRoute } from "./primary.js";
import { discoverProjectSessions } from "./sessions.js";
import {
  matchDuplicateMessage,
  MESSAGE_MODES,
  type MessageIdentity,
  type InboxItem,
  type MessageMode,
  type NewMessage,
  questionNotOpen,
  type Store,
  type StoredMessage,
  type StoredSession,
} from "./store.js";

export const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;

export type Clock = () => Date;

const systemClock: Clock = () => new Date();

export interface SendRequest {
  project_id: string;
  text: string;
  mode: MessageMode;
  /** The inbox question an `answer_question` request answers. */
  question_id?: string;
  idempotency_key: string;
  approve_queue: boolean;
}

/** The stored message as the tools report it; the text is kept but not echoed back. */
export type MessageReceipt = Omit<StoredMessage, "body" | "approve_queue">;

function receipt({ body: _body, approve_queue: _approveQueue, ...message }: StoredMessage): MessageReceipt {
  return message;
}

function messageIdentity(request: SendRequest): MessageIdentity {
  return {
    project_id: request.project_id,
    body: request.text,
    mode: request.mode,
    question_id: request.question_id ?? null,
    approve_queue: request.approve_queue,
    idempotency_key: request.idempotency_key,
  };
}

function isMode(value: unknown): value is (typeof MESSAGE_MODES)[number] {
  return (MESSAGE_MODES as readonly unknown[]).includes(value);
}

/** Reads only the fields of the tool's signature, so any other field, such as `origin`, confers nothing. */
function sendRequest(body: Record<string, unknown>): SendRequest {
  const projectId = requireString(body, "project_id");
  const text = requireString(body, "text");
  const idempotencyKey = requireString(body, "idempotency_key");
  if (!isMode(body.mode)) throw new BridgeError("invalid_request", `mode must be one of ${MESSAGE_MODES.join(", ")}`);
  const approveQueue = body.approve_queue ?? false;
  if (typeof approveQueue !== "boolean") throw new BridgeError("invalid_request", "approve_queue must be a boolean when present");
  return { project_id: projectId, text, mode: body.mode, idempotency_key: idempotencyKey, approve_queue: approveQueue };
}

/**
 * What a send does, the first matching rule winning. A steer is refused even with `approve_queue`:
 * no session can verify a steer, and a queued one would later go out as a next turn.
 */
export function planSend(route: PrimaryRoute, mode: MessageMode, approveQueue: boolean, canSendNextTurn: boolean): NewMessage["decision"] {
  const refuse = (reason: "ambiguous_owner" | "not_controllable" | "unsupported_capability", detail: string): NewMessage["decision"] =>
    approveQueue
      ? { deliverable: false, state: "queued", reason: "awaiting_controllable_session", detail }
      : { deliverable: false, state: "failed", reason, detail };

  if (mode === "steer") {
    return {
      deliverable: false,
      state: "failed",
      reason: "unsupported_capability",
      detail: "no session in this build can steer an active turn; resend with mode next_turn to send it as the next turn",
    };
  }
  if (route.route === "ambiguous") return refuse("ambiguous_owner", route.reason);
  if (!route.mutating_allowed) return refuse("not_controllable", route.reason);
  if (!canSendNextTurn) return refuse("unsupported_capability", `${route.primary_session_id} cannot be sent a next turn`);
  return { deliverable: true };
}

/**
 * Stores the message; a deliverable one is stored `queued`, and the dispatcher of the session host
 * holding that session (src/dispatcher.ts) delivers it. Nothing here starts a process or talks to one.
 */
export function submitMessage(
  store: Store,
  request: SendRequest,
  route: PrimaryRoute,
  primary: StoredSession | undefined,
  clock: Clock = systemClock,
): MessageReceipt & { duplicate: boolean } {
  const canSendNextTurn = primary?.capabilities.next_turn === true;
  const now = clock();
  const { message, duplicate } = store.createMessage({
    ...messageIdentity(request),
    message_id: `m-${randomUUID()}`,
    session_id: route.primary_session_id,
    decision: planSend(route, request.mode, request.approve_queue, canSendNextTurn),
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + MESSAGE_TTL_MS).toISOString(),
  });
  return { ...receipt(message), duplicate };
}

/** The text handed to the asking session, so it can tell which question was answered. */
function answerText(item: InboxItem, answer: string): string {
  const theirs = item.origin_question_id ? ` (your id ${item.origin_question_id})` : "";
  return `Answer to your question ${item.question_id}${theirs}: ${answer}`;
}

/**
 * Sends an answer to the session that asked the question, never to the project's primary, over freshly
 * discovered sessions. A retry under a stored key returns that message before the question's status is
 * checked. An approval is refused and nothing is stored: no session here can answer a pending approval,
 * and sending it as a next turn would fabricate one.
 */
export async function answerInboxQuestion(
  store: Store,
  body: Record<string, unknown>,
  homes: ProviderHomes,
): Promise<MessageReceipt & { duplicate: boolean }> {
  const questionId = requireString(body, "question_id");
  const answer = requireString(body, "answer");
  const idempotencyKey = requireString(body, "idempotency_key");
  const approveQueue = body.approve_queue ?? false;
  if (typeof approveQueue !== "boolean") throw new BridgeError("invalid_request", "approve_queue must be a boolean when present");
  store.expireMessages(systemClock().toISOString());
  const item = store.getInboxItem(questionId);
  if (!item) throw new BridgeError("inbox_question_not_found", `no inbox question with id ${questionId}`);
  const request: SendRequest = {
    project_id: item.project_id,
    text: answerText(item, answer),
    mode: "answer_question",
    question_id: item.question_id,
    idempotency_key: idempotencyKey,
    approve_queue: approveQueue,
  };
  const stored = store.findMessageByKey(idempotencyKey);
  if (stored) return { ...receipt(matchDuplicateMessage(stored, messageIdentity(request))), duplicate: true };

  if (item.status !== "open") throw questionNotOpen(questionId, item.status);
  if (item.type === "approval") {
    throw new BridgeError(
      "unsupported_capability",
      `answering approval ${questionId} needs the asking session's answerPendingQuestion capability, which no session in this build has; nothing was sent`,
    );
  }
  const origin = item.origin_session_id;
  if (origin === null) {
    throw new BridgeError("no_origin_session", `question ${questionId} has no asking session to answer; dismiss it instead`);
  }
  const project = store.getById(item.project_id);
  if (!project) throw new BridgeError("project_not_found", `no project registered with id ${item.project_id}`);
  await discoverProjectSessions(store, project, homes);
  const sessions = store.listSessions(project.project_id);
  const session = sessions.find((s) => s.session_id === origin);
  return submitMessage(store, request, resolveOrigin(sessions, origin), session);
}

/**
 * Routes over freshly discovered sessions, so a send goes where `get_primary_session` would report.
 * A retry under a stored key returns that message before any rediscovery, so it is never rerouted.
 */
export async function sendToPrimary(
  store: Store,
  body: Record<string, unknown>,
  homes: ProviderHomes,
): Promise<MessageReceipt & { duplicate: boolean }> {
  const request = sendRequest(body);
  store.expireMessages(systemClock().toISOString());
  const stored = store.findMessageByKey(request.idempotency_key);
  if (stored) return { ...receipt(matchDuplicateMessage(stored, messageIdentity(request))), duplicate: true };

  const route = await getPrimarySession(store, request.project_id, homes);
  const primary = store.listSessions(request.project_id).find((s) => s.session_id === route.primary_session_id);
  return submitMessage(store, request, route, primary);
}

export function getMessage(store: Store, body: Record<string, unknown>, clock: Clock = systemClock): MessageReceipt {
  const messageId = requireString(body, "message_id");
  store.expireMessages(clock().toISOString());
  const message = store.getMessage(messageId);
  if (!message) throw new BridgeError("message_not_found", `no message with id ${messageId}`);
  return receipt(message);
}

/** Cancels a queued message; any other state is returned unchanged with `cancelled: false`. */
export function cancelMessage(
  store: Store,
  body: Record<string, unknown>,
  clock: Clock = systemClock,
): MessageReceipt & { cancelled: boolean } {
  const messageId = requireString(body, "message_id");
  const now = clock().toISOString();
  store.expireMessages(now);
  const result = store.transitionMessage(
    messageId,
    "queued",
    { state: "cancelled", reason: "cancelled_by_user", detail: "cancelled before delivery" },
    now,
  );
  if (!result) throw new BridgeError("message_not_found", `no message with id ${messageId}`);
  return { ...receipt(result.message), cancelled: result.changed };
}
