import { readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import path from "node:path";
import { resolveProviderHomes } from "./adapters/homes.js";
import { writeFileAtomic } from "./atomicFile.js";
import { resolveBuildId } from "./buildId.js";
import { ensureDataDir } from "./dataDir.js";
import { BridgeError } from "./errors.js";
import { DEFAULT_RECONCILE_INTERVAL_MS, Reconciler } from "./reconcile.js";
import { createBridgeServer } from "./server.js";
import { openStore } from "./store.js";
import { ensureClientToken } from "./token.js";

export const LISTEN_ADDRESS = "127.0.0.1";
export const DAEMON_FILE = "daemon.json";

export interface DaemonInfo {
  port: number;
  pid: number;
}

export interface RunningBridge {
  server: Server;
  address: string;
  port: number;
  /** The reconcile pass over every project that starts once the server listens; never rejects. */
  startupReconciliation: Promise<void>;
  close(): Promise<void>;
}

export interface StartOptions {
  dataDir: string;
  port: number;
  env?: NodeJS.ProcessEnv;
}

export function daemonInfoPath(dataDir: string): string {
  return path.join(dataDir, DAEMON_FILE);
}

/** Written so the CLI can find a daemon whose port was chosen at start. */
function writeDaemonInfo(dataDir: string, info: DaemonInfo): void {
  writeFileAtomic(daemonInfoPath(dataDir), JSON.stringify(info), { mode: 0o600 });
}

function removeOwnDaemonInfo(dataDir: string): void {
  try {
    const info = JSON.parse(readFileSync(daemonInfoPath(dataDir), "utf8")) as Partial<DaemonInfo>;
    if (info.pid === process.pid) rmSync(daemonInfoPath(dataDir));
  } catch {
    // Absent or replaced by another daemon: nothing of ours to remove.
  }
}

function reconcileInterval(env: NodeJS.ProcessEnv): number {
  const value = env.VOICE_BRIDGE_RECONCILE_INTERVAL_MS;
  if (value === undefined) return DEFAULT_RECONCILE_INTERVAL_MS;
  const ms = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(ms) || ms < 1) {
    throw new BridgeError("invalid_reconcile_interval", `VOICE_BRIDGE_RECONCILE_INTERVAL_MS must be a whole number of milliseconds of at least 1, not ${JSON.stringify(value)}`);
  }
  return ms;
}

export async function startBridge({ dataDir, port, env = process.env }: StartOptions): Promise<RunningBridge> {
  const intervalMs = reconcileInterval(env);
  ensureDataDir(dataDir);
  const token = ensureClientToken(dataDir);
  const buildId = resolveBuildId(env);
  const store = openStore(dataDir);
  const reconciler = new Reconciler(store, { intervalMs });
  const server = createBridgeServer({ store, token, buildId, providerHomes: resolveProviderHomes(env), reconciler });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, LISTEN_ADDRESS, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    store.close();
    throw error;
  }

  const address = server.address() as AddressInfo;
  writeDaemonInfo(dataDir, { port: address.port, pid: process.pid });
  const startupReconciliation = reconciler.start();

  return {
    server,
    address: address.address,
    port: address.port,
    startupReconciliation,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      // Passes in progress write to the store, so they finish before it closes.
      await reconciler.stop();
      store.close();
      removeOwnDaemonInfo(dataDir);
    },
  };
}
