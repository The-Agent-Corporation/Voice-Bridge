import { BridgeError } from "./errors.js";
import type { EventType, Store, TurnState, WatermarkRow } from "./store.js";

export type Freshness = "current" | "lagging" | "unverified" | "conflicted";

/** Listed in this order in `freshness_reasons`. */
const REASONS = ["no_events", "sequence_gap", "turn_state_conflict", "unprocessed_events"] as const;
export type FreshnessReason = (typeof REASONS)[number];

/** Highest rank first: missing evidence outranks disagreement, which outranks held events. */
const PRECEDENCE: readonly { freshness: Freshness; reasons: readonly FreshnessReason[] }[] = [
  { freshness: "unverified", reasons: ["no_events", "sequence_gap"] },
  { freshness: "conflicted", reasons: ["turn_state_conflict"] },
  { freshness: "lagging", reasons: ["unprocessed_events"] },
];

export interface FreshnessInput {
  eventCount: number;
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
 * Every condition that holds is reported. Events are processed in the request, so an event above
 * its watermark is always waiting behind a gap: `unprocessed_events` comes with `sequence_gap`, and
 * `lagging` stays outranked until something other than a gap can hold events back.
 */
export function computeFreshness(input: FreshnessInput): Pick<ProjectStatus, "freshness" | "freshness_reasons"> {
  const held = input.watermarks.some((row) => row.highest_stored > row.watermark);
  const holds: Record<FreshnessReason, boolean> = {
    no_events: input.eventCount === 0,
    sequence_gap: held,
    turn_state_conflict: hasTurnConflict(input.latestTurnStates),
    unprocessed_events: held,
  };
  const reasons = REASONS.filter((reason) => holds[reason]);
  const winner = PRECEDENCE.find((rank) => rank.reasons.some((reason) => holds[reason]));
  return { freshness: winner?.freshness ?? "current", freshness_reasons: reasons };
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
      eventCount: store.countEvents(projectId),
      watermarks,
      latestTurnStates: store.latestTurnStates(projectId),
    }),
    watermarks: Object.fromEntries(watermarks.map((row) => [row.source, row.watermark])),
    last_confirmed_activity: latest ? { type: latest.type, observed_at: latest.observed_at } : null,
    last_event_id: latest?.event_id ?? null,
  };
}
