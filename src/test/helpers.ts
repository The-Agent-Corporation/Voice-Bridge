import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { zstdCompressSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { PACKAGE_ROOT } from "../buildId.js";
import { runGit } from "../git.js";

export const DAEMON_ENTRY = path.join(PACKAGE_ROOT, "dist", "daemon.js");
export const CLI_ENTRY = path.join(PACKAGE_ROOT, "dist", "cli.js");

/** The `.voice/config.json` sample from docs/PRD.md §6.2. */
export const PRD_SAMPLE = {
  schema_version: 1,
  project_id: "desktop-agent",
  display_name: "Desktop Agent",
  briefing_file: "VOICE.md",
  primary_selection: "pin_then_connected_then_recent",
  allowed_providers: ["codex", "claude-code"],
  auto_deliver: false,
  bridge_profile: "local",
};

const tempDirs: string[] = [];

export function tempDir(prefix = "voice-bridge-test-"): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

export function removeTempDirs(): void {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function writeVoiceConfig(dir: string, config: unknown): void {
  mkdirSync(path.join(dir, ".voice"), { recursive: true });
  writeFileSync(path.join(dir, ".voice", "config.json"), JSON.stringify(config, null, 2));
}

/** A fresh Git work tree holding `config` as its `.voice/config.json`; returns its realpath. */
export function makeRepo(config: unknown = PRD_SAMPLE, { git = true } = {}): string {
  const dir = tempDir("voice-bridge-repo-");
  const init = git ? runGit(["init", "-q"], dir) : undefined;
  if (init && !init.ok) throw new Error(`git init failed in ${dir}: ${init.detail}`);
  writeVoiceConfig(dir, config);
  return dir;
}

/** Empty provider homes, so a daemon under test never reads the developer's real sessions. */
export function fixtureHomes(): { VOICE_BRIDGE_CODEX_HOME: string; VOICE_BRIDGE_CLAUDE_HOME: string } {
  return { VOICE_BRIDGE_CODEX_HOME: tempDir("voice-bridge-codex-"), VOICE_BRIDGE_CLAUDE_HOME: tempDir("voice-bridge-claude-") };
}

/** A Claude Code saved session laid out as Claude Code writes it; returns the file. */
export function writeClaudeSession(home: string, cwd: string, id: string): string {
  const dir = path.join(home, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const lines = [
    { type: "queue-operation", operation: "enqueue", timestamp: "2026-10-24T12:00:00.000Z", sessionId: id },
    { type: "attachment", cwd, sessionId: id, timestamp: "2026-10-24T12:00:01.000Z" },
    { type: "user", cwd, sessionId: id, message: { role: "user", content: "hello" } },
  ];
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return file;
}

/** A Codex saved session laid out as codex-cli writes it, optionally zstd-compressed; returns the file. */
export function writeCodexSession(home: string, cwd: string, id: string, { zstd = false } = {}): string {
  const dir = path.join(home, "sessions", "2026", "10", "24");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-10-24T00-00-00-${id}.jsonl${zstd ? ".zst" : ""}`);
  const lines = [
    { timestamp: "2026-10-24T00:00:00.000Z", type: "session_meta", payload: { id, cwd, timestamp: "2026-10-24T00:00:00.000Z" } },
    { timestamp: "2026-10-24T00:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "hello" } },
  ];
  const text = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
  writeFileSync(file, zstd ? zstdCompressSync(text) : text);
  return file;
}

export async function call(
  port: number,
  token: string | null,
  tool: string,
  body: unknown = {},
  authorization = token === null ? undefined : `Bearer ${token}`,
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authorization) headers.Authorization = authorization;
  const response = await fetch(`http://127.0.0.1:${port}/tools/${tool}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

export interface SpawnedDaemon {
  child: ChildProcess;
  address: string;
  port: number;
  stop(): Promise<void>;
}

/** Starts the built daemon on a free port and resolves on its listening line. */
export function spawnDaemon(env: NodeJS.ProcessEnv, timeoutMs = 10_000): Promise<SpawnedDaemon> {
  const child = spawn(process.execPath, [DAEMON_ENTRY, "--port", "0"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));

  return new Promise((resolve, reject) => {
    const fail = (reason: string) => {
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(new Error(`${reason}; daemon stderr:\n${stderr}`));
    };
    const timer = setTimeout(() => fail(`daemon did not report listening within ${timeoutMs} ms`), timeoutMs);
    const onEarlyExit = (code: number | null) => fail(`daemon exited early with code ${code}`);
    child.once("exit", onEarlyExit);
    createInterface({ input: child.stdout! }).once("line", (line) => {
      clearTimeout(timer);
      child.off("exit", onEarlyExit);
      const { address, port } = JSON.parse(line) as { address: string; port: number };
      resolve({
        child,
        address,
        port,
        async stop() {
          if (child.exitCode === null) child.kill("SIGTERM");
          await exited;
        },
      });
    });
  });
}
