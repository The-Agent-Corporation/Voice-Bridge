import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, mock, test } from "node:test";
import { resolveProviderHomes } from "../adapters/homes.js";
import { startBridge, type RunningBridge } from "../app.js";
import { SECTION_HEADINGS } from "../briefing.js";
import { Reconciler } from "../reconcile.js";
import { createBridgeServer } from "../server.js";
import { openStore } from "../store.js";
import { readClientToken } from "../token.js";
import { call, fixtureHomes, makeRepo, PRD_SAMPLE, removeTempDirs, tempDir, writeClaudeSession } from "./helpers.js";

const headings = (text: string) => text.match(/^## .+$/gm)?.map((line) => line.slice(3));
const tokens = (text: string) => Math.ceil(text.length / 4);

describe("VOICE.md generation", () => {
  let bridge: RunningBridge;
  let token: string;
  let homes: ReturnType<typeof fixtureHomes>;
  let projects = 0;

  const tool = (name: string, body: unknown) => call(bridge.port, token, name, body);
  const open = async (projectId: string) => (await tool("open_project", { project_id: projectId })).body;
  /** Resolves once the background pass each `open_project` starts has finished, since passes queue per project. */
  const settle = async (projectId: string) => {
    assert.equal((await tool("reconcile_project", { project_id: projectId })).status, 200);
  };

  /**
   * Registers a fresh repository with `config` over the PRD sample and reads its HEAD once, as a running
   * daemon would have, so the background pass `open_project` starts leaves the briefing's text alone.
   * Returns the project's id and path.
   */
  const register = async (config: Record<string, unknown> = {}, prepare: (repo: string) => void = () => {}) => {
    const projectId = `voice-${++projects}`;
    const repo = makeRepo({ ...PRD_SAMPLE, project_id: projectId, ...config });
    prepare(repo);
    const response = await tool("register_project", { path: repo });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    await settle(projectId);
    return { projectId, repo };
  };

  const ingest = async (projectId: string, sequence: number, type: string, payload: unknown, sessionId = "s1") => {
    const response = await tool("ingest_event", {
      project_id: projectId,
      session_id: sessionId,
      source: "hook",
      source_event_id: `${projectId}-${sequence}`,
      source_sequence: sequence,
      type,
      payload,
      observed_at: new Date(Date.UTC(2026, 9, 24, 12, 0, sequence)).toISOString(),
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  };

  before(async () => {
    homes = fixtureHomes();
    const dataDir = tempDir();
    bridge = await startBridge({ dataDir, port: 0, env: homes });
    token = readClientToken(dataDir);
  });

  after(async () => {
    await bridge.close();
    removeTempDirs();
  });

  test("after turn_started and progress, VOICE.md has the seven headings in order and matches open_project", async () => {
    const { projectId, repo } = await register();
    await ingest(projectId, 1, "turn_started", {});
    await ingest(projectId, 2, "progress", { summary: "renderer wired", current_task: "tests" });
    const file = readFileSync(path.join(repo, "VOICE.md"), "utf8");
    assert.deepEqual(headings(file), [...SECTION_HEADINGS]);
    assert.match(file, /renderer wired/);
    const opened = await open(projectId);
    assert.equal(opened.briefing, file);
    assert.equal(opened.briefing_write, "unchanged");
    assert.equal(opened.briefing_write_error, null);
  });

  test("re-posting the same event leaves VOICE.md's bytes and mtime unchanged", async () => {
    const { projectId, repo } = await register();
    const file = path.join(repo, "VOICE.md");
    await ingest(projectId, 1, "progress", { summary: "once" });
    const bytes = readFileSync(file, "utf8");
    const { mtimeMs } = statSync(file);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await ingest(projectId, 1, "progress", { summary: "once" })).duplicate, true);
    assert.equal(readFileSync(file, "utf8"), bytes);
    assert.equal(statSync(file).mtimeMs, mtimeMs);
    assert.equal((await open(projectId)).briefing_write, "unchanged");
    assert.equal(statSync(file).mtimeMs, mtimeMs);
  });

  test("the largest storable progress summary still fits 800 tokens and keeps blockers and questions", async () => {
    const { projectId, repo } = await register();
    await ingest(projectId, 1, "blocker", { summary: "review pending" });
    await ingest(projectId, 2, "user_question", { summary: "merge now?" });
    await ingest(projectId, 3, "progress", { summary: "p".repeat(16_000) });
    const file = readFileSync(path.join(repo, "VOICE.md"), "utf8");
    assert.ok(tokens(file) <= 800, `${tokens(file)} tokens`);
    assert.match(file, /## Blockers and pending questions\nBlockers:\n- reported at .+: review pending\nPending questions:\n- q-\d+: merge now\?/);
  });

  test("a deleted or hand-edited VOICE.md is rewritten from the store on the next refresh", async () => {
    const { projectId, repo } = await register();
    const file = path.join(repo, "VOICE.md");
    await ingest(projectId, 1, "progress", { summary: "restore me" });

    rmSync(file);
    assert.equal((await ingest(projectId, 1, "progress", { summary: "restore me" })).duplicate, true);
    const restored = readFileSync(file, "utf8");
    assert.match(restored, /restore me/);
    assert.equal((await open(projectId)).briefing, restored);
    await settle(projectId);

    writeFileSync(file, "hand edited\n");
    const opened = await open(projectId);
    assert.equal(opened.briefing_write, "written");
    assert.equal(readFileSync(file, "utf8"), opened.briefing);
    assert.match(opened.briefing, /restore me/);
  });

  test("max_briefing_tokens: 300 keeps a heavy briefing within 300 tokens", async () => {
    const { projectId, repo } = await register({ max_briefing_tokens: 300 });
    const text = (label: string) => `${label} `.padEnd(300, "x");
    let sequence = 0;
    await ingest(projectId, ++sequence, "plan_updated", {
      objective: text("objective"),
      next_steps: [1, 2, 3, 4, 5].map((n) => text(`step ${n}`)),
    });
    for (let n = 0; n < 5; n++) await ingest(projectId, ++sequence, "user_question", { summary: text(`question ${n}`) });
    for (let n = 0; n < 3; n++) await ingest(projectId, ++sequence, "blocker", { summary: text(`blocker ${n}`) });
    await ingest(projectId, ++sequence, "progress", { summary: text("progress"), current_task: text("task") });
    const file = readFileSync(path.join(repo, "VOICE.md"), "utf8");
    assert.ok(tokens(file) <= 300, `${tokens(file)} tokens`);
    assert.deepEqual(headings(file), [...SECTION_HEADINGS]);
  });

  test("a secret in a payload is redacted in the file and in open_project", async () => {
    const { projectId, repo } = await register();
    await ingest(projectId, 1, "progress", { summary: "used sk-abcdefghijklmnop1234 to deploy" });
    const file = readFileSync(path.join(repo, "VOICE.md"), "utf8");
    const opened = await open(projectId);
    for (const text of [file, opened.briefing]) {
      assert.match(text, /used \[REDACTED\] to deploy/);
      assert.doesNotMatch(text, /sk-abcdefghijklmnop1234/);
    }
  });

  test("no stored native session id appears in the file, even when an agent echoes it", async () => {
    const nativeId = randomUUID();
    const { projectId, repo } = await register({}, (dir) => writeClaudeSession(homes.VOICE_BRIDGE_CLAUDE_HOME, dir, nativeId));
    const { sessions } = (await tool("list_sessions", { project_id: projectId })).body;
    assert.deepEqual(sessions.map((s: { native_session_id: string }) => s.native_session_id), [nativeId]);
    await ingest(projectId, 1, "turn_started", {}, `claude-code:${nativeId}`);
    await ingest(projectId, 2, "progress", { summary: `resumed session ${nativeId}` }, `claude-code:${nativeId}`);
    const file = readFileSync(path.join(repo, "VOICE.md"), "utf8");
    assert.ok(!file.includes(nativeId));
    assert.match(file, /^Agent: claude-code$/m);
  });

  test("20 concurrent regenerations leave one complete file and no temp files", async () => {
    const { projectId, repo } = await register();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => ingest(projectId, i + 1, "progress", { summary: `step ${i + 1}` })),
    );
    const file = readFileSync(path.join(repo, "VOICE.md"), "utf8");
    assert.deepEqual(headings(file), [...SECTION_HEADINGS]);
    assert.ok(file.endsWith("\n"));
    assert.deepEqual(readdirSync(repo).filter((name) => name.endsWith(".tmp")), []);
    assert.equal((await open(projectId)).briefing, file);
  });

  test("briefing_file names the file that is written", async () => {
    const { projectId, repo } = await register({ briefing_file: "BRIEF.md" });
    await ingest(projectId, 1, "progress", { summary: "renamed" });
    assert.match(readFileSync(path.join(repo, "BRIEF.md"), "utf8"), /renamed/);
    assert.equal(existsSync(path.join(repo, "VOICE.md")), false);
  });

  test("a briefing_file outside the repository root or a budget below the floor rejects registration", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ briefing_file: "../x" }, "invalid_briefing_file"],
      [{ briefing_file: "a/b" }, "invalid_briefing_file"],
      [{ briefing_file: ".hidden" }, "invalid_briefing_file"],
      [{ max_briefing_tokens: 100 }, "invalid_max_briefing_tokens"],
      [{ max_briefing_tokens: 800.5 }, "invalid_max_briefing_tokens"],
    ];
    for (const [config, code] of cases) {
      const repo = makeRepo({ ...PRD_SAMPLE, project_id: `rejected-${++projects}`, ...config });
      const response = await tool("register_project", { path: repo });
      assert.equal(response.status, 400, JSON.stringify(config));
      assert.equal(response.body.error.code, code);
    }
  });

  test("a repository that cannot be written still answers open_project and says the write failed", { skip: process.getuid?.() === 0 }, async () => {
    const { projectId, repo } = await register();
    rmSync(path.join(repo, "VOICE.md"));
    chmodSync(repo, 0o555);
    try {
      await ingest(projectId, 1, "progress", { summary: "read-only" });
      const opened = await open(projectId);
      assert.equal(opened.briefing_write, "failed");
      assert.ok(opened.briefing_write_error);
      assert.match(opened.briefing, /read-only/);
      assert.equal(existsSync(path.join(repo, "VOICE.md")), false);
    } finally {
      chmodSync(repo, 0o755);
    }
  });
});

test("an ingest whose briefing refresh throws still reports the committed event", async () => {
  const store = openStore(tempDir());
  store.saveBriefing = () => {
    throw new Error("disk full");
  };
  const server = createBridgeServer({
    store,
    token: "t",
    buildId: null,
    providerHomes: resolveProviderHomes(fixtureHomes()),
    reconciler: new Reconciler(store),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const errors = mock.method(console, "error", () => {});
  try {
    const repo = makeRepo({ ...PRD_SAMPLE, project_id: "voice-throws" });
    assert.equal((await call(port, "t", "register_project", { path: repo })).status, 200);
    const event = {
      project_id: "voice-throws",
      session_id: "s1",
      source: "hook",
      source_event_id: "voice-throws-1",
      source_sequence: 1,
      type: "progress",
      payload: { summary: "stored" },
      observed_at: new Date().toISOString(),
    };
    const first = await call(port, "t", "ingest_event", event);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.duplicate, false);
    assert.equal((await call(port, "t", "ingest_event", event)).body.duplicate, true);
    assert.match(String(errors.mock.calls[0]?.arguments[0]), /VOICE\.md not written for voice-throws: disk full/);
  } finally {
    errors.mock.restore();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    removeTempDirs();
  }
});
