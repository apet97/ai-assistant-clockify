import { createStore } from "../../src/db/store.js";
import type { ActionContext } from "../../src/harness/action.js";
import type { EntityRef } from "../../src/harness/receipts.js";
import type { ExternalMutationPlan } from "../../src/harness/mutation-contract.js";
import { undoMutationPlan } from "../../src/harness/undo.js";

/**
 * C4: the one undo path is the durable one, so tests drive it the way
 * production does.
 *
 * This composes the REAL SQLite store rather than a hand-authored journal
 * fake. `reverseCreationDurably` refuses a context whose `mutationJournal` is
 * absent or bound to a different operation (undo.ts:187-189) and re-derives
 * the plan's step ids itself (:190-194), so a permissive fake here would prove
 * nothing — exactly the failure mode CLAUDE.md warns about. The setup mirrors
 * `confirmation-service.ts:370-416`: record the undoable, build the plan with
 * the production `undoMutationPlan`, start the undo operation, and hand the
 * action context the store's own step journal.
 */
export interface DurableUndoHarness {
  context: ActionContext;
  operationId: string;
  plan: ExternalMutationPlan;
  close: () => void;
}

let counter = 0;

export function durableUndoHarness(base: ActionContext, refs: EntityRef[]): DurableUndoHarness {
  const store = createStore(":memory:", { encryptionKey: "test-key" });
  counter += 1;
  const sessionId = `session-undo-${counter}`;
  const undoId = store.recordUndoable({
    sessionId,
    workspaceId: base.workspaceId,
    adminUserId: base.adminUserId,
    actionName: "clockify_create_work_package",
    reversal: refs,
  });
  const plan = undoMutationPlan(refs);
  const operationId = store.startUndoOperation(undoId, {
    id: `op-undo-${counter}`,
    sessionId,
    workspaceId: base.workspaceId,
    adminUserId: base.adminUserId,
    actionName: "undo",
    actionFingerprint: "undo-fingerprint",
    catalogHash: "catalog",
    operationHash: `operation-${counter}`,
    operation: { undoId, reversal: refs },
    mutationPlan: plan,
  });
  if (!operationId) throw new Error("durable_undo_harness_operation_not_started");
  return {
    context: { ...base, mutationJournal: store.mutationStepJournal(operationId) },
    operationId,
    plan,
    close: () => store.close(),
  };
}
