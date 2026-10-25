import { BridgeError } from "./errors.js";
import type { BriefingEventRow, EventType, HeadObservation, Store, TurnState, WatermarkRow } from "./store.js";

export type Freshness = "current" | "lagging" | "unverified" | "conflicted";

export type FreshnessReason =
  | "no_events"
  | "sequence_gap"
  | "head_moved"
  | "head_unreadable"
  | "unprocessed_events"
  | "turn_state_conflict";

export interface FreshnessInput {
  watermarks: readonly WatermarkRow[];
  latestTurnStates: readonly TurnState[];
  pendingEvents: number;
  /** The last HEAD read from the repository, if any read has happened. */
  head: HeadObservation | undefined;
  /** The newest processed `git_commit`'s commit, as `latestRecordedCommit` reads it. */
  recordedCommit: string | null;
}

export interface ProjectStatus {
  project_id: string;
  freshness: Freshness;
  freshness_reasons: FreshnessReason[];
  watermarks: Record<string, number>;
  last_confirmed_activity: { type: EventType; observed_at: string } | null;
  last_event_id: number | null;
}

const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/;

function commitOf(payload: string): string | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    const commit = typeof parsed === "object" && parsed !== null ? (parsed as { commit?: unknown }).commit : undefined;
    return typeof commit === "string" && COMMIT_PATTERN.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

/** The commit of the newest `git_commit` among `events` (newest first) that names a well-formed one. */
export function latestRecordedCommit(events: readonly BriefingEventRow[]): string | null {
  for (const event of events) {
    if (event.type !== "git_commit") continue;
    const commit = commitOf(event.payload);
    if (commit !== null) return commit;
  }
  return null;
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

/** A hook may record a short hash, so a recorded prefix of HEAD counts as the same commit. */
export function headMoved(head: HeadObservation | undefined, recordedCommit: string | null): boolean {
  if (!head || head.error !== null || head.head === null) return false;
  return recordedCommit === null || !head.head.startsWith(recordedCommit);
}

/**
 * Every reason that holds is listed. Missing evidence (no events, a gap, a HEAD the store has not
 * recorded or cannot read) makes the project unverified; otherwise unprocessed events make it lagging,
 * ahead of a turn conflict they may resolve.
 */
export function computeFreshness(input: FreshnessInput): Pick<ProjectStatus, "freshness" | "freshness_reasons"> {
  const holds: Record<FreshnessReason, boolean> = {
    no_events: input.watermarks.length === 0,
    sequence_gap: input.watermarks.some((row) => row.highest_stored > row.watermark),
    head_moved: headMoved(input.head, input.recordedCommit),
    head_unreadable: input.head !== undefined && input.head.error !== null,
    unprocessed_events: input.pendingEvents > 0,
    turn_state_conflict: hasTurnConflict(input.latestTurnStates),
  };
  const reasons = (Object.keys(holds) as FreshnessReason[]).filter((reason) => holds[reason]);
  const freshness: Freshness =
    holds.no_events || holds.sequence_gap || holds.head_moved || holds.head_unreadable
      ? "unverified"
      : holds.unprocessed_events
        ? "lagging"
        : holds.turn_state_conflict
          ? "conflicted"
          : "current";
  return { freshness, freshness_reasons: reasons };
}

export function getProjectStatus(store: Store, projectId: string): ProjectStatus {
  if (!store.getById(projectId)) {
    throw new BridgeError("project_not_found", `no project registered with id ${projectId}`);
  }
  const watermarks = store.listWatermarks(projectId);
  const latest = store.latestProcessedEvent(projectId);
  return {
    project_id: projectId,
    ...computeFreshness({
      watermarks,
      latestTurnStates: store.latestTurnStates(projectId),
      pendingEvents: store.countPendingEvents(projectId),
      head: store.getHead(projectId),
      recordedCommit: latestRecordedCommit(store.recentBriefingEvents(projectId)),
    }),
    watermarks: Object.fromEntries(watermarks.map((row) => [row.source, row.watermark])),
    last_confirmed_activity: latest ? { type: latest.type, observed_at: latest.observed_at } : null,
    last_event_id: latest?.event_id ?? null,
  };
}
