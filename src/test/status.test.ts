import assert from "node:assert/strict";
import { test } from "node:test";
import { computeFreshness, type FreshnessInput } from "../status.js";
import type { TurnState } from "../store.js";

const turn = (session_id: string, type: TurnState["type"]) => ({ session_id, type });
const gapped = [{ source: "hook", watermark: 1, highest_stored: 3 }];
const contiguous = [{ source: "hook", watermark: 2, highest_stored: 2 }];
const disagreeing = [turn("s1", "turn_started"), turn("s1", "turn_completed")];

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
      latestTurnStates: [turn("s1", "turn_completed"), turn("s1", "turn_failed")],
    },
    freshness: "conflicted",
    reasons: ["turn_state_conflict"],
  },
  {
    name: "sources agreeing, or different turn states in different sessions, are current",
    input: {
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
];

for (const { name, input, freshness, reasons } of CASES) {
  test(name, () => {
    assert.deepEqual(computeFreshness(input), { freshness, freshness_reasons: reasons });
  });
}
