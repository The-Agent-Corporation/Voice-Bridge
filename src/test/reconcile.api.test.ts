import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import diagnosticsChannel from "node:diagnostics_channel";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, mock, test } from "node:test";
import { startBridge, type RunningBridge, type StartOptions } from "../app.js";
import { resolveGit, runGit } from "../git.js";
import { readHead, type HeadReader } from "../head.js";
import { openStore, STORE_FILE } from "../store.js";
import { readClientToken } from "../token.js";
import { call, commitEmpty, fixtureHomes, makeRepo, PRD_SAMPLE, removeTempDirs, tempDir } from "./helpers.js";

after(removeTempDirs);

const PROJECT = PRD_SAMPLE.project_id;

interface Harness {
  bridge: RunningBridge;
  dataDir: string;
  tool(name: string, body?: unknown): Promise<{ status: number; body: any }>;
}

async function start(dataDir = tempDir(), options: Partial<StartOptions> = {}): Promise<Harness> {
  const bridge = await startBridge({ dataDir, port: 0, env: fixtureHomes(), ...options });
  const token = readClientToken(dataDir);
  return { bridge, dataDir, tool: (name, body = { project_id: PROJECT }) => call(bridge.port, token, name, body) };
}

function hookEvent(sequence: number, summary: string) {
  return {
    project_id: PROJECT,
    session_id: "s1",
    source: "hook",
    source_event_id: `hook-${sequence}`,
    source_sequence: sequence,
    type: "progress" as const,
    payload: { summary },
    observed_at: new Date(Date.UTC(2026, 9, 24, 12, 0, sequence)).toISOString(),
  };
}

async function registerAndIngest(h: Harness): Promise<string> {
  const repo = makeRepo();
  assert.equal((await h.tool("register_project", { path: repo })).status, 200);
  const ingested = await h.tool("ingest_event", hookEvent(1, "first step"));
  assert.equal(ingested.status, 200, JSON.stringify(ingested.body));
  return repo;
}

