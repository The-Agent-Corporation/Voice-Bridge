import { accessSync, constants, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { probeCodexAppServer } from "./codexAppServer.js";
import { runToExit, type ChildRecord, type Ended } from "./providerProcess.js";

export const CAPABILITIES = ["discover", "inspect", "live_attach", "next_turn", "steer", "events", "answer_question"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const SURFACES = {
  codex: ["cli", "app_server", "desktop", "ide"],
  "claude-code": ["cli", "sdk", "desktop", "ide"],
} as const;
export type ProviderName = keyof typeof SURFACES;
export type SurfaceName<P extends ProviderName = ProviderName> = (typeof SURFACES)[P][number];

/**
 * Why a cell has its status. `resume_is_not_attach` marks surfaces whose resume
 * replays a saved session: that never counts as `live_attach`.
 */
export type UnverifiedReason =
  | "not_installed"
  | "no_check"
  | "needs_credentials"
  | "needs_foreign_session"
  | "needs_pending_question"
  | "resume_is_not_attach"
  | "check_failed";
export type ProbeReason = "proved" | "method_not_found" | UnverifiedReason;

export interface Evidence {
  /** Absolute argv. */
  command: string[];
  pid: number | null;
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  /** The request a cell rests on and what came back, e.g. "turn/steer → error -32601". */
  rpc?: string;
  /** At most 300 characters: a stderr tail, a spawn error, or server requests left unanswered. */
  observed?: string;
}

/** `supported` only with proof, `unsupported` only when the provider said the method does not exist. */
export type Verdict = { detail: string } & (
  | { status: "supported"; reason: "proved" }
  | { status: "unsupported"; reason: "method_not_found" }
  | { status: "unverified"; reason: UnverifiedReason }
);
export type CapabilityResult = Verdict & { evidence: Evidence[] };
export type CapabilityStatus = CapabilityResult["status"];
export type SurfaceReport = Record<Capability, CapabilityResult>;

export interface ProviderReport<P extends ProviderName = ProviderName> {
  provider: P;
  binary: string;
  found_on_path: string | null;
  version: string | null;
  version_check: Evidence | null;
  surfaces: Record<SurfaceName<P>, SurfaceReport>;
}

export interface ProbeReport {
  schema_version: 1;
  probed_at: string;
  platform: string;
  providers: [ProviderReport<"codex">, ProviderReport<"claude-code">];
  children: ChildRecord[];
}

const BINARY_NAMES: Record<ProviderName, string> = { codex: "codex", "claude-code": "claude" };
const VERSION_TIMEOUT_MS = 10_000;
const OBSERVED_LIMIT = 300;

export type StaticReason = Exclude<UnverifiedReason, "check_failed" | "not_installed">;
type StaticRow = Record<Capability, StaticReason>;
const every = (reason: StaticReason): StaticRow =>
  Object.fromEntries(CAPABILITIES.map((capability) => [capability, reason])) as StaticRow;

/** Cells the probe has no safe live check for. Only Codex's app_server is checked live (codexAppServer.ts). */
const STATIC_REASONS: { codex: Record<Exclude<SurfaceName<"codex">, "app_server">, StaticRow>; "claude-code": Record<SurfaceName<"claude-code">, StaticRow> } = {
  codex: {
    cli: {
      discover: "no_check",
      inspect: "no_check",
      live_attach: "resume_is_not_attach",
      next_turn: "needs_credentials",
      steer: "needs_credentials",
      events: "no_check",
      answer_question: "needs_credentials",
    },
    desktop: every("no_check"),
    ide: every("no_check"),
  },
  "claude-code": {
    cli: {
      discover: "no_check",
      inspect: "no_check",
      live_attach: "resume_is_not_attach",
      next_turn: "needs_credentials",
      steer: "needs_credentials",
      events: "needs_credentials",
      answer_question: "needs_credentials",
    },
    sdk: every("needs_credentials"),
    desktop: every("no_check"),
    ide: every("no_check"),
  },
};

const STATIC_DETAIL: Record<StaticReason, string> = {
  no_check: "the probe has no check for this surface that leaves provider state untouched",
  needs_credentials: "proving this needs a credentialed model turn or the user's session store, which the probe never uses",
  needs_foreign_session: "proving this needs a session the probe did not start, and the probe never touches one",
  needs_pending_question: "proving this needs a provider question waiting for an answer, which a credential-less turn never raises",
  resume_is_not_attach: "resume reopens a saved session; it does not attach to a live one, so it proves nothing about live_attach",
};

export function unverified(reason: UnverifiedReason, detail: string, evidence: Evidence[] = []): CapabilityResult {
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

const staticSurface = (row: StaticRow) => surfaceOf((capability) => ({ ...unprovable(row[capability]), evidence: [] }));

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

/**
 * Finds `name` on `pathValue` the way a shell would, but only in absolute entries: a
 * relative entry resolves against whatever the cwd is, which the caller controls.
 * Returns the PATH hit and its realpath, which is what the probe executes.
 */
export function resolveExecutable(name: string, pathValue: string): { found_on_path: string; binary: string } | null {
  for (const entry of pathValue.split(path.delimiter)) {
    if (!path.isAbsolute(entry)) continue;
    const candidate = path.join(entry, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return { found_on_path: candidate, binary: realpathSync(candidate) };
    } catch {
      continue;
    }
  }
  return null;
}

interface ProbeHome {
  root: string;
  home: string;
  codexHome: string;
}

/**
 * Built from nothing rather than from `process.env`, so API keys and the user's real
 * provider homes never reach a provider the probe starts.
 */
export function buildChildEnv(pathValue: string, probeHome: ProbeHome): Record<string, string> {
  return {
    PATH: pathValue,
    HOME: probeHome.home,
    CODEX_HOME: probeHome.codexHome,
    CLAUDE_CONFIG_DIR: path.join(probeHome.root, "claude"),
    LANG: "C",
  };
}

function makeProbeHome(): ProbeHome {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "voice-bridge-probe-")));
  const probeHome = { root, home: path.join(root, "home"), codexHome: path.join(root, "codex") };
  for (const dir of [probeHome.home, probeHome.codexHome, path.join(root, "claude")]) mkdirSync(dir);
  return probeHome;
}

