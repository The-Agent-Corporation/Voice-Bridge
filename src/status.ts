import { BridgeError } from "./errors.js";
import type { EventType, Store, TurnState, WatermarkRow } from "./store.js";

export type Freshness = "current" | "lagging" | "unverified" | "conflicted";

export type FreshnessReason = "no_events" | "sequence_gap" | "turn_state_conflict";

export interface FreshnessInput {
  watermarks: readonly WatermarkRow[];
  latestTurnStates: readonly TurnState[];
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
 * Every reason that holds is listed; missing evidence outranks disagreement. Events are processed in
 * the request, so only a gap holds events above a watermark and `lagging` cannot occur yet.
 */
export function computeFreshness(input: FreshnessInput): Pick<ProjectStatus, "freshness" | "freshness_reasons"> {
  const noEvents = input.watermarks.length === 0;
  const gap = input.watermarks.some((row) => row.highest_stored > row.watermark);
  const conflict = hasTurnConflict(input.latestTurnStates);
  const reasons: FreshnessReason[] = [];
  if (noEvents) reasons.push("no_events");
  if (gap) reasons.push("sequence_gap");
  if (conflict) reasons.push("turn_state_conflict");
  const freshness: Freshness = noEvents || gap ? "unverified" : conflict ? "conflicted" : "current";
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
    }),
    watermarks: Object.fromEntries(watermarks.map((row) => [row.source, row.watermark])),
    last_confirmed_activity: latest ? { type: latest.type, observed_at: latest.observed_at } : null,
    last_event_id: latest?.event_id ?? null,
  };
}
