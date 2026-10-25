import type { Session } from "./providerProcess.js";

export type Outcome =
  | { kind: "result"; value: unknown }
  | { kind: "error"; code: unknown; message: unknown }
  | { kind: "timeout"; ms: number }
  | { kind: "closed" };

export interface Notification {
  method: string;
  params: unknown;
}

/** Reads a nested field of untyped JSON, e.g. `field(result, "thread", "id")`. */
export function field(value: unknown, ...keys: string[]): unknown {
  for (const key of keys) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

export function describe(method: string, outcome: Outcome): string {
  switch (outcome.kind) {
    case "result":
      return `${method} → result`;
    case "error":
      return `${method} → error ${String(outcome.code)}: ${String(outcome.message)}`;
    case "timeout":
      return `${method} → no response within ${outcome.ms} ms`;
    case "closed":
      return `${method} → stdout closed before a response`;
  }
}

/**
 * A minimal line-delimited JSON-RPC client. Requests the server sends to us (approvals,
 * `item/tool/requestUserInput`) are recorded and never answered, so the bridge never
 * fabricates an approval.
 */
export class RpcClient {
  private nextId = 1;
  private isClosed = false;
  private readonly pending = new Map<number, (outcome: Outcome) => void>();
  private readonly waiters = new Set<() => void>();
  private readonly notificationListeners: ((notification: Notification) => void)[] = [];
  private readonly serverRequestListeners: ((method: string) => void)[] = [];
  private readonly closedListeners: (() => void)[] = [];
  readonly notifications: Notification[] = [];
  readonly serverRequests: string[] = [];
  readonly strayLines: string[] = [];
  private readonly deadline: number;
  private history = true;

  /** With `deadlineMs`, no wait outlasts that long from now. */
  constructor(private readonly session: Session, { deadlineMs }: { deadlineMs?: number } = {}) {
    this.deadline = deadlineMs === undefined ? Infinity : Date.now() + deadlineMs;
    session.onLine((line) => this.receive(line));
    session.onClosed(() => {
      this.isClosed = true;
      for (const settle of this.pending.values()) settle({ kind: "closed" });
      this.pending.clear();
      for (const listener of this.closedListeners) listener();
    });
  }

  /** Drops what was kept and keeps nothing more, so a long-lived session does not grow without bound. */
  forgetHistory(): void {
    this.history = false;
    this.notifications.length = 0;
    this.serverRequests.length = 0;
    this.strayLines.length = 0;
  }

  get closed(): boolean {
    return this.isClosed;
  }

  onNotification(listener: (notification: Notification) => void): void {
    this.notificationListeners.push(listener);
  }

  onServerRequest(listener: (method: string) => void): void {
    this.serverRequestListeners.push(listener);
  }

  onClosed(listener: () => void): void {
    if (this.isClosed) listener();
    else this.closedListeners.push(listener);
  }

  private receive(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      if (this.history && line.trim() !== "") this.strayLines.push(line.trim());
      return;
    }
    const id = field(message, "id");
    const method = field(message, "method");
    if (typeof method === "string" && id !== undefined) {
      if (this.history) this.serverRequests.push(method);
      for (const listener of this.serverRequestListeners) listener(method);
    } else if (typeof method === "string") {
      const notification = { method, params: field(message, "params") };
      if (this.history) this.notifications.push(notification);
      for (const wake of this.waiters) wake();
      for (const listener of this.notificationListeners) listener(notification);
    } else if (typeof id === "number" && this.pending.has(id)) {
      const settle = this.pending.get(id)!;
      this.pending.delete(id);
      const error = field(message, "error");
      settle(
        error === undefined
          ? { kind: "result", value: field(message, "result") }
          : { kind: "error", code: field(error, "code"), message: field(error, "message") },
      );
    }
  }

  private budget(ms: number): number {
    return Math.max(0, Math.min(ms, this.deadline - Date.now()));
  }

  /** Without `timeoutMs` (and no deadline) it waits for the reply or for stdout to close. */
  request(method: string, params: unknown, timeoutMs?: number): Promise<Outcome> {
    if (this.isClosed) return Promise.resolve({ kind: "closed" });
    const id = this.nextId++;
    const ms = this.budget(timeoutMs ?? Infinity);
    return new Promise((resolve) => {
      const timer =
        ms === Infinity
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id);
              resolve({ kind: "timeout", ms });
            }, ms);
      this.pending.set(id, (outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      });
      this.session.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.session.write({ jsonrpc: "2.0", method, params });
  }

  /** Resolves true once a notification matching `matches` has arrived, false after `ms`. */
  waitFor(matches: (notification: Notification) => boolean, ms: number): Promise<boolean> {
    if (this.notifications.some(matches)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const wake = () => {
        if (!this.notifications.some(matches)) return;
        finish(true);
      };
      const finish = (seen: boolean) => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        resolve(seen);
      };
      const timer = setTimeout(() => finish(false), this.budget(ms));
      this.waiters.add(wake);
    });
  }
}
