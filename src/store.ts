import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type { DiscoveredSession, Provider } from "./adapters/types.js";
import { BridgeError } from "./errors.js";

export const STORE_FILE = "bridge.sqlite";
const SCHEMA_VERSION = 2;
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

/** Tables each known version still lacks; every step only adds tables and leaves stored rows alone. */
const MIGRATIONS: Record<number, string> = {
  0: PROJECTS_TABLE + SESSIONS_TABLE,
  1: SESSIONS_TABLE,
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
    close() {
      db.close();
    },
  };
}
