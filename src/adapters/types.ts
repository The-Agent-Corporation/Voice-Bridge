import type { Capability } from "../probeReport.js";

export const PROVIDERS = ["codex", "claude-code"] as const;

export type Provider = (typeof PROVIDERS)[number];

export type ObservedState =
  | "saved"
  | "connected_idle"
  | "connected_running"
  | "waiting_user"
  | "unreachable"
  | "unknown";

export interface SessionCapabilities {
  live_attach: boolean;
  next_turn: boolean;
  steer_active_turn: boolean;
  answer_pending_question: boolean;
  subscribe_events: boolean;
}

/** The probe's name (probeReport.ts) for each session capability, so the two vocabularies cannot drift apart. */
export const PROBED_AS = {
  live_attach: "live_attach",
  next_turn: "next_turn",
  steer_active_turn: "steer",
  answer_pending_question: "answer_question",
  subscribe_events: "events",
} as const satisfies Record<keyof SessionCapabilities, Capability>;

/** A work tree of a registered project; `id` is its canonical root path. */
export interface Worktree {
  id: string;
  path: string;
}

export interface DiscoveredSession {
  provider: Provider;
  native_session_id: string;
  worktree_id: string;
  observed_state: ObservedState;
  last_activity_at: string | null;
  capabilities: SessionCapabilities;
}

export interface DiscoveryResult {
  sessions: DiscoveredSession[];
  /** Records found in the provider's store that could not be read or parsed. */
  skipped_records: number;
}

/**
 * The discovery slice of the provider adapter contract (docs/PRD.md §8). The control
 * methods there (inspectSession, capabilities, sendNextTurn, steerActiveTurn,
 * answerPendingQuestion, subscribeEvents) arrive with the work that first calls them;
 * until then a session's capabilities are the all-false object it was discovered with.
 */
export interface AgentAdapter {
  readonly provider: Provider;
  /** Reads the provider's saved records without writing to them and keeps those whose cwd is one of `worktrees`. */
  discoverSessions(worktrees: readonly Worktree[]): Promise<DiscoveryResult>;
}
