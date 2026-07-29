import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStore, type Store } from "../../src/db/store.js";

/**
 * Closure-plan PR 11 (F15): the purpose-built maintenance retirement refuses
 * anything but the exact operator-restated row, retires the token fingerprint
 * so a delayed signed callback can never replay it, and never erases data.
 */
const WORKSPACE_ID = "64ad1305c701cc5be7c26fe4";

let store: Store;

beforeEach(() => {
  store = createStore(":memory:", { encryptionKey: "maintenance-test-key" });
  const saved = store.saveInstallation({
    workspaceId: WORKSPACE_ID,
    addonId: "69950af22720c2992bab57f7",
    addonUserId: "5f0a1305c701cc5be7c26aa1",
    addonToken: "stale-v1-token",
    apiUrl: "https://api.clockify.me",
    status: "active",
    lifecycleIssuedAt: 1_700_000_000,
  });
  expect(saved.outcome).toBe("applied");
});

afterEach(() => store.close());

describe("retireInstallationForMaintenance (F15)", () => {
  it("refuses a mismatched generation, status, or unknown workspace", () => {
    expect(store.retireInstallationForMaintenance({
      workspaceId: WORKSPACE_ID,
      expectedGeneration: 7,
      expectedStatus: "active",
    })).toEqual({ outcome: "generation_mismatch", actualGeneration: 1 });

    expect(store.retireInstallationForMaintenance({
      workspaceId: WORKSPACE_ID,
      expectedGeneration: 1,
      expectedStatus: "inactive",
    })).toEqual({ outcome: "status_mismatch", actualStatus: "active" });

    expect(store.retireInstallationForMaintenance({
      workspaceId: "64ad1305c701cc5be7c26aa9",
      expectedGeneration: 1,
      expectedStatus: "active",
    })).toEqual({ outcome: "not_found" });

    // Refusals change nothing.
    expect(store.getInstallation(WORKSPACE_ID)).toMatchObject({
      status: "active",
      generation: 1,
      addonToken: "stale-v1-token",
    });
  });

  it("retires the exact row: inactive, token wiped, generation bumped, data intact", () => {
    store.addAuditEvent({
      workspaceId: WORKSPACE_ID,
      adminUserId: "admin-1",
      actionName: "clockify_projects_list",
      risk: ["read"],
      receipt: { ok: true, action: "clockify_projects_list" },
    });

    const result = store.retireInstallationForMaintenance({
      workspaceId: WORKSPACE_ID,
      expectedGeneration: 1,
      expectedStatus: "active",
    });
    expect(result).toEqual({ outcome: "retired", generation: 2, tokenFingerprintRetired: true });

    const row = store.getInstallation(WORKSPACE_ID);
    expect(row).toMatchObject({ status: "inactive", generation: 2, addonToken: "" });
    // A maintenance retirement is NOT an uninstall: workspace data survives.
    expect(store.listActionOutcomes(WORKSPACE_ID, "admin-1")).toHaveLength(1);
    expect(store.listDeletionTombstones()).toEqual([]);
  });

  it("a delayed signed INSTALLED callback replaying the retired token is denied", () => {
    expect(store.retireInstallationForMaintenance({
      workspaceId: WORKSPACE_ID,
      expectedGeneration: 1,
      expectedStatus: "active",
    })).toMatchObject({ outcome: "retired" });

    const replay = store.saveInstallation({
      workspaceId: WORKSPACE_ID,
      addonId: "69950af22720c2992bab57f7",
      addonUserId: "5f0a1305c701cc5be7c26aa1",
      addonToken: "stale-v1-token",
      status: "active",
      lifecycleIssuedAt: 1_800_000_000,
    });
    expect(replay.outcome).toBe("retired_token_replay");
    expect(store.getInstallation(WORKSPACE_ID)).toMatchObject({ status: "inactive" });

    // A genuinely NEW installation token (a real reinstall) still works.
    const reinstall = store.saveInstallation({
      workspaceId: WORKSPACE_ID,
      addonId: "69950af22720c2992bab57f7",
      addonUserId: "5f0a1305c701cc5be7c26aa1",
      addonToken: "fresh-reinstall-token",
      status: "active",
      lifecycleIssuedAt: 1_800_000_001,
    });
    expect(reinstall.outcome).toBe("applied");
    expect(store.getInstallation(WORKSPACE_ID)).toMatchObject({
      status: "active",
      addonToken: "fresh-reinstall-token",
    });
  });
});
