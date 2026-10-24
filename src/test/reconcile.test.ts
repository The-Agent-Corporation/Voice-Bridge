import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { compareHead, readHead, type HeadRead } from "../head.js";
import { createReconciler, DEFAULT_RECONCILE_INTERVAL_MS, parseReconcileInterval } from "../reconcile.js";
import { openStore } from "../store.js";
import { commitEmpty, makeRepo, PRD_SAMPLE, removeTempDirs, tempDir } from "./helpers.js";

after(removeTempDirs);

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("compareHead", () => {
  const cases: [string, HeadRead, string | null, string][] = [
    ["the recorded full hash", { state: "commit", commit: SHA }, SHA, "matches"],
    ["a recorded short hash", { state: "commit", commit: SHA }, SHA.slice(0, 7), "matches"],
    ["another commit", { state: "commit", commit: SHA }, "fedcba9", "moved"],
    ["a commit with nothing recorded", { state: "commit", commit: SHA }, null, "moved"],
    ["no commits with nothing recorded", { state: "unborn" }, null, "matches"],
    ["no commits with a commit recorded", { state: "unborn" }, SHA, "moved"],
    ["a HEAD that cannot be read", { state: "unreadable", detail: "boom" }, SHA, "unreadable"],
  ];
  for (const [name, head, recorded, expected] of cases) {
    test(`${name} is ${expected}`, () => assert.equal(compareHead(head, recorded), expected));
  }
});

describe("parseReconcileInterval", () => {
  test("unset or empty is the 60 s default", () => {
    assert.equal(parseReconcileInterval({}), DEFAULT_RECONCILE_INTERVAL_MS);
    assert.equal(parseReconcileInterval({ VOICE_BRIDGE_RECONCILE_INTERVAL_MS: "" }), 60_000);
  });

  test("a whole number of milliseconds in range is taken as is", () => {
    assert.equal(parseReconcileInterval({ VOICE_BRIDGE_RECONCILE_INTERVAL_MS: "1000" }), 1000);
  });

  test("anything else refuses to start rather than falling back", () => {
    for (const value of ["999", "abc", "1.5", "-1000", "86400001"]) {
      assert.throws(() => parseReconcileInterval({ VOICE_BRIDGE_RECONCILE_INTERVAL_MS: value }), { code: "invalid_reconcile_interval" }, value);
    }
  });
});

describe("readHead", () => {
  test("a repository with no commits is unborn, and a commit is read in full", async () => {
    const repo = makeRepo();
    assert.deepEqual(await readHead(repo), { state: "unborn" });
    const sha = commitEmpty(repo);
    assert.deepEqual(await readHead(repo), { state: "commit", commit: sha });
  });

  test("a HEAD whose commit object is missing is unreadable, not unborn", async () => {
    const repo = makeRepo();
    const sha = commitEmpty(repo);
    rmSync(path.join(repo, ".git", "objects", sha.slice(0, 2), sha.slice(2)));
    const head = await readHead(repo);
    assert.equal(head.state, "unreadable");
  });

  test("a directory outside any repository is unreadable, not unborn", async () => {
    const head = await readHead(tempDir());
    assert.equal(head.state, "unreadable");
  });
});

test("asks during a run share one queued run, and close waits for both", async () => {
  const store = openStore(tempDir());
  const repo = makeRepo();
  store.upsert({ project_id: PRD_SAMPLE.project_id, display_name: PRD_SAMPLE.display_name, canonical_path: repo });
  const gates: (() => void)[] = [];
  const reconciler = createReconciler({
    store,
    intervalMs: DEFAULT_RECONCILE_INTERVAL_MS,
    readHead: async (root) => {
      await new Promise<void>((resolve) => gates.push(resolve));
      return readHead(root);
    },
  });
  try {
    const first = reconciler.reconcile(PRD_SAMPLE.project_id);
    const second = reconciler.reconcile(PRD_SAMPLE.project_id);
    const third = reconciler.reconcile(PRD_SAMPLE.project_id);
    assert.equal(second, third);
    assert.equal(gates.length, 1);
    gates[0]!();
    await first;
    while (gates.length < 2) await new Promise((resolve) => setImmediate(resolve));
    const closing = reconciler.close();
    gates[1]!();
    await closing;
    await assert.rejects(second, { code: "shutting_down" });
    assert.equal(gates.length, 2);
  } finally {
    store.close();
  }
});
