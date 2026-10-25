import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { CLI_ENTRY } from "./helpers.js";

/** One line of the fake's log: a provider start, or a turn it was asked to start. */
export type FakeLogEntry = { start: number } | { turn_start: string };

/**
 * Writes `codex` into `dir`: a stand-in for `codex app-server --listen stdio://` speaking the v2
 * protocol the session host uses. It logs each start and each `turn/start` to `log`, accepts every
 * turn and reports it started, and holds it open until it receives SIGUSR2, which completes the
 * oldest open turn. It exits when stdin closes.
 */
export function writeFakeCodex(dir: string, log: string): void {
  const file = path.join(dir, "codex");
  writeFileSync(
    file,
    `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const record = (entry) => appendFileSync(${JSON.stringify(log)}, JSON.stringify(entry) + "\\n");
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
if (!process.argv.includes("app-server")) process.exit(3);
record({ start: process.pid });
const threadId = "t-" + process.pid;
const open = [];
let turns = 0;
process.on("SIGUSR2", () => {
  const id = open.shift();
  if (id) send({ method: "turn/completed", params: { threadId, turn: { id, status: "completed", items: [] } } });
});
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  const reply = (result) => send({ id: message.id, result });
  switch (message.method) {
    case "initialize": return reply({ userAgent: "fake" });
    case "thread/start":
      reply({ thread: { id: threadId } });
      return send({ method: "thread/started", params: { thread: { id: threadId } } });
    case "turn/start": {
      record({ turn_start: message.params.input[0].text });
      const id = "u" + ++turns;
      open.push(id);
      reply({ turn: { id, status: "inProgress", items: [] } });
      return send({ method: "turn/started", params: { threadId, turn: { id, status: "inProgress", items: [] } } });
    }
  }
}).on("close", () => process.exit(0));
`,
  );
  chmodSync(file, 0o755);
}

export function readFakeLog(log: string): FakeLogEntry[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as FakeLogEntry);
}

export interface Host {
  child: ChildProcess;
  session_id: string;
  provider_pid: number;
  exited: Promise<number | null>;
  stderr(): string;
}

/** Runs `voice-bridge session start <projectId> --provider codex`, resolving on its connected line. */
export function startHost(env: NodeJS.ProcessEnv, projectId: string, timeoutMs = 10_000): Promise<Host> {
  const child = spawn(process.execPath, [CLI_ENTRY, "session", "start", projectId, "--provider", "codex"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`session host did not connect within ${timeoutMs} ms; stderr:\n${stderr}`));
    }, timeoutMs);
    void exited.then((code) => {
      clearTimeout(timer);
      reject(new Error(`session host exited with ${code} before connecting; stderr:\n${stderr}`));
    });
    createInterface({ input: child.stdout! }).once("line", (line) => {
      clearTimeout(timer);
      const { session_id, provider_pid } = JSON.parse(line) as { session_id: string; provider_pid: number };
      resolve({ child, session_id, provider_pid, exited, stderr: () => stderr });
    });
  });
}
