import type { Ended } from "./providerProcess.js";

export const CAPABILITIES = ["discover", "inspect", "live_attach", "next_turn", "steer", "events", "answer_question"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/**
 * Why a cell has its status. `resume_is_not_attach` marks surfaces whose resume
 * replays a saved session: that never counts as `live_attach`.
 */
export const UNVERIFIED_REASONS = [
  "not_installed",
  "no_check",
  "needs_credentials",
  "needs_foreign_session",
  "needs_pending_question",
  "resume_is_not_attach",
  "check_failed",
] as const;
export type UnverifiedReason = (typeof UNVERIFIED_REASONS)[number];
export type ProbeReason = "proved" | "method_not_found" | UnverifiedReason;

export type Evidence = Pick<Ended, "command" | "pid" | "exit_code" | "signal" | "timed_out"> & {
  /** The request a cell rests on and what came back, e.g. "turn/steer → error -32601". */
  rpc?: string;
  /** At most 300 characters: a stderr tail, a spawn error, or server requests left unanswered. */
  observed?: string;
};

/** `supported` only with proof, `unsupported` only when the provider said the method does not exist. */
export type Verdict = { detail: string } & (
  | { status: "supported"; reason: "proved" }
  | { status: "unsupported"; reason: "method_not_found" }
  | { status: "unverified"; reason: UnverifiedReason }
);
export type CapabilityResult = Verdict & { evidence: Evidence[] };
export type CapabilityStatus = CapabilityResult["status"];
export type SurfaceReport = Record<Capability, CapabilityResult>;

export type StaticReason = Exclude<UnverifiedReason, "check_failed" | "not_installed">;

const STATIC_DETAIL: Record<StaticReason, string> = {
  no_check: "the probe has no check for this surface that leaves provider state untouched",
  needs_credentials: "proving this needs a credentialed model turn or the user's session store, which the probe never uses",
  needs_foreign_session: "proving this needs a session the probe did not start, and the probe never touches one",
  needs_pending_question: "proving this needs a provider question waiting for an answer, which a credential-less turn never raises",
  resume_is_not_attach: "resume reopens a saved session; it does not attach to a live one, so it proves nothing about live_attach",
};

const OBSERVED_LIMIT = 300;

function unverified(reason: UnverifiedReason, detail: string, evidence: Evidence[] = []): CapabilityResult {
  return { status: "unverified", reason, detail, evidence };
}

/** A cell the probe cannot prove for a fixed reason, with the standard explanation. */
export function unprovable(reason: StaticReason): Verdict {
  return { status: "unverified", reason, detail: STATIC_DETAIL[reason] };
}

/** A surface with exactly the seven capabilities, in the issue's order. */
export function surfaceOf(cell: (capability: Capability) => CapabilityResult): SurfaceReport {
  return Object.fromEntries(CAPABILITIES.map((capability) => [capability, cell(capability)])) as SurfaceReport;
}

/** Every capability of a surface with the same unverified reason. */
export const uniformSurface = (reason: UnverifiedReason, detail: string, evidence: Evidence[] = []) =>
  surfaceOf(() => unverified(reason, detail, evidence));

// Codex colours its log lines even when stderr is a pipe.
const ANSI_SGR = /\x1b\[[0-9;]*m/g;

/** The tail of `text` that fits in an Evidence `observed` field. */
function tail(text: string): string {
  const trimmed = text.replace(ANSI_SGR, "").trim();
  return trimmed.length <= OBSERVED_LIMIT ? trimmed : `…${trimmed.slice(-(OBSERVED_LIMIT - 1))}`;
}

export function evidenceOf(ended: Ended, extra: { rpc?: string; observed?: string } = {}): Evidence {
  const observed = extra.observed ?? (ended.spawn_error ?? ended.stderr);
  return {
    command: ended.command,
    pid: ended.pid,
    exit_code: ended.exit_code,
    signal: ended.signal,
    timed_out: ended.timed_out,
    ...(extra.rpc === undefined ? {} : { rpc: extra.rpc }),
    ...(observed.trim() === "" ? {} : { observed: tail(observed) }),
  };
}
