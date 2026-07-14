import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createStore, type Store } from "../../src/db/store.js";
import { createPendingConfirmation } from "../../src/harness/confirmations.js";
import { successReceipt } from "../../src/harness/receipts.js";

const now = new Date("2026-07-14T10:00:00.000Z");

function preparedConfirmation(store: Store) {
  const session = store.createSession({ workspaceId: "workspace", adminUserId: "admin" });
  const operation = {
    operationId: "operation-confirm",
    actionName: "clockify_tags_update",
    featureGroup: "work_structure" as const,
    risks: ["high_risk_write" as const],
    payload: { id: "tag-1", patch: { name: "New" } },
  };
  const created = createPendingConfirmation({
    sessionId: session.id,
    workspaceId: "workspace",
    adminUserId: "admin",
    risk: operation.risks,
    preview: {
      actionLabel: "Update tag",
      featureGroup: "work_structure",
      riskLabels: operation.risks,
      targets: [{ type: "tag", id: "tag-1" }],
      expectedChanges: ["Rename tag"],
      reversibility: "Rename it back",
      warnings: [],
    },
    operation,
    sessionSecret: "test-secret",
    now,
  });
  store.prepareOperationRun({
    id: created.record.operationId,
    confirmationId: created.record.id,
    sessionId: session.id,
    workspaceId: "workspace",
    adminUserId: "admin",
    actionName: operation.actionName,
    actionFingerprint: "action",
    catalogHash: "catalog",
    operationHash: created.record.operationHash,
    operation: { id: "tag-1", patch: { name: "New" } },
    mutationPlan: { mode: "single", steps: [{ id: "update-tag", kind: "primary" }] },
  });
  store.savePendingConfirmation(created.record);
  return created.record;
}

describe("atomic confirmed-operation settlement", () => {
  it("does not claim a confirmation whose operation lifecycle was already started", () => {
    const store = createStore(":memory:", { now: () => now });
    const confirmation = preparedConfirmation(store);
    expect(store.markOperationExecuting(confirmation.operationId)).toBe(true);

    expect(() => store.markConfirmationExecuting(confirmation.id))
      .toThrow(/operation_not_prepared/);
    expect(store.getPendingConfirmation(confirmation.id)).toMatchObject({
      status: "pending",
      actionResultId: undefined,
    });
    expect(store.getOperationRun(confirmation.operationId)).toMatchObject({ status: "executing" });
    expect(store.getOperationRun(confirmation.operationId)?.actionResultId).toBeUndefined();
    store.close();
  });

  it("keeps normalized operation intent after claim-time confirmation scrubbing", () => {
    const store = createStore(":memory:", { now: () => now });
    const confirmation = preparedConfirmation(store);

    expect(store.markConfirmationExecuting(confirmation.id)).toBe(true);

    expect(store.getPendingConfirmation(confirmation.id)?.operation).toEqual({});
    expect(store.getOperationRun(confirmation.operationId)).toMatchObject({
      status: "executing",
      operation: { id: "tag-1", patch: { name: "New" } },
      mutationPlan: { mode: "single", steps: [{ id: "update-tag", kind: "primary" }] },
    });
    store.close();
  });

  it("settles operation, confirmation, and canonical partial result in one transaction", () => {
    const store = createStore(":memory:", { now: () => now });
    const confirmation = preparedConfirmation(store);
    store.markConfirmationExecuting(confirmation.id);
    const receipt = successReceipt({
      action: "clockify_tags_update",
      changed: { updated: [{ type: "tag", id: "tag-1" }] },
    });
    const partial = {
      kind: "partial" as const,
      receipt,
      message: "The first change applied before a later step failed.",
      recovery: { hint: "Review the tag before retrying.", retryable: false },
    };

    const ref = store.settleConfirmedOperation(
      confirmation.id,
      "partial",
      "clockify_tags_update",
      partial,
    );

    expect(ref.kind).toBe("partial");
    expect(store.getActionResult(ref.id)).toEqual(partial);
    expect(store.getOperationRun(confirmation.operationId)).toMatchObject({
      status: "partial",
      actionResultId: ref.id,
    });
    expect(store.getPendingConfirmation(confirmation.id)).toMatchObject({
      status: "partial",
      actionResultId: ref.id,
      operation: {},
    });
    store.close();
  });

  it("rolls all three settlement writes back when the operation transition fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "confirmed-settlement-"));
    const path = join(dir, "store.sqlite");
    const store = createStore(path, { now: () => now });
    const confirmation = preparedConfirmation(store);
    store.markConfirmationExecuting(confirmation.id);
    const raw = new Database(path);
    raw.exec(`
      CREATE TRIGGER reject_operation_success
      BEFORE UPDATE OF status ON operation_runs
      WHEN NEW.status = 'succeeded'
      BEGIN
        SELECT RAISE(ABORT, 'forced operation settlement failure');
      END;
    `);

    expect(() => store.settleConfirmedOperation(
      confirmation.id,
      "succeeded",
      "clockify_tags_update",
      successReceipt({ action: "clockify_tags_update" }),
    )).toThrow(/forced operation settlement failure/);

    expect(store.getPendingConfirmation(confirmation.id)?.status).toBe("executing");
    expect(store.getOperationRun(confirmation.operationId)?.status).toBe("executing");
    const placeholderId = store.getPendingConfirmation(confirmation.id)?.actionResultId;
    expect(store.getActionResult(placeholderId!)).toMatchObject({
      kind: "receipt",
      receipt: { code: "commit_outcome_unknown" },
    });
    raw.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
