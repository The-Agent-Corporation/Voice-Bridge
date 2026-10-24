import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ObservedState } from "../adapters/types.js";
import { resolvePrimary, type PrimaryRoute } from "../primary.js";
import type { StoredSession } from "../store.js";

const W = "/w";
const OTHER = "/other";

function session(id: string, observed_state: ObservedState, last_activity_at: string | null, worktree_id = W): StoredSession {
  return {
    session_id: `codex:${id}`,
    provider: "codex",
    native_session_id: id,
    worktree_id,
    observed_state,
    last_activity_at,
    capabilities: {
      live_attach: false,
      next_turn: false,
      steer_active_turn: false,
      answer_pending_question: false,
      subscribe_events: false,
    },
  };
}

const OLD = "2026-10-01T00:00:00.000Z";
const NEW = "2026-10-20T00:00:00.000Z";

type Expected = Pick<PrimaryRoute, "route" | "primary_session_id" | "mutating_allowed" | "available" | "connected_session_id">;

const CASES: { name: string; sessions: StoredSession[]; pin: string | null; expected: Expected }[] = [
  {
    name: "a pinned connected session alone in its worktree is pinned and may mutate",
    sessions: [session("s1", "connected_idle", OLD)],
    pin: "codex:s1",
    expected: { route: "pinned", primary_session_id: "codex:s1", mutating_allowed: true, available: true, connected_session_id: "codex:s1" },
  },
  {
    name: "the one connected session wins over a newer saved one",
    sessions: [session("s1", "connected_running", OLD), session("s2", "saved", NEW)],
    pin: null,
    expected: { route: "sole_connected", primary_session_id: "codex:s1", mutating_allowed: true, available: true, connected_session_id: "codex:s1" },
  },
  {
    name: "with nothing connected the newest saved session is read-only",
    sessions: [session("s1", "saved", OLD), session("s2", "saved", NEW)],
    pin: null,
    expected: { route: "recent_saved_read_only", primary_session_id: "codex:s2", mutating_allowed: false, available: false, connected_session_id: null },
  },
  {
    name: "two connected sessions in the worktree without a pin are ambiguous",
    sessions: [session("s1", "connected_idle", OLD), session("s2", "connected_idle", NEW)],
    pin: null,
    expected: { route: "ambiguous", primary_session_id: null, mutating_allowed: false, available: false, connected_session_id: null },
  },
  {
    name: "no sessions is none",
    sessions: [],
    pin: null,
    expected: { route: "none", primary_session_id: null, mutating_allowed: false, available: false, connected_session_id: null },
  },
  {
    name: "sessions only in another worktree are none",
    sessions: [session("s1", "connected_idle", NEW, OTHER), session("s2", "saved", NEW, OTHER)],
    pin: null,
    expected: { route: "none", primary_session_id: null, mutating_allowed: false, available: false, connected_session_id: null },
  },
  {
    name: "a pinned saved session stays primary over a newer one",
    sessions: [session("s1", "saved", OLD), session("s2", "saved", NEW)],
    pin: "codex:s1",
    expected: { route: "pinned", primary_session_id: "codex:s1", mutating_allowed: false, available: false, connected_session_id: null },
  },
  {
    name: "a pinned unreachable session stays primary and is unavailable",
    sessions: [session("s1", "unreachable", OLD), session("s2", "saved", NEW)],
    pin: "codex:s1",
    expected: { route: "pinned", primary_session_id: "codex:s1", mutating_allowed: false, available: false, connected_session_id: null },
  },
  {
    name: "a pinned saved session reports the one connected session beside it",
    sessions: [session("s1", "saved", OLD), session("s2", "connected_idle", NEW)],
    pin: "codex:s1",
    expected: { route: "pinned", primary_session_id: "codex:s1", mutating_allowed: false, available: false, connected_session_id: "codex:s2" },
  },
  {
    name: "a second connected session in the pinned worktree blocks mutating but keeps the pin",
    sessions: [session("s1", "connected_idle", OLD), session("s2", "connected_idle", NEW)],
    pin: "codex:s1",
    expected: { route: "pinned", primary_session_id: "codex:s1", mutating_allowed: false, available: true, connected_session_id: null },
  },
  {
    name: "an unknown session in the pinned worktree blocks mutating but keeps the pin",
    sessions: [session("s1", "waiting_user", OLD), session("s2", "unknown", NEW)],
    pin: "codex:s1",
    expected: { route: "pinned", primary_session_id: "codex:s1", mutating_allowed: false, available: true, connected_session_id: "codex:s1" },
  },
  {
    name: "a connected session in another worktree does not block the pin",
    sessions: [session("s1", "connected_idle", OLD), session("s2", "connected_idle", NEW, OTHER)],
    pin: "codex:s1",
    expected: { route: "pinned", primary_session_id: "codex:s1", mutating_allowed: true, available: true, connected_session_id: "codex:s1" },
  },
  {
    name: "a pin may name a session in another worktree of the project",
    sessions: [session("s1", "connected_idle", OLD, OTHER), session("s2", "saved", NEW)],
    pin: "codex:s1",
    expected: { route: "pinned", primary_session_id: "codex:s1", mutating_allowed: true, available: true, connected_session_id: null },
  },
  {
    name: "an unknown session beside one connected session is ambiguous",
    sessions: [session("s1", "connected_idle", OLD), session("s2", "unknown", NEW)],
    pin: null,
    expected: { route: "ambiguous", primary_session_id: null, mutating_allowed: false, available: false, connected_session_id: "codex:s1" },
  },
  {
    name: "an unknown session in another worktree does not block the sole connected one",
    sessions: [session("s1", "connected_idle", OLD), session("s2", "unknown", NEW, OTHER)],
    pin: null,
    expected: { route: "sole_connected", primary_session_id: "codex:s1", mutating_allowed: true, available: true, connected_session_id: "codex:s1" },
  },
  {
    name: "an unreachable session is never the recent saved one",
    sessions: [session("s1", "unreachable", NEW)],
    pin: null,
    expected: { route: "none", primary_session_id: null, mutating_allowed: false, available: false, connected_session_id: null },
  },
  {
    name: "a stale pin is ambiguous rather than replaced by the sole connected session",
    sessions: [session("s1", "connected_idle", OLD)],
    pin: "codex:gone",
    expected: { route: "ambiguous", primary_session_id: null, mutating_allowed: false, available: false, connected_session_id: "codex:s1" },
  },
];

