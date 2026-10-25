import { refreshBriefing, type BriefingRefresh } from "./briefingFile.js";
import { BridgeError, errorMessage } from "./errors.js";
import { readHead, type HeadRead } from "./git.js";
import { getProjectStatus, headMoved, latestRecordedCommit, type ProjectStatus } from "./status.js";
import type { HeadObservation, Project, Store } from "./store.js";

export const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;
/** The `source` of the `git_commit` events reconciliation records. */
export const RECONCILE_SOURCE = "reconcile";

export type HeadReader = (cwd: string) => Promise<HeadRead>;

export interface ReconcileResult {
  project_id: string;
  head: string | null;
  head_error: string | null;
  /** The `git_commit` event this pass recorded, or null when HEAD was already recorded. */
  recorded_event_id: number | null;
  status: ProjectStatus;
  briefing_write: BriefingRefresh["write"];
  briefing_write_error: string | null;
}

/**
 * Marks the project's stored events processed, then rewrites its briefing from them. A crash between
 * the two leaves the store consistent and only the file stale; startup reconciliation rewrites every
 * briefing, so that window closes on restart.
 */
export function processEvents(store: Store, projectId: string): BriefingRefresh {
  store.markEventsProcessed(projectId);
  return refreshBriefing(store, projectId);
}

/**
 * Compares each project's Git HEAD with its newest recorded commit, records a `git_commit` from
 * `RECONCILE_SOURCE` when they differ, processes events a crash left unprocessed and rewrites the
 * briefing. It runs only `git rev-parse` (read-only) and writes to the repository only through the
 * briefing file.
 *
 * Passes for one project run one after another, and everything after the HEAD read is synchronous in
 * the daemon, the only event writer, so the compare-and-record cannot interleave with another write:
 * a second pass for the same HEAD records nothing.
 */
export class Reconciler {
  readonly #store: Store;
  readonly #readHead: HeadReader;
  readonly #intervalMs: number;
  /** The latest pass per project; each pass starts after the one before it settles. */
  readonly #passes = new Map<string, Promise<ReconcileResult>>();
  readonly #observing = new Set<Promise<unknown>>();
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;

  constructor(store: Store, options: { readHead?: HeadReader; intervalMs?: number } = {}) {
    this.#store = store;
    this.#readHead = options.readHead ?? readHead;
    this.#intervalMs = options.intervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
  }

  /** Reads HEAD and stores it as the project's observation, without recording or processing anything. */
  async observe(projectId: string): Promise<void> {
    const reading = this.#observeHead(this.#project(projectId));
    this.#observing.add(reading);
    try {
      await reading;
    } finally {
      this.#observing.delete(reading);
    }
  }

  reconcile(projectId: string): Promise<ReconcileResult> {
    if (this.#stopped) return Promise.reject(closing());
    const previous = this.#passes.get(projectId) ?? Promise.resolve();
    const pass = previous.catch(() => {}).then(() => this.#pass(projectId));
    this.#passes.set(projectId, pass);
    const forget = () => {
      if (this.#passes.get(projectId) === pass) this.#passes.delete(projectId);
    };
    pass.then(forget, forget);
    return pass;
  }

  /** Reconciles every project, then repeats every interval after each round ends. Never rejects. */
  async start(): Promise<void> {
    await this.#reconcileAll();
    this.#schedule();
  }

  /** Waits for passes in progress; afterwards every call refuses with `bridge_closing`. */
  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    await Promise.allSettled([...this.#passes.values(), ...this.#observing]);
  }

  #schedule(): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => void this.#reconcileAll().then(() => this.#schedule()), this.#intervalMs);
    this.#timer.unref();
  }

  async #reconcileAll(): Promise<void> {
    if (this.#stopped) return;
    for (const { project_id } of this.#store.list()) {
      if (this.#stopped) return;
      try {
        await this.reconcile(project_id);
      } catch (error) {
        console.error(`voice-bridge: reconcile failed for ${project_id}: ${errorMessage(error)}`);
      }
    }
  }

  #project(projectId: string): Project {
    if (this.#stopped) throw closing();
    const project = this.#store.getById(projectId);
    if (!project) throw new BridgeError("project_not_found", `no project registered with id ${projectId}`);
    return project;
  }

  /** Stamped before the read, so a slow read that finishes after a newer one is not stored over it. */
  async #observeHead(project: Project): Promise<HeadObservation> {
    const observedAt = new Date().toISOString();
    const read = await this.#readHead(project.canonical_path);
    const observation: HeadObservation = {
      project_id: project.project_id,
      head: read.ok ? read.head : null,
      error: read.ok ? null : read.detail,
      observed_at: observedAt,
    };
    this.#store.recordHead(observation);
    return observation;
  }

  async #pass(projectId: string): Promise<ReconcileResult> {
    const store = this.#store;
    const observation = await this.#observeHead(this.#project(projectId));
    // Nothing below awaits: see the class comment.
    store.markEventsProcessed(projectId);
    let recordedEventId: number | null = null;
    if (headMoved(observation, latestRecordedCommit(store.recentBriefingEvents(projectId)))) {
      recordedEventId = this.#recordCommit(projectId, observation);
      store.markEventsProcessed(projectId);
    }
    let briefing: Pick<BriefingRefresh, "write" | "error">;
    try {
      briefing = refreshBriefing(store, projectId);
    } catch (error) {
      briefing = { write: "failed", error: errorMessage(error) };
    }
    if (briefing.write === "failed") console.error(`voice-bridge: VOICE.md not written for ${projectId}: ${briefing.error}`);
    return {
      project_id: projectId,
      head: observation.head,
      head_error: observation.error,
      recorded_event_id: recordedEventId,
      status: getProjectStatus(store, projectId),
      briefing_write: briefing.write,
      briefing_write_error: briefing.error,
    };
  }

  /**
   * The id carries the sequence, not the hash, so HEAD moving back to an earlier commit is recorded
   * again rather than taken for a duplicate.
   */
  #recordCommit(projectId: string, observation: HeadObservation): number {
    const reconcileRow = this.#store.listWatermarks(projectId).find((row) => row.source === RECONCILE_SOURCE);
    const sequence = (reconcileRow?.highest_stored ?? 0) + 1;
    return this.#store.ingestEvent({
      project_id: projectId,
      session_id: null,
      source: RECONCILE_SOURCE,
      source_event_id: `${projectId}:${sequence}`,
      source_sequence: sequence,
      type: "git_commit",
      payload: JSON.stringify({ commit: observation.head }),
      observed_at: observation.observed_at,
    }).event_id;
  }
}

function closing(): BridgeError {
  return new BridgeError("bridge_closing", "the bridge is shutting down");
}
