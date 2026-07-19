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
import { buildAllowIntentCapabilityV1 } from "../../src/harness/intent-capability.js";
import {
  FEATURE_GROUPS,
  adminPolicySchema,
  defaultAdminPolicy,
} from "../../src/harness/permissions.js";
import { LIFECYCLE_LINEAGE_RETENTION_SECONDS } from "../../src/addon/lifecycle-authority.js";

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
      "installation_attestations",
      "retired_installation_tokens",
      "lifecycle_authority_watermarks",
      "admin_policies",
      "chat_sessions",
      "chat_messages",
      "pending_confirmations",
      "audit_events",
    ]) {
      expect(tables).toContain(t);
    }
  });

  it("stores only a fresh installation token fingerprint, preserves exact retries, and invalidates replacement", () => {
    const path = tempDbPath();
    const binding = {
      releaseSha: "a".repeat(40),
      releaseBuildHash: "b".repeat(64),
      serverArtifactSha256: "c".repeat(64),
      sourceRelationship: "source_bound_builder" as const,
      sourceBindingSha256: "d".repeat(64),
      manifestSha256: "e".repeat(64),
    };
    let store = createStore(path, { encryptionKey: ENC_KEY });
    store.saveInstallation({
      workspaceId: "ws-attested-store",
      addonId: "a",
      addonUserId: "u",
      addonToken: "raw-token-must-not-be-the-fingerprint",
      freshInstallAttestation: binding,
    });
    store.close();

    let db = new Database(path, { readonly: true });
    const row = db.prepare(
      "SELECT token_fingerprint_sha256, workspace_sha256, installation_generation FROM installation_attestations",
    ).get() as Record<string, unknown>;
    expect(row.token_fingerprint_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(row.workspace_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(row.installation_generation).toBe(1);
    expect(row.token_fingerprint_sha256).not.toBe("raw-token-must-not-be-the-fingerprint");
    db.close();

    store = createStore(path, { encryptionKey: ENC_KEY });
    store.saveInstallation({
      workspaceId: "ws-attested-store",
      addonId: "a",
      addonUserId: "u",
      addonToken: "raw-token-must-not-be-the-fingerprint",
      freshInstallAttestation: binding,
    });
    expect(store.getInstallation("ws-attested-store")?.generation).toBe(1);
    store.close();
    db = new Database(path, { readonly: true });
    expect((db.prepare("SELECT COUNT(*) AS count FROM installation_attestations").get() as { count: number }).count).toBe(1);
    db.close();

    store = createStore(path, { encryptionKey: ENC_KEY });
    store.saveInstallation({
      workspaceId: "ws-attested-store",
      addonId: "a",
      addonUserId: "u",
      addonToken: "replacement-token",
      freshInstallAttestation: binding,
    });
    store.close();
    db = new Database(path, { readonly: true });
    expect((db.prepare("SELECT COUNT(*) AS count FROM installation_attestations").get() as { count: number }).count).toBe(0);
    db.close();
  });

  it("rejects a retired install token after erasure and process restart but accepts a genuinely new token", () => {
    const path = tempDbPath();
    const oldToken = "retired-installation-token-must-never-return";
    let store = createStore(path, { encryptionKey: ENC_KEY });
    store.saveInstallation({
      workspaceId: "ws-retired-token",
      addonId: "a",
      addonUserId: "u",
      addonToken: oldToken,
      lifecycleIssuedAt: 1_700_000_100,
    });
    const tombstone = store.tombstoneInstallation("ws-retired-token");
    expect(tombstone).toBeDefined();
    expect(store.eraseWorkspaceForDeletion("ws-retired-token", tombstone!.generation)).toBeDefined();
    expect(store.getInstallation("ws-retired-token")).toBeUndefined();
    store.close();

    store = createStore(path, { encryptionKey: ENC_KEY });
    store.saveInstallation({
      workspaceId: "ws-retired-token",
      addonId: "a",
      addonUserId: "u",
      addonToken: oldToken,
    });
    expect(store.getInstallation("ws-retired-token")).toBeUndefined();

    store.saveInstallation({
      workspaceId: "ws-retired-token",
      addonId: "a",
      addonUserId: "u",
      addonToken: "genuinely-new-installation-token",
      lifecycleIssuedAt: 1_700_000_200,
    });
    expect(store.getInstallation("ws-retired-token")).toMatchObject({
      status: "active",
      addonToken: "genuinely-new-installation-token",
      lifecycleIssuedAt: 1_700_000_200,
    });
    store.close();

    store = createStore(path, { encryptionKey: ENC_KEY });
    expect(store.getInstallation("ws-retired-token")?.lifecycleIssuedAt).toBe(1_700_000_200);
    store.close();

    const db = new Database(path, { readonly: true });
    const rows = db.prepare("SELECT * FROM retired_installation_tokens").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      "retired_at",
      "token_fingerprint_sha256",
    ]);
    expect(rows[0]?.token_fingerprint_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(rows)).not.toContain(oldToken);
    expect(JSON.stringify(rows)).not.toContain("ws-retired-token");
    const lineageRows = db.prepare("SELECT * FROM lifecycle_authority_watermarks").all() as Array<
      Record<string, unknown>
    >;
    expect(lineageRows).toHaveLength(1);
    expect(Object.keys(lineageRows[0] ?? {}).sort()).toEqual([
      "authority_state",
      "expires_at",
      "installation_generation",
      "lifecycle_issued_at",
      "recorded_at",
      "workspace_fingerprint_sha256",
    ]);
    expect(lineageRows[0]).toMatchObject({
      authority_state: "active",
      lifecycle_issued_at: 1_700_000_200,
    });
    expect(lineageRows[0]?.workspace_fingerprint_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(lineageRows)).not.toContain("ws-retired-token");
    db.close();
  });

  it("prunes erased lifecycle lineage only after every acceptable callback has expired", () => {
    const path = tempDbPath();
    let current = new Date("2026-07-19T00:00:00.000Z");
    let store = createStore(path, { encryptionKey: ENC_KEY, now: () => current });
    const eventIat = Math.floor(current.getTime() / 1000);
    store.saveInstallation({
      workspaceId: "ws-bounded-lineage",
      addonId: "a",
      addonUserId: "u",
      addonToken: "token",
      lifecycleIssuedAt: eventIat,
    });
    const deletion = store.tombstoneInstallationForLifecycle(
      "ws-bounded-lineage",
      eventIat + 1,
    );
    expect(deletion.accepted).toBe(true);
    expect(store.eraseWorkspaceForDeletion("ws-bounded-lineage", deletion.generation!)).toBeDefined();
    store.close();

    let db = new Database(path, { readonly: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM lifecycle_authority_watermarks").get())
      .toEqual({ count: 1 });
    db.close();

    current = new Date(current.getTime() + LIFECYCLE_LINEAGE_RETENTION_SECONDS * 1000 + 1);
    store = createStore(path, { encryptionKey: ENC_KEY, now: () => current });
    store.close();
    db = new Database(path, { readonly: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM lifecycle_authority_watermarks").get())
      .toEqual({ count: 0 });
    db.close();
  });

  it("does not let an equal-iat absent INACTIVE event downgrade DELETED lineage", () => {
    const path = tempDbPath();
    const store = createStore(path, { encryptionKey: ENC_KEY });
    store.saveInstallation({
      workspaceId: "ws-terminal-rank",
      addonId: "a",
      addonUserId: "u",
      addonToken: "token",
      lifecycleIssuedAt: 1_700_000_000,
    });
    const deletion = store.tombstoneInstallationForLifecycle("ws-terminal-rank", 1_700_000_100);
    expect(store.eraseWorkspaceForDeletion("ws-terminal-rank", deletion.generation!)).toBeDefined();
    expect(store.setInstallationStatus("ws-terminal-rank", "inactive", 1_700_000_100).outcome)
      .toBe("stale_lifecycle");
    store.close();

    const db = new Database(path, { readonly: true });
    expect(db.prepare(
      "SELECT lifecycle_issued_at, authority_state FROM lifecycle_authority_watermarks",
    ).get()).toEqual({ lifecycle_issued_at: 1_700_000_100, authority_state: "deleted" });
    db.close();
  });

  it("persists absent-row INACTIVE authority and requires a strictly newer install after reopen", () => {
    const path = tempDbPath();
    let store = createStore(path, { encryptionKey: ENC_KEY });
    expect(store.setInstallationStatus("ws-inactive-before-install", "inactive", 1_700_000_100))
      .toMatchObject({ outcome: "applied" });
    store.close();

    store = createStore(path, { encryptionKey: ENC_KEY });
    expect(store.saveInstallation({
      workspaceId: "ws-inactive-before-install",
      addonId: "a",
      addonUserId: "u",
      addonToken: "equal-token",
      lifecycleIssuedAt: 1_700_000_100,
    }).outcome).toBe("stale_lifecycle");
    expect(store.getInstallation("ws-inactive-before-install")).toBeUndefined();

    expect(store.saveInstallation({
      workspaceId: "ws-inactive-before-install",
      addonId: "a",
      addonUserId: "u",
      addonToken: "newer-token",
      lifecycleIssuedAt: 1_700_000_101,
    }).outcome).toBe("applied");
    expect(store.getInstallation("ws-inactive-before-install")).toMatchObject({
      addonToken: "newer-token",
      generation: 1,
      status: "active",
    });
    store.close();
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

  it("advances installation generations and durably tombstones a deleted token", () => {
    const store = createStore(":memory:", { encryptionKey: ENC_KEY }) as TestStore;
    store.saveInstallation({
      workspaceId: "ws-generation",
      addonId: "addon-1",
      addonUserId: "addon-user-1",
      addonToken: "token-v1",
      lifecycleIssuedAt: 1_700_000_001,
    });
    expect(store.getInstallation("ws-generation")?.generation).toBe(1);
    expect(store.getInstallation("ws-generation")?.lifecycleIssuedAt).toBe(1_700_000_001);

    store.saveInstallation({
      workspaceId: "ws-generation",
      addonId: "addon-1",
      addonUserId: "addon-user-1",
      addonToken: "token-v2",
      lifecycleIssuedAt: 1_700_000_002,
    });
    expect(store.getInstallation("ws-generation")?.generation).toBe(2);
    expect(store.getInstallation("ws-generation")?.lifecycleIssuedAt).toBe(1_700_000_002);

    store.setInstallationStatus("ws-generation", "inactive");
    expect(store.getInstallation("ws-generation")?.generation).toBe(2);
    store.setInstallationStatus("ws-generation", "active");
    expect(store.getInstallation("ws-generation")?.generation).toBe(3);

    const tombstone = store.tombstoneInstallation("ws-generation");
    expect(tombstone?.generation).toBe(4);
    expect(store.getInstallation("ws-generation")).toMatchObject({
      status: "deleted",
      addonToken: "",
      generation: 4,
    });
    expect(store.listDeletionTombstones()).toEqual(["ws-generation"]);

    store.eraseWorkspace("ws-generation");
    expect(store.listDeletionTombstones()).toEqual([]);
  });

  it("does not resurrect a tokenless deletion tombstone from a status event", () => {
    const store = createStore(":memory:", { encryptionKey: ENC_KEY });
    store.saveInstallation({
      workspaceId: "ws-deleted-status",
      addonId: "addon-1",
      addonUserId: "addon-user-1",
      addonToken: "secret",
    });
    const tombstone = store.tombstoneInstallation("ws-deleted-status");

    store.setInstallationStatus("ws-deleted-status", "active");

    expect(store.getInstallation("ws-deleted-status")).toMatchObject({
      status: "deleted",
      addonToken: "",
      generation: tombstone?.generation,
    });
    store.close();
  });

  it("never reuses an erased installation generation within the running store", () => {
    const store = createStore(":memory:", { encryptionKey: ENC_KEY });
    store.saveInstallation({
      workspaceId: "ws-reinstalled",
      addonId: "addon-1",
      addonUserId: "addon-user-1",
      addonToken: "old-token",
    });
    const tombstone = store.tombstoneInstallation("ws-reinstalled");
    store.eraseWorkspace("ws-reinstalled");

    store.saveInstallation({
      workspaceId: "ws-reinstalled",
      addonId: "addon-1",
      addonUserId: "addon-user-1",
      addonToken: "fresh-token",
    });

    expect(store.getInstallation("ws-reinstalled")).toMatchObject({
      status: "active",
      addonToken: "fresh-token",
      generation: (tombstone?.generation ?? 0) + 1,
    });
    store.close();
  });

  it("binds uninstall erasure to the exact deleted installation generation", () => {
    const store = createStore(":memory:", { encryptionKey: ENC_KEY });
    store.saveInstallation({
      workspaceId: "ws-conditional-erase",
      addonId: "addon-1",
      addonUserId: "addon-user-1",
      addonToken: "old-token",
    });
    const oldSession = store.createSession({
      workspaceId: "ws-conditional-erase",
      adminUserId: "admin-1",
    });
    const tombstone = store.tombstoneInstallation("ws-conditional-erase");
    if (!tombstone) throw new Error("expected deletion tombstone");

    // Simulate an out-of-band newer install. The old deletion generation must
    // never erase its replacement, even though normal lifecycle routing now
    // serializes this transition behind the deletion barrier.
    store.saveInstallation({
      workspaceId: "ws-conditional-erase",
      addonId: "addon-1",
      addonUserId: "addon-user-1",
      addonToken: "replacement-token",
    });

    expect(store.eraseWorkspaceForDeletion(
      "ws-conditional-erase",
      tombstone.generation,
    )).toBeUndefined();
    expect(store.getInstallation("ws-conditional-erase")).toMatchObject({
      status: "active",
      addonToken: "replacement-token",
      generation: tombstone.generation + 1,
    });
    expect(store.getSession(oldSession.id)).toBeDefined();
    store.close();
  });

  it("re-encrypts installation tokens from DATA_ENCRYPTION_KEY_PREVIOUS on startup", () => {
    const dbPath = tempDbPath();
    const oldKey = "old-encryption-key-32-characters!!";
    const newKey = "new-encryption-key-32-characters!!";
    const oldStore = createStore(dbPath, { encryptionKey: oldKey }) as TestStore;
    oldStore.saveInstallation({
      workspaceId: "ws-rotate",
      addonId: "addon-1",
      addonUserId: "addon-user-1",
      addonToken: "rotating-secret-token",
    });
    const oldCiphertext = oldStore.rawAddonTokenForTest("ws-rotate");
    oldStore.close();

    const rotated = createStore(dbPath, {
      encryptionKey: newKey,
      previousEncryptionKey: oldKey,
    }) as TestStore;
    expect(rotated.getInstallation("ws-rotate")?.addonToken).toBe("rotating-secret-token");
    expect(rotated.rawAddonTokenForTest("ws-rotate")).not.toBe(oldCiphertext);
    rotated.close();

    const reopened = createStore(dbPath, { encryptionKey: newKey });
    expect(reopened.getInstallation("ws-rotate")?.addonToken).toBe("rotating-secret-token");
    reopened.close();
  });

  it("eraseWorkspace deletes all workspace-scoped data + tombstones the token, leaving other workspaces intact", () => {
    const store = createStore(":memory:", { encryptionKey: ENC_KEY }) as TestStore;
    const seed = (ws: string) => {
      store.saveInstallation({ workspaceId: ws, addonId: "a", addonUserId: "u", addonToken: `tok-${ws}`, status: "active" });
      store.upsertAdminPolicy(ws, "admin-1", defaultAdminPolicy());
      const session = store.createSession({ workspaceId: ws, adminUserId: "admin-1" });
      const authoredSource = `Create tag ${ws}`;
      const literal = {
        startByte: Buffer.byteLength("Create tag ", "utf8"),
        endByte: Buffer.byteLength(authoredSource, "utf8"),
        text: ws,
      };
      const capability = buildAllowIntentCapabilityV1({
        authoredSource,
        catalogHash: "catalog",
        writeActions: [{
          actionName: "clockify_tags_create",
          sourceSpans: [literal],
          literalConstraints: [{ path: "name", value: ws, sourceSpan: literal }],
        }],
      });
      const requestId = `request-${ws}`;
      const capabilityRecord = store.createIntentCapability({
        id: `capability-${ws}`,
        workspaceId: ws,
        adminUserId: "admin-1",
        sessionId: session.id,
        requestId,
        authoredSource,
        capability,
      });
      store.addMessage({ sessionId: session.id, workspaceId: ws, adminUserId: "admin-1", role: "user", content: "hi" });
      const receipt = successReceipt({ action: "clockify_tags_create" });
      const result = { kind: "receipt", receipt };
      const resultRef = store.recordActionResult({
        workspaceId: ws,
        adminUserId: "admin-1",
        sessionId: session.id,
        actionName: "clockify_tags_create",
        status: "succeeded",
        result,
      });
      store.addMessage({
        sessionId: session.id,
        workspaceId: ws,
        adminUserId: "admin-1",
        role: "assistant",
        content: "done",
        payload: { kind: "answer" },
        resultLinks: [{ kind: "action_result", ref: resultRef }],
      });
      store.addAuditEvent({
        workspaceId: ws,
        adminUserId: "admin-1",
        actionName: "clockify_tags_create",
        risk: ["safe_write"],
        resultRef,
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
      store.claimTurnRun({ requestId, sessionId: session.id, workspaceId: ws, adminUserId: "admin-1", intentHash: "intent" });
      store.finishTurnRun(session.id, requestId, "succeeded", { status: 200, body: { ok: true } }, [{ kind: "action_result", ref: resultRef }]);
      const operationId = store.prepareOperationRun({
        requestId,
        sessionId: session.id,
        workspaceId: ws,
        adminUserId: "admin-1",
        actionName: "clockify_tags_create",
        actionFingerprint: "action",
        catalogHash: "catalog",
        operationHash: "operation",
        capabilityId: capabilityRecord.id,
        capabilityHash: capabilityRecord.capabilityHash,
      });
      expect(store.consumeIntentCapabilityForOperation({
        operationId,
        workspaceId: ws,
        adminUserId: "admin-1",
        sessionId: session.id,
        capabilityId: capabilityRecord.id,
        capabilityHash: capabilityRecord.capabilityHash,
      })).toEqual({ state: "consumed", execution: 1 });
      store.settleOperationRun(operationId, "succeeded", resultRef.id);
      store.recordIdempotency("same-key", ws, "admin-1", resultRef, Date.now());
      store.createArtifact({
        workspaceId: ws,
        adminUserId: "admin-1",
        sessionId: session.id,
        contentType: "text/plain",
        filename: "result.txt",
        bytes: new Uint8Array([1]),
      });
      return { session, capability, capabilityRecord, requestId };
    };
    const s1 = seed("ws-1");
    const s2 = seed("ws-2");

    const counts = store.eraseWorkspace("ws-1");
    expect(counts.chatMessages).toBe(2);
    expect(counts.auditEvents).toBe(1);
    expect(counts.pendingConfirmations).toBe(1);
    expect(counts.undoRecords).toBe(1);
    expect(counts.turnTelemetry).toBe(1);
    expect(counts.turnRuns).toBe(1);
    expect(counts.operationRuns).toBe(1);
    expect(counts.intentCapabilityUsage).toBe(1);
    expect(counts.intentCapabilities).toBe(1);
    expect(counts.actionResults).toBe(1);
    expect(counts.artifacts).toBe(1);
    expect(counts.idempotencyKeys).toBe(1);
    expect(counts.turnRunResultLinks).toBe(1);
    expect(counts.chatMessageResultLinks).toBe(1);
    expect(counts.chatSessions).toBe(1);
    expect(counts.adminPolicies).toBe(1);

    // ws-1 fully erased, including installation metadata and its token.
    expect(store.getInstallation("ws-1")).toBeUndefined();
    expect(store.getRecentMessages(s1.session.id, 10)).toHaveLength(0);
    expect(store.listActionOutcomes("ws-1", "admin-1")).toHaveLength(0);
    expect(store.getAdminPolicy("ws-1", "admin-1")).toBeUndefined();
    expect(store.getSession(s1.session.id)).toBeUndefined();
    expect(store.listTurnTelemetry("ws-1", "admin-1")).toHaveLength(0);
    expect(store.getIntentCapability(s1.capabilityRecord.id, {
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      sessionId: s1.session.id,
      requestId: s1.requestId,
      requestHash: s1.capability.requestHash,
      catalogHash: s1.capability.catalogHash,
    })).toBeUndefined();

    // ws-2 is completely untouched.
    expect(store.getInstallation("ws-2")?.addonToken).toBe("tok-ws-2");
    expect(store.getInstallation("ws-2")?.status).toBe("active");
    expect(store.getRecentMessages(s2.session.id, 10)).toHaveLength(2);
    expect(store.listActionOutcomes("ws-2", "admin-1")).toHaveLength(1);
    expect(store.getAdminPolicy("ws-2", "admin-1")).toBeDefined();
    expect(store.getSession(s2.session.id)).toBeDefined();
    expect(store.getIntentCapability(s2.capabilityRecord.id, {
      workspaceId: "ws-2",
      adminUserId: "admin-1",
      sessionId: s2.session.id,
      requestId: s2.requestId,
      requestHash: s2.capability.requestHash,
      catalogHash: s2.capability.catalogHash,
    })).toBeDefined();
    store.close();
  });

  it("migrates missing groups in an existing policy to off while preserving explicit choices", () => {
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
    // Existing admins must explicitly opt into newly introduced capabilities.
    expect(loaded?.groups.custom_fields).toBe("off");
    expect(loaded?.groups.approvals).toBe("off");
    expect(loaded?.groups.audit_log).toBe("off");
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
    store.prepareOperationRun({
      id: created.record.operationId,
      confirmationId: created.record.id,
      sessionId: session.id,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      actionName: "a",
      actionFingerprint: created.record.actionFingerprint,
      catalogHash: created.record.catalogHash,
      operationHash: created.record.operationHash,
      operation: created.record.operation,
    });
    store.savePendingConfirmation(created.record);

    expect(store.updateConfirmationNonceHash(created.previewId, "new-hash")).toBe(true);
    expect(store.getPendingConfirmation(created.previewId)?.nonceHash).toBe("new-hash");

    store.markConfirmationExecuting(created.previewId);
    expect(store.updateConfirmationNonceHash(created.previewId, "later-hash")).toBe(false);
    expect(store.getPendingConfirmation(created.previewId)).toMatchObject({
      status: "executing",
      nonceHash: "",
      operation: {},
      agentState: undefined,
      actionResultId: expect.any(String),
    });
    store.close();
  });

  it("settles a confirmation and its canonical action result in one durable transition", () => {
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
    store.prepareOperationRun({
      id: created.record.operationId,
      confirmationId: created.record.id,
      sessionId: session.id,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      actionName: "a",
      actionFingerprint: created.record.actionFingerprint,
      catalogHash: created.record.catalogHash,
      operationHash: created.record.operationHash,
      operation: created.record.operation,
    });
    store.savePendingConfirmation(created.record);
    expect(store.markConfirmationExecuting(created.previewId)).toBe(true);
    const receipt = { ok: true, action: "a" };
    const actionResult = store.settleConfirmation(created.previewId, "succeeded", "a", receipt);

    expect(store.getPendingConfirmation(created.previewId)).toMatchObject({
      status: "succeeded",
      actionResultId: actionResult.id,
      nonceHash: "",
      agentState: undefined,
    });
    expect(store.getActionResult(actionResult.id)).toEqual({ kind: "receipt", receipt });
    store.close();
  });

  it("getRecentMessages omits the parsed payload by default and only loads it when asked (efficiency-05)", () => {
    const store = createStore(":memory:", { encryptionKey: ENC_KEY });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    // A fat assistant payload (the kind persisted with full list/report receipts).
    const result = { kind: "receipt", blob: "x".repeat(2000) };
    const payload = { kind: "answer", results: [result] };
    const ref = store.recordActionResult({
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      sessionId: session.id,
      actionName: "x",
      status: "succeeded",
      result,
    });
    store.addMessage({
      sessionId: session.id,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      role: "assistant",
      content: "here you go",
      payload,
      resultLinks: [{ kind: "action_result", ref }],
    });

    // The model-visible window (the sole request-path consumer) only needs
    // role + content; it never reads payload. So the default load must NOT
    // fetch + JSON.parse the payload blob.
    const lean = store.getRecentMessages(session.id, 12);
    expect(lean).toHaveLength(1);
    expect(lean[0]?.role).toBe("assistant");
    expect(lean[0]?.content).toBe("here you go");
    expect(lean[0]?.payload).toBeUndefined();

    // Opt-in callers hydrate the result from its canonical action_results row.
    const full = store.getRecentMessages(session.id, 12, true);
    expect(full[0]?.payload).toEqual(payload);
    store.close();
  });
});
