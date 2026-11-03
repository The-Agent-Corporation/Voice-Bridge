import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { startBridge, type RunningBridge } from "../app.js";
import { Conversation, describeReceipt, matchProjects, parseCommand, type CallTool } from "../chat.js";
import type { MessageReceipt } from "../messages.js";
import { MESSAGE_STATES } from "../store.js";
import { readClientToken } from "../token.js";
import { call, CLI_ENTRY, fixtureHomes, makeRepo, PRD_SAMPLE, removeTempDirs, tempDir } from "./helpers.js";

after(removeTempDirs);

async function chatCli(dataDir: string, input: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
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
  child.stdin.end(input);
  return { status: await exited, stdout, stderr };
}

describe("chat grammar", () => {
  test("parses the five commands and nothing else", () => {
    assert.deepEqual(parseCommand("list projects"), { kind: "list" });
    assert.deepEqual(parseCommand("  Open   Golf App "), { kind: "open", name: "Golf App" });
    assert.deepEqual(parseCommand("switch to B"), { kind: "open", name: "B" });
    assert.deepEqual(parseCommand("What's happening?"), { kind: "happening" });
    assert.deepEqual(parseCommand("whats happening"), { kind: "happening" });
    assert.deepEqual(parseCommand("What\u2019s happening?"), { kind: "happening" });
    assert.deepEqual(parseCommand("  WHAT\u2019S   HAPPENING "), { kind: "happening" });
    assert.deepEqual(parseCommand("start the build"), { kind: "unknown" });
    assert.deepEqual(parseCommand("open"), { kind: "unknown" });
    assert.deepEqual(parseCommand("  Tell IT   run the tests "), { kind: "tell", instruction: "run the tests" });
    assert.deepEqual(parseCommand("tell it what\u2019s left"), { kind: "tell", instruction: "what\u2019s left" });
    assert.deepEqual(parseCommand("tell it"), { kind: "unknown" });
    assert.deepEqual(parseCommand("tell them to stop"), { kind: "unknown" });
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

function sendReceipt(overrides: Partial<MessageReceipt & { duplicate: boolean }> = {}): MessageReceipt & { duplicate: boolean } {
  return {
    message_id: "m-1",
    project_id: "golf-app",
    session_id: "codex:s1",
    sequence: 1,
    mode: "next_turn",
    question_id: null,
    idempotency_key: "k",
    state: "queued",
    reason: "awaiting_delivery",
    detail: "waiting for the session host",
    provider_ref: null,
    created_at: "2026-11-03T12:00:00.000Z",
    updated_at: "2026-11-03T12:00:00.000Z",
    expires_at: "2026-11-04T12:00:00.000Z",
    transitions: [],
    duplicate: false,
    ...overrides,
  };
}

describe("tell it", () => {
  const projects = [
    { project_id: "golf-app", display_name: "Golf App", freshness: "current", briefing: "B" },
    { project_id: "tennis-app", display_name: "Tennis App", freshness: "current", briefing: "T" },
  ];

  /** A bridge stand-in that records every call and answers each send from `answer`. */
  function fakeBridge(answer: (body: Record<string, unknown>) => unknown) {
    const sends: Record<string, unknown>[] = [];
    const callTool: CallTool = async <T>(tool: string, body: Record<string, unknown>) => {
      if (tool === "list_projects") return { projects: projects.map((p) => ({ ...p, canonical_path: `/${p.project_id}` })) } as T;
      if (tool === "open_project") return projects.find((p) => p.project_id === body.project_id) as T;
      assert.equal(tool, "send_to_primary");
      sends.push(body);
      return answer(body) as T;
    };
    return { sends, chat: new Conversation(callTool) };
  }

  test("with no project open it says so and sends nothing", async () => {
    const { sends, chat } = fakeBridge(() => sendReceipt());
    assert.match(await chat.reply("tell it run the tests"), /^No project is open, so nothing was sent\./);
    assert.equal(sends.length, 0);
  });

  test("sends the instruction as the open project's next turn and reports the receipt", async () => {
    const { sends, chat } = fakeBridge(() => sendReceipt());
    await chat.reply("open golf");
    const reply = await chat.reply("tell it run the tests");
    assert.equal(reply, "Message m-1 for codex:s1: queued, not yet delivered (awaiting_delivery: waiting for the session host).");
    assert.equal(sends.length, 1);
    assert.deepEqual({ ...sends[0], idempotency_key: undefined }, {
      project_id: "golf-app",
      text: "run the tests",
      mode: "next_turn",
      idempotency_key: undefined,
    });
    assert.match(String(sends[0]!.idempotency_key), /^chat-/);
  });

  test("each receipt state is worded without claiming more than it shows", () => {
    const worded = Object.fromEntries(MESSAGE_STATES.map((state) => [state, describeReceipt(sendReceipt({ state, reason: "turn_failed" }))]));
    for (const state of MESSAGE_STATES) {
      const claimsWork = /started;|completed;/.test(worded[state]!);
      assert.equal(claimsWork, state === "started" || state === "completed", worded[state]);
    }
    assert.match(worded.delivered!, /delivered; the session has not reported starting it/);
    assert.match(worded.failed!, /: failed \(turn_failed: /);
    assert.match(describeReceipt(sendReceipt({ session_id: null })), /for no session:/);
  });

  test("a refusal says it was not sent and why", () => {
    for (const reason of ["ambiguous_owner", "not_controllable", "unsupported_capability"] as const) {
      const reply = describeReceipt(sendReceipt({ state: "failed", reason, detail: "the primary is saved, not connected" }));
      assert.match(reply, new RegExp(`refused, not sent \\(${reason}: the primary is saved, not connected\\)\\.$`));
    }
  });

  test("a duplicate receipt says the bridge already had the instruction", () => {
    assert.match(describeReceipt(sendReceipt({ duplicate: true, state: "delivered" })), /^The bridge already had this instruction; Message m-1 .*delivered/);
  });

  test("retrying an instruction whose send threw reuses its key; a later repeat is a new instruction", async () => {
    let fail = true;
    const { sends, chat } = fakeBridge(() => {
      if (fail) throw new Error("bridge unreachable");
      return sendReceipt();
    });
    await chat.reply("open golf");
    await assert.rejects(chat.reply("tell it run the tests"), /bridge unreachable/);
    fail = false;
    await chat.reply("tell it   run the tests");
    await chat.reply("tell it run the tests");
    const keys = sends.map((body) => body.idempotency_key);
    assert.equal(keys.length, 3);
    assert.equal(keys[1], keys[0]);
    assert.notEqual(keys[2], keys[1]);
  });

  test("a different instruction after a failed send gets its own key", async () => {
    let fail = true;
    const { sends, chat } = fakeBridge(() => {
      if (fail) throw new Error("bridge unreachable");
      return sendReceipt();
    });
    await chat.reply("open golf");
    await assert.rejects(chat.reply("tell it run the tests"), /bridge unreachable/);
    fail = false;
    await chat.reply("tell it stop");
    assert.notEqual(sends[1]!.idempotency_key, sends[0]!.idempotency_key);
  });

  test("the same instruction to another project after a failed send gets its own key", async () => {
    let fail = true;
    const { sends, chat } = fakeBridge(() => {
      if (fail) throw new Error("bridge unreachable");
      return sendReceipt();
    });
    await chat.reply("open golf");
    await assert.rejects(chat.reply("tell it run the tests"), /bridge unreachable/);
    fail = false;
    await chat.reply("open tennis");
    await chat.reply("tell it run the tests");
    assert.equal(sends[1]!.project_id, "tennis-app");
    assert.notEqual(sends[1]!.idempotency_key, sends[0]!.idempotency_key);
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
    await callTool("reconcile_project", { project_id: projectId });
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

  test("a failed tool call leaves the context as it was and the conversation goes on", async () => {
    const failing: CallTool = async <T>(tool: string, body: Record<string, unknown>) => {
      if (tool === "open_project" && body.project_id === "b") throw new Error("bridge unreachable");
      return callTool<T>(tool, body);
    };
    const chat = new Conversation(failing);
    await chat.reply("open golf app");
    const before = chat.context;

    await assert.rejects(chat.reply("switch to B"), /bridge unreachable/);
    assert.deepEqual(chat.context, before);
    assert.match(await chat.reply("what's happening?"), /^Golf App \(freshness: current\)\n/);
  });

  test("asking before opening, unknown input and listing", async () => {
    const chat = new Conversation(callTool);
    assert.match(await chat.reply("what's happening?"), /^No project is open\./);
    assert.match(await chat.reply("deploy it"), /^I understand:/);
    assert.equal(await chat.reply("list projects"), "b (Project Bravo)\ngolf-app (Golf App)\ntennis-app (Tennis App)");
    assert.equal(chat.context.active_project_id, null);
  });

  test("voice-bridge chat answers stdin lines through the running daemon", async () => {
    const { status, stdout, stderr } = await chatCli(dataDir, "open golf app\nwhat's happening?\nswitch to B\nwhat's happening?\nopen croquet club\n");

    assert.equal(status, 0, stderr);
    assert.equal(stderr, "");
    const [, afterSwitch] = stdout.split("Project Bravo (freshness: current)\nOpened.");
    assert.match(stdout, /MARKER-A/);
    assert.match(afterSwitch!, /MARKER-B/);
    assert.doesNotMatch(afterSwitch!, /MARKER-A|Golf App/);
    assert.match(stdout, /No project matches "croquet club"\.\n$/);
  });
});

test("voice-bridge chat reports each failed tool call, keeps answering, and exits 1", async () => {
  const { status, stdout, stderr } = await chatCli(tempDir(), "list projects\nopen golf app\ndeploy it\n");
  assert.equal(status, 1);
  assert.equal(stderr.match(/^voice-bridge: daemon_not_running: /gm)?.length, 2, stderr);
  assert.match(stdout, /^I understand:/);
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
