import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createStore, type TestStore } from "../../src/db/store.js";
import { migrate } from "../../src/db/schema.js";
import { createPendingConfirmation } from "../../src/harness/confirmations.js";
import { successReceipt } from "../../src/harness/receipts.js";
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

  it("round-trips turn telemetry incl. cached prompt tokens (NULL when the backend reported none)", () => {
    const store = createStore(":memory:", { encryptionKey: ENC_KEY });
    store.saveInstallation({ workspaceId: "ws-1", addonId: "a", addonUserId: "u", addonToken: "tok", status: "active" });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    // A turn whose backend reported a prompt-cache hit…
    store.recordTurnTelemetry({
      sessionId: session.id, workspaceId: "ws-1", adminUserId: "admin-1", kind: "chat",
      modelCalls: 2, promptTokens: 1400, completionTokens: 30, cachedPromptTokens: 1024, turnMs: 20, modelMs: 12,
    });
    // …and one whose backend reported no cache info at all.
    store.recordTurnTelemetry({
      sessionId: session.id, workspaceId: "ws-1", adminUserId: "admin-1", kind: "resume",
      modelCalls: 1, promptTokens: 900, completionTokens: 10, turnMs: 8, modelMs: 5,
    });
    const rows = store.listTurnTelemetry("ws-1", "admin-1");
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.kind === "chat")?.cachedPromptTokens).toBe(1024);
    expect(rows.find((r) => r.kind === "resume")?.cachedPromptTokens).toBeUndefined(); // NULL ⇒ undefined
  });

  it("sets a non-zero busy_timeout so concurrent writers retry instead of an immediate SQLITE_BUSY 500", () => {
    // WAL is on, but better-sqlite3 defaults busy_timeout to 0 — a write-lock
    // collision (two concurrent admins on the Railway /data volume) then
    // surfaces as an instant SQLITE_BUSY → 500. A non-zero timeout makes the
    // second writer wait-and-retry within the window instead.
    const db = new Database(":memory:");
    migrate(db);
    expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
    db.close();
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

  it("eraseWorkspace deletes all workspace-scoped data + tombstones the token, leaving other workspaces intact", () => {
    const store = createStore(":memory:", { encryptionKey: ENC_KEY }) as TestStore;
    const seed = (ws: string) => {
      store.saveInstallation({ workspaceId: ws, addonId: "a", addonUserId: "u", addonToken: `tok-${ws}`, status: "active" });
      store.upsertAdminPolicy(ws, "admin-1", defaultAdminPolicy());
      const session = store.createSession({ workspaceId: ws, adminUserId: "admin-1" });
      store.addMessage({ sessionId: session.id, workspaceId: ws, adminUserId: "admin-1", role: "user", content: "hi" });
      store.addAuditEvent({
        workspaceId: ws,
        adminUserId: "admin-1",
        actionName: "clockify_tags_create",
        risk: ["safe_write"],
        receipt: successReceipt({ action: "clockify_tags_create" }),
      });
      const pc = createPendingConfirmation({
        sessionId: session.id,
        workspaceId: ws,
        adminUserId: "admin-1",
        risk: ["destructive"],
        preview: { summary: "x" },
        operation: { actionName: "projects_delete", featureGroup: "work_structure", risks: ["destructive"], payload: {} },
        sessionSecret: "s",
      });
      store.savePendingConfirmation(pc.record);
      store.recordUndoable({ sessionId: session.id, workspaceId: ws, adminUserId: "admin-1", actionName: "x", reversal: [] });
      store.recordTurnTelemetry({ sessionId: session.id, workspaceId: ws, adminUserId: "admin-1", kind: "chat", modelCalls: 1, turnMs: 10, modelMs: 5 });
      return session;
    };
    const s1 = seed("ws-1");
    const s2 = seed("ws-2");

    const counts = store.eraseWorkspace("ws-1");
    expect(counts.chatMessages).toBe(1);
    expect(counts.auditEvents).toBe(1);
    expect(counts.pendingConfirmations).toBe(1);
    expect(counts.undoRecords).toBe(1);
    expect(counts.turnTelemetry).toBe(1);
    expect(counts.chatSessions).toBe(1);
    expect(counts.adminPolicies).toBe(1);

    // ws-1 fully erased; the install is tombstoned with the token wiped (no decrypt throw).
    const inst1 = store.getInstallation("ws-1");
    expect(inst1?.status).toBe("deleted");
    expect(inst1?.addonToken).toBe(""); // token wiped to an empty secret, still decryptable
    expect(store.getRecentMessages(s1.id, 10)).toHaveLength(0);
    expect(store.listActionOutcomes("ws-1", "admin-1")).toHaveLength(0);
    expect(store.getAdminPolicy("ws-1", "admin-1")).toBeUndefined();
    expect(store.getSession(s1.id)).toBeUndefined();
    expect(store.listTurnTelemetry("ws-1", "admin-1")).toHaveLength(0);

    // ws-2 is completely untouched.
    expect(store.getInstallation("ws-2")?.addonToken).toBe("tok-ws-2");
    expect(store.getInstallation("ws-2")?.status).toBe("active");
    expect(store.getRecentMessages(s2.id, 10)).toHaveLength(1);
    expect(store.listActionOutcomes("ws-2", "admin-1")).toHaveLength(1);
    expect(store.getAdminPolicy("ws-2", "admin-1")).toBeDefined();
    expect(store.getSession(s2.id)).toBeDefined();
    store.close();
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

  it("listPendingConfirmations returns only this session's LIVE pendings, oldest-first", () => {
    const store = createStore(":memory:", { encryptionKey: ENC_KEY });
    const now = new Date("2026-06-06T10:00:00.000Z");
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    const other = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    const make = (sessionId: string, nowAt: Date) =>
      createPendingConfirmation({
        sessionId,
        workspaceId: "ws-1",
        adminUserId: "admin-1",
        risk: ["destructive"],
        preview: { summary: "x" },
        operation: { actionName: "a", featureGroup: "work_structure", risks: ["destructive"], payload: {} },
        sessionSecret: "s",
        now: nowAt,
      });
    const first = make(session.id, new Date(now.getTime() - 60_000));
    const second = make(session.id, now);
    const foreign = make(other.id, now);
    const expired = make(session.id, new Date(now.getTime() - 10 * 60_000)); // 5-min TTL long past
    for (const c of [second, first, foreign, expired]) store.savePendingConfirmation(c.record);
    const cancelled = make(session.id, now);
    store.savePendingConfirmation(cancelled.record);
    store.cancelConfirmation(cancelled.previewId);

    const live = store.listPendingConfirmations(session.id, now.toISOString());
    expect(live.map((r) => r.id)).toEqual([first.previewId, second.previewId]);
    store.close();
  });

  it("updateConfirmationNonceHash swaps the hash only while still pending (loser of a race gets false)", () => {
    const store = createStore(":memory:", { encryptionKey: ENC_KEY });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    const created = createPendingConfirmation({
      sessionId: session.id,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      risk: ["destructive"],
      preview: { summary: "x" },
      operation: { actionName: "a", featureGroup: "work_structure", risks: ["destructive"], payload: {} },
      sessionSecret: "s",
    });
    store.savePendingConfirmation(created.record);

    expect(store.updateConfirmationNonceHash(created.previewId, "new-hash")).toBe(true);
    expect(store.getPendingConfirmation(created.previewId)?.nonceHash).toBe("new-hash");

    store.markConfirmationUsed(created.previewId);
    expect(store.updateConfirmationNonceHash(created.previewId, "later-hash")).toBe(false);
    expect(store.getPendingConfirmation(created.previewId)?.nonceHash).toBe("new-hash");
    store.close();
  });

  it("getRecentMessages omits the parsed payload by default and only loads it when asked (efficiency-05)", () => {
    const store = createStore(":memory:", { encryptionKey: ENC_KEY });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    // A fat assistant payload (the kind persisted with full list/report receipts).
    const payload = { kind: "answer", results: [{ kind: "receipt", blob: "x".repeat(2000) }] };
    store.addMessage({
      sessionId: session.id,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      role: "assistant",
      content: "here you go",
      payload,
    });

    // The model-visible window (the sole request-path consumer) only needs
    // role + content; it never reads payload. So the default load must NOT
    // fetch + JSON.parse the payload blob.
    const lean = store.getRecentMessages(session.id, 12);
    expect(lean).toHaveLength(1);
    expect(lean[0]?.role).toBe("assistant");
    expect(lean[0]?.content).toBe("here you go");
    expect(lean[0]?.payload).toBeUndefined();

    // Opt-in callers (e.g. the persisted-nonce safety check) can still read it.
    const full = store.getRecentMessages(session.id, 12, true);
    expect(full[0]?.payload).toEqual(payload);
    store.close();
  });
});
