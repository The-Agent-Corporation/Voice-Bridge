import { groupAlive, pidAlive } from "./providerProcess.js";
import type { Store, WorkspaceLease } from "./store.js";

/**
 * Live while its holder or its provider's group still runs. Elapsed time never releases it: a
 * sleeping laptop would make a live writer look expired, which is the second writer the lease prevents.
 */
export function leaseIsLive(lease: WorkspaceLease): boolean {
  return pidAlive(lease.holder_pid) || (lease.provider_pgid !== null && groupAlive(lease.provider_pgid));
}

/**
 * Ends the project's controlled sessions whose host process is gone, as a host killed without cleanup
 * leaves them. Their leases are kept: the provider may outlive its host, and the next `session start`
 * judges that.
 */
export function reconcileControlledSessions(store: Store, projectId: string, at: string): void {
  for (const session of store.listLiveControlledSessions(projectId)) {
    if (!pidAlive(session.holder_pid)) {
      store.endControlledSession(session.session_id, `the bridge session host (pid ${session.holder_pid}) is gone`, at);
    }
  }
}
