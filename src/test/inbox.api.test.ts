import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, test } from "node:test";
import { startBridge, type RunningBridge } from "../app.js";
import { STORE_FILE } from "../store.js";
import { readClientToken } from "../token.js";
import { call, fixtureHomes, makeRepo, PRD_SAMPLE, removeTempDirs, tempDir } from "./helpers.js";

const A = PRD_SAMPLE.project_id;
const B = "second";

after(removeTempDirs);

let sequence = 0;

function question(projectId: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  sequence++;
  return {
    project_id: projectId,
    session_id: "s1",
    source: "hook",
    source_event_id: `hook-${sequence}`,
    source_sequence: sequence,
    type: "user_question",
    payload,
    observed_at: new Date(Date.UTC(2026, 9, 24, 12, 0, sequence)).toISOString(),
    ...extra,
  };
}

async function registerBoth(tool: (name: string, body: unknown) => Promise<{ status: number }>): Promise<void> {
  for (const config of [PRD_SAMPLE, { ...PRD_SAMPLE, project_id: B, display_name: "Second" }]) {
    assert.equal((await tool("register_project", { path: makeRepo(config) })).status, 200);
  }
}

describe("the inbox", () => {
  let bridge: RunningBridge;
  let dataDir: string;
  let token: string;

  const tool = (name: string, body: unknown) => call(bridge.port, token, name, body);
  const ask = async (projectId: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const response = await tool("ingest_event", question(projectId, payload, extra));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.event_id as number;
  };
  const list = async (body: Record<string, unknown> = {}) => {
    const response = await tool("list_inbox", body);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.items as (Record<string, unknown> & { project_id: string })[];
  };
  const notificationCount = (questionId: string) => {
    const db = new DatabaseSync(path.join(dataDir, STORE_FILE), { readOnly: true });
    try {
      return (db.prepare("SELECT COUNT(*) AS n FROM inbox_notifications WHERE question_id = ?").get(questionId) as { n: number }).n;
    } finally {
      db.close();
    }
  };

  let questionA: string;
  let questionB: string;

  before(async () => {
    dataDir = tempDir();
    bridge = await startBridge({ dataDir, port: 0, env: fixtureHomes() });
    token = readClientToken(dataDir);
    await registerBoth(tool);
  });

  after(() => bridge.close());

  test("one distinct question from each of two projects gives two open items, each under its own project", async () => {
    questionA = `q-${await ask(A, { question_id: "ask-a", summary: "Deploy now?" })}`;
    questionB = `q-${await ask(B, { question_id: "ask-b", summary: "Rename the table?" })}`;
    const items = await list();
    assert.deepEqual(
      items.map(({ question_id, project_id, status }) => ({ question_id, project_id, status })).sort((x, y) => (x.project_id < y.project_id ? -1 : 1)),
      [
        { question_id: questionA, project_id: A, status: "open" },
        { question_id: questionB, project_id: B, status: "open" },
      ],
    );
  });

  test("the same question posted twice and then updated is one item with the new summary and one notification", async () => {
    const posted = question(A, { question_id: "ask-1", summary: "Which branch?" });
    const created = (await tool("ingest_event", posted)).body.event_id as number;
    const id = `q-${created}`;
    await ask(A, { question_id: "ask-1", summary: "Which branch?" });
    await ask(A, { question_id: "ask-1", summary: "Which branch, main or dev?" });
    assert.equal((await tool("ingest_event", posted)).body.duplicate, true);

    const matching = (await list({ project_id: A })).filter((item) => item.origin_question_id === "ask-1");
    assert.equal(matching.length, 1);
    assert.equal(matching[0]!.question_id, id);
    assert.equal(matching[0]!.summary, "Which branch, main or dev?");
    assert.equal(matching[0]!.source_event_id, created);
    assert.equal(notificationCount(id), 1);
  });

  test("list_inbox filters by project", async () => {
    const onlyA = await list({ project_id: A });
    assert.ok(onlyA.length > 0);
    assert.ok(onlyA.every((item) => item.project_id === A));
    assert.deepEqual((await list({ project_id: B })).map((item) => item.question_id), [questionB]);
  });

  test("dismissal cancels one item, records when, is safe to repeat, and leaves the other project's open", async () => {
    const dismissed = await tool("dismiss_inbox_question", { question_id: questionA });
    assert.equal(dismissed.status, 200);
    assert.equal(dismissed.body.dismissed, true);
    assert.equal(dismissed.body.item.status, "cancelled");
    assert.ok(Number.isFinite(Date.parse(dismissed.body.item.dismissed_at)));

    const again = await tool("dismiss_inbox_question", { question_id: questionA });
    assert.equal(again.status, 200);
    assert.equal(again.body.dismissed, false);
    assert.equal(again.body.item.dismissed_at, dismissed.body.item.dismissed_at);

    const open = await list({ status: "open" });
    assert.ok(!open.some((item) => item.question_id === questionA));
    assert.ok(open.some((item) => item.question_id === questionB));
    assert.equal((await list({ project_id: B }))[0]!.status, "open");

    const unknown = await tool("dismiss_inbox_question", { question_id: "q-999999" });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, "inbox_question_not_found");
  });

  test("withdrawn: true makes an open question obsolete without a notification", async () => {
    const id = `q-${await ask(B, { question_id: "ask-w", summary: "Still needed?" })}`;
    await ask(B, { question_id: "ask-w", withdrawn: true });
    const item = (await list({ project_id: B })).find((candidate) => candidate.question_id === id)!;
    assert.equal(item.status, "obsolete");
    assert.equal(notificationCount(id), 1);
  });

  test("a bad status or an unknown project is refused", async () => {
    const bogus = await tool("list_inbox", { status: "bogus" });
    assert.equal(bogus.status, 400);
    assert.equal(bogus.body.error.code, "invalid_request");
    const unknown = await tool("list_inbox", { project_id: "nope" });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, "project_not_found");
  });

  test("a summary comes back on one line with credentials redacted", async () => {
    const id = `q-${await ask(A, { summary: "Use key sk-abcdefghijklmnopqrstuvwxyz123456\nor not?" })}`;
    const item = (await list({ project_id: A })).find((candidate) => candidate.question_id === id)!;
    assert.equal(item.summary, "Use key [REDACTED] or not?");
  });
});

