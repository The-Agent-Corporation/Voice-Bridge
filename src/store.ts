import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { BridgeError } from "./errors.js";

export const STORE_FILE = "bridge.sqlite";
const SCHEMA_VERSION = 1;
const SQLITE_CONSTRAINT_UNIQUE = 2067;

export interface Project {
  project_id: string;
  display_name: string;
  canonical_path: string;
  config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface ProjectRow {
  project_id: string;
  display_name: string;
  canonical_path: string;
  config_json: string;
  created_at: string;
  updated_at: string;
}

export interface Store {
  getById(projectId: string): Project | undefined;
  getByPath(canonicalPath: string): Project | undefined;
  list(): Project[];
  /** Inserts the project, or refreshes name and config for the same id at the same path. */
  upsert(project: Omit<Project, "created_at" | "updated_at">): Project;
  close(): void;
}

function toProject(row: ProjectRow): Project {
  return {
    project_id: row.project_id,
    display_name: row.display_name,
    canonical_path: row.canonical_path,
    config: JSON.parse(row.config_json) as Record<string, unknown>,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Migrating stored data is a human decision, so an unknown schema version refuses to open. */
function initSchema(db: DatabaseSync, file: string): void {
  const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (version === SCHEMA_VERSION) return;
  if (version !== 0) {
    throw new BridgeError(
      "store_version_unsupported",
      `${file} has schema version ${version}; this build only understands version ${SCHEMA_VERSION}`,
    );
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      project_id     TEXT PRIMARY KEY,
      canonical_path TEXT NOT NULL UNIQUE,
      display_name   TEXT NOT NULL,
      config_json    TEXT NOT NULL,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
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
    INSERT INTO projects (project_id, canonical_path, display_name, config_json, created_at, updated_at)
    VALUES (:project_id, :canonical_path, :display_name, :config_json, :now, :now)
    ON CONFLICT (project_id) DO UPDATE SET
      display_name = excluded.display_name,
      config_json = excluded.config_json,
      updated_at = excluded.updated_at
    WHERE projects.canonical_path = excluded.canonical_path
  `);

  const getById = (projectId: string) => {
    const row = byId.get(projectId) as ProjectRow | undefined;
    return row && toProject(row);
  };

  return {
    getById,
    getByPath(canonicalPath) {
      const row = byPath.get(canonicalPath) as ProjectRow | undefined;
      return row && toProject(row);
    },
    list() {
      return (all.all() as unknown as ProjectRow[]).map(toProject);
    },
    upsert(project) {
      let changes: number | bigint;
      try {
        ({ changes } = upsert.run({
          project_id: project.project_id,
          canonical_path: project.canonical_path,
          display_name: project.display_name,
          config_json: JSON.stringify(project.config),
          now: new Date().toISOString(),
        }));
      } catch (error) {
        // The project_id conflict is absorbed by ON CONFLICT, so a unique failure here is the path.
        if ((error as { errcode?: number }).errcode === SQLITE_CONSTRAINT_UNIQUE) {
          throw new BridgeError(
            "path_already_registered",
            `${project.canonical_path} is already registered under another project_id`,
          );
        }
        throw error;
      }
      const stored = getById(project.project_id);
      if (changes === 0 || !stored) {
        throw new BridgeError(
          "project_id_conflict",
          `project_id ${project.project_id} is already registered at another path`,
        );
      }
      return stored;
    },
    close() {
      db.close();
    },
  };
}
