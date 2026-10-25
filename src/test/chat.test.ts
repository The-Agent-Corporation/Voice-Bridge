import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { startBridge, type RunningBridge } from "../app.js";
import { Conversation, matchProjects, parseCommand, type CallTool } from "../chat.js";
import { readClientToken } from "../token.js";
import { call, CLI_ENTRY, fixtureHomes, makeRepo, PRD_SAMPLE, removeTempDirs, tempDir } from "./helpers.js";

after(removeTempDirs);

describe("chat grammar", () => {
  test("parses the four commands and nothing else", () => {
    assert.deepEqual(parseCommand("list projects"), { kind: "list" });
    assert.deepEqual(parseCommand("  Open   Golf App "), { kind: "open", name: "Golf App" });
    assert.deepEqual(parseCommand("switch to B"), { kind: "open", name: "B" });
    assert.deepEqual(parseCommand("What's happening?"), { kind: "happening" });
    assert.deepEqual(parseCommand("whats happening"), { kind: "happening" });
    assert.deepEqual(parseCommand("start the build"), { kind: "unknown" });
    assert.deepEqual(parseCommand("open"), { kind: "unknown" });
  });

  test("an exact id or display name wins over partial matches", () => {
    const projects = [
      { project_id: "golf-app", display_name: "Golf App", canonical_path: "/a" },
      { project_id: "golf", display_name: "Golf Club", canonical_path: "/b" },
    ];
    assert.deepEqual(matchProjects(projects, "GOLF").map((p) => p.project_id), ["golf"]);
    assert.deepEqual(matchProjects(projects, "golf app").map((p) => p.project_id), ["golf-app"]);
    assert.deepEqual(matchProjects(projects, "gol").map((p) => p.project_id), ["golf-app", "golf"]);
    assert.deepEqual(matchProjects(projects, "tennis"), []);
  });
});

describe("chat conversation over the bridge tools", () => {
  let bridge: RunningBridge;
  let dataDir: string;
  let token: string;
  let sequence = 0;

  const callTool: CallTool = async <T>(tool: string, body: Record<string, unknown>) => {
    const response = await call(bridge.port, token, tool, body);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body as T;
  };

  const register = async (projectId: string, displayName: string, objective?: string) => {
    const repo = makeRepo({ ...PRD_SAMPLE, project_id: projectId, display_name: displayName });
    await callTool("register_project", { path: repo });
    if (objective === undefined) return;
    sequence += 1;
    await callTool("ingest_event", {
      project_id: projectId,
      session_id: "s1",
      source: "hook",
      source_event_id: `${projectId}-${sequence}`,
      source_sequence: 1,
      type: "plan_updated",
      payload: { objective, next_steps: [] },
      observed_at: "2026-10-24T12:00:00.000Z",
    });
  };

  before(async () => {
    dataDir = tempDir();
    bridge = await startBridge({ dataDir, port: 0, env: fixtureHomes() });
    token = readClientToken(dataDir);
    await register("golf-app", "Golf App", "MARKER-A");
    await register("b", "Project Bravo", "MARKER-B");
    await register("tennis-app", "Tennis App");
  });

  after(() => bridge.close());

  test("switching projects drops the old briefing from the answer and from the context", async () => {
    const chat = new Conversation(callTool);
    const opened = await chat.reply("open golf app");
    assert.match(opened, /^Golf App \(freshness: current\)\n/);
    const first = await chat.reply("what's happening?");
    assert.match(first, /MARKER-A/);
    const briefingA = chat.context.briefing!.briefing;

    const switched = await chat.reply("switch to B");
    assert.match(switched, /^Project Bravo \(freshness: current\)\n/);
    const second = await chat.reply("what's happening?");
    assert.match(second, /^Project Bravo \(freshness: current\)\n/);
    assert.match(second, /MARKER-B/);
    assert.doesNotMatch(second, /MARKER-A|Golf App/);

    const context = chat.context;
    assert.equal(context.active_project_id, "b");
    const stored = JSON.stringify(context);
    const briefingB = context.briefing!.briefing.split("\n");
    const onlyInA = briefingA.split("\n").filter((line) => line.trim() && !briefingB.includes(line));
    assert.ok(onlyInA.some((line) => line.includes("MARKER-A")), "A's briefing has lines of its own");
    for (const line of onlyInA) assert.ok(!stored.includes(line), `context still holds A's line: ${line}`);
  });

  test("an ambiguous name lists every candidate id and keeps the active project", async () => {
    const chat = new Conversation(callTool);
    await chat.reply("open b");
    const reply = await chat.reply("open app");
    assert.match(reply, /golf-app/);
    assert.match(reply, /tennis-app/);
    assert.equal(chat.context.active_project_id, "b");
  });

  test("an unknown name says so and keeps the active project", async () => {
    const chat = new Conversation(callTool);
    await chat.reply("open b");
    assert.equal(await chat.reply("switch to croquet"), 'No project matches "croquet".');
    assert.equal(chat.context.active_project_id, "b");
  });

  test("an unverified briefing is labelled unverified", async () => {
    const chat = new Conversation(callTool);
    assert.match(await chat.reply("open tennis app"), /^Tennis App \(freshness: unverified\)\n/);
    assert.match(await chat.reply("what's happening?"), /^Tennis App \(freshness: unverified\)\n/);
  });

  test("asking before opening, unknown input and listing", async () => {
    const chat = new Conversation(callTool);
    assert.match(await chat.reply("what's happening?"), /^No project is open\./);
    assert.match(await chat.reply("deploy it"), /^I understand:/);
    assert.equal(await chat.reply("list projects"), "b (Project Bravo)\ngolf-app (Golf App)\ntennis-app (Tennis App)");
    assert.equal(chat.context.active_project_id, null);
  });

  test("voice-bridge chat answers stdin lines through the running daemon", async () => {
    const child = spawn(process.execPath, [CLI_ENTRY, "chat"], {
      env: { ...process.env, VOICE_BRIDGE_DATA_DIR: dataDir },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    child.stdin.end("open golf app\nwhat's happening?\nswitch to B\nwhat's happening?\nopen croquet club\n");

    assert.equal(await exited, 0, stderr);
    assert.equal(stderr, "");
    const [, afterSwitch] = stdout.split("Project Bravo (freshness: current)\nOpened.");
    assert.match(stdout, /MARKER-A/);
    assert.match(afterSwitch!, /MARKER-B/);
    assert.doesNotMatch(afterSwitch!, /MARKER-A|Golf App/);
    assert.match(stdout, /No project matches "croquet club"\.\n$/);
  });
});

/** Relative runtime imports of a compiled module, followed through the whole local graph. */
function runtimeImports(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const source = readFileSync(entry, "utf8");
  for (const [, specifier] of source.matchAll(/^\s*(?:import|export)\b[^;"]*?(?:from\s*)?"(\.[^"]+)"/gm)) {
    runtimeImports(path.resolve(path.dirname(entry), specifier!), seen);
  }
  for (const [, specifier] of source.matchAll(/\bimport\(\s*"(\.[^"]+)"\s*\)/g)) {
    runtimeImports(path.resolve(path.dirname(entry), specifier!), seen);
  }
  return seen;
}

test("the chat module never loads the store; it reaches projects only through HTTP tools", () => {
  const distDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const loaded = [...runtimeImports(path.join(distDir, "chat.js"))].map((file) => path.relative(distDir, file));
  assert.ok(!loaded.includes("store.js"), `chat loads: ${loaded.join(", ")}`);
  assert.ok(!loaded.some((file) => /sqlite/i.test(readFileSync(path.join(distDir, file), "utf8"))), "chat touches SQLite");
});