describe("list_inbox and adapters", () => {
  test("list_inbox answers while every adapter call would fail, and list_sessions proves the trap is armed", async () => {
    const dataDir = tempDir();
    const seeding = await startBridge({ dataDir, port: 0, env: fixtureHomes() });
    const token = readClientToken(dataDir);
    try {
      await registerBoth((name, body) => call(seeding.port, token, name, body));
      for (const projectId of [A, B]) {
        const response = await call(seeding.port, token, "ingest_event", question(projectId, { summary: `from ${projectId}` }));
        assert.equal(response.status, 200);
      }
    } finally {
      await seeding.close();
    }

    const missing = tempDir();
    const trapped = await startBridge({
      dataDir,
      port: 0,
      env: { VOICE_BRIDGE_CODEX_HOME: path.join(missing, "codex"), VOICE_BRIDGE_CLAUDE_HOME: path.join(missing, "claude") },
    });
    try {
      const all = await call(trapped.port, token, "list_inbox", {});
      assert.equal(all.status, 200, JSON.stringify(all.body));
      assert.equal(all.body.items.length, 2);
      const onlyA = await call(trapped.port, token, "list_inbox", { project_id: A });
      assert.equal(onlyA.status, 200, JSON.stringify(onlyA.body));
      assert.deepEqual(onlyA.body.items.map((item: { project_id: string }) => item.project_id), [A]);

      const sessions = await call(trapped.port, token, "list_sessions", { project_id: A });
      assert.equal(sessions.status, 500);
      assert.equal(sessions.body.error.code, "session_discovery_failed");
    } finally {
      await trapped.close();
    }
  });
});
