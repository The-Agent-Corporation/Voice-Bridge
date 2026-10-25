import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type { DiscoveredSession, ObservedState, Provider } from "./adapters/types.js";
import { BridgeError } from "./errors.js";

export const STORE_FILE = "bridge.sqlite";
const SCHEMA_VERSION = 9;
const SQLITE_CONSTRAINT_UNIQUE = 2067;

export interface Project {
  project_id: string;
  display_name: string;
  canonical_path: string;
  created_at: string;
  updated_at: string;
}

export interface StoredSession extends DiscoveredSession {
  /** `<provider>:<native_session_id>`, stable across rediscovery. */
  session_id: string;
}

/** A session the bridge itself started and holds (src/sessionHost.ts), with the process evidence for it. */
export interface ControlledSession extends StoredSession {
  project_id: string;
  /** The `voice-bridge session start` process that owns the provider connection. */
  holder_pid: number;
  /** The provider's process group, led by the provider process. */
  provider_pgid: number;
  started_at: string;
  /** Set once the session is over; it is never reopened. */
  ended_at: string | null;
}

/**
 * One worktree's writer lease (docs/PRD.md §10). The heartbeat and expiry are reported, never used to
 * judge liveness: only process evidence releases a lease whose holder or provider may still run.
 */
export interface WorkspaceLease {
  worktree_id: string;
  project_id: string;
  /** Null until the provider has connected. */
  owner_session_id: string | null;
  holder_pid: number;
  /** Null until the provider has been started. */
  provider_pgid: number | null;
  enforceability: "bridge_controlled";
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
}

export interface PrimaryPin {
  project_id: string;
  session_id: string;
  pinned_at: string;
}

