import { BridgeError } from "./errors.js";
import { compareHead, latestRecordedCommit, type HeadCheck, type HeadReader } from "./head.js";
import type { EventType, Store, TurnState, WatermarkRow } from "./store.js";

export type Freshness = "current" | "lagging" | "unverified" | "conflicted";

export type FreshnessReason =
  | "no_events"
  | "sequence_gap"
  | "head_moved"
  | "head_unreadable"
  | "pending_refresh"
  | "turn_state_conflict";

export interface FreshnessInput {
  watermarks: readonly WatermarkRow[];
  latestTurnStates: readonly TurnState[];
  /** Admitted events the briefing has not been refreshed from yet. */
  pendingRefresh?: boolean;
  /** Absent when HEAD was not read; that adds no reason. */
  head?: HeadCheck;
}

export interface ProjectStatus {
  project_id: string;
  freshness: Freshness;
  freshness_reasons: FreshnessReason[];
  watermarks: Record<string, number>;
  last_confirmed_activity: { type: EventType; observed_at: string } | null;
  last_event_id: number | null;
}

function hasTurnConflict(states: readonly TurnState[]): boolean {
  const bySession = new Map<string, Set<EventType>>();
  for (const { session_id, type } of states) {
    const types = bySession.get(session_id) ?? new Set();
    types.add(type);
    bySession.set(session_id, types);
  }
  return [...bySession.values()].some((types) => types.size > 1);
}

/**
 * Every reason that holds is listed. Missing evidence (no events, a gap, a HEAD the store has not
 * recorded or cannot read) makes it `unverified`; known events not yet refreshed into the briefing
 * make it `lagging`; disagreement makes it `conflicted`, in that order of precedence.
 */
export function computeFreshness(input: FreshnessInput): Pick<ProjectStatus, "freshness" | "freshness_reasons"> {
  const holds: [FreshnessReason, boolean][] = [
    ["no_events", input.watermarks.length === 0],
    ["sequence_gap", input.watermarks.some((row) => row.highest_stored > row.watermark)],
    ["head_moved", input.head === "moved"],
    ["head_unreadable", input.head === "unreadable"],
    ["pending_refresh", input.pendingRefresh === true],
    ["turn_state_conflict", hasTurnConflict(input.latestTurnStates)],
  ];
  const reasons = holds.filter(([, holds]) => holds).map(([reason]) => reason);
  const any = (...names: FreshnessReason[]) => names.some((name) => reasons.includes(name));
  const freshness: Freshness = any("no_events", "sequence_gap", "head_moved", "head_unreadable")
    ? "unverified"
    : any("pending_refresh")
      ? "lagging"
      : any("turn_state_conflict")
        ? "conflicted"
        : "current";
  return { freshness, freshness_reasons: reasons };
}

function requireProject(store: Store, projectId: string) {
  const project = store.getById(projectId);
  if (!project) throw new BridgeError("project_not_found", `no project registered with id ${projectId}`);
  return project;
}

/**
 * The status from the store alone, with `head` from a HEAD read the caller made. A briefing refresh
 * passes `refreshing`, since the refresh is what clears `pending_refresh`.
 */
export function getProjectStatus(
  store: Store,
  projectId: string,
  options: { head?: HeadCheck; refreshing?: boolean } = {},
): ProjectStatus {
  requireProject(store, projectId);
  const watermarks = store.listWatermarks(projectId);
  const latest = store.latestProcessedEvent(projectId);
  const highest = store.highestProcessedEventId(projectId);
  const mark = store.getRefreshMark(projectId);
  return {
    project_id: projectId,
    ...computeFreshness({
      watermarks,
      latestTurnStates: store.latestTurnStates(projectId),
      pendingRefresh: !options.refreshing && highest !== null && (mark === null || mark < highest),
      head: options.head,
    }),
    watermarks: Object.fromEntries(watermarks.map((row) => [row.source, row.watermark])),
    last_confirmed_activity: latest ? { type: latest.type, observed_at: latest.observed_at } : null,
    last_event_id: latest?.event_id ?? null,
  };
}

/** Reads the repository's HEAD now and compares it with the last commit the store recorded. */
export async function getLiveHeadCheck(store: Store, projectId: string, readHead: HeadReader): Promise<HeadCheck> {
  const project = requireProject(store, projectId);
  const head = await readHead(project.canonical_path);
  return compareHead(head, latestRecordedCommit(store.recentCommitEvents(projectId)));
}

export async function getLiveProjectStatus(store: Store, projectId: string, readHead: HeadReader): Promise<ProjectStatus> {
  const head = await getLiveHeadCheck(store, projectId, readHead);
  return getProjectStatus(store, projectId, { head });
}
