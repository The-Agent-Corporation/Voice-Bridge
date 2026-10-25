import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import diagnosticsChannel from "node:diagnostics_channel";
import path from "node:path";
import { after, test } from "node:test";
import { gitBinary, READ_HEAD_ARGS } from "../git.js";
import { RECONCILE_SOURCE, Reconciler } from "../reconcile.js";
import { getProjectStatus } from "../status.js";
import { openStore, type Store } from "../store.js";
import { commit, heldReader, makeRepo, PRD_SAMPLE, removeTempDirs, tempDir } from "./helpers.js";

after(removeTempDirs);

const PROJECT = PRD_SAMPLE.project_id;

function registered(): { store: Store; repo: string; dataDir: string } {
  const dataDir = tempDir();
  const repo = makeRepo();
  const store = openStore(dataDir);
  store.upsert({ project_id: PROJECT, display_name: PRD_SAMPLE.display_name, canonical_path: repo });
  return { store, repo, dataDir };
}

function reconcileEvents(store: Store): number {
  return store.listWatermarks(PROJECT).find((row) => row.source === RECONCILE_SOURCE)?.highest_stored ?? 0;
}

test("reconciling the same HEAD twice records one git_commit; a new commit records one more", async () => {
  const { store, repo } = registered();
  const reconciler = new Reconciler(store);
  try {
    const first = commit(repo);
    const recorded = await reconciler.reconcile(PROJECT);
    assert.equal(recorded.head, first);
    assert.notEqual(recorded.recorded_event_id, null);
    const again = await reconciler.reconcile(PROJECT);
    assert.equal(again.recorded_event_id, null);
    assert.equal(reconcileEvents(store), 1);
    assert.equal(again.status.freshness, "current");

    commit(repo);
    await Promise.all([reconciler.reconcile(PROJECT), reconciler.reconcile(PROJECT)]);
    assert.equal(reconcileEvents(store), 2);
  } finally {
    await reconciler.stop();
    store.close();
  }
});

test("an event stored but not processed before a crash leaves the project lagging until startup reconciliation", async () => {
  const { store: crashed, repo, dataDir } = registered();
  const hash = commit(repo);
  crashed.ingestEvent({
    project_id: PROJECT,
    session_id: "s1",
    source: "hook",
    source_event_id: "hook-1",
    source_sequence: 1,
    type: "git_commit",
    payload: JSON.stringify({ commit: hash }),
    observed_at: "2026-10-25T12:00:00.000Z",
  });
  crashed.close();

  const store = openStore(dataDir);
  const held = heldReader();
  const reconciler = new Reconciler(store, { readHead: held.readHead });
  try {
    assert.deepEqual(getProjectStatus(store, PROJECT).freshness_reasons, ["unprocessed_events"]);
    const startup = reconciler.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(held.started(), 1);
    assert.equal(getProjectStatus(store, PROJECT).freshness, "lagging");
    held.release();
    await startup;
    assert.equal(getProjectStatus(store, PROJECT).freshness, "current");
    // The hook's own commit event, once processed, already matches HEAD.
    assert.equal(reconcileEvents(store), 0);
  } finally {
    held.release();
    await reconciler.stop();
    store.close();
  }
});

test("reconciliation starts no process but a read-only git found on an absolute PATH entry", async () => {
  const { store, repo } = registered();
  commit(repo);
  const reconciler = new Reconciler(store);
  // The channel sees asynchronous child processes only, so src/reconcile.ts must use only async Git for
  // this spy to cover it.
  const spawned: ChildProcess[] = [];
  const onSpawn = (message: unknown) => spawned.push((message as { process: ChildProcess }).process);
  diagnosticsChannel.subscribe("child_process", onSpawn);
  try {
    await reconciler.reconcile(PROJECT);
  } finally {
    diagnosticsChannel.unsubscribe("child_process", onSpawn);
    await reconciler.stop();
    store.close();
  }
  assert.ok(spawned.length > 0, "the spy saw no process at all");
  const git = gitBinary();
  assert.ok(git !== null && path.isAbsolute(git));
  for (const child of spawned) {
    assert.equal(child.spawnfile, git);
    assert.deepEqual(child.spawnargs.slice(1), [...READ_HEAD_ARGS]);
  }
});

test("passes repeat on the interval and stop refuses further passes", async () => {
  const { store, repo } = registered();
  const reconciler = new Reconciler(store, { intervalMs: 20 });
  try {
    await reconciler.start();
    assert.equal(reconcileEvents(store), 0);
    commit(repo);
    const deadline = Date.now() + 2_000;
    while (reconcileEvents(store) === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(reconcileEvents(store), 1);
  } finally {
    await reconciler.stop();
  }
  await assert.rejects(reconciler.reconcile(PROJECT), { code: "bridge_closing" });
  await assert.rejects(reconciler.observe(PROJECT), { code: "bridge_closing" });
  store.close();
});

test("an unknown project is refused before git runs", async () => {
  const { store } = registered();
  const held = heldReader();
  const reconciler = new Reconciler(store, { readHead: held.readHead });
  try {
    await assert.rejects(reconciler.reconcile("nope"), { code: "project_not_found" });
    await assert.rejects(reconciler.observe("nope"), { code: "project_not_found" });
    assert.equal(held.started(), 0);
  } finally {
    await reconciler.stop();
    store.close();
  }
});
