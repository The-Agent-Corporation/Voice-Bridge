import { readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import path from "node:path";
import { resolveProviderHomes } from "./adapters/homes.js";
import { writeFileAtomic } from "./atomicFile.js";
import { resolveBuildId } from "./buildId.js";
import { ensureDataDir } from "./dataDir.js";
import { readHead as readGitHead, type HeadReader } from "./head.js";
import { createReconciler, parseReconcileInterval } from "./reconcile.js";
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
  close(): Promise<void>;
}

export interface StartOptions {
  dataDir: string;
  port: number;
  env?: NodeJS.ProcessEnv;
  /** Tests replace the HEAD read to hold a reconciliation open; the daemon always reads Git. */
  readHead?: HeadReader;
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

export async function startBridge({ dataDir, port, env = process.env, readHead = readGitHead }: StartOptions): Promise<RunningBridge> {
  const intervalMs = parseReconcileInterval(env);
  ensureDataDir(dataDir);
  const token = ensureClientToken(dataDir);
  const buildId = resolveBuildId(env);
  const store = openStore(dataDir);
  const reconciler = createReconciler({ store, readHead, intervalMs });
  const server = createBridgeServer({ store, token, buildId, providerHomes: resolveProviderHomes(env), reconciler, readHead });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, LISTEN_ADDRESS, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await reconciler.close();
    store.close();
    throw error;
  }

  const address = server.address() as AddressInfo;
  writeDaemonInfo(dataDir, { port: address.port, pid: process.pid });
  // In the background, so the daemon answers while a crash or a missed hook is being repaired.
  reconciler.triggerAll();

  return {
    server,
    address: address.address,
    port: address.port,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await reconciler.close();
      store.close();
      removeOwnDaemonInfo(dataDir);
    },
  };
}
