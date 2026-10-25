import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, test } from "node:test";
import { resolveProviderHomes } from "../adapters/homes.js";
import { startBridge } from "../app.js";
import { RECONCILE_SOURCE, Reconciler } from "../reconcile.js";
import { createBridgeServer } from "../server.js";
import { openStore, type Store } from "../store.js";
import { readClientToken } from "../token.js";
import { call, commit, fixtureHomes, heldReader, makeRepo, PRD_SAMPLE, removeTempDirs, tempDir } from "./helpers.js";

after(removeTempDirs);

const PROJECT = PRD_SAMPLE.project_id;

const turnCompleted = {
  project_id: PROJECT,
  session_id: "s1",
  source: "hook",
  source_event_id: "hook-1",
  source_sequence: 1,
  type: "turn_completed" as const,
  payload: {},
  observed_at: "2026-10-25T12:00:00.000Z",
};

/** A store holding the project with one event stored but never processed, as a crash would leave it. */
function crashedStore(repo: string): { dataDir: string; store: Store } {
  const dataDir = tempDir();
  const store = openStore(dataDir);
  store.upsert({ project_id: PROJECT, display_name: PRD_SAMPLE.display_name, canonical_path: repo });
  store.ingestEvent({ ...turnCompleted, payload: "{}" });
  return { dataDir, store };
}

test("a commit with no event is reported as head_moved and reconcile_project records it once", async () => {
  const dataDir = tempDir();
  const bridge = await startBridge({ dataDir, port: 0, env: fixtureHomes() });
  const tool = (name: string, body: unknown) => call(bridge.port, readClientToken(dataDir), name, body);
  try {
    const repo = makeRepo();
    assert.equal((await tool("register_project", { path: repo })).status, 200);
    assert.equal((await tool("ingest_event", turnCompleted)).status, 200);
    assert.equal((await tool("get_project_status", { project_id: PROJECT })).body.freshness, "current");

    const hash = commit(repo);
    const before = (await tool("get_project_status", { project_id: PROJECT })).body;
    assert.equal(before.freshness, "unverified");
    assert.deepEqual(before.freshness_reasons, ["head_moved"]);
    const opened = (await tool("open_project", { project_id: PROJECT })).body;
    assert.equal(opened.uncertain, true);

    const reconciled = await tool("reconcile_project", { project_id: PROJECT });
    assert.equal(reconciled.status, 200);
    assert.equal(reconciled.body.head, hash);
    assert.equal(reconciled.body.status.freshness, "current");
    assert.match(readFileSync(path.join(repo, "VOICE.md"), "utf8"), new RegExp(`^Commit: ${hash}$`, "m"));
    // open_project's background pass and reconcile_project ran one after the other: one event between them.
    const reconcileRow = (await tool("get_project_status", { project_id: PROJECT })).body.watermarks[RECONCILE_SOURCE];
    assert.equal(reconcileRow, 1);
    assert.equal((await tool("open_project", { project_id: PROJECT })).body.uncertain, false);
  } finally {
    await bridge.close();
  }
});

test("open_project on a lagging project answers uncertain at once while a reconcile is in progress", async () => {
  const repo = makeRepo();
  const { store } = crashedStore(repo);
  const held = heldReader();
  const reconciler = new Reconciler(store, { readHead: held.readHead });
  const server = createBridgeServer({ store, token: "t", buildId: null, providerHomes: resolveProviderHomes(fixtureHomes()), reconciler });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const reconciling = call(port, "t", "reconcile_project", { project_id: PROJECT });
    const deadline = Date.now() + 2_000;
    while (held.started() === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(held.started(), 1);

    const started = performance.now();
    const opened = await call(port, "t", "open_project", { project_id: PROJECT });
    const elapsed = performance.now() - started;
    assert.equal(opened.status, 200);
    assert.equal(opened.body.uncertain, true);
    assert.equal(opened.body.freshness, "lagging");
    assert.equal(opened.body.last_confirmed_activity, null);
    assert.ok(elapsed < 500, `open_project took ${elapsed} ms`);

    held.release();
    assert.equal((await reconciling).body.status.freshness, "current");
  } finally {
    held.release();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await reconciler.stop();
    store.close();
  }
});

test("startup reconciliation processes the events a crash left unprocessed", async () => {
  const { dataDir, store } = crashedStore(makeRepo());
  store.close();
  const bridge = await startBridge({ dataDir, port: 0, env: fixtureHomes() });
  try {
    await bridge.startupReconciliation;
    const status = await call(bridge.port, readClientToken(dataDir), "get_project_status", { project_id: PROJECT });
    assert.equal(status.body.freshness, "current");
  } finally {
    await bridge.close();
  }
});

test("a reconcile interval that is not a whole number of at least 1 ms refuses to start", async () => {
  for (const value of ["0", "abc", "1.5", "-5", ""]) {
    await assert.rejects(
      startBridge({ dataDir: tempDir(), port: 0, env: { ...fixtureHomes(), VOICE_BRIDGE_RECONCILE_INTERVAL_MS: value } }),
      { code: "invalid_reconcile_interval" },
      value,
    );
  }
});