describe("resolvePrimary", () => {
  for (const { name, sessions, pin, expected } of CASES) {
    test(name, () => {
      const result = resolvePrimary(sessions, pin, W);
      const { reason, workspace_owner_session_id, ...fields } = result;
      assert.deepEqual(fields, expected);
      assert.equal(workspace_owner_session_id, null);
      assert.ok(reason.length > 0);
      assert.ok(!result.mutating_allowed || result.available, "mutating_allowed implies available");
    });
  }

  test("covers every route", () => {
    const routes = new Set(CASES.map((c) => resolvePrimary(c.sessions, c.pin, W).route));
    assert.deepEqual([...routes].sort(), ["ambiguous", "none", "pinned", "recent_saved_read_only", "sole_connected"]);
  });

  test("two connected_idle sessions in one worktree without a pin may not mutate", () => {
    const result = resolvePrimary([session("s1", "connected_idle", OLD), session("s2", "connected_idle", OLD)], null, W);
    assert.equal(result.route, "ambiguous");
    assert.equal(result.mutating_allowed, false);
  });

  test("a stale pin names the missing session in its reason", () => {
    assert.match(resolvePrimary([session("s1", "connected_idle", OLD)], "codex:gone", W).reason, /codex:gone/);
  });

  test("input order never changes the result, and equal timestamps tie-break by session_id", () => {
    const sessions = [session("b", "saved", NEW), session("a", "saved", NEW), session("c", "saved", null), session("d", "saved", OLD)];
    const forward = resolvePrimary(sessions, null, W);
    const reversed = resolvePrimary([...sessions].reverse(), null, W);
    assert.deepEqual(reversed, forward);
    assert.equal(forward.primary_session_id, "codex:a");
  });

  test("a session with unknown activity is chosen only when nothing else is saved", () => {
    assert.equal(resolvePrimary([session("z", "saved", null), session("y", "saved", OLD)], null, W).primary_session_id, "codex:y");
    assert.equal(resolvePrimary([session("z", "saved", null)], null, W).primary_session_id, "codex:z");
  });

  test("does not mutate its input", () => {
    const sessions = [session("b", "saved", OLD), session("a", "saved", NEW)];
    const copy = structuredClone(sessions);
    resolvePrimary(sessions, null, W);
    assert.deepEqual(sessions, copy);
  });
});
