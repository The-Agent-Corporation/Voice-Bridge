import { BridgeError, requireString } from "./errors.js";
import { EVENT_TYPES, type EventType, type NewEvent, type Store } from "./store.js";

export const MAX_PAYLOAD_BYTES = 16 * 1024;

function invalid(message: string): BridgeError {
  return new BridgeError("invalid_request", message);
}

function isEventType(value: unknown): value is EventType {
  return (EVENT_TYPES as readonly unknown[]).includes(value);
}

/**
 * Validates the whole request before touching the store, so a rejected event stores nothing.
 * The payload is kept as JSON text and never read back, interpreted or passed on.
 */
export function ingestEvent(store: Store, body: Record<string, unknown>): { event_id: number; duplicate: boolean } {
  const projectId = requireString(body, "project_id");
  const source = requireString(body, "source");
  const sourceEventId = requireString(body, "source_event_id");
  const sessionId = body.session_id ?? null;
  if (sessionId !== null && (typeof sessionId !== "string" || !sessionId)) {
    throw invalid("session_id must be a non-empty string when present");
  }
  const sequence = body.source_sequence;
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1) {
    throw invalid("source_sequence must be an integer of at least 1");
  }
  if (!isEventType(body.type)) throw invalid(`type must be one of ${EVENT_TYPES.join(", ")}`);
  if (body.payload === undefined) throw invalid("payload is required");
  const observedAt = body.observed_at;
  if (typeof observedAt !== "string" || !Number.isFinite(Date.parse(observedAt))) {
    throw invalid("observed_at must be a parseable date-time string");
  }

  const payload = JSON.stringify(body.payload);
  if (Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new BridgeError("payload_too_large", `payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
  }
  if (!store.getById(projectId)) {
    throw new BridgeError("project_not_found", `no project registered with id ${projectId}`);
  }

  const event: NewEvent = {
    project_id: projectId,
    session_id: sessionId,
    source,
    source_event_id: sourceEventId,
    source_sequence: sequence,
    type: body.type,
    payload,
    observed_at: new Date(observedAt).toISOString(),
  };
  return store.ingestEvent(event);
}