function firstLine(text: string): string | null {
  return text.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? null;
}

async function probeProvider<P extends ProviderName>(
  provider: P,
  pathValue: string,
  probeHome: ProbeHome,
  children: ChildRecord[],
): Promise<ProviderReport<P>> {
  const surfaces = (sources: Partial<Record<string, SurfaceReport>>) =>
    Object.fromEntries(SURFACES[provider].map((surface) => [surface, sources[surface]])) as Record<SurfaceName<P>, SurfaceReport>;
  const resolved = resolveExecutable(BINARY_NAMES[provider], pathValue);
  if (resolved === null) {
    const absent = uniformSurface("not_installed", `${BINARY_NAMES[provider]} was not found in any absolute PATH entry`);
    return {
      provider,
      binary: "not_installed",
      found_on_path: null,
      version: null,
      version_check: null,
      surfaces: surfaces(Object.fromEntries(SURFACES[provider].map((surface) => [surface, absent]))),
    };
  }

  const env = buildChildEnv(pathValue, probeHome);
  const ended = await runToExit([resolved.binary, "--version"], { env, cwd: probeHome.home, timeoutMs: VERSION_TIMEOUT_MS }, children);
  const version = ended.exit_code === 0 && !ended.timed_out ? firstLine(ended.stdout) : null;

  const sources: Partial<Record<string, SurfaceReport>> = {};
  for (const [surface, row] of Object.entries(STATIC_REASONS[provider])) sources[surface] = staticSurface(row);
  if (provider === "codex") {
    sources.app_server = await probeCodexAppServer(resolved.binary, { env, cwd: probeHome.home }, probeHome.codexHome, children);
  }
  return { provider, ...resolved, version, version_check: evidenceOf(ended), surfaces: surfaces(sources) };
}

/** Probes both providers. Every provider process it starts has been reaped by the time this resolves. */
export async function runProbe(pathValue = process.env.PATH ?? ""): Promise<ProbeReport> {
  const probed_at = new Date().toISOString();
  const children: ChildRecord[] = [];
  const probeHome = makeProbeHome();
  try {
    const codex = await probeProvider("codex", pathValue, probeHome, children);
    const claude = await probeProvider("claude-code", pathValue, probeHome, children);
    return {
      schema_version: 1,
      probed_at,
      platform: `${process.platform}-${process.arch}`,
      providers: [codex, claude],
      children,
    };
  } finally {
    rmSync(probeHome.root, { recursive: true, force: true });
  }
}
