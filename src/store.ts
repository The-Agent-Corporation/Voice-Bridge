import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type { DiscoveredSession, Provider } from "./adapters/types.js";
import { BridgeError } from "./errors.js";

export const STORE_FILE = "bridge.sqlite";
const SCHEMA_VERSION = 6;
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
  /** JSON text, kept as untrusted data; only the briefing renderer and, for `user_question`, the inbox read its named fields. */
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

/** The question statuses of docs/PRD.md §12; this build writes only `open`, `cancelled` and `obsolete`. */
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
  /** Most recent activity first, then by session_id. */
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
   * sequence number, throws `event_conflict` and writes nothing. `question` is applied to the inbox in
   * the same transaction, only when the event is newly stored.
   */
  ingestEvent(event: NewEvent, question?: QuestionFields): { event_id: number; duplicate: boolean };
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
  /** In emission order. */
  listInboxNotifications(): InboxNotification[];
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

/** Tables each known version still lacks; every step only adds tables and leaves stored rows alone. */
const MIGRATIONS: Record<number, string> = {
  0: PROJECTS_TABLE + SESSIONS_TABLE + PRIMARY_PINS_TABLE + PIN_AUDIT_TABLE + EVENT_TABLES + BRIEFINGS_TABLE + INBOX_TABLES,
  1: SESSIONS_TABLE + PRIMARY_PINS_TABLE + PIN_AUDIT_TABLE + EVENT_TABLES + BRIEFINGS_TABLE + INBOX_TABLES,
  2: PRIMARY_PINS_TABLE + PIN_AUDIT_TABLE + EVENT_TABLES + BRIEFINGS_TABLE + INBOX_TABLES,
  3: EVENT_TABLES + BRIEFINGS_TABLE + INBOX_TABLES,
  4: BRIEFINGS_TABLE + INBOX_TABLES,
  5: INBOX_TABLES,
};

function inTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN");
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
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
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
  const sessionsOf = db.prepare(`
    SELECT session_id, provider, native_session_id, worktree_id, observed_state, last_activity_at, capabilities
    FROM sessions WHERE project_id = ?
    ORDER BY last_activity_at IS NULL, last_activity_at DESC, session_id
  `);

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
      const rows = sessionsOf.all(projectId) as unknown as (Omit<StoredSession, "capabilities"> & { capabilities: string })[];
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
    ingestEvent(event, question) {
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
    listInboxNotifications() {
      return notifications.all().map((row) => ({ ...row })) as unknown as InboxNotification[];
    },
    close() {
      db.close();
    },
  };
}
