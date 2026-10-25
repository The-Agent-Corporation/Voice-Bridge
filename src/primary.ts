import type { ProviderHomes } from "./adapters/homes.js";
import type { ObservedState } from "./adapters/types.js";
import { BridgeError } from "./errors.js";
import { discoverProjectSessions } from "./sessions.js";
import type { Project, Store, StoredSession } from "./store.js";

/** `origin` routes an inbox answer to the session that asked; `get_primary_session` never returns it. */
export type PrimaryRouteName = "pinned" | "sole_connected" | "recent_saved_read_only" | "ambiguous" | "none" | "origin";

/** docs/PRD.md §7.3. Invariant: `mutating_allowed` implies `available`. */
export interface PrimaryRoute {
  primary_session_id: string | null;
  /** The one connected session in the selected worktree, when there is exactly one. */
  connected_session_id: string | null;
  /**
   * The bridge-controlled session holding the worktree's lease (docs/PRD.md §10), or null. Only a lease
   * sets it; discovery evidence never proves ownership.
   */
  workspace_owner_session_id: string | null;
  route: PrimaryRouteName;
  mutating_allowed: boolean;
  /** The primary can receive a message now. */
  available: boolean;
  reason: string;
}

export interface PrimaryResult extends PrimaryRoute {
  project_id: string;
  /** Records discovery could not read; a nonzero count means the route was resolved without them. */
  skipped_records: number;
}

/** The states docs/PRD.md §7.1 calls a live controllable agent. */
const CONNECTED_STATES: ReadonlySet<ObservedState> = new Set(["connected_idle", "connected_running", "waiting_user"]);

const isConnected = (session: StoredSession) => CONNECTED_STATES.has(session.observed_state);

/** Another session in the chosen one's worktree is connected or of unknown state, so it may also write. */
const competes = (sessions: readonly StoredSession[], chosen: StoredSession) =>
  sessions.some((s) => s !== chosen && s.worktree_id === chosen.worktree_id && (isConnected(s) || s.observed_state === "unknown"));

/** Most recent activity first, unknown activity last, then by session_id, whatever the input order. */
function byRecency(a: StoredSession, b: StoredSession): number {
  if (a.last_activity_at !== b.last_activity_at) {
    if (a.last_activity_at === null) return 1;
    if (b.last_activity_at === null) return -1;
    return a.last_activity_at > b.last_activity_at ? -1 : 1;
  }
  return a.session_id < b.session_id ? -1 : a.session_id > b.session_id ? 1 : 0;
}

/**
 * Picks the session a project's instructions go to: a pin always wins, even over a newer
 * session; otherwise the selected worktree decides, and ambiguity is checked before any
 * timestamp is used, so a timestamp only ever chooses among sessions that are safe to choose.
 */
export function resolvePrimary(
  sessions: readonly StoredSession[],
  pin: string | null,
  worktreeId: string,
  ownerSessionId: string | null = null,
): PrimaryRoute {
  const inWorktree = sessions.filter((s) => s.worktree_id === worktreeId);
  const connected = inWorktree.filter(isConnected);
  const connectedSessionId = connected.length === 1 ? connected[0]!.session_id : null;
  const route = (fields: Omit<PrimaryRoute, "connected_session_id" | "workspace_owner_session_id">): PrimaryRoute => ({
    ...fields,
    connected_session_id: connectedSessionId,
    workspace_owner_session_id: ownerSessionId,
  });

  if (pin !== null) {
    const pinned = sessions.find((s) => s.session_id === pin);
    if (!pinned) {
      return route({
        primary_session_id: null,
        route: "ambiguous",
        mutating_allowed: false,
        available: false,
        reason: `pinned session ${pin} is no longer among the project's sessions; unpin it or pin another`,
      });
    }
    const available = isConnected(pinned);
    const competing = competes(sessions, pinned);
    const reason = !available
      ? `pinned session ${pin} is ${pinned.observed_state}; the pin is kept`
      : competing
        ? `pinned session ${pin} is connected, but another session in its worktree may also write, so mutating is blocked`
        : `pinned session ${pin} is connected`;
    return route({ primary_session_id: pin, route: "pinned", mutating_allowed: available && !competing, available, reason });
  }

  const unknown = inWorktree.filter((s) => s.observed_state === "unknown");
  if (connected.length >= 2 || unknown.length > 0) {
    const reason =
      connected.length >= 2
        ? `${connected.length} connected sessions in ${worktreeId}; pin one to choose`
        : `the state of ${unknown.map((s) => s.session_id).join(", ")} in ${worktreeId} is unknown; pin a session to choose`;
    return route({ primary_session_id: null, route: "ambiguous", mutating_allowed: false, available: false, reason });
  }
  if (connected.length === 1) {
    return route({
      primary_session_id: connectedSessionId,
      route: "sole_connected",
      mutating_allowed: true,
      available: true,
      reason: `${connectedSessionId} is the only connected session in ${worktreeId}`,
    });
  }
  const recent = inWorktree.filter((s) => s.observed_state === "saved").sort(byRecency)[0];
  if (recent) {
    return route({
      primary_session_id: recent.session_id,
      route: "recent_saved_read_only",
      mutating_allowed: false,
      available: false,
      reason: `no connected session in ${worktreeId}; ${recent.session_id} is the most recently active saved session, read-only`,
    });
  }
  return route({
    primary_session_id: null,
    route: "none",
    mutating_allowed: false,
    available: false,
    reason: `no resumable session in ${worktreeId}`,
  });
}