function reconcileCommitRows(dataDir: string, commit: string): number {
  const db = new DatabaseSync(path.join(dataDir, STORE_FILE), { readOnly: true });
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE source = 'reconcile' AND type = 'git_commit' AND payload = ?")
      .get(JSON.stringify({ commit })) as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A HEAD reader whose first read waits until `release` is called; every later read goes straight to Git. */
function gatedReadHead(): { readHead: HeadReader; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let first = true;
  return {
    release,
    readHead: async (root) => {
      if (first) {
        first = false;
        await gate;
      }
      return readHead(root);
    },
  };
}

/**
 * Leaves a store holding an admitted event the briefing was never refreshed from: the state a crash
 * between the ingest commit and the refresh leaves behind.
 */
async function crashedAfterStore(): Promise<{ dataDir: string; repo: string }> {
  const h = await start();
  const repo = await registerAndIngest(h);
  await h.bridge.close();
  const store = openStore(h.dataDir);
  try {
    store.ingestEvent({ ...hookEvent(2, "stored before the crash"), payload: JSON.stringify({ summary: "stored before the crash" }) });
  } finally {
    store.close();
  }
  return { dataDir: h.dataDir, repo };
}

const voiceFile = (repo: string) => readFileSync(path.join(repo, "VOICE.md"), "utf8");
const untouchedByBridge = (repo: string) => {
  const status = runGit(["status", "--porcelain", "--untracked-files=all"], repo);
  assert.ok(status.ok);
  return status.stdout.split("\n").filter((line) => !line.endsWith(" VOICE.md"));
};

test("a commit with no event is head_moved until reconcile_project records it in provenance", async () => {
  const h = await start();
  try {
    const repo = await registerAndIngest(h);
    assert.equal((await h.tool("get_project_status")).body.freshness, "current");
    const before = untouchedByBridge(repo);
    const sha = commitEmpty(repo, "missed by the hook");

    const status = (await h.tool("get_project_status")).body;
    assert.notEqual(status.freshness, "current");
    assert.ok(status.freshness_reasons.includes("head_moved"), JSON.stringify(status));
    const opened = (await h.tool("open_project")).body;
    assert.equal(opened.uncertain, true);
    assert.ok(opened.freshness_reasons.includes("head_moved"), JSON.stringify(opened));

    const reconciled = await h.tool("reconcile_project");
    assert.equal(reconciled.status, 200, JSON.stringify(reconciled.body));
    assert.equal(reconciled.body.head_commit, sha);
    assert.equal(reconciled.body.status.freshness, "current");
    assert.equal((await h.tool("get_project_status")).body.freshness, "current");
    assert.match(voiceFile(repo), new RegExp(`^Commit: ${sha}$`, "m"));
    const reopened = (await h.tool("open_project")).body;
    assert.equal(reopened.uncertain, false);
    assert.match(reopened.briefing, new RegExp(`^Commit: ${sha}$`, "m"));
    assert.deepEqual(untouchedByBridge(repo), before);
  } finally {
    await h.bridge.close();
  }
});

test("reconciling again, or twice at once, records one event per commit", async () => {
  const h = await start();
  try {
    const repo = await registerAndIngest(h);
    const sha = commitEmpty(repo, "one");
    for (let n = 0; n < 2; n++) assert.equal((await h.tool("reconcile_project")).status, 200);
    const both = await Promise.all([h.tool("reconcile_project"), h.tool("reconcile_project")]);
    assert.deepEqual(both.map((r) => r.status), [200, 200]);
    assert.equal(reconcileCommitRows(h.dataDir, sha), 1);

    const next = commitEmpty(repo, "two");
    const reconciled = (await h.tool("reconcile_project")).body;
    assert.notEqual(reconciled.recorded_event_id, null);
    assert.equal(reconcileCommitRows(h.dataDir, sha), 1);
    assert.equal(reconcileCommitRows(h.dataDir, next), 1);
  } finally {
    await h.bridge.close();
  }
});

test("an event stored but never refreshed is lagging after a restart until startup reconciliation finishes", async () => {
  const { dataDir, repo } = await crashedAfterStore();
  const gated = gatedReadHead();
  const h = await start(dataDir, { readHead: gated.readHead });
  try {
    const held = (await h.tool("get_project_status")).body;
    assert.equal(held.freshness, "lagging");
    assert.deepEqual(held.freshness_reasons, ["pending_refresh"]);
    assert.doesNotMatch(voiceFile(repo), /stored before the crash/);

    gated.release();
    const repaired = await waitFor(() => h.tool("get_project_status").then((r) => r.body), (s) => s.freshness === "current");
    assert.equal(repaired.freshness, "current", JSON.stringify(repaired));
    assert.match(voiceFile(repo), /stored before the crash/);
  } finally {
    gated.release();
    await h.bridge.close();
  }
});

test("open_project on a lagging project answers uncertain within 500 ms while reconciliation is held", async () => {
  const { dataDir, repo } = await crashedAfterStore();
  const gated = gatedReadHead();
  const h = await start(dataDir, { readHead: gated.readHead });
  try {
    const started = performance.now();
    const opened = await h.tool("open_project");
    const elapsed = performance.now() - started;
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    assert.ok(elapsed < 500, `${elapsed} ms`);
    assert.equal(opened.body.uncertain, true);
    assert.equal(opened.body.freshness, "lagging");
    assert.equal(opened.body.briefing_write, "deferred");
    assert.match(opened.body.briefing, /^Freshness: lagging \(pending_refresh\)$/m);
    assert.doesNotMatch(voiceFile(repo), /stored before the crash/);

    gated.release();
    const repaired = await waitFor(() => h.tool("get_project_status").then((r) => r.body), (s) => s.freshness === "current");
    assert.equal(repaired.freshness, "current");
  } finally {
    gated.release();
    await h.bridge.close();
  }
});

test("reconciliation spawns git, by its absolute path, and nothing else", async () => {
  const h = await start();
  const spawned: ChildProcess[] = [];
  const onSpawn = (message: unknown) => spawned.push((message as { process: ChildProcess }).process);
  try {
    const repo = await registerAndIngest(h);
    commitEmpty(repo);
    diagnosticsChannel.subscribe("child_process", onSpawn);
    try {
      assert.equal((await h.tool("reconcile_project")).status, 200);
    } finally {
      diagnosticsChannel.unsubscribe("child_process", onSpawn);
    }
    const git = resolveGit();
    assert.ok(git !== null && path.isAbsolute(git));
    assert.ok(spawned.length > 0);
    assert.deepEqual(new Set(spawned.map((child) => child.spawnfile)), new Set([git]));
  } finally {
    await h.bridge.close();
  }
});

test("VOICE_BRIDGE_RECONCILE_INTERVAL_MS repairs a missed commit with no tool call", async () => {
  const h = await start(tempDir(), { env: { ...fixtureHomes(), VOICE_BRIDGE_RECONCILE_INTERVAL_MS: "1000" } });
  try {
    const repo = await registerAndIngest(h);
    const sha = commitEmpty(repo);
    assert.equal((await h.tool("get_project_status")).body.freshness, "unverified");
    const repaired = await waitFor(() => h.tool("get_project_status").then((r) => r.body), (s) => s.freshness === "current", 4_000);
    assert.equal(repaired.freshness, "current");
    assert.match(voiceFile(repo), new RegExp(`^Commit: ${sha}$`, "m"));
  } finally {
    await h.bridge.close();
  }
});

test("closing the bridge waits out a background reconciliation without an error", async () => {
  const slowReadHead: HeadReader = async (root) => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return readHead(root);
  };
  const h = await start(tempDir(), { readHead: slowReadHead });
  const errors = mock.method(console, "error", () => {});
  try {
    assert.equal((await h.tool("register_project", { path: makeRepo() })).status, 200);
    const opened = (await h.tool("open_project")).body;
    assert.equal(opened.uncertain, true);
    await h.bridge.close();
    assert.equal(errors.mock.callCount(), 0, JSON.stringify(errors.mock.calls.map((c) => c.arguments)));
  } finally {
    errors.mock.restore();
  }
});
