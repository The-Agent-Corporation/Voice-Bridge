import assert from "node:assert/strict";
import { test } from "node:test";
import { computeFreshness, type FreshnessInput } from "../status.js";
import type { EventType } from "../store.js";

const turn = (session_id: string, source: string, type: EventType) => ({ session_id, source, type });
const gapped = [{ source: "hook", watermark: 1, highest_stored: 3 }];
const contiguous = [{ source: "hook", watermark: 2, highest_stored: 2 }];
const disagreeing = [turn("s1", "hook", "turn_started"), turn("s1", "reconcile", "turn_completed")];

const CASES: { name: string; input: FreshnessInput; freshness: string; reasons: string[] }[] = [
  {
    name: "no events is unverified",
    input: { watermarks: [], latestTurnStates: [] },
    freshness: "unverified",
    reasons: ["no_events"],
  },
  {
    name: "a gap and a conflict are unverified and list every reason in order",
    input: { watermarks: gapped, latestTurnStates: disagreeing },
    freshness: "unverified",
    reasons: ["sequence_gap", "turn_state_conflict"],
  },
  {
    name: "a conflict alone is conflicted",
    input: { watermarks: contiguous, latestTurnStates: disagreeing },
    freshness: "conflicted",
    reasons: ["turn_state_conflict"],
  },
  {
    name: "turn_completed against turn_failed is conflicted",
    input: {
      watermarks: contiguous,
      latestTurnStates: [turn("s1", "hook", "turn_completed"), turn("s1", "reconcile", "turn_failed")],
    },
    freshness: "conflicted",
    reasons: ["turn_state_conflict"],
  },
  {
    name: "sources agreeing, or disagreeing about different sessions, are current",
    input: {
      watermarks: contiguous,
      latestTurnStates: [
        turn("s1", "hook", "turn_started"),
        turn("s1", "reconcile", "turn_started"),
        turn("s2", "hook", "turn_completed"),
        turn("s3", "reconcile", "turn_failed"),
      ],
    },
    freshness: "current",
    reasons: [],
  },
];

for (const { name, input, freshness, reasons } of CASES) {
  test(name, () => {
    assert.deepEqual(computeFreshness(input), { freshness, freshness_reasons: reasons });
  });
}
