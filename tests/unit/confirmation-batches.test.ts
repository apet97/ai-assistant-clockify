import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "../../src/db/store.js";
import { migrate, LATEST_SCHEMA_VERSION } from "../../src/db/schema.js";
import {
  validateDiscriminatorMatrix,
  v1DiscriminatorFromCapability,
  type DiscriminatorTuple,
} from "../../src/harness/action-discriminators.js";
import { computeOrderedTupleHash } from "../../src/db/store/confirmation-batches.js";
import { createPendingConfirmation } from "../../src/harness/confirmations.js";

const NOW = new Date("2026-07-23T12:00:00.000Z");
const HASH = "a".repeat(64);
const PROVENANCE = JSON.stringify({ "/name": { source: "model_inference" } });

function insertAssistantRun(
  db: Database.Database,
  scope: {
    sessionId: string;
    runId: string;
    workspaceId: string;
    adminUserId: string;
  },
): void {
  db.prepare(
    `INSERT INTO chat_sessions
       (id, workspace_id, admin_user_id, created_at, last_seen_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    scope.sessionId,
    scope.workspaceId,
    scope.adminUserId,
    NOW.toISOString(),
    NOW.toISOString(),
    new Date(NOW.getTime() + 86_400_000).toISOString(),
  );
  db.prepare(
    `INSERT INTO turn_runs
       (request_id, session_id, workspace_id, admin_user_id, intent_hash, status,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?)`,
  ).run(
    scope.runId,
    scope.sessionId,
    scope.workspaceId,
    scope.adminUserId,
    scope.runId,
    NOW.toISOString(),
    NOW.toISOString(),
  );
  db.prepare(
    `INSERT INTO assistant_runs (
       session_id, run_id, workspace_id, admin_user_id, installation_generation,
       auth_class, original_request, request_hash, phase, registry_id, catalog_hash,
       loaded_tool_names_json, used_tool_names_json, continuation_json, budget_json,
       unfinished_operations_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 1, 'addon', 'hello', ?, 'awaiting_confirmation', 'v2-api',
               ?, '[]', '[]', '{"kind":"none"}', '{"hostCallsUsed":0,"hostCallsReserved":0}',
               '[]', ?, ?)`,
  ).run(
    scope.sessionId,
    scope.runId,
    scope.workspaceId,
    scope.adminUserId,
    HASH,
    HASH,
    NOW.toISOString(),
    NOW.toISOString(),
  );
}

function insertScopedConfirmation(
  db: Database.Database,
  input: {
    id: string;
    operationId: string;
    sessionId: string;
    runId: string | null;
    workspaceId: string;
    adminUserId: string;
    tuple: DiscriminatorTuple;
    batchId?: string;
  },
): void {
  db.prepare(
    `INSERT INTO pending_confirmations (
       id, operation_id, session_id, workspace_id, admin_user_id, status,
       risk_json, preview_json, operation_json, operation_hash,
       target_fingerprints_json, action_fingerprint, catalog_hash, nonce_hash,
       expires_at, created_at, origin, registry_id, authority_model, executor_kind,
       run_id, batch_id
     ) VALUES (?, ?, ?, ?, ?, 'pending', '[]', '{}', '{}', 'hash', '[]', 'fp', ?,
               'nonce', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.operationId,
    input.sessionId,
    input.workspaceId,
    input.adminUserId,
    HASH,
    new Date(NOW.getTime() + 300_000).toISOString(),
    NOW.toISOString(),
    input.tuple.origin,
    input.tuple.registryId,
    input.tuple.authorityModel,
    input.tuple.executorKind,
    input.runId,
    input.batchId ?? null,
  );
}

function insertScopedOperation(
  db: Database.Database,
  input: {
    id: string;
    sessionId: string;
    runId: string | null;
    workspaceId: string;
    adminUserId: string;
    tuple: DiscriminatorTuple;
    confirmationId?: string;
  },
): void {
  db.prepare(
    `INSERT INTO operation_runs (
       id, session_id, workspace_id, admin_user_id, action_name, action_fingerprint,
       catalog_hash, operation_hash, operation_json, status, created_at, updated_at,
       origin, registry_id, authority_model, executor_kind, run_id,
       field_provenance_json, field_provenance_hash, source_undo_id, source_undo_hash,
       confirmation_id
     ) VALUES (?, ?, ?, ?, 'clockify_tags_create', 'fp', ?, 'hash', '{}', 'prepared',
               ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.sessionId,
    input.workspaceId,
    input.adminUserId,
    HASH,
    NOW.toISOString(),
    NOW.toISOString(),
    input.tuple.origin,
    input.tuple.registryId,
    input.tuple.authorityModel,
    input.tuple.executorKind,
    input.runId,
    input.tuple.fieldProvenanceJson ?? null,
    input.tuple.fieldProvenanceHash ?? null,
    input.tuple.sourceUndoId ?? null,
    input.tuple.sourceUndoHash ?? null,
    input.confirmationId ?? null,
  );
}

describe("validateDiscriminatorMatrix", () => {
  const validConfirmationTuples: DiscriminatorTuple[] = [
    v1DiscriminatorFromCapability("cap-1"),
    v1DiscriminatorFromCapability(),
    {
      origin: "assistant",
      registryId: "v2-api",
      authorityModel: "preview_confirmation_v2",
      executorKind: "prepared_safe_write",
      runId: "run-1",
    },
    {
      origin: "assistant",
      registryId: "v2-api",
      authorityModel: "preview_confirmation_v2",
      executorKind: "risky_commit",
      runId: "run-1",
    },
  ];

  const validOperationTuples: DiscriminatorTuple[] = [
    v1DiscriminatorFromCapability("cap-1"),
    v1DiscriminatorFromCapability(),
    {
      origin: "direct_ui",
      registryId: "v2-api",
      authorityModel: "trusted_direct_v2",
      executorKind: "direct_safe_write",
    },
    {
      origin: "system",
      registryId: "v2-local",
      authorityModel: "undo_v2",
      executorKind: "undo_commit",
      sourceUndoId: "undo-1",
      sourceUndoHash: HASH,
    },
    {
      origin: "assistant",
      registryId: "v2-api",
      authorityModel: "preview_confirmation_v2",
      executorKind: "prepared_safe_write",
      runId: "run-1",
      fieldProvenanceJson: PROVENANCE,
      fieldProvenanceHash: HASH,
    },
  ];

  it.each(validConfirmationTuples.map((tuple, index) => [index, tuple] as const))(
    "accepts valid pending_confirmation tuple %i",
    (_index, tuple) => {
      expect(validateDiscriminatorMatrix("pending_confirmation", tuple)).toEqual({ ok: true });
    },
  );

  it.each(validOperationTuples.map((tuple, index) => [index, tuple] as const))(
    "accepts valid operation_run tuple %i",
    (_index, tuple) => {
      expect(validateDiscriminatorMatrix("operation_run", tuple)).toEqual({ ok: true });
    },
  );

  it("rejects incomplete tuples fail-closed", () => {
    expect(validateDiscriminatorMatrix("pending_confirmation", { origin: "assistant" }))
      .toEqual({ ok: false, code: "discriminator_incomplete" });
  });

  it("rejects trusted direct and undo authorities on pending confirmations", () => {
    expect(validateDiscriminatorMatrix("pending_confirmation", {
      origin: "direct_ui",
      registryId: "v2-api",
      authorityModel: "trusted_direct_v2",
      executorKind: "direct_safe_write",
    })).toEqual({ ok: false, code: "confirmation_authority_invalid" });
  });

  it("rejects v2 preview without run scope on confirmations", () => {
    expect(validateDiscriminatorMatrix("pending_confirmation", {
      origin: "assistant",
      registryId: "v2-api",
      authorityModel: "preview_confirmation_v2",
      executorKind: "prepared_safe_write",
    })).toEqual({ ok: false, code: "discriminator_matrix_invalid" });
  });

  it("rejects preview operations without bounded provenance", () => {
    expect(validateDiscriminatorMatrix("operation_run", {
      origin: "assistant",
      registryId: "v2-api",
      authorityModel: "preview_confirmation_v2",
      executorKind: "prepared_safe_write",
      runId: "run-1",
    })).toEqual({ ok: false, code: "discriminator_matrix_invalid" });
  });
});

describe("schema v11 discriminator persistence", () => {
  it("backfills v1 rows from capability linkage only", () => {
    const fixturePath = fileURLToPath(new URL("../fixtures/db/schema-v10.sql", import.meta.url));
    const db = new Database(":memory:");
    db.exec(readFileSync(fixturePath, "utf8"));
    db.prepare(
      `INSERT INTO chat_sessions
         (id, workspace_id, admin_user_id, created_at, last_seen_at, expires_at)
       VALUES ('session-v11', 'ws', 'admin', ?, ?, ?)`,
    ).run(NOW.toISOString(), NOW.toISOString(), new Date(NOW.getTime() + 86_400_000).toISOString());
    db.prepare(
      `INSERT INTO pending_confirmations (
         id, operation_id, session_id, workspace_id, admin_user_id, status,
         risk_json, preview_json, operation_json, operation_hash,
         target_fingerprints_json, action_fingerprint, catalog_hash, nonce_hash,
         expires_at, created_at, capability_id
       ) VALUES ('conf-cap', 'op-cap', 'session-v11', 'ws', 'admin', 'pending',
                 '[]', '{}', '{}', 'hash', '[]', 'fp', ?, 'nonce', ?, ?, 'cap-1')`,
    ).run(HASH, NOW.toISOString(), NOW.toISOString());
    db.prepare(
      `INSERT INTO pending_confirmations (
         id, operation_id, session_id, workspace_id, admin_user_id, status,
         risk_json, preview_json, operation_json, operation_hash,
         target_fingerprints_json, action_fingerprint, catalog_hash, nonce_hash,
         expires_at, created_at
       ) VALUES ('conf-legacy', 'op-legacy', 'session-v11', 'ws', 'admin', 'pending',
                 '[]', '{}', '{}', 'hash', '[]', 'fp', ?, 'nonce', ?, ?)`,
    ).run(HASH, NOW.toISOString(), NOW.toISOString());

    migrate(db);

    expect(db.prepare(
      `SELECT origin, registry_id, authority_model, executor_kind
         FROM pending_confirmations WHERE id = 'conf-cap'`,
    ).get()).toEqual({
      origin: "assistant",
      registry_id: "v1-internal",
      authority_model: "intent_capability_v1",
      executor_kind: "legacy_v1",
    });
    expect(db.prepare(
      `SELECT authority_model, executor_kind FROM pending_confirmations WHERE id = 'conf-legacy'`,
    ).get()).toEqual({
      authority_model: "legacy_v1",
      executor_kind: "legacy_v1",
    });
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    db.close();
  });

  it("aborts invalid discriminator cross-products at the database boundary", () => {
    const db = new Database(":memory:");
    migrate(db);
    insertAssistantRun(db, {
      sessionId: "session-1",
      runId: "run-1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
    });
    expect(() => insertScopedConfirmation(db, {
      id: "conf-trusted",
      operationId: "op-trusted",
      sessionId: "session-1",
      runId: "run-1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      tuple: {
        origin: "direct_ui",
        registryId: "v2-api",
        authorityModel: "trusted_direct_v2",
        executorKind: "direct_safe_write",
      },
    })).toThrow(/discriminator_matrix_invalid/);
    expect(() => insertScopedOperation(db, {
      id: "op-preview-no-run",
      sessionId: "session-1",
      runId: null,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      tuple: {
        origin: "assistant",
        registryId: "v2-api",
        authorityModel: "preview_confirmation_v2",
        executorKind: "prepared_safe_write",
        runId: "run-1",
        fieldProvenanceJson: PROVENANCE,
        fieldProvenanceHash: HASH,
      },
    })).toThrow(/discriminator_matrix_invalid/);
    db.close();
  });
});

describe("confirmation batch store", () => {
  it("persists ordered tuple hash and enforces one active batch per run", () => {
    const store = createStore(":memory:", { encryptionKey: "k", now: () => NOW });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    store.startRunWithTurn({
      scope: {
        sessionId: session.id,
        runId: "run-1",
        workspaceId: "ws-1",
        adminUserId: "admin-1",
        installationGeneration: 1,
        authClass: "addon",
      },
      originalRequest: "rename both tags",
      requestHash: HASH,
      catalogHash: HASH,
      loadedToolNames: [],
      intentHash: "run-1",
    });

    const items = [
      { confirmationId: "conf-a", operationId: "op-a" },
      { confirmationId: "conf-b", operationId: "op-b" },
    ];
    const orderedTupleHash = computeOrderedTupleHash(items);
    expect(orderedTupleHash).toHaveLength(64);
    expect(computeOrderedTupleHash([...items].reverse())).not.toBe(orderedTupleHash);

    for (const item of items) {
      const created = createPendingConfirmation({
        id: item.confirmationId,
        sessionId: session.id,
        workspaceId: "ws-1",
        adminUserId: "admin-1",
        risk: ["high_risk_write"],
        preview: { summary: item.confirmationId },
        operation: { operationId: item.operationId, actionName: "clockify_tags_update" },
        sessionSecret: "secret",
        now: NOW,
        origin: "assistant",
        registryId: "v2-api",
        authorityModel: "preview_confirmation_v2",
        executorKind: "risky_commit",
        runId: "run-1",
      });
      store.savePendingConfirmation(created.record);
      store.prepareOperationRun({
        id: item.operationId,
        confirmationId: item.confirmationId,
        sessionId: session.id,
        workspaceId: "ws-1",
        adminUserId: "admin-1",
        actionName: "clockify_tags_update",
        actionFingerprint: "fp",
        catalogHash: HASH,
        operationHash: "hash",
        discriminator: {
          origin: "assistant",
          registryId: "v2-api",
          authorityModel: "preview_confirmation_v2",
          executorKind: "risky_commit",
          runId: "run-1",
          fieldProvenanceJson: PROVENANCE,
          fieldProvenanceHash: HASH,
        },
      });
    }

    const batch = store.createConfirmationBatch({
      id: "batch-1",
      sessionId: session.id,
      runId: "run-1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      orderedTupleHash,
      expiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
      items,
    });
    expect(batch.status).toBe("pending");
    expect(store.listConfirmationBatchItems("batch-1").map((item) => item.confirmationId))
      .toEqual(["conf-a", "conf-b"]);
    expect(store.getPendingConfirmation("conf-a")?.batchId).toBe("batch-1");

    expect(() => store.createConfirmationBatch({
      id: "batch-2",
      sessionId: session.id,
      runId: "run-1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      orderedTupleHash: computeOrderedTupleHash([{ confirmationId: "conf-c", operationId: "op-c" }]),
      expiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
      items: [{ confirmationId: "conf-c", operationId: "op-c" }],
    })).toThrow();
    store.close();
  });

  it("prunes and erases batch tables with workspace lifecycle", async () => {
    const store = createStore(":memory:", { encryptionKey: "k", now: () => NOW });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    store.startRunWithTurn({
      scope: {
        sessionId: session.id,
        runId: "run-1",
        workspaceId: "ws-1",
        adminUserId: "admin-1",
        installationGeneration: 1,
        authClass: "addon",
      },
      originalRequest: "hello",
      requestHash: HASH,
      catalogHash: HASH,
      loadedToolNames: [],
      intentHash: "run-1",
    });
    const confirmationId = randomUUID();
    const operationId = randomUUID();
    const created = createPendingConfirmation({
      id: confirmationId,
      sessionId: session.id,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      risk: ["high_risk_write"],
      preview: {},
      operation: { operationId, actionName: "clockify_tags_update" },
      sessionSecret: "secret",
      now: NOW,
      origin: "assistant",
      registryId: "v2-api",
      authorityModel: "preview_confirmation_v2",
      executorKind: "risky_commit",
      runId: "run-1",
    });
    store.savePendingConfirmation(created.record);
    store.prepareOperationRun({
      id: operationId,
      confirmationId,
      sessionId: session.id,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      actionName: "clockify_tags_update",
      actionFingerprint: "fp",
      catalogHash: HASH,
      operationHash: "hash",
      discriminator: {
        origin: "assistant",
        registryId: "v2-api",
        authorityModel: "preview_confirmation_v2",
        executorKind: "risky_commit",
        runId: "run-1",
        fieldProvenanceJson: PROVENANCE,
        fieldProvenanceHash: HASH,
      },
    });
    const items = [{ confirmationId, operationId }];
    store.createConfirmationBatch({
      id: "batch-old",
      sessionId: session.id,
      runId: "run-1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      orderedTupleHash: computeOrderedTupleHash(items),
      expiresAt: new Date(NOW.getTime() - 60_000).toISOString(),
      items,
    });

    const counts = await store.pruneExpired(NOW.toISOString());
    expect(counts.expiredConfirmationBatches).toBeGreaterThanOrEqual(1);
    expect(store.getConfirmationBatch("batch-old")).toMatchObject({ status: "expired" });

    const erased = store.eraseWorkspace("ws-1");
    expect(erased.confirmationBatches).toBeGreaterThanOrEqual(1);
    expect(erased.confirmationBatchItems).toBeGreaterThanOrEqual(1);
    store.close();
  });
});
