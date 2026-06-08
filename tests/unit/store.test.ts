import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createStore } from "../../src/db/store.js";
import {
  FEATURE_GROUPS,
  adminPolicySchema,
  defaultAdminPolicy,
} from "../../src/harness/permissions.js";

const ENC_KEY = "test-encryption-key-do-not-use-in-prod";

const tempDirs: string[] = [];
function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "aiassist-store-"));
  tempDirs.push(dir);
  return join(dir, "test.db");
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

  it("back-fills feature groups added after a policy was stored (defaults to read_write)", () => {
    const dbPath = tempDbPath();
    // First create + close the store so the schema exists, then write a LEGACY
    // policy row directly (predating custom_fields/approvals/audit_log).
    createStore(dbPath, { encryptionKey: ENC_KEY }).close();

    const legacyGroups: Record<string, string> = {
      time_tracking: "read_write",
      work_structure: "read_write",
      reports: "read_write",
      invoices: "off", // a non-default value must survive the migration
      expenses: "read",
      users_groups: "read_write",
      time_off_approvals: "read_write",
      scheduling: "read_write",
      webhooks: "read_write",
      workspace_settings: "read_write",
    };
    const raw = new Database(dbPath);
    raw
      .prepare(
        `INSERT INTO admin_policies (id, workspace_id, admin_user_id, policy_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), "ws-1", "admin-1", JSON.stringify({ version: 1, groups: legacyGroups }), "t", "t");
    raw.close();

    const store = createStore(dbPath, { encryptionKey: ENC_KEY });
    const loaded = store.getAdminPolicy("ws-1", "admin-1");
    expect(loaded).toBeDefined();
    // New groups default to read_write (the locked full-access default).
    expect(loaded?.groups.custom_fields).toBe("read_write");
    expect(loaded?.groups.approvals).toBe("read_write");
    expect(loaded?.groups.audit_log).toBe("read_write");
    // Existing non-default values are preserved through the migration.
    expect(loaded?.groups.invoices).toBe("off");
    expect(loaded?.groups.expenses).toBe("read");
    // And the result satisfies the strict schema with every current group present.
    expect(() => adminPolicySchema.parse(loaded)).not.toThrow();
    expect(Object.keys(loaded?.groups ?? {}).sort()).toEqual([...FEATURE_GROUPS].sort());
    store.close();
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

  it("captures the reports host via updateInstallationEnv without touching the token", () => {
    const store = createStore(":memory:", { encryptionKey: ENC_KEY });
    store.saveInstallation({
      workspaceId: "ws-1",
      addonId: "addon-1",
      addonUserId: "addon-user-1",
      addonToken: "secret-token",
      apiUrl: "https://developer.clockify.me/api",
    });
    // The lifecycle/install token omitted reportsUrl; the component-load user
    // token supplies it. Only provided fields change; the token is untouched.
    store.updateInstallationEnv("ws-1", {
      reportsUrl: "https://developer.clockify.me/report",
    });
    const inst = store.getInstallation("ws-1");
    expect(inst?.reportsUrl).toBe("https://developer.clockify.me/report");
    expect(inst?.apiUrl).toBe("https://developer.clockify.me/api");
    expect(inst?.addonToken).toBe("secret-token");
  });
});
