import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createStore, type TestStore } from "../../src/db/store.js";
import { createPendingConfirmation } from "../../src/harness/confirmations.js";
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
    const store = createStore(":memory:", { encryptionKey: ENC_KEY }) as TestStore;
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
    const store = createStore(":memory:", { encryptionKey: ENC_KEY }) as TestStore;
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

  it("uses an index seek for the typed-consent countPendingConfirmations query (no full table scan)", () => {
    const dbPath = tempDbPath();
    // Build the schema through migrate(), then open the same DB file directly to
    // ask SQLite how it would run the exact countPendingConfirmations query on the
    // TYPED_CONSENT safety hot path (run on every "yes"/"confirm"-shaped message).
    createStore(dbPath, { encryptionKey: ENC_KEY }).close();

    const raw = new Database(dbPath);
    const plan = raw
      .prepare(
        "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM pending_confirmations WHERE session_id = ? AND status = 'pending' AND expires_at > ?",
      )
      .all("session-1", "2026-01-01T00:00:00.000Z") as Array<{ detail: string }>;
    raw.close();

    const details = plan.map((p) => p.detail).join(" | ");
    // Without a session_id-leading index this is `SCAN pending_confirmations`.
    expect(details).toMatch(/USING (COVERING )?INDEX/);
    expect(details).not.toMatch(/SCAN pending_confirmations/);
  });

  it("loads a pending confirmation with corrupt agent_state_json as agentState undefined (malformed => no resume below the schema layer too)", () => {
    const dbPath = tempDbPath();
    // Persist a real pending confirmation carrying a valid agentState, then close.
    const seed = createStore(dbPath, { encryptionKey: ENC_KEY });
    const session = seed.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    const created = createPendingConfirmation({
      sessionId: session.id,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      risk: ["destructive"],
      preview: { summary: "delete a thing" },
      operation: {
        actionName: "projects_delete",
        featureGroup: "work_structure",
        risks: ["destructive"],
        payload: {},
      },
      sessionSecret: "s",
      agentState: { transcript: [{ role: "user", content: "hi" }], call: { id: "r1", name: "x" } },
    });
    seed.savePendingConfirmation(created.record);
    seed.close();

    // Simulate a row whose agent_state_json was truncated at rest (crash mid-write,
    // disk corruption, a partial migration). JSON.parse would throw on this value.
    const raw = new Database(dbPath);
    raw
      .prepare("UPDATE pending_confirmations SET agent_state_json = ? WHERE id = ?")
      .run("{truncated", created.previewId);
    raw.close();

    // The confirm/cancel routes call getPendingConfirmation with no try/catch, so a
    // raw SyntaxError here would escape as an unhandled rejection and leave the
    // preview permanently unconfirmable AND uncancellable. Per the agentic-loop
    // invariant ("agent_state_json ... malformed => no resume"), a corrupt stored
    // state must degrade to agentState undefined: the confirm then commits the
    // receipt with no resume. The strict parses (risk/preview/operation) are
    // untouched and still load.
    const store = createStore(dbPath, { encryptionKey: ENC_KEY });
    const loaded = store.getPendingConfirmation(created.previewId);
    expect(loaded).toBeDefined();
    expect(loaded?.agentState).toBeUndefined();
    expect(loaded?.risk).toEqual(["destructive"]);
    expect(loaded?.preview).toEqual({ summary: "delete a thing" });
    store.close();
  });
});