/**
 * Routes to the session that asked an inbox question, judged as a pin is: it must be among the discovered
 * sessions, connected, and alone in its worktree. The route names it even when refused, so an answer is
 * only ever addressed to the asking session.
 */
export function resolveOrigin(sessions: readonly StoredSession[], originSessionId: string): PrimaryRoute {
  const route = (available: boolean, mutatingAllowed: boolean, reason: string): PrimaryRoute => ({
    primary_session_id: originSessionId,
    connected_session_id: null,
    workspace_owner_session_id: null,
    route: "origin",
    mutating_allowed: mutatingAllowed,
    available,
    reason,
  });
  const origin = sessions.find((s) => s.session_id === originSessionId);
  if (!origin) return route(false, false, `asking session ${originSessionId} is not among the project's discovered sessions`);
  if (!isConnected(origin)) return route(false, false, `asking session ${originSessionId} is ${origin.observed_state}`);
  if (competes(sessions, origin)) {
    return route(true, false, `asking session ${originSessionId} is connected, but another session in its worktree may also write`);
  }
  return route(true, true, `asking session ${originSessionId} is connected`);
}

/** Resolves over what the store holds now, without rediscovering. */
export function resolveStoredPrimary(store: Store, project: Project): PrimaryRoute {
  const pin = store.getPin(project.project_id)?.session_id ?? null;
  const owner = store.getLease(project.canonical_path)?.owner_session_id ?? null;
  return resolvePrimary(store.listSessions(project.project_id), pin, project.canonical_path, owner);
}

interface Discovered {
  project: Project;
  skipped_records: number;
}

async function discoveredProject(store: Store, projectId: string, homes: ProviderHomes): Promise<Discovered> {
  const project = store.getById(projectId);
  if (!project) throw new BridgeError("project_not_found", `no project registered with id ${projectId}`);
  const { skipped_records } = await discoverProjectSessions(store, project, homes);
  return { project, skipped_records };
}

const result = (store: Store, { project, skipped_records }: Discovered): PrimaryResult => ({
  project_id: project.project_id,
  ...resolveStoredPrimary(store, project),
  skipped_records,
});

export async function getPrimarySession(store: Store, projectId: string, homes: ProviderHomes): Promise<PrimaryResult> {
  return result(store, await discoveredProject(store, projectId, homes));
}

/** Pins only a session discovered for this project just now; anything else writes nothing. */
export async function pinPrimary(store: Store, projectId: string, sessionId: string, homes: ProviderHomes): Promise<PrimaryResult> {
  const discovered = await discoveredProject(store, projectId, homes);
  const { project } = discovered;
  if (!store.listSessions(project.project_id).some((s) => s.session_id === sessionId)) {
    throw new BridgeError("session_not_in_project", `${sessionId} is not a session of project ${project.project_id}`);
  }
  store.setPin(project.project_id, sessionId);
  return result(store, discovered);
}

export async function unpinPrimary(store: Store, projectId: string, homes: ProviderHomes): Promise<PrimaryResult> {
  const discovered = await discoveredProject(store, projectId, homes);
  store.clearPin(discovered.project.project_id);
  return result(store, discovered);
}
