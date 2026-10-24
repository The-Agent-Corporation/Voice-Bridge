import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import path from "node:path";
import type { Provider } from "./adapters/types.js";
import { probeCodexAppServer } from "./codexAppServer.js";
import { resolveExecutable } from "./executable.js";
import {
  CAPABILITIES,
  evidenceOf,
  surfaceOf,
  uniformSurface,
  unprovable,
  type Capability,
  type Evidence,
  type StaticReason,
  type SurfaceReport,
} from "./probeReport.js";
import { killLiveGroups, runToExit, type ChildRecord } from "./providerProcess.js";

export const SURFACES = {
  codex: ["cli", "app_server", "desktop", "ide"],
  "claude-code": ["cli", "sdk", "desktop", "ide"],
} as const satisfies Record<Provider, readonly string[]>;
export type ProviderName = Provider;
export type SurfaceName<P extends ProviderName = ProviderName> = (typeof SURFACES)[P][number];

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
const INTERRUPTS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

type StaticRow = Record<Capability, StaticReason>;
const every = (reason: StaticReason): StaticRow =>
  Object.fromEntries(CAPABILITIES.map((capability) => [capability, reason])) as StaticRow;

/** Cells the probe has no safe live check for. Only Codex's app_server is checked live (codexAppServer.ts). */
export const STATIC_REASONS: { codex: Record<Exclude<SurfaceName<"codex">, "app_server">, StaticRow>; "claude-code": Record<SurfaceName<"claude-code">, StaticRow> } = {
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

const staticSurface = (row: StaticRow) => surfaceOf((capability) => ({ ...unprovable(row[capability]), evidence: [] }));

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
  versionTimeoutMs: number,
  children: ChildRecord[],
): Promise<ProviderReport<P>> {
  const surfaces = (report: (surface: SurfaceName<P>) => SurfaceReport) =>
    Object.fromEntries(SURFACES[provider].map((surface: SurfaceName<P>) => [surface, report(surface)])) as Record<SurfaceName<P>, SurfaceReport>;
  const resolved = resolveExecutable(BINARY_NAMES[provider], pathValue);
  if (resolved === null) {
    const absent = uniformSurface("not_installed", `${BINARY_NAMES[provider]} was not found in any absolute PATH entry`);
    return {
      provider,
      binary: "not_installed",
      found_on_path: null,
      version: null,
      version_check: null,
      surfaces: surfaces(() => absent),
    };
  }

  const env = buildChildEnv(pathValue, probeHome);
  const ended = await runToExit([resolved.binary, "--version"], { env, cwd: probeHome.home, timeoutMs: versionTimeoutMs }, children);
  const version = ended.exit_code === 0 && !ended.timed_out ? firstLine(ended.stdout) : null;

  const sources: Partial<Record<string, SurfaceReport>> = {};
  for (const [surface, row] of Object.entries(STATIC_REASONS[provider])) sources[surface] = staticSurface(row);
  if (provider === "codex") {
    sources.app_server = await probeCodexAppServer(resolved.binary, { env, cwd: probeHome.home }, probeHome.codexHome, children);
  }
  return { provider, ...resolved, version, version_check: evidenceOf(ended), surfaces: surfaces((surface) => sources[surface]!) };
}

export interface ProbeOptions {
  versionTimeoutMs?: number;
}

/**
 * Probes both providers. Every provider process it starts has been reaped by the time
 * this resolves. Children lead their own process groups, so a terminal's Ctrl-C never
 * reaches them: on SIGINT, SIGTERM or SIGHUP the probe kills every group it started,
 * removes its temp home and exits with 128 + the signal number.
 */
export async function runProbe(pathValue = process.env.PATH ?? "", { versionTimeoutMs = VERSION_TIMEOUT_MS }: ProbeOptions = {}): Promise<ProbeReport> {
  const probed_at = new Date().toISOString();
  const children: ChildRecord[] = [];
  const probeHome = makeProbeHome();
  const interrupted = (signal: (typeof INTERRUPTS)[number]) => {
    killLiveGroups();
    rmSync(probeHome.root, { recursive: true, force: true });
    process.exit(128 + osConstants.signals[signal]);
  };
  for (const signal of INTERRUPTS) process.on(signal, interrupted);
  try {
    const codex = await probeProvider("codex", pathValue, probeHome, versionTimeoutMs, children);
    const claude = await probeProvider("claude-code", pathValue, probeHome, versionTimeoutMs, children);
    return {
      schema_version: 1,
      probed_at,
      platform: `${process.platform}-${process.arch}`,
      providers: [codex, claude],
      children,
    };
  } finally {
    for (const signal of INTERRUPTS) process.off(signal, interrupted);
    rmSync(probeHome.root, { recursive: true, force: true });
  }
}
