import { oneLine, redactSecrets, stringField } from "./briefing.js";
import { BridgeError, requireString } from "./errors.js";
import type { Clock } from "./messages.js";
import { INBOX_STATUSES, type InboxItem, type InboxStatus, type QuestionFields, type Store } from "./store.js";

function payloadFields(payload: unknown): Record<string, unknown> {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
}

/**
 * Reads a `user_question` payload as leniently as the briefing does: a missing or mistyped field is
 * absent, never a reason to refuse the event.
 */
export function questionFields(payload: unknown): QuestionFields {
  const fields = payloadFields(payload);
  return {
    origin_question_id: stringField(fields, "question_id"),
    summary: stringField(fields, "summary"),
    type: stringField(fields, "type"),
    priority: stringField(fields, "priority"),
    withdrawn: fields.withdrawn === true,
  };
}

/** The bridge's `q-N` id an `agent_ack` payload names in `question_id`, or null when it names none. */
export function acknowledgedQuestionId(payload: unknown): string | null {
  return stringField(payloadFields(payload), "question_id");
}

function isInboxStatus(value: unknown): value is InboxStatus {
  return (INBOX_STATUSES as readonly unknown[]).includes(value);
}

/** The summary goes to a voice model and a terminal, so it is one line with credentials redacted. */
function presented(item: InboxItem): InboxItem {
  return { ...item, summary: redactSecrets(oneLine(item.summary)) };
}

/**
 * Never given provider homes, so it cannot reach an adapter; it writes only the expiry of queued answers,
 * so an item whose answer expired reads `open` again.
 */
export function listInbox(store: Store, body: Record<string, unknown>, clock: Clock = () => new Date()): { items: InboxItem[] } {
  const projectId = body.project_id === undefined ? undefined : requireString(body, "project_id");
  if (projectId !== undefined && !store.getById(projectId)) {
    throw new BridgeError("project_not_found", `no project registered with id ${projectId}`);
  }
  const status = body.status;
  if (status !== undefined && !isInboxStatus(status)) {
    throw new BridgeError("invalid_request", `status must be one of ${INBOX_STATUSES.join(", ")}`);
  }
  store.expireMessages(clock().toISOString());
  return { items: store.listInbox({ project_id: projectId, status }).map(presented) };
}

export function dismissInboxQuestion(
  store: Store,
  body: Record<string, unknown>,
  clock: Clock = () => new Date(),
): { item: InboxItem; dismissed: boolean } {
  const questionId = requireString(body, "question_id");
  store.expireMessages(clock().toISOString());
  const result = store.dismissInboxQuestion(questionId);
  if (!result) throw new BridgeError("inbox_question_not_found", `no inbox question with id ${questionId}`);
  return { item: presented(result.item), dismissed: result.dismissed };
}
