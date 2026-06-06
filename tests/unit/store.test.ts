import { describe, expect, it } from "vitest";
import { createStore } from "../../src/db/store.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";

const ENC_KEY = "test-encryption-key-do-not-use-in-prod";

describe("store", () => {
  it("creates schema", () => {
    const store = createStore(":memory:", { encryptionKey: ENC_KEY });
    const tables = store.tables();
    for (const t of [
      "installations",
      "admin_policies",
      "chat_sessions",
      "chat_messages",
      "pending_confirmations",
      "audit_events",
    ]) {
      expect(tables).toContain(t);
    }
  });

  it("returns undefined for missing policy", () => {
    const store = createStore(":memory:", { encryptionKey: ENC_KEY });
    expect(store.getAdminPolicy("ws-1", "admin-1")).toBeUndefined();
  });

  it("upserts and loads admin policy (default is full access)", () => {
    const store = createStore(":memory:", { encryptionKey: ENC_KEY });
    store.upsertAdminPolicy("ws-1", "admin-1", defaultAdminPolicy());
    const loaded = store.getAdminPolicy("ws-1", "admin-1");
    expect(loaded).toBeDefined();
    expect(loaded?.groups.time_tracking).toBe("read_write");
    expect(loaded?.groups.invoices).toBe("read_write");
  });

  it("upserts an updated admin policy in place", () => {
    const store = createStore(":memory:", { encryptionKey: ENC_KEY });
    store.upsertAdminPolicy("ws-1", "admin-1", defaultAdminPolicy());
    const lowered = defaultAdminPolicy();
    lowered.groups.invoices = "off";
    store.upsertAdminPolicy("ws-1", "admin-1", lowered);
    expect(store.getAdminPolicy("ws-1", "admin-1")?.groups.invoices).toBe("off");
  });

  it("scopes policy per workspace + admin", () => {
    const store = createStore(":memory:", { encryptionKey: ENC_KEY });
    store.upsertAdminPolicy("ws-1", "admin-1", defaultAdminPolicy());
    expect(store.getAdminPolicy("ws-1", "admin-2")).toBeUndefined();
    expect(store.getAdminPolicy("ws-2", "admin-1")).toBeUndefined();
  });

  it("upserts and loads installation, encrypting the token at rest", () => {
    const store = createStore(":memory:", { encryptionKey: ENC_KEY });
    store.saveInstallation({
      workspaceId: "ws-1",
      addonId: "addon-1",
      addonUserId: "addon-user-1",
      addonToken: "secret-addon-token",
      apiUrl: "https://api.clockify.me/api/v1",
      backendUrl: "https://api.clockify.me",
      installedByUserId: "owner-1",
    });
    const inst = store.getInstallation("ws-1");
    expect(inst).toBeDefined();
    expect(inst?.addonToken).toBe("secret-addon-token");
    expect(inst?.status).toBe("active");
    expect(inst?.addonId).toBe("addon-1");

    // The raw stored value must NOT contain the plaintext token.
    const raw = store.rawAddonTokenForTest("ws-1");
    expect(raw).toBeDefined();
    expect(raw).not.toContain("secret-addon-token");
    expect(raw?.startsWith("v1:")).toBe(true);
  });

  it("updates an existing installation in place", () => {
    const store = createStore(":memory:", { encryptionKey: ENC_KEY });
    store.saveInstallation({
      workspaceId: "ws-1",
      addonId: "addon-1",
      addonUserId: "addon-user-1",
      addonToken: "token-a",
    });
    store.saveInstallation({
      workspaceId: "ws-1",
      addonId: "addon-1",
      addonUserId: "addon-user-1",
      addonToken: "token-b",
      status: "inactive",
    });
    const inst = store.getInstallation("ws-1");
    expect(inst?.addonToken).toBe("token-b");
    expect(inst?.status).toBe("inactive");
  });
});
