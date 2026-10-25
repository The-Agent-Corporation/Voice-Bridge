import assert from "node:assert/strict";
import { test } from "node:test";
import { computeFreshness, type FreshnessInput } from "../status.js";
import type { TurnState } from "../store.js";

const turn = (session_id: string, type: TurnState["type"]) => ({ session_id, type });
const gapped = [{ source: "hook", watermark: 1, highest_stored: 3 }];
const contiguous = [{ source: "hook", watermark: 2, highest_stored: 2 }];
const disagreeing = [turn("s1", "turn_started"), turn("s1", "turn_completed")];
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const base = { watermarks: contiguous, latestTurnStates: [], pendingEvents: 0, head: undefined, recordedCommit: null };
const observed = (head: string | null, error: string | null = null) => ({
  project_id: "p",
  head,
  error,
  observed_at: "2026-10-25T12:00:00.000Z",
});

const CASES: { name: string; input: FreshnessInput; freshness: string; reasons: string[] }[] = [
  {
    name: "no events is unverified",
    input: { ...base, watermarks: [], latestTurnStates: [] },
    freshness: "unverified",
    reasons: ["no_events"],
  },
  {
    name: "a gap and a conflict are unverified and list every reason in order",
    input: { ...base, watermarks: gapped, latestTurnStates: disagreeing },
    freshness: "unverified",
    reasons: ["sequence_gap", "turn_state_conflict"],
  },
  {
    name: "a conflict alone is conflicted",
    input: { ...base, watermarks: contiguous, latestTurnStates: disagreeing },
    freshness: "conflicted",
    reasons: ["turn_state_conflict"],
  },
  {
    name: "turn_completed against turn_failed is conflicted",
    input: {
      ...base,
      watermarks: contiguous,
      latestTurnStates: [turn("s1", "turn_completed"), turn("s1", "turn_failed")],
    },
    freshness: "conflicted",
    reasons: ["turn_state_conflict"],
  },
  {
    name: "sources agreeing, or different turn states in different sessions, are current",
    input: {
      ...base,
      watermarks: contiguous,
      latestTurnStates: [
        turn("s1", "turn_started"),
        turn("s1", "turn_started"),
        turn("s2", "turn_completed"),
        turn("s3", "turn_failed"),
      ],
    },
    freshness: "current",
    reasons: [],
  },
  {
    name: "unprocessed events alone are lagging",
    input: { ...base, pendingEvents: 2 },
    freshness: "lagging",
    reasons: ["unprocessed_events"],
  },
  {
    name: "unprocessed events outrank a turn conflict they may resolve",
    input: { ...base, pendingEvents: 1, latestTurnStates: disagreeing },
    freshness: "lagging",
    reasons: ["unprocessed_events", "turn_state_conflict"],
  },
  {
    name: "a HEAD other than the recorded commit is unverified",
    input: { ...base, head: observed(COMMIT), recordedCommit: "fedcba9" },
    freshness: "unverified",
    reasons: ["head_moved"],
  },
  {
    name: "a HEAD with no recorded commit is unverified",
    input: { ...base, head: observed(COMMIT) },
    freshness: "unverified",
    reasons: ["head_moved"],
  },
  {
    name: "a HEAD matching a short recorded commit is current",
    input: { ...base, head: observed(COMMIT), recordedCommit: COMMIT.slice(0, 7) },
    freshness: "current",
    reasons: [],
  },
  {
    name: "a repository with no commits is current",
    input: { ...base, head: observed(null) },
    freshness: "current",
    reasons: [],
  },
  {
    name: "a HEAD Git could not read is unverified",
    input: { ...base, head: observed(null, "fatal: not a git repository") },
    freshness: "unverified",
    reasons: ["head_unreadable"],
  },
];

for (const { name, input, freshness, reasons } of CASES) {
  test(name, () => {
    assert.deepEqual(computeFreshness(input), { freshness, freshness_reasons: reasons });
  });
}
