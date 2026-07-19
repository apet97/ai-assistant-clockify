import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStore, type Store } from "../../src/db/store.js";
import { createPendingConfirmation } from "../../src/harness/confirmations.js";

const directories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "assistant-orphan-"));
  directories.push(directory);
  return join(directory, "db.sqlite");
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("orphaned execution recovery", () => {
  it("atomically records and settles a safe-write result", () => {
    const path = databasePath();
    const store = createStore(path, { encryptionKey: "k" });
    const operationId = store.prepareOperationRun({
      id: "op-atomic-safe-write",
      requestId: "request-atomic",
      sessionId: "session-atomic",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      actionName: "clockify_tags_create",
      actionFingerprint: "fingerprint",
      catalogHash: "catalog",
      operationHash: "operation",
    });
    expect(store.markOperationExecuting(operationId)).toBe(true);
    const raw = new Database(path);
    raw.exec(`
      CREATE TRIGGER reject_operation_settlement
      BEFORE UPDATE OF status ON operation_runs
      WHEN NEW.id = 'op-atomic-safe-write'
      BEGIN
        SELECT RAISE(ABORT, 'forced operation settlement failure');
      END;
    `);
    raw.close();

    type AtomicStore = Store & {
      settleOperationResult?: (id: string, status: "succeeded", result: unknown) => unknown;
    };
    const settle = (store as AtomicStore).settleOperationResult;
    expect(settle).toBeTypeOf("function");
    if (!settle) {
      store.close();
      return;
    }
    expect(() => settle(operationId, "succeeded", {
      kind: "receipt",
      receipt: { ok: true, action: "clockify_tags_create" },
    })).toThrow(/forced operation settlement failure/);
    store.close();

    const verify = new Database(path, { readonly: true });
    expect(verify.prepare("SELECT COUNT(*) AS count FROM action_results").get()).toEqual({ count: 0 });
    expect(verify.prepare("SELECT status, action_result_id FROM operation_runs WHERE id = ?").get(operationId)).toEqual({
      status: "executing",
      action_result_id: null,
    });
    verify.close();
  });

  it("records one canonical unknown result and scrubs an executing confirmation", () => {
    const path = databasePath();
    const store = createStore(path, { encryptionKey: "k" });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    const created = createPendingConfirmation({
      sessionId: session.id,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      risk: ["high_risk_write"],
      preview: { summary: "Update a client" },
      operation: {
        operationId: "op-confirmation",
        actionName: "clockify_clients_update",
        featureGroup: "work_structure",
        risks: ["high_risk_write"],
        payload: { clientId: "client-1", name: "new name" },
      },
      sessionSecret: "secret",
      agentState: { messages: [{ role: "user", content: "change it" }] },
    });
    store.savePendingConfirmation(created.record);
    store.prepareOperationRun({
      id: created.record.operationId,
      confirmationId: created.record.id,
      sessionId: session.id,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      actionName: "clockify_clients_update",
      actionFingerprint: created.record.actionFingerprint,
      catalogHash: created.record.catalogHash,
      operationHash: created.record.operationHash,
    });
    expect(store.markConfirmationExecuting(created.record.id)).toBe(true);
    store.close();

    const recovered = createStore(path, { encryptionKey: "k" });
    const confirmation = recovered.getPendingConfirmation(created.record.id);
    expect(confirmation).toMatchObject({
      status: "outcome_unknown",
      nonceHash: "",
      operation: {},
      agentState: undefined,
    });
    expect(confirmation?.actionResultId).toBeDefined();
    expect(recovered.getOperationRun(created.record.operationId)).toMatchObject({
      status: "outcome_unknown",
      actionResultId: confirmation?.actionResultId,
    });
    expect(recovered.getActionResult(confirmation!.actionResultId!)).toMatchObject({
      kind: "receipt",
      receipt: { ok: false, action: "clockify_clients_update", code: "commit_outcome_unknown" },
    });
    recovered.close();

    const db = new Database(path, { readonly: true });
    const raw = db.prepare(
      "SELECT nonce_hash, operation_json, agent_state_json, action_result_id FROM pending_confirmations WHERE id = ?",
    ).get(created.record.id) as Record<string, unknown>;
    expect(raw).toMatchObject({
      nonce_hash: "",
      operation_json: null,
      agent_state_json: null,
      action_result_id: confirmation?.actionResultId,
    });
    expect((db.prepare("SELECT COUNT(*) AS count FROM action_results").get() as { count: number }).count).toBe(1);
    db.close();
  });

  it("records one canonical unknown result for an orphaned safe-write operation", () => {
    const path = databasePath();
    const store = createStore(path, { encryptionKey: "k" });
    const operationId = store.prepareOperationRun({
      id: "op-safe-write",
      requestId: "request-1",
      sessionId: "session-1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      actionName: "clockify_tags_create",
      actionFingerprint: "fingerprint",
      catalogHash: "catalog",
      operationHash: "operation",
    });
    expect(store.markOperationExecuting(operationId)).toBe(true);
    const stepId = store.prepareOperationStep({
      operationId,
      planStepId: "create-tag",
      index: 0,
      name: "Create tag",
      kind: "primary",
    });
    expect(store.markOperationStepExecuting(stepId)).toBe(true);
    expect(store.markOperationStepDispatched(stepId)).toBe(true);
    store.close();

    const recovered = createStore(path, { encryptionKey: "k" });
    const operation = recovered.getOperationRun(operationId);
    expect(operation).toMatchObject({ status: "outcome_unknown" });
    expect(operation?.actionResultId).toBeDefined();
    expect(recovered.getActionResult(operation!.actionResultId!)).toMatchObject({
      kind: "receipt",
      receipt: { ok: false, action: "clockify_tags_create", code: "commit_outcome_unknown" },
    });
    recovered.close();

    const db = new Database(path, { readonly: true });
    expect((db.prepare("SELECT COUNT(*) AS count FROM action_results").get() as { count: number }).count).toBe(1);
    db.close();
  });

  it("reuses a canonical safe-write result that survived a crash before operation settlement", () => {
    const path = databasePath();
    const store = createStore(path, { encryptionKey: "k" });
    const operationId = store.prepareOperationRun({
      id: "op-safe-write-with-result",
      requestId: "request-2",
      sessionId: "session-2",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      actionName: "clockify_tags_create",
      actionFingerprint: "fingerprint",
      catalogHash: "catalog",
      operationHash: "operation",
    });
    expect(store.markOperationExecuting(operationId)).toBe(true);
    const ref = store.recordActionResult({
      operationId,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      sessionId: "session-2",
      actionName: "clockify_tags_create",
      status: "succeeded",
      result: {
        kind: "receipt",
        receipt: { ok: true, action: "clockify_tags_create", changed: { created: [{ id: "tag-1" }] } },
      },
    } as Parameters<Store["recordActionResult"]>[0] & { operationId: string });
    store.close();

    const recovered = createStore(path, { encryptionKey: "k" });
    expect(recovered.getOperationRun(operationId)).toMatchObject({
      status: "succeeded",
      actionResultId: ref.id,
    });
    expect(recovered.getActionResult(ref.id)).toMatchObject({
      kind: "receipt",
      receipt: { ok: true, action: "clockify_tags_create" },
    });
    recovered.close();

    const db = new Database(path, { readonly: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM action_results").get()).toEqual({ count: 1 });
    db.close();
  });

  it("reconciles a bound idempotency claim to the pre-dispatch canonical unknown result", () => {
    const path = databasePath();
    const store = createStore(path, { encryptionKey: "k" });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    const created = createPendingConfirmation({
      sessionId: session.id,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      risk: ["high_risk_write"],
      preview: { summary: "Create an invoice" },
      operation: {
        operationId: "op-idempotency-recovery",
        actionName: "clockify_invoices_create",
        featureGroup: "invoices",
        risks: ["high_risk_write"],
        payload: { clientId: "client-1" },
      },
      sessionSecret: "secret",
      agentState: { messages: [{ role: "user", content: "create it" }] },
    });
    store.savePendingConfirmation(created.record);
    store.prepareOperationRun({
      id: created.record.operationId,
      confirmationId: created.record.id,
      sessionId: session.id,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      actionName: "clockify_invoices_create",
      actionFingerprint: created.record.actionFingerprint,
      catalogHash: created.record.catalogHash,
      operationHash: created.record.operationHash,
    });
    expect(store.markConfirmationExecuting(created.record.id)).toBe(true);
    expect(store.claimIdempotency("invoice-key", "ws-1", "admin-1", 1_000, 0, 0)).toBe("won");
    store.bindConfirmationIdempotencyKey(created.record.id, "invoice-key");
    const refId = store.getPendingConfirmation(created.record.id)?.actionResultId;
    expect(refId).toBeDefined();
    store.close();

    const recovered = createStore(path, { encryptionKey: "k" });
    expect(recovered.getPendingConfirmation(created.record.id)).toMatchObject({
      status: "outcome_unknown",
      nonceHash: "",
      operation: {},
      actionResultId: refId,
    });
    expect(recovered.claimIdempotency("invoice-key", "ws-1", "admin-1", 2_000, 0, 0)).toBe("stale_unknown");
    expect(recovered.getActionResult(refId!)).toMatchObject({
      kind: "receipt",
      receipt: {
        ok: false,
        action: "clockify_invoices_create",
        code: "commit_outcome_unknown",
      },
    });
    recovered.close();
  });

  it("settles an orphaned undo as outcome-unknown without erasing its remaining work", () => {
    const path = databasePath();
    const store = createStore(path, { encryptionKey: "k" });
    const reversal = [{ type: "tag", id: "tag-1", name: "urgent" }] as const;
    const undoId = store.recordUndoable({
      sessionId: "session-undo",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      actionName: "clockify_tags_create",
      reversal: [...reversal],
    });
    expect(store.markUndoExecuting(undoId)).toBe(true);
    store.close();

    const recovered = createStore(path, { encryptionKey: "k" });
    expect(recovered.getUndoRecord(undoId)).toMatchObject({
      status: "outcome_unknown",
      remaining: reversal,
    });
    recovered.close();

    const db = new Database(path, { readonly: true });
    const row = db.prepare(
      "SELECT action_result_id, result_summary_json FROM undo_records WHERE id = ?",
    ).get(undoId) as { action_result_id: string | null; result_summary_json: string | null };
    expect(row.action_result_id).toBeTruthy();
    expect(row.result_summary_json).toContain("recovery");
    expect(db.prepare("SELECT COUNT(*) AS count FROM action_results").get()).toEqual({ count: 1 });
    db.close();
  });

  it("shares one canonical unknown result when a route-backed undo is orphaned", () => {
    const path = databasePath();
    const store = createStore(path, { encryptionKey: "k" });
    const reversal = [{ type: "tag", id: "tag-route-undo", name: "urgent" }] as const;
    const undoId = store.recordUndoable({
      sessionId: "session-route-undo",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      actionName: "clockify_tags_create",
      reversal: [...reversal],
    });
    const operationId = store.startUndoOperation(undoId, {
      id: "op-route-undo",
      sessionId: "session-route-undo",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      actionName: "undo",
      actionFingerprint: "undo-fingerprint",
      catalogHash: "catalog",
      operationHash: "operation",
      operation: { undoId, reversal },
      mutationPlan: {
        mode: "batch",
      maxHostCalls: 60,
        steps: [{ id: "undo-0-tag-delete", kind: "primary", reconciliationStrategy: "delete" }],
      },
    });
    expect(operationId).toBe("op-route-undo");
    const stepId = store.prepareOperationStep({
      operationId: operationId!,
      planStepId: "undo-0-tag-delete",
      index: 0,
      name: "Delete tag",
      kind: "primary",
    });
    expect(store.markOperationStepExecuting(stepId)).toBe(true);
    expect(store.markOperationStepDispatched(stepId)).toBe(true);
    store.close();

    const recovered = createStore(path, { encryptionKey: "k" });
    const operation = recovered.getOperationRun(operationId!);
    const undo = recovered.getUndoRecord(undoId);
    expect(operation).toMatchObject({ status: "outcome_unknown" });
    expect(undo).toMatchObject({ status: "outcome_unknown", remaining: reversal });
    expect(operation?.actionResultId).toBeDefined();
    expect(undo?.actionResultId).toBe(operation?.actionResultId);
    expect(recovered.getActionResult(operation!.actionResultId!)).toMatchObject({
      kind: "receipt",
      receipt: { ok: false, action: "undo", code: "commit_outcome_unknown" },
    });
    expect(recovered.recoverOrphanedRuns()).toEqual({ turns: 0, operations: 0, confirmations: 0, undos: 0 });
    expect(recovered.recoverOrphanedRuns()).toEqual({ turns: 0, operations: 0, confirmations: 0, undos: 0 });
    recovered.close();

    const db = new Database(path, { readonly: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM action_results").get()).toEqual({ count: 1 });
    expect(db.prepare(
      "SELECT operation_id FROM action_results WHERE id = ?",
    ).get(operation!.actionResultId!)).toEqual({ operation_id: operationId });
    db.close();
  });

  it("settles a route-backed undo definitively when restart happens before dispatch", () => {
    const path = databasePath();
    const store = createStore(path, { encryptionKey: "k" });
    const reversal = [{ type: "tag", id: "tag-queued-undo", name: "queued" }] as const;
    const undoId = store.recordUndoable({
      sessionId: "session-queued-undo",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      actionName: "clockify_tags_create",
      reversal: [...reversal],
    });
    const operationId = store.startUndoOperation(undoId, {
      id: "op-queued-undo",
      sessionId: "session-queued-undo",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      actionName: "undo",
      actionFingerprint: "undo-fingerprint",
      catalogHash: "catalog",
      operationHash: "operation",
      operation: { undoId, reversal },
      mutationPlan: {
        mode: "single",
      maxHostCalls: 60,
        steps: [{ id: "undo-0-tag-delete", kind: "primary", reconciliationStrategy: "delete" }],
      },
    });
    expect(operationId).toBe("op-queued-undo");
    const stepId = store.prepareOperationStep({
      operationId: operationId!,
      planStepId: "undo-0-tag-delete",
      index: 0,
      name: "Delete tag",
      kind: "primary",
    });
    expect(store.markOperationStepExecuting(stepId)).toBe(true);
    store.close();

    const recovered = createStore(path, { encryptionKey: "k" });
    const operation = recovered.getOperationRun(operationId!);
    const undo = recovered.getUndoRecord(undoId);
    expect(operation).toMatchObject({ status: "definitive_failed" });
    expect(undo).toMatchObject({ status: "failed", remaining: reversal });
    expect(operation?.actionResultId).toBeDefined();
    expect(undo?.actionResultId).toBe(operation?.actionResultId);
    expect(recovered.getActionResult(operation!.actionResultId!)).toMatchObject({
      kind: "receipt",
      receipt: { ok: false, action: "undo", code: "operation_cancelled_before_dispatch" },
    });
    recovered.close();
  });
});