/** The agent event types of docs/PRD.md §11.1. */
export const EVENT_TYPES = [
  "session_started",
  "session_ended",
  "turn_started",
  "turn_completed",
  "turn_failed",
  "plan_updated",
  "step_completed",
  "git_commit",
  "tool_failure",
  "blocker",
  "user_question",
  "progress",
  "final_output",
  "user_decision",
  "agent_ack",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

/** The types that say where a session's turn stands; conflict detection compares only these. */
export const TURN_EVENT_TYPES = ["turn_started", "turn_completed", "turn_failed"] as const satisfies readonly EventType[];

/** The types the briefing renderer reads: their named payload fields, or their session for the agent line. */
export const BRIEFING_EVENT_TYPES = [
  "plan_updated",
  "progress",
  "blocker",
  "user_question",
  "user_decision",
  "git_commit",
  "session_started",
  "session_ended",
  ...TURN_EVENT_TYPES,
] as const satisfies readonly EventType[];

/** The most events of one type the briefing renderer is given. */
export const BRIEFING_EVENTS_PER_TYPE = 200;

export interface NewEvent {
  project_id: string;
  session_id: string | null;
  source: string;
  source_event_id: string;
  source_sequence: number;
  type: EventType;
  /**
   * JSON text, kept as untrusted data; only the briefing renderer and, for `user_question` and `agent_ack`,
   * the inbox read its named fields.
   */
  payload: string;
  /** ISO 8601, as `Date.prototype.toISOString` writes it. */
  observed_at: string;
}

export interface WatermarkRow {
  source: string;
  /** Highest N such that sequences 1..N from this source are all stored. */
  watermark: number;
  highest_stored: number;
}

export interface ProcessedEvent {
  event_id: number;
  type: EventType;
  observed_at: string;
}

export interface BriefingEventRow {
  event_id: number;
  session_id: string | null;
  type: (typeof BRIEFING_EVENT_TYPES)[number];
  /** Untrusted JSON text, as stored. */
  payload: string;
  observed_at: string;
}

export interface StoredBriefing {
  project_id: string;
  /** sha256 hex of the text rendered with a fixed generation time. */
  content_hash: string;
  text: string;
  generated_at: string;
}

/** The question statuses of docs/PRD.md §12, all of which this build writes. */
export const INBOX_STATUSES = [
  "open",
  "answer_queued",
  "delivered",
  "acknowledged",
  "resolved",
  "cancelled",
  "obsolete",
] as const;

export type InboxStatus = (typeof INBOX_STATUSES)[number];

/** The named fields of a `user_question` payload; each is null when absent or of the wrong type. */
export interface QuestionFields {
  /** The payload's `question_id`: the asking agent's own id for the question. */
  origin_question_id: string | null;
  summary: string | null;
  type: string | null;
  priority: string | null;
  withdrawn: boolean;
}

export interface InboxItem {
  /**
   * `q-<source_event_id>`. VOICE.md shows the same id unless that event is not yet processed or has
   * fallen outside the briefing's 200-event window.
   */
  question_id: string;
  project_id: string;
  origin_session_id: string | null;
  origin_question_id: string | null;
  type: string | null;
  /** `""` while no event has supplied one. */
  summary: string;
  priority: string | null;
  status: InboxStatus;
  /**
   * The bridge's `event_id` of the identity's earliest stored `user_question`, which may predate the inbox;
   * not the producer's `source_event_id` string.
   */
  source_event_id: number;
  created_at: string;
  updated_at: string;
  dismissed_at: string | null;
  resolution_message_id: string | null;
}

export interface InboxNotification {
  notification_id: number;
  question_id: string;
  project_id: string;
  created_at: string;
}

/**
 * The message states of docs/PRD.md Appendix A but `draft`, which the bridge never stores, plus
 * `delivering`: handed to the provider, outcome not yet known, so neither cancel nor expiry may touch it.
 * This build writes every state but `acknowledged`.
 */
export const MESSAGE_STATES = [
  "accepted",
  "queued",
  "delivering",
  "delivered",
  "acknowledged",
  "started",
  "completed",
  "failed",
  "expired",
  "cancelled",
] as const;

export type MessageState = (typeof MESSAGE_STATES)[number];

/** The modes `send_to_primary` takes and the `messages` CHECK lists. */
export const MESSAGE_MODES = ["next_turn", "steer"] as const;

/** An answer to an inbox question is stored as `next_turn` plus a `message_answers` row and reported as `answer_question`. */
export type MessageMode = (typeof MESSAGE_MODES)[number] | "answer_question";

/** The machine reason recorded with each state; `detail` carries the human sentence. */
export type MessageReason =
  | "authenticated"
  | "ambiguous_owner"
  | "not_controllable"
  | "unsupported_capability"
  | "delivery_failed"
  | "awaiting_controllable_session"
  | "awaiting_earlier_messages"
  | "awaiting_delivery"
  | "handed_to_adapter"
  | "adapter_receipt"
  | "turn_started"
  | "turn_completed"
  | "turn_failed"
  | "owner_disconnected"
  | "cancelled_by_user"
  | "expired_unsent"
  | "agent_ack";

/** The reasons a dispatcher sends a queued message for; a message queued for any other reason keeps it. */
export const SENDABLE_REASONS: ReadonlySet<MessageReason> = new Set(["awaiting_delivery", "awaiting_earlier_messages"]);

export interface MessageChange {
  state: MessageState;
  reason: MessageReason;
  detail: string;
  provider_ref?: string;
}

export interface MessageTransition {
  state: MessageState;
  reason: MessageReason;
  at: string;
}

export interface StoredMessage {
  message_id: string;
  project_id: string;
  /** The session the route named when the message was sent; null when it named none. */
  session_id: string | null;
  /** 1, 2, 3, … per project, in send order. */
  sequence: number;
  mode: MessageMode;
  /** The inbox question an `answer_question` message answers; null for every other mode. */
  question_id: string | null;
  body: string;
  approve_queue: boolean;
  idempotency_key: string;
  state: MessageState;
  reason: MessageReason;
  detail: string;
  provider_ref: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
  /** Oldest first, starting with `accepted`. */
  transitions: MessageTransition[];
}

export interface NewMessage {
  message_id: string;
  project_id: string;
  session_id: string | null;
  mode: MessageMode;
  /** Set exactly when `mode` is `answer_question`. */
  question_id: string | null;
  body: string;
  approve_queue: boolean;
  idempotency_key: string;
  /**
   * The routing decision. `deliverable` stores `queued`, with `awaiting_delivery`, or with
   * `awaiting_earlier_messages` when its session already has a queued or delivering message, which
   * goes first; the session host's dispatcher delivers it. A session that has ended gets it with
   * `owner_disconnected`. Any other decision is stored as given.
   */
  decision: { deliverable: true } | { deliverable: false; state: MessageState; reason: MessageReason; detail: string };
  created_at: string;
  expires_at: string;
}

/** The fields a retry under the same idempotency key must repeat. */
export type MessageIdentity = Pick<NewMessage, "project_id" | "body" | "mode" | "question_id" | "approve_queue" | "idempotency_key">;

/** Returns `stored` when `request` repeats it; a different request under its key throws `idempotency_conflict`. */
export function matchDuplicateMessage(stored: StoredMessage, request: MessageIdentity): StoredMessage {
  if (
    stored.project_id !== request.project_id ||
    stored.body !== request.body ||
    stored.mode !== request.mode ||
    stored.question_id !== request.question_id ||
    stored.approve_queue !== request.approve_queue
  ) {
    throw new BridgeError(
      "idempotency_conflict",
      `idempotency_key ${request.idempotency_key} already names message ${stored.message_id}, sent with other fields`,
    );
  }
  return stored;
}

export interface TurnState {
  session_id: string;
  type: (typeof TURN_EVENT_TYPES)[number];
}

export interface Store {
  getById(projectId: string): Project | undefined;
  list(): Project[];
  /**
   * Inserts the project, or refreshes its name for the same id at the same path.
   * One id maps to one canonical path; either conflict throws and writes nothing.
   */
  upsert(project: Omit<Project, "created_at" | "updated_at">): { project: Project; created: boolean };
  /** Replaces every stored session of the project with `sessions`, in one transaction. */
  replaceSessions(projectId: string, sessions: readonly DiscoveredSession[]): void;
  /**
   * Most recent activity first, then by session_id. A live controlled session replaces the discovered
   * row with its id; an ended one is left out, so discovery reports it as its saved record says.
   */
  listSessions(projectId: string): StoredSession[];
  getPin(projectId: string): PrimaryPin | undefined;
  /** Pins the session, replacing any earlier pin, and records a `pin` audit row in the same transaction. */
  setPin(projectId: string, sessionId: string): PrimaryPin;
  /**
   * Removes the pin and records an `unpin` audit row in the same transaction; returns the removed pin.
   * With no pin it writes nothing.
   */
  clearPin(projectId: string): PrimaryPin | undefined;
  /**
   * Stores the event and advances its source's watermark in one transaction. An identical event
   * under a stored `(source, source_event_id)` is a duplicate; a differing one, or a taken
   * sequence number, throws `event_conflict` and writes nothing. `question`, and an `agent_ack`'s
   * `acknowledgedQuestionId`, are applied to the inbox in the same transaction, only when the event is newly stored.
   * An acknowledgement counts only from the item's asking session in its project.
   */
  ingestEvent(
    event: NewEvent,
    question?: QuestionFields,
    acknowledgedQuestionId?: string | null,
  ): { event_id: number; duplicate: boolean };
  /** One row per source that has stored events, ordered by source. */
  listWatermarks(projectId: string): WatermarkRow[];
  /** The processed event (at or below its source's watermark) observed last, ties broken by event_id. */
  latestProcessedEvent(projectId: string): ProcessedEvent | undefined;
  /** Per session and source, the type of the processed turn event with the highest sequence. */
  latestTurnStates(projectId: string): TurnState[];
  /**
   * Processed events of the briefing types, at most `BRIEFING_EVENTS_PER_TYPE` newest of each type,
   * newest first, ties broken by event_id.
   */
  recentBriefingEvents(projectId: string): BriefingEventRow[];
  /** The highest event_id among processed events, or null when none is processed. */
  highestProcessedEventId(projectId: string): number | null;
  getBriefing(projectId: string): StoredBriefing | undefined;
  /** Inserts or replaces the project's briefing record. */
  saveBriefing(briefing: StoredBriefing): void;
  /** Newest first by `created_at`, ties broken by `source_event_id`. */
  listInbox(filter: { project_id?: string; status?: InboxStatus }): InboxItem[];
  /**
   * Cancels an `open` item and stamps `dismissed_at`, in one transaction. Any other status is left
   * as it is, with `dismissed: false`. Undefined when no item has the id.
   */
  dismissInboxQuestion(questionId: string): { item: InboxItem; dismissed: boolean } | undefined;
  getInboxItem(questionId: string): InboxItem | undefined;
  /** In emission order. */
  listInboxNotifications(): InboxNotification[];
  findMessageByKey(idempotencyKey: string): StoredMessage | undefined;
  getMessage(messageId: string): StoredMessage | undefined;
  /**
   * Stores the message with the next sequence of its project, its `accepted` transition and its decided
   * state, in one transaction. A stored message under the same key is returned as a duplicate when its
   * project, body, mode, question and approve_queue match; otherwise this throws `idempotency_conflict` and
   * writes nothing. An answer needs its inbox item `open`, else it throws `inbox_question_not_open` and writes
   * nothing; once stored as `delivering` or `queued` it moves the item to `answer_queued`.
   */
  createMessage(message: NewMessage): { message: StoredMessage; duplicate: boolean };
  /**
   * Moves the message from `from` to `to` and records the transition, in one transaction. A message in
   * any other state is left as it is, with `changed: false`. Undefined when no message has the id. An answer's
   * inbox item follows it in the same transaction: delivery moves it on, and a failed, expired or cancelled
   * answer reopens it unless its asking session already acknowledged it.
   */
  transitionMessage(
    messageId: string,
    from: MessageState,
    to: MessageChange,
    at: string,
  ): { message: StoredMessage; changed: boolean } | undefined;
  /** Moves every queued message whose `expires_at` is at or before `now` to `expired`, in one transaction. */
  expireMessages(now: string): void;
  /** The session's queued message with the lowest sequence. */
  nextQueuedMessage(sessionId: string): StoredMessage | undefined;
  getLease(worktreeId: string): WorkspaceLease | undefined;
  /**
   * Takes the worktree's lease for `holder_pid`, in one immediate transaction, so two starts serialize.
   * A held lease that `isLive` judges live throws `workspace_owned` and writes nothing; a stale one has
   * its session ended and is replaced.
   */
  acquireLease(
    lease: Pick<WorkspaceLease, "worktree_id" | "project_id" | "holder_pid" | "expires_at"> & { at: string },
    isLive: (held: WorkspaceLease) => boolean,
  ): void;
  /** Deletes the lease only while `holderPid` has it. */
  releaseLease(worktreeId: string, holderPid: number): void;
  /** Records the provider's group on the holder's lease; false when the holder no longer has it. */
  setLeaseProvider(worktreeId: string, holderPid: number, providerPgid: number): boolean;
  /** Renews the holder's heartbeat; false when the holder no longer has the lease. */
  heartbeatLease(worktreeId: string, holderPid: number, at: string, expiresAt: string): boolean;
  /** Inserts the session and names it the owner of its holder's lease, in one transaction. */
  connectControlledSession(session: Omit<ControlledSession, "ended_at">): void;
  setControlledState(sessionId: string, state: ObservedState, at: string): void;
  /**
   * Ends the session, in one transaction: it becomes `unreachable`; its waiting messages stay `queued`
   * with `owner_disconnected`; a message handed over or running becomes `failed`, never to be resent.
   * With `release`, the lease is deleted too, but only while that holder has it.
   */
  endControlledSession(sessionId: string, detail: string, at: string, release?: { worktree_id: string; holder_pid: number }): void;
  /** The project's controlled sessions not yet ended. */
  listLiveControlledSessions(projectId: string): ControlledSession[];
  close(): void;
}

const PROJECTS_TABLE = `
  CREATE TABLE IF NOT EXISTS projects (
    project_id     TEXT PRIMARY KEY,
    canonical_path TEXT NOT NULL UNIQUE,
    display_name   TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );
`;

const SESSIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS sessions (
    project_id        TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    session_id        TEXT NOT NULL,
    provider          TEXT NOT NULL,
    native_session_id TEXT NOT NULL,
    worktree_id       TEXT NOT NULL,
    observed_state    TEXT NOT NULL,
    last_activity_at  TEXT,
    capabilities      TEXT NOT NULL,
    PRIMARY KEY (project_id, session_id)
  );
`;

// No foreign key to sessions: replaceSessions deletes and reinserts every row, which would drop or block the pin.
const PRIMARY_PINS_TABLE = `
  CREATE TABLE IF NOT EXISTS primary_pins (
    project_id TEXT PRIMARY KEY REFERENCES projects(project_id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    pinned_at  TEXT NOT NULL
  );
`;

/** Append-only, with no foreign keys, so the history outlives the pins and projects it names. */
const PIN_AUDIT_TABLE = `
  CREATE TABLE IF NOT EXISTS pin_audit (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    action     TEXT NOT NULL CHECK (action IN ('pin', 'unpin')),
    at         TEXT NOT NULL
  );
`;

// No foreign key to sessions: hook session ids need not match discovered `<provider>:<native>` ids, and
// replaceSessions rewrites that table.
const EVENTS_TABLE = `
  CREATE TABLE IF NOT EXISTS events (
    event_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    session_id      TEXT,
    source          TEXT NOT NULL,
    source_event_id TEXT NOT NULL,
    source_sequence INTEGER NOT NULL CHECK (source_sequence >= 1),
    type            TEXT NOT NULL,
    payload         TEXT NOT NULL,
    observed_at     TEXT NOT NULL,
    received_at     TEXT NOT NULL,
    UNIQUE (source, source_event_id),
    UNIQUE (project_id, source, source_sequence)
  );
`;

const SOURCE_WATERMARKS_TABLE = `
  CREATE TABLE IF NOT EXISTS source_watermarks (
    project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    source     TEXT NOT NULL,
    watermark  INTEGER NOT NULL CHECK (watermark >= 0),
    PRIMARY KEY (project_id, source)
  );
`;

const EVENT_TABLES = EVENTS_TABLE + SOURCE_WATERMARKS_TABLE;

const BRIEFINGS_TABLE = `
  CREATE TABLE IF NOT EXISTS briefings (
    project_id   TEXT PRIMARY KEY REFERENCES projects(project_id) ON DELETE CASCADE,
    content_hash TEXT NOT NULL,
    text         TEXT NOT NULL,
    generated_at TEXT NOT NULL
  );
`;

/**
 * The status CHECK already lists every §12 status, so later tickets need no table rebuild. The unique
 * index is the question identity; a NULL `origin_question_id` never matches, so each such event stands
 * alone, and `''` cannot be a real session id because ingest refuses an empty one. Notifications are
 * append-only with no foreign keys, like `pin_audit`.
 */
const INBOX_TABLES = `
  CREATE TABLE IF NOT EXISTS inbox_items (
    question_id           TEXT PRIMARY KEY,
    project_id            TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    origin_session_id     TEXT,
    origin_question_id    TEXT,
    type                  TEXT,
    summary               TEXT NOT NULL,
    priority              TEXT,
    status                TEXT NOT NULL CHECK (status IN (${INBOX_STATUSES.map((status) => `'${status}'`).join(", ")})),
    source_event_id       INTEGER NOT NULL,
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL,
    dismissed_at          TEXT,
    resolution_message_id TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS inbox_items_origin
    ON inbox_items (project_id, COALESCE(origin_session_id, ''), origin_question_id);
  CREATE TABLE IF NOT EXISTS inbox_notifications (
    notification_id INTEGER PRIMARY KEY AUTOINCREMENT,
    question_id     TEXT NOT NULL,
    project_id      TEXT NOT NULL,
    created_at      TEXT NOT NULL
  );
`;

/**
 * Names the question each answer message answers. A table of its own because the `mode` CHECK of a stored
 * `messages` table predates `answer_question`, and widening it would rebuild that table and rewrite its rows.
 * No foreign keys, like `message_transitions`.
 */
const MESSAGE_ANSWERS_TABLE = `
  CREATE TABLE IF NOT EXISTS message_answers (
    message_id  TEXT PRIMARY KEY,
    question_id TEXT NOT NULL
  );
`;

/**
 * The state CHECK lists every state, so later tickets need no table rebuild. The sequence orders a
 * project's messages, which keeps each of its sessions' messages in order. Transitions are append-only
 * with no foreign keys, like `pin_audit`.
 */
const MESSAGE_TABLES = `
  CREATE TABLE IF NOT EXISTS messages (
    message_id      TEXT PRIMARY KEY,
    project_id      TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    session_id      TEXT,
    sequence        INTEGER NOT NULL CHECK (sequence >= 1),
    mode            TEXT NOT NULL CHECK (mode IN (${MESSAGE_MODES.map((mode) => `'${mode}'`).join(", ")})),
    body            TEXT NOT NULL,
    approve_queue   INTEGER NOT NULL CHECK (approve_queue IN (0, 1)),
    idempotency_key TEXT NOT NULL UNIQUE,
    state           TEXT NOT NULL CHECK (state IN (${MESSAGE_STATES.map((state) => `'${state}'`).join(", ")})),
    reason          TEXT NOT NULL,
    detail          TEXT NOT NULL,
    provider_ref    TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    expires_at      TEXT NOT NULL,
    UNIQUE (project_id, sequence)
  );
  CREATE TABLE IF NOT EXISTS message_transitions (
    transition_id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id    TEXT NOT NULL,
    state         TEXT NOT NULL,
    reason        TEXT NOT NULL,
    at            TEXT NOT NULL
  );
` + MESSAGE_ANSWERS_TABLE;

/**
 * No foreign key to sessions: replaceSessions rewrites that table. The lease's primary key is the
 * worktree, so one worktree has at most one holder.
 */
const CONTROL_TABLES = `
  CREATE TABLE IF NOT EXISTS controlled_sessions (
    session_id        TEXT PRIMARY KEY,
    project_id        TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    provider          TEXT NOT NULL,
    native_session_id TEXT NOT NULL,
    worktree_id       TEXT NOT NULL,
    observed_state    TEXT NOT NULL,
    last_activity_at  TEXT,
    capabilities      TEXT NOT NULL,
    holder_pid        INTEGER NOT NULL,
    provider_pgid     INTEGER NOT NULL,
    started_at        TEXT NOT NULL,
    ended_at          TEXT
  );
  CREATE TABLE IF NOT EXISTS workspace_leases (
    worktree_id      TEXT PRIMARY KEY,
    project_id       TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
    owner_session_id TEXT,
    holder_pid       INTEGER NOT NULL,
    provider_pgid    INTEGER,
    enforceability   TEXT NOT NULL CHECK (enforceability IN ('bridge_controlled')),
    acquired_at      TEXT NOT NULL,
    heartbeat_at     TEXT NOT NULL,
    expires_at       TEXT NOT NULL
  );
`;

/** Tables each known version still lacks; every step only adds tables and leaves stored rows alone. */
const MIGRATIONS: Record<number, string> = {
  0: PROJECTS_TABLE + SESSIONS_TABLE + PRIMARY_PINS_TABLE + PIN_AUDIT_TABLE + EVENT_TABLES + BRIEFINGS_TABLE + INBOX_TABLES + MESSAGE_TABLES + CONTROL_TABLES,
  1: SESSIONS_TABLE + PRIMARY_PINS_TABLE + PIN_AUDIT_TABLE + EVENT_TABLES + BRIEFINGS_TABLE + INBOX_TABLES + MESSAGE_TABLES + CONTROL_TABLES,
  2: PRIMARY_PINS_TABLE + PIN_AUDIT_TABLE + EVENT_TABLES + BRIEFINGS_TABLE + INBOX_TABLES + MESSAGE_TABLES + CONTROL_TABLES,
  3: EVENT_TABLES + BRIEFINGS_TABLE + INBOX_TABLES + MESSAGE_TABLES + CONTROL_TABLES,
  4: BRIEFINGS_TABLE + INBOX_TABLES + MESSAGE_TABLES + CONTROL_TABLES,
  5: INBOX_TABLES + MESSAGE_TABLES + CONTROL_TABLES,
  6: MESSAGE_TABLES + CONTROL_TABLES,
  7: MESSAGE_ANSWERS_TABLE + CONTROL_TABLES,
  8: MESSAGE_ANSWERS_TABLE,
};

/**
 * Every transaction here writes, and a session host writes the same store as the daemon. `IMMEDIATE`
 * takes the write lock up front, where the busy timeout applies; a deferred read that later tries to
 * write fails at once if the other process committed in between.
 */
function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Rewriting stored data is a human decision, so a version with no additive step here refuses to open. */
function initSchema(db: DatabaseSync, file: string): void {
  const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (version === SCHEMA_VERSION) return;
  const migration = Object.hasOwn(MIGRATIONS, version) ? MIGRATIONS[version] : undefined;
  if (migration === undefined) {
    throw new BridgeError(
      "store_version_unsupported",
      `${file} has schema version ${version}; this build only understands versions up to ${SCHEMA_VERSION}`,
    );
  }
  inTransaction(db, () => db.exec(`${migration} PRAGMA user_version = ${SCHEMA_VERSION};`));
}

export function sessionId(provider: Provider, nativeSessionId: string): string {
  return `${provider}:${nativeSessionId}`;
}

export function openStore(dataDir: string): Store {
  const file = path.join(dataDir, STORE_FILE);
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    initSchema(db, file);
  } catch (error) {
    db.close();
    throw error;
  }

  const byId = db.prepare("SELECT * FROM projects WHERE project_id = ?");
  const byPath = db.prepare("SELECT * FROM projects WHERE canonical_path = ?");
  const all = db.prepare("SELECT * FROM projects ORDER BY project_id");
  const upsert = db.prepare(`
    INSERT INTO projects (project_id, canonical_path, display_name, created_at, updated_at)
    VALUES (:project_id, :canonical_path, :display_name, :now, :now)
    ON CONFLICT (project_id) DO UPDATE SET
      display_name = excluded.display_name,
      updated_at = excluded.updated_at
    WHERE projects.canonical_path = excluded.canonical_path
  `);

  const deleteSessions = db.prepare("DELETE FROM sessions WHERE project_id = ?");
  const insertSession = db.prepare(`
    INSERT INTO sessions (project_id, session_id, provider, native_session_id, worktree_id,
                          observed_state, last_activity_at, capabilities)
    VALUES (:project_id, :session_id, :provider, :native_session_id, :worktree_id,
            :observed_state, :last_activity_at, :capabilities)
  `);
  const SESSION_COLUMNS = "session_id, provider, native_session_id, worktree_id, observed_state, last_activity_at, capabilities";
  const LIVE_CONTROLLED = "controlled_sessions WHERE project_id = :project_id AND ended_at IS NULL";
  const sessionsOf = db.prepare(`
    SELECT * FROM (
      SELECT ${SESSION_COLUMNS} FROM sessions
      WHERE project_id = :project_id AND session_id NOT IN (SELECT session_id FROM ${LIVE_CONTROLLED})
      UNION ALL
      SELECT ${SESSION_COLUMNS} FROM ${LIVE_CONTROLLED}
    )
    ORDER BY last_activity_at IS NULL, last_activity_at DESC, session_id
  `);
  const liveControlled = db.prepare(`SELECT * FROM ${LIVE_CONTROLLED} ORDER BY started_at, session_id`);
  const insertControlled = db.prepare(`
    INSERT INTO controlled_sessions (session_id, project_id, provider, native_session_id, worktree_id, observed_state,
                                     last_activity_at, capabilities, holder_pid, provider_pgid, started_at)
    VALUES (:session_id, :project_id, :provider, :native_session_id, :worktree_id, :observed_state,
            :last_activity_at, :capabilities, :holder_pid, :provider_pgid, :started_at)
  `);
  const updateControlledState = db.prepare(
    "UPDATE controlled_sessions SET observed_state = ?, last_activity_at = ? WHERE session_id = ? AND ended_at IS NULL",
  );
  const endedControlled = db.prepare("SELECT 1 FROM controlled_sessions WHERE session_id = ? AND ended_at IS NOT NULL");
  const endControlled = db.prepare(
    "UPDATE controlled_sessions SET observed_state = 'unreachable', ended_at = ? WHERE session_id = ? AND ended_at IS NULL",
  );
  const leaseOf = db.prepare("SELECT * FROM workspace_leases WHERE worktree_id = ?");
  const insertLease = db.prepare(`
    INSERT INTO workspace_leases (worktree_id, project_id, owner_session_id, holder_pid, provider_pgid, enforceability,
                                  acquired_at, heartbeat_at, expires_at)
    VALUES (:worktree_id, :project_id, NULL, :holder_pid, NULL, 'bridge_controlled', :at, :at, :expires_at)
  `);
  const deleteLease = db.prepare("DELETE FROM workspace_leases WHERE worktree_id = ? AND holder_pid = ?");
  const setLeaseProvider = db.prepare("UPDATE workspace_leases SET provider_pgid = ? WHERE worktree_id = ? AND holder_pid = ?");
  const setLeaseOwner = db.prepare("UPDATE workspace_leases SET owner_session_id = ? WHERE worktree_id = ? AND holder_pid = ?");
  const heartbeat = db.prepare(
    "UPDATE workspace_leases SET heartbeat_at = ?, expires_at = ? WHERE worktree_id = ? AND holder_pid = ?",
  );

  const pinOf = db.prepare("SELECT project_id, session_id, pinned_at FROM primary_pins WHERE project_id = ?");
  const upsertPin = db.prepare(`
    INSERT INTO primary_pins (project_id, session_id, pinned_at) VALUES (:project_id, :session_id, :pinned_at)
    ON CONFLICT (project_id) DO UPDATE SET session_id = excluded.session_id, pinned_at = excluded.pinned_at
  `);
  const deletePin = db.prepare("DELETE FROM primary_pins WHERE project_id = ?");
  const insertAudit = db.prepare(`
    INSERT INTO pin_audit (project_id, session_id, action, at) VALUES (:project_id, :session_id, :action, :at)
  `);

  const eventBySourceId = db.prepare(`
    SELECT event_id, project_id, source_sequence FROM events WHERE source = ? AND source_event_id = ?
  `);
  const eventBySequence = db.prepare(
    "SELECT source_event_id FROM events WHERE project_id = ? AND source = ? AND source_sequence = ?",
  );
  const insertEvent = db.prepare(`
    INSERT INTO events (project_id, session_id, source, source_event_id, source_sequence, type, payload,
                        observed_at, received_at)
    VALUES (:project_id, :session_id, :source, :source_event_id, :source_sequence, :type, :payload,
            :observed_at, :received_at)
  `);
  const watermarkOf = db.prepare(`
    SELECT COALESCE((SELECT watermark FROM source_watermarks WHERE project_id = ? AND source = ?), 0) AS watermark
  `);
  const upsertWatermark = db.prepare(`
    INSERT INTO source_watermarks (project_id, source, watermark) VALUES (?, ?, ?)
    ON CONFLICT (project_id, source) DO UPDATE SET watermark = excluded.watermark
  `);
  const watermarksOf = db.prepare(`
    SELECT w.source, w.watermark, MAX(e.source_sequence) AS highest_stored
    FROM source_watermarks w JOIN events e ON e.project_id = w.project_id AND e.source = w.source
    WHERE w.project_id = ?
    GROUP BY w.source, w.watermark
    ORDER BY w.source
  `);
  const PROCESSED_EVENTS = `
    events e JOIN source_watermarks w ON w.project_id = e.project_id AND w.source = e.source
    WHERE e.project_id = ? AND e.source_sequence <= w.watermark
  `;
  const latestProcessed = db.prepare(`
    SELECT e.event_id, e.type, e.observed_at FROM ${PROCESSED_EVENTS}
    ORDER BY e.observed_at DESC, e.event_id DESC LIMIT 1
  `);
  const turnStates = db.prepare(`
    SELECT session_id, type FROM (
      SELECT e.session_id, e.type,
             ROW_NUMBER() OVER (PARTITION BY e.session_id, e.source ORDER BY e.source_sequence DESC) AS latest
      FROM ${PROCESSED_EVENTS}
        AND e.session_id IS NOT NULL AND e.type IN (${TURN_EVENT_TYPES.map((type) => `'${type}'`).join(", ")})
    ) WHERE latest = 1
    ORDER BY session_id
  `);
  const briefingEvents = db.prepare(`
    SELECT event_id, session_id, type, payload, observed_at FROM (
      SELECT e.event_id, e.session_id, e.type, e.payload, e.observed_at,
             ROW_NUMBER() OVER (PARTITION BY e.type ORDER BY e.observed_at DESC, e.event_id DESC) AS recency
      FROM ${PROCESSED_EVENTS}
        AND e.type IN (${BRIEFING_EVENT_TYPES.map((type) => `'${type}'`).join(", ")})
    ) WHERE recency <= ${BRIEFING_EVENTS_PER_TYPE}
    ORDER BY observed_at DESC, event_id DESC
  `);
  const highestProcessed = db.prepare(`SELECT MAX(e.event_id) AS event_id FROM ${PROCESSED_EVENTS}`);
  const briefingOf = db.prepare(
    "SELECT project_id, content_hash, text, generated_at FROM briefings WHERE project_id = ?",
  );
  const upsertBriefing = db.prepare(`
    INSERT INTO briefings (project_id, content_hash, text, generated_at)
    VALUES (:project_id, :content_hash, :text, :generated_at)
    ON CONFLICT (project_id) DO UPDATE SET
      content_hash = excluded.content_hash, text = excluded.text, generated_at = excluded.generated_at
  `);

  const inboxByOrigin = db.prepare(`
    SELECT question_id, status, updated_at FROM inbox_items
    WHERE project_id = ? AND origin_session_id IS ? AND origin_question_id = ?
  `);
  const insertInboxItem = db.prepare(`
    INSERT INTO inbox_items (question_id, project_id, origin_session_id, origin_question_id, type, summary, priority,
                             status, source_event_id, created_at, updated_at)
    VALUES (:question_id, :project_id, :origin_session_id, :origin_question_id, :type, :summary, :priority,
            :status, :source_event_id, :observed_at, :observed_at)
  `);
  const updateInboxItem = db.prepare(`
    UPDATE inbox_items SET
      summary = COALESCE(:summary, summary),
      type = COALESCE(:type, type),
      priority = COALESCE(:priority, priority),
      updated_at = :observed_at
    WHERE question_id = :question_id
  `);
  const withdrawInboxItem = db.prepare(
    "UPDATE inbox_items SET status = 'obsolete' WHERE question_id = ? AND status = 'open'",
  );
  const earliestQuestionEvent = db.prepare(`
    SELECT MIN(event_id) AS event_id FROM events
    WHERE project_id = ? AND session_id IS ? AND type = 'user_question'
      AND json_type(payload, '$.question_id') = 'text' AND json_extract(payload, '$.question_id') = ?
  `);
  const insertNotification = db.prepare(
    "INSERT INTO inbox_notifications (question_id, project_id, created_at) VALUES (?, ?, ?)",
  );
  const inboxItems = db.prepare(`
    SELECT * FROM inbox_items
    WHERE (:project_id IS NULL OR project_id = :project_id) AND (:status IS NULL OR status = :status)
    ORDER BY created_at DESC, source_event_id DESC
  `);
  const inboxItemById = db.prepare("SELECT * FROM inbox_items WHERE question_id = ?");
  const cancelInboxItem = db.prepare(
    "UPDATE inbox_items SET status = 'cancelled', dismissed_at = ? WHERE question_id = ? AND status = 'open'",
  );
  const notifications = db.prepare("SELECT * FROM inbox_notifications ORDER BY notification_id");

  const MESSAGE_ROWS = "SELECT m.*, a.question_id FROM messages m LEFT JOIN message_answers a ON a.message_id = m.message_id";
  const messageById = db.prepare(`${MESSAGE_ROWS} WHERE m.message_id = ?`);
  const messageByKey = db.prepare(`${MESSAGE_ROWS} WHERE m.idempotency_key = ?`);
  const transitionsOf = db.prepare(
    "SELECT state, reason, at FROM message_transitions WHERE message_id = ? ORDER BY transition_id",
  );
  const nextSequence = db.prepare(
    "SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM messages WHERE project_id = ?",
  );
  const pendingForSession = db.prepare(
    "SELECT 1 FROM messages WHERE session_id IS ? AND state IN ('queued', 'delivering') LIMIT 1",
  );
  const nextQueued = db.prepare(
    "SELECT * FROM messages WHERE session_id = ? AND state = 'queued' ORDER BY sequence LIMIT 1",
  );
  const sessionMessages = db.prepare(
    "SELECT message_id, state, reason FROM messages WHERE session_id = ? AND state IN ('queued', 'delivering', 'delivered', 'started') ORDER BY sequence",
  );
  const insertMessage = db.prepare(`
    INSERT INTO messages (message_id, project_id, session_id, sequence, mode, body, approve_queue, idempotency_key,
                          state, reason, detail, created_at, updated_at, expires_at)
    VALUES (:message_id, :project_id, :session_id, :sequence, :mode, :body, :approve_queue, :idempotency_key,
            :state, :reason, :detail, :created_at, :created_at, :expires_at)
  `);
  const insertTransition = db.prepare(
    "INSERT INTO message_transitions (message_id, state, reason, at) VALUES (?, ?, ?, ?)",
  );
  const updateMessageState = db.prepare(`
    UPDATE messages SET state = :state, reason = :reason, detail = :detail,
                        provider_ref = COALESCE(:provider_ref, provider_ref), updated_at = :at
    WHERE message_id = :message_id AND state = :from
  `);
  const insertAnswer = db.prepare("INSERT INTO message_answers (message_id, question_id) VALUES (?, ?)");
  const answerOf = db.prepare("SELECT question_id FROM message_answers WHERE message_id = ?");
  const queueAnswer = db.prepare(
    "UPDATE inbox_items SET status = 'answer_queued', resolution_message_id = ? WHERE question_id = ? AND status = 'open'",
  );
  // Keyed by the answer as well as the question, so an answer only ever moves its own item.
  const moveAnswered = db.prepare(`
    UPDATE inbox_items SET status = :to
    WHERE question_id = :question_id AND resolution_message_id = :message_id AND status = :from
  `);
  const reopenAnswered = db.prepare(`
    UPDATE inbox_items SET status = 'open', resolution_message_id = NULL
    WHERE question_id = ? AND resolution_message_id = ? AND status = 'answer_queued'
  `);
  const expiredMessages = db.prepare(
    "SELECT message_id FROM messages WHERE state = 'queued' AND expires_at <= ? ORDER BY project_id, sequence",
  );

  /** A question with no origin id is identified by its event alone, so it always creates an item. */
  const applyQuestion = (eventId: number, event: NewEvent, question: QuestionFields) => {
    const known =
      question.origin_question_id === null
        ? undefined
        : (inboxByOrigin.get(event.project_id, event.session_id, question.origin_question_id) as
            | { question_id: string; status: InboxStatus; updated_at: string }
            | undefined);
    if (known) {
      // A late event cannot overwrite newer fields, but its withdrawal still counts: open → obsolete only moves one way.
      if (event.observed_at >= known.updated_at) {
        updateInboxItem.run({
          question_id: known.question_id,
          summary: question.summary,
          type: question.type,
          priority: question.priority,
          observed_at: event.observed_at,
        });
      }
      if (question.withdrawn) withdrawInboxItem.run(known.question_id);
      return;
    }
    if (question.withdrawn && question.origin_question_id === null) return;
    // A question asked before the inbox existed keeps the id the briefing already gave it.
    const sourceEventId =
      question.origin_question_id === null
        ? eventId
        : ((earliestQuestionEvent.get(event.project_id, event.session_id, question.origin_question_id) as {
            event_id: number;
          }).event_id);
    const questionId = `q-${sourceEventId}`;
    // A withdrawal seen first leaves an obsolete placeholder, so the late original cannot open and notify.
    insertInboxItem.run({
      question_id: questionId,
      project_id: event.project_id,
      origin_session_id: event.session_id,
      origin_question_id: question.origin_question_id,
      type: question.type,
      summary: question.summary ?? "",
      priority: question.priority,
      status: question.withdrawn ? "obsolete" : "open",
      source_event_id: sourceEventId,
      observed_at: event.observed_at,
    });
    if (!question.withdrawn) insertNotification.run(questionId, event.project_id, new Date().toISOString());
  };

  const storedMessage = (row: Record<string, unknown> | undefined): StoredMessage | undefined =>
    row && {
      ...(row as unknown as Omit<StoredMessage, "approve_queue" | "transitions">),
      mode: row.question_id ? "answer_question" : (row.mode as MessageMode),
      question_id: (row.question_id as string | null) ?? null,
      approve_queue: row.approve_queue === 1,
      transitions: transitionsOf.all(row.message_id as string).map((t) => ({ ...t })) as unknown as MessageTransition[],
    };
  const getMessage = (messageId: string) => storedMessage(messageById.get(messageId));
  const findMessageByKey = (key: string) => storedMessage(messageByKey.get(key));

  const EXPIRED: MessageChange = {
    state: "expired",
    reason: "expired_unsent",
    detail: "the message was not delivered before it expired",
  };
  const ACKNOWLEDGED = (sessionId: string): MessageChange => ({
    state: "acknowledged",
    reason: "agent_ack",
    detail: `acknowledged by ${sessionId}`,
  });
  const moveItem = (questionId: string, messageId: string, from: InboxStatus, to: InboxStatus): boolean =>
    moveAnswered.run({ question_id: questionId, message_id: messageId, from, to }).changes > 0;

  /**
   * Moves an answer's inbox item after its message moved to `state`. An item already `acknowledged` by its
   * asking session resolves on any outcome, since that acknowledgement is the evidence `resolved` needs.
   */
  const applyAnswerOutcome = (messageId: string, state: MessageState, at: string) => {
    const answer = answerOf.get(messageId) as { question_id: string } | undefined;
    if (!answer) return;
    const questionId = answer.question_id;
    if (state === "delivered") {
      if (moveItem(questionId, messageId, "answer_queued", "delivered")) return;
      if (moveItem(questionId, messageId, "acknowledged", "resolved")) {
        const origin = (inboxItemById.get(questionId) as unknown as InboxItem).origin_session_id ?? "the asking session";
        applyTransition(messageId, "delivered", ACKNOWLEDGED(origin), at);
      }
    } else if (state === "failed" || state === "expired" || state === "cancelled") {
      if (!reopenAnswered.run(questionId, messageId).changes && state === "failed") {
        moveItem(questionId, messageId, "acknowledged", "resolved");
      }
    }
  };

  /** Updates the message only if it is still in `from`, and records the transition when it did. */
  const applyTransition = (messageId: string, from: MessageState, to: MessageChange, at: string): boolean => {
    const { changes } = updateMessageState.run({
      message_id: messageId,
      from,
      state: to.state,
      reason: to.reason,
      detail: to.detail,
      provider_ref: to.provider_ref ?? null,
      at,
    });
    if (changes === 0) return false;
    insertTransition.run(messageId, to.state, to.reason, at);
    applyAnswerOutcome(messageId, to.state, at);
    return true;
  };

  /**
   * An acknowledgement before the adapter's receipt is recorded as `acknowledged` and resolves the item when
   * the receipt arrives; one while the answer is still queued has nothing to acknowledge.
   */
  const applyAck = (event: NewEvent, questionId: string) => {
    const item = inboxItemById.get(questionId) as InboxItem | undefined;
    if (
      !item ||
      event.session_id === null ||
      item.project_id !== event.project_id ||
      item.origin_session_id !== event.session_id ||
      item.resolution_message_id === null
    ) {
      return;
    }
    const messageId = item.resolution_message_id;
    if (item.status === "delivered") {
      moveItem(questionId, messageId, "delivered", "resolved");
      applyTransition(messageId, "delivered", ACKNOWLEDGED(event.session_id), new Date().toISOString());
    } else if (item.status === "answer_queued" && getMessage(messageId)?.state === "delivering") {
      moveItem(questionId, messageId, "answer_queued", "acknowledged");
    }
  };

  const endSession = (sessionId: string, detail: string, at: string) => {
    endControlled.run(at, sessionId);
    const messages = sessionMessages.all(sessionId) as { message_id: string; state: MessageState; reason: MessageReason }[];
    for (const { message_id, state, reason } of messages) {
      if (state === "queued" && !SENDABLE_REASONS.has(reason)) continue;
      const outcome =
        state === "queued"
          ? `${detail}; not delivered, and it will not be sent to another session`
          : state === "delivering"
            ? `${detail}; the provider never confirmed the turn, which may have started, and it will not be resent`
            : `${detail}; the turn did not complete`;
      applyTransition(message_id, state, { state: state === "queued" ? "queued" : "failed", reason: "owner_disconnected", detail: outcome }, at);
    }
  };
  const controlledSession = (row: Record<string, unknown>): ControlledSession => ({
    ...(row as unknown as Omit<ControlledSession, "capabilities">),
    capabilities: JSON.parse(row.capabilities as string),
  });
  const lease = (row: unknown): WorkspaceLease | undefined => (row ? { ...(row as WorkspaceLease) } : undefined);

  const getById = (projectId: string) => byId.get(projectId) as Project | undefined;
  const getByPath = (canonicalPath: string) => byPath.get(canonicalPath) as Project | undefined;

  return {
    getById,
    list() {
      return all.all() as unknown as Project[];
    },
    upsert(project) {
      const existing = getById(project.project_id);
      let changes: number | bigint;
      try {
        ({ changes } = upsert.run({
          project_id: project.project_id,
          canonical_path: project.canonical_path,
          display_name: project.display_name,
          now: new Date().toISOString(),
        }));
      } catch (error) {
        // The project_id conflict is absorbed by ON CONFLICT, so a unique failure here is the path.
        if ((error as { errcode?: number }).errcode === SQLITE_CONSTRAINT_UNIQUE) {
          const holder = getByPath(project.canonical_path)?.project_id ?? "another project_id";
          throw new BridgeError(
            "path_already_registered",
            `${project.canonical_path} is already registered as ${holder}`,
          );
        }
        throw error;
      }
      const stored = getById(project.project_id);
      if (changes === 0 || !stored) {
        const holder = stored?.canonical_path ?? "another path";
        throw new BridgeError(
          "project_id_conflict",
          `project_id ${project.project_id} is already registered at ${holder}`,
        );
      }
      return { project: stored, created: existing === undefined };
    },
    replaceSessions(projectId, sessions) {
      inTransaction(db, () => {
        deleteSessions.run(projectId);
        for (const session of sessions) {
          insertSession.run({
            project_id: projectId,
            session_id: sessionId(session.provider, session.native_session_id),
            provider: session.provider,
            native_session_id: session.native_session_id,
            worktree_id: session.worktree_id,
            observed_state: session.observed_state,
            last_activity_at: session.last_activity_at,
            capabilities: JSON.stringify(session.capabilities),
          });
        }
      });
    },
    listSessions(projectId) {
      const rows = sessionsOf.all({ project_id: projectId }) as unknown as (Omit<StoredSession, "capabilities"> & { capabilities: string })[];
      return rows.map((row) => ({ ...row, capabilities: JSON.parse(row.capabilities) }));
    },
    getPin(projectId) {
      return pinOf.get(projectId) as PrimaryPin | undefined;
    },
    setPin(projectId, sessionId) {
      const pin: PrimaryPin = { project_id: projectId, session_id: sessionId, pinned_at: new Date().toISOString() };
      inTransaction(db, () => {
        upsertPin.run({ ...pin });
        insertAudit.run({ project_id: projectId, session_id: sessionId, action: "pin", at: pin.pinned_at });
      });
      return pin;
    },
    clearPin(projectId) {
      return inTransaction(db, () => {
        const pin = pinOf.get(projectId) as PrimaryPin | undefined;
        if (!pin) return undefined;
        deletePin.run(projectId);
        insertAudit.run({ project_id: projectId, session_id: pin.session_id, action: "unpin", at: new Date().toISOString() });
        return pin;
      });
    },
    ingestEvent(event, question, acknowledgedQuestionId) {
      return inTransaction(db, () => {
        const stored = eventBySourceId.get(event.source, event.source_event_id) as
          | { event_id: number; project_id: string; source_sequence: number }
          | undefined;
        if (stored) {
          // A retry may re-serialize its payload or re-stamp observed_at, so only its project and sequence must match.
          if (stored.project_id !== event.project_id || stored.source_sequence !== event.source_sequence) {
            throw new BridgeError(
              "event_conflict",
              `source ${event.source} already stored event ${event.source_event_id} with another project or sequence`,
            );
          }
          return { event_id: stored.event_id, duplicate: true };
        }
        const holder = eventBySequence.get(event.project_id, event.source, event.source_sequence) as
          | { source_event_id: string }
          | undefined;
        if (holder) {
          throw new BridgeError(
            "event_conflict",
            `source ${event.source} sequence ${event.source_sequence} is already event ${holder.source_event_id}`,
          );
        }
        const { lastInsertRowid } = insertEvent.run({ ...event, received_at: new Date().toISOString() });
        let { watermark } = watermarkOf.get(event.project_id, event.source) as { watermark: number };
        while (eventBySequence.get(event.project_id, event.source, watermark + 1)) watermark++;
        upsertWatermark.run(event.project_id, event.source, watermark);
        const eventId = Number(lastInsertRowid);
        if (question) applyQuestion(eventId, event, question);
        if (typeof acknowledgedQuestionId === "string") applyAck(event, acknowledgedQuestionId);
        return { event_id: eventId, duplicate: false };
      });
    },
    listWatermarks(projectId) {
      return watermarksOf.all(projectId) as unknown as WatermarkRow[];
    },
    latestProcessedEvent(projectId) {
      const row = latestProcessed.get(projectId) as ProcessedEvent | undefined;
      return row && { ...row };
    },
    latestTurnStates(projectId) {
      return turnStates.all(projectId).map((row) => ({ ...row })) as unknown as TurnState[];
    },
    recentBriefingEvents(projectId) {
      return briefingEvents.all(projectId).map((row) => ({ ...row })) as unknown as BriefingEventRow[];
    },
    highestProcessedEventId(projectId) {
      return (highestProcessed.get(projectId) as { event_id: number | null }).event_id;
    },
    getBriefing(projectId) {
      const row = briefingOf.get(projectId) as StoredBriefing | undefined;
      return row && { ...row };
    },
    saveBriefing(briefing) {
      upsertBriefing.run({ ...briefing });
    },
    listInbox(filter) {
      const rows = inboxItems.all({ project_id: filter.project_id ?? null, status: filter.status ?? null });
      return rows.map((row) => ({ ...row })) as unknown as InboxItem[];
    },
    dismissInboxQuestion(questionId) {
      return inTransaction(db, () => {
        const { changes } = cancelInboxItem.run(new Date().toISOString(), questionId);
        const row = inboxItemById.get(questionId) as InboxItem | undefined;
        return row && { item: { ...row }, dismissed: changes > 0 };
      });
    },
    getInboxItem(questionId) {
      const row = inboxItemById.get(questionId) as InboxItem | undefined;
      return row && { ...row };
    },
    listInboxNotifications() {
      return notifications.all().map((row) => ({ ...row })) as unknown as InboxNotification[];
    },
    findMessageByKey,
    getMessage,
    createMessage(message) {
      return inTransaction(db, () => {
        if ((message.mode === "answer_question") !== (message.question_id !== null)) {
          throw new Error(`message ${message.message_id}: question_id must be set exactly for mode answer_question`);
        }
        const stored = findMessageByKey(message.idempotency_key);
        if (stored) return { message: matchDuplicateMessage(stored, message), duplicate: true };
        if (message.question_id !== null) {
          const item = inboxItemById.get(message.question_id) as InboxItem | undefined;
          if (item?.status !== "open") {
            throw new BridgeError(
              "inbox_question_not_open",
              `inbox question ${message.question_id} is ${item?.status ?? "missing"}, so it cannot be answered`,
            );
          }
        }
        const { decision } = message;
        // Routed to a controlled session that ended since: it is kept as that session's other waiting messages are.
        const { state, reason, detail }: MessageChange = !decision.deliverable
          ? decision
          : endedControlled.get(message.session_id)
            ? { state: "queued", reason: "owner_disconnected", detail: `${message.session_id} ended before the message was stored; it will not be sent to another session` }
            : pendingForSession.get(message.session_id)
            ? { state: "queued", reason: "awaiting_earlier_messages", detail: "an earlier message to this session is still pending" }
            : { state: "queued", reason: "awaiting_delivery", detail: "waiting for the session to be idle" };
        const { sequence } = nextSequence.get(message.project_id) as { sequence: number };
        insertMessage.run({
          message_id: message.message_id,
          project_id: message.project_id,
          session_id: message.session_id,
          sequence,
          mode: message.mode === "answer_question" ? "next_turn" : message.mode,
          body: message.body,
          approve_queue: message.approve_queue ? 1 : 0,
          idempotency_key: message.idempotency_key,
          state,
          reason,
          detail,
          created_at: message.created_at,
          expires_at: message.expires_at,
        });
        insertTransition.run(message.message_id, "accepted", "authenticated", message.created_at);
        insertTransition.run(message.message_id, state, reason, message.created_at);
        if (message.question_id !== null) {
          insertAnswer.run(message.message_id, message.question_id);
          if (state === "delivering" || state === "queued") queueAnswer.run(message.message_id, message.question_id);
        }
        return { message: getMessage(message.message_id)!, duplicate: false };
      });
    },
    transitionMessage(messageId, from, to, at) {
      return inTransaction(db, () => {
        const changed = applyTransition(messageId, from, to, at);
        const message = getMessage(messageId);
        return message && { message, changed };
      });
    },
    expireMessages(now) {
      inTransaction(db, () => {
        for (const { message_id } of expiredMessages.all(now) as { message_id: string }[]) {
          applyTransition(message_id, "queued", EXPIRED, now);
        }
      });
    },
    nextQueuedMessage(sessionId) {
      return storedMessage(nextQueued.get(sessionId));
    },
    getLease(worktreeId) {
      return lease(leaseOf.get(worktreeId));
    },
    acquireLease(wanted, isLive) {
      return inTransaction(db, () => {
        const held = lease(leaseOf.get(wanted.worktree_id));
        if (held && isLive(held)) {
          throw new BridgeError(
            "workspace_owned",
            `${wanted.worktree_id} is held by bridge session host pid ${held.holder_pid}` +
              `${held.provider_pgid === null ? "" : `, provider process group ${held.provider_pgid}`}` +
              `${held.owner_session_id === null ? "" : `, session ${held.owner_session_id}`}` +
              `, last heartbeat ${held.heartbeat_at}, expiry ${held.expires_at}`,
          );
        }
        if (held) {
          if (held.owner_session_id !== null) endSession(held.owner_session_id, `the lease of ${held.worktree_id} was found stale`, wanted.at);
          deleteLease.run(held.worktree_id, held.holder_pid);
        }
        insertLease.run({ ...wanted });
      });
    },
    releaseLease(worktreeId, holderPid) {
      deleteLease.run(worktreeId, holderPid);
    },
    setLeaseProvider(worktreeId, holderPid, providerPgid) {
      return setLeaseProvider.run(providerPgid, worktreeId, holderPid).changes > 0;
    },
    heartbeatLease(worktreeId, holderPid, at, expiresAt) {
      return heartbeat.run(at, expiresAt, worktreeId, holderPid).changes > 0;
    },
    connectControlledSession(session) {
      inTransaction(db, () => {
        insertControlled.run({ ...session, capabilities: JSON.stringify(session.capabilities) });
        setLeaseOwner.run(session.session_id, session.worktree_id, session.holder_pid);
      });
    },
    setControlledState(sessionId, state, at) {
      updateControlledState.run(state, at, sessionId);
    },
    endControlledSession(sessionId, detail, at, release) {
      inTransaction(db, () => {
        endSession(sessionId, detail, at);
        if (release) deleteLease.run(release.worktree_id, release.holder_pid);
      });
    },
    listLiveControlledSessions(projectId) {
      return (liveControlled.all({ project_id: projectId }) as Record<string, unknown>[]).map(controlledSession);
    },
    close() {
      db.close();
    },
  };
}
