import { refreshBriefing, type BriefingRefresh } from "./briefingFile.js";
import { BridgeError } from "./errors.js";
import { compareHead, latestRecordedCommit, type HeadReader } from "./head.js";
import { getProjectStatus, type ProjectStatus } from "./status.js";
import { requireProject, type Store } from "./store.js";

export const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;
const MIN_RECONCILE_INTERVAL_MS = 1_000;
const MAX_RECONCILE_INTERVAL_MS = 86_400_000;

/** The source the bridge records its own observations under. */
const RECONCILE_SOURCE = "reconcile";

export interface ReconcileResult {
  project_id: string;
  /** The commit HEAD pointed at, or null for a repository with no commits or a HEAD that could not be read. */
  head_commit: string | null;
  /** The `git_commit` event this run recorded, or null when HEAD already matched the store. */
  recorded_event_id: number | null;
  status: ProjectStatus;
  briefing_write: BriefingRefresh["write"];
  briefing_write_error: string | null;
}

export interface Reconciler {
  /** Resolves with a run whose HEAD read started after this call. */
  reconcile(projectId: string): Promise<ReconcileResult>;
  /** Like `reconcile`, but nothing waits for it; a failure is logged. */
  trigger(projectId: string): void;
  triggerAll(): void;
  /** Stops the timer and waits for every started run, so the store can be closed after it. */
  close(): Promise<void>;
}

export function parseReconcileInterval(env: NodeJS.ProcessEnv): number {
  const value = env.VOICE_BRIDGE_RECONCILE_INTERVAL_MS;
  if (value === undefined || value === "") return DEFAULT_RECONCILE_INTERVAL_MS;
  const interval = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!(interval >= MIN_RECONCILE_INTERVAL_MS && interval <= MAX_RECONCILE_INTERVAL_MS)) {
    throw new BridgeError(
      "invalid_reconcile_interval",
      `VOICE_BRIDGE_RECONCILE_INTERVAL_MS must be a whole number of milliseconds from ${MIN_RECONCILE_INTERVAL_MS} to ${MAX_RECONCILE_INTERVAL_MS}, not ${JSON.stringify(value)}`,
    );
  }
  return interval;
}

const ignore = () => {};

function shuttingDown(): BridgeError {
  return new BridgeError("shutting_down", "the bridge is shutting down");
}

/** At most one run per project executes, and at most one more waits; later asks join the waiting one. */
interface Slot {
  running: Promise<ReconcileResult>;
  queued: Promise<ReconcileResult> | null;
}

export function createReconciler({ store, readHead, intervalMs }: { store: Store; readHead: HeadReader; intervalMs: number }): Reconciler {
  const slots = new Map<string, Slot>();
  let closed = false;

  /** Compare-then-record runs with no await in between, and the daemon is the store's only writer, so two runs cannot both record. */
  function recordCommit(projectId: string, commit: string): number {
    const highest = store.listWatermarks(projectId).find((row) => row.source === RECONCILE_SOURCE)?.highest_stored ?? 0;
    const sequence = highest + 1;
    return store.ingestEvent({
      project_id: projectId,
      session_id: null,
      source: RECONCILE_SOURCE,
      source_event_id: `${RECONCILE_SOURCE}:${projectId}:${sequence}`,
      source_sequence: sequence,
      type: "git_commit",
      payload: JSON.stringify({ commit }),
      observed_at: new Date().toISOString(),
    }).event_id;
  }

  async function runOnce(projectId: string): Promise<ReconcileResult> {
    const project = requireProject(store, projectId);
    const head = await readHead(project.canonical_path);
    if (closed) throw shuttingDown();

    const recordedBefore = latestRecordedCommit(store.recentCommitEvents(projectId));
    const recordedEventId =
      head.state === "commit" && compareHead(head, recordedBefore) === "moved" ? recordCommit(projectId, head.commit) : null;
    const check = compareHead(head, latestRecordedCommit(store.recentCommitEvents(projectId)));
    // Every admitted event, including the one just recorded, reaches the briefing here, and only through its updater.
    const briefing = refreshBriefing(store, projectId, { head: check });
    if (briefing.write === "failed") console.error(`voice-bridge: VOICE.md not written for ${projectId}: ${briefing.error}`);
    return {
      project_id: projectId,
      head_commit: head.state === "commit" ? head.commit : null,
      recorded_event_id: recordedEventId,
      status: getProjectStatus(store, projectId, { head: check }),
      briefing_write: briefing.write,
      briefing_write_error: briefing.error,
    };
  }

  function launch(projectId: string): Promise<ReconcileResult> {
    const running = runOnce(projectId);
    const slot: Slot = { running, queued: null };
    slots.set(projectId, slot);
    // A queued run replaces the slot itself when it launches.
    const settle = () => {
      if (slot.queued === null) slots.delete(projectId);
    };
    running.then(settle, settle);
    return running;
  }

  function reconcile(projectId: string): Promise<ReconcileResult> {
    if (closed) return Promise.reject(shuttingDown());
    const slot = slots.get(projectId);
    if (!slot) return launch(projectId);
    slot.queued ??= slot.running.then(ignore, ignore).then(() => {
      if (!closed) return launch(projectId);
      slots.delete(projectId);
      throw shuttingDown();
    });
    return slot.queued;
  }

  function trigger(projectId: string): void {
    if (closed) return;
    reconcile(projectId).catch((error: unknown) => {
      if (error instanceof BridgeError && error.code === "shutting_down") return;
      console.error(`voice-bridge: reconciliation failed for ${projectId}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  function triggerAll(): void {
    for (const { project_id } of store.list()) trigger(project_id);
  }

  const timer = setInterval(triggerAll, intervalMs);
  timer.unref();

  return {
    reconcile,
    trigger,
    triggerAll,
    async close() {
      closed = true;
      clearInterval(timer);
      while (slots.size > 0) {
        await Promise.allSettled([...slots.values()].flatMap((slot) => [slot.running, slot.queued ?? slot.running]));
      }
    },
  };
}
