import { describe, expect, it } from "vitest";
import { completeInterruptedDeletionTombstones } from "../../src/db/deletion-tombstones.js";
import { createStore } from "../../src/db/store.js";

describe("startup deletion tombstones", () => {
  it("finishes an uninstall interrupted after token wipe and before workspace erasure", () => {
    const store = createStore(":memory:", { encryptionKey: "test-key" });
    store.saveInstallation({
      workspaceId: "ws-deleting",
      addonId: "addon",
      addonUserId: "user",
      addonToken: "secret",
    });
    const session = store.createSession({ workspaceId: "ws-deleting", adminUserId: "admin" });
    store.addMessage({
      sessionId: session.id,
      workspaceId: "ws-deleting",
      adminUserId: "admin",
      role: "user",
      content: "erase me",
    });
    store.tombstoneInstallation("ws-deleting");

    expect(completeInterruptedDeletionTombstones(store)).toEqual(["ws-deleting"]);
    expect(store.getInstallation("ws-deleting")).toBeUndefined();
    expect(store.getRecentMessages(session.id, 10)).toEqual([]);
    expect(completeInterruptedDeletionTombstones(store)).toEqual([]);
    store.close();
  });

  it("does not erase an active replacement from a stale startup tombstone scan", () => {
    const store = createStore(":memory:", { encryptionKey: "test-key" });
    store.saveInstallation({
      workspaceId: "ws-replaced",
      addonId: "addon",
      addonUserId: "user",
      addonToken: "replacement-token",
    });
    let eraseAttempted = false;
    const staleScan = {
      ...store,
      listDeletionTombstones: () => ["ws-replaced"],
      eraseWorkspaceForDeletion() {
        eraseAttempted = true;
        return undefined;
      },
    };

    expect(completeInterruptedDeletionTombstones(staleScan)).toEqual([]);
    expect(eraseAttempted).toBe(false);
    expect(store.getInstallation("ws-replaced")).toMatchObject({
      status: "active",
      addonToken: "replacement-token",
    });
    store.close();
  });
});
