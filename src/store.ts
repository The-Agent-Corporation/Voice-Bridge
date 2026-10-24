import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type { DiscoveredSession, Provider } from "./adapters/types.js";
import { BridgeError } from "./errors.js";

export const STORE_FILE = "bridge.sqlite";
const SCHEMA_VERSION = 4;
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

export interface NewEvent {
  project_id: string;
  session_id: string | null;
  source: string;
  source_event_id: string;
  source_sequence: number;
  type: EventType;
  /** JSON text, kept as untrusted data: nothing reads it back. */
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

export interface TurnState {
  session_id: string;
  source: string;
  type: EventType;
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
   * sequence number, throws `event_conflict` and writes nothing.
   */
  ingestEvent(event: NewEvent): { event_id: number; duplicate: boolean };
  /** One row per source that has stored events, ordered by source. */
  listWatermarks(projectId: string): WatermarkRow[];
  countEvents(projectId: string): number;
  /** The processed event (at or below its source's watermark) observed last, ties broken by event_id. */
  latestProcessedEvent(projectId: string): ProcessedEvent | undefined;
  /** Per session and source, the type of the processed turn event with the highest sequence. */
  latestTurnStates(projectId: string): TurnState[];
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

/** Tables each known version still lacks; every step only adds tables and leaves stored rows alone. */
const MIGRATIONS: Record<number, string> = {
  0: PROJECTS_TABLE + SESSIONS_TABLE + PRIMARY_PINS_TABLE + PIN_AUDIT_TABLE + EVENT_TABLES,
  1: SESSIONS_TABLE + PRIMARY_PINS_TABLE + PIN_AUDIT_TABLE + EVENT_TABLES,
  2: PRIMARY_PINS_TABLE + PIN_AUDIT_TABLE + EVENT_TABLES,
  3: EVENT_TABLES,
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
    SELECT event_id, project_id, session_id, source_sequence, type, payload, observed_at
    FROM events WHERE source = ? AND source_event_id = ?
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
  const ensureWatermark = db.prepare(`
    INSERT INTO source_watermarks (project_id, source, watermark) VALUES (?, ?, 0)
    ON CONFLICT (project_id, source) DO NOTHING
  `);
  const watermarkOf = db.prepare("SELECT watermark FROM source_watermarks WHERE project_id = ? AND source = ?");
  const setWatermark = db.prepare("UPDATE source_watermarks SET watermark = ? WHERE project_id = ? AND source = ?");
  const watermarksOf = db.prepare(`
    SELECT w.source, w.watermark, MAX(e.source_sequence) AS highest_stored
    FROM source_watermarks w JOIN events e ON e.project_id = w.project_id AND e.source = w.source
    WHERE w.project_id = ?
    GROUP BY w.source, w.watermark
    ORDER BY w.source
  `);
  const eventCount = db.prepare("SELECT COUNT(*) AS n FROM events WHERE project_id = ?");
  const PROCESSED_EVENTS = `
    events e JOIN source_watermarks w ON w.project_id = e.project_id AND w.source = e.source
    WHERE e.project_id = ? AND e.source_sequence <= w.watermark
  `;
  const latestProcessed = db.prepare(`
    SELECT e.event_id, e.type, e.observed_at FROM ${PROCESSED_EVENTS}
    ORDER BY e.observed_at DESC, e.event_id DESC LIMIT 1
  `);
  const turnStates = db.prepare(`
    SELECT session_id, source, type FROM (
      SELECT e.session_id, e.source, e.type,
             ROW_NUMBER() OVER (PARTITION BY e.session_id, e.source ORDER BY e.source_sequence DESC) AS latest
      FROM ${PROCESSED_EVENTS}
        AND e.session_id IS NOT NULL AND e.type IN ('turn_started', 'turn_completed', 'turn_failed')
    ) WHERE latest = 1
    ORDER BY session_id, source
  `);

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
    ingestEvent(event) {
      return inTransaction(db, () => {
        const stored = eventBySourceId.get(event.source, event.source_event_id) as
          | (Omit<NewEvent, "source" | "source_event_id"> & { event_id: number })
          | undefined;
        if (stored) {
          const { event_id, ...fields } = stored;
          const same = (Object.keys(fields) as (keyof typeof fields)[]).every((key) => fields[key] === event[key]);
          if (!same) {
            throw new BridgeError(
              "event_conflict",
              `source ${event.source} already stored event ${event.source_event_id} with different content`,
            );
          }
          return { event_id, duplicate: true };
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
        ensureWatermark.run(event.project_id, event.source);
        let { watermark } = watermarkOf.get(event.project_id, event.source) as { watermark: number };
        const start = watermark;
        while (eventBySequence.get(event.project_id, event.source, watermark + 1)) watermark++;
        if (watermark !== start) setWatermark.run(watermark, event.project_id, event.source);
        return { event_id: Number(lastInsertRowid), duplicate: false };
      });
    },
    listWatermarks(projectId) {
      return watermarksOf.all(projectId) as unknown as WatermarkRow[];
    },
    countEvents(projectId) {
      return (eventCount.get(projectId) as { n: number }).n;
    },
    latestProcessedEvent(projectId) {
      const row = latestProcessed.get(projectId) as ProcessedEvent | undefined;
      return row && { ...row };
    },
    latestTurnStates(projectId) {
      return turnStates.all(projectId).map((row) => ({ ...row })) as unknown as TurnState[];
    },
    close() {
      db.close();
    },
  };
}
