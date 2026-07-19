import type { Store } from "./store.js";

/**
 * Complete uninstall erasure that was interrupted after the tokenless durable
 * tombstone was committed. This runs before reconciliation or network traffic;
 * a deleted installation can never be used to construct a host client.
 */
export function completeInterruptedDeletionTombstones(store: Store): string[] {
  const completed: string[] = [];
  for (const workspaceId of store.listDeletionTombstones()) {
    const tombstone = store.getInstallation(workspaceId);
    if (
      tombstone?.status === "deleted" &&
      store.eraseWorkspaceForDeletion(workspaceId, tombstone.generation)
    ) {
      completed.push(workspaceId);
    }
  }
  return completed;
}
