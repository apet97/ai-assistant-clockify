import type { ActionContext, CommitResult, ConfirmableOperation, TargetSnapshot } from "./action.js";
import { executeDurableRiskyStep } from "./durable-risky-write.js";
import { isJournalDegradedStep, withJournalDegradedWarning } from "./mutation-workflow.js";
import { errorReceipt, successReceipt, type SuccessReceipt } from "./receipts.js";
import { captureTargetSnapshot, verifyTargetSnapshots } from "./target-snapshots.js";
import { DefinitiveWriteFailure } from "../clockify/write-outcome.js";
import { dispatchWithReconciliation, reconcileExactUpdate } from "./workflows/structure-durable.js";

export interface InvoiceUpdatePayload extends Record<string, unknown> {
  id: string;
  patch: Record<string, unknown>;
  updateBody?: Record<string, unknown>;
  status?: string;
  expectedAfterFields?: Record<string, unknown>;
  expectedAfterStatus?: Record<string, unknown>;
}

async function fetchSnapshot(ctx: ActionContext, snapshot: TargetSnapshot) {
  if (snapshot.ref.type === "client") {
    const client = await ctx.clockify.getClient(snapshot.ref.id);
    return client ? { ref: { type: "client", id: client.id, name: client.name }, projection: client, truncated: false } : undefined;
  }
  const invoice = await ctx.clockify.getInvoice(snapshot.ref.id);
  return invoice ? { ref: { type: "invoice", id: invoice.id, ...(invoice.number ? { name: invoice.number } : {}) }, projection: invoice, truncated: false } : undefined;
}

function updateReceipt(ctx: ActionContext, id: string, name?: string): SuccessReceipt {
  return successReceipt({
    action: "clockify_invoices_update",
    entity: "invoice",
    ids: { workspaceId: ctx.workspaceId },
    changed: { updated: [{ type: "invoice", id, name }] },
  });
}

function unknown(operation: ConfirmableOperation, id: string) {
  return errorReceipt({
    action: operation.actionName,
    code: "commit_outcome_unknown",
    message: `Clockify did not give a definitive response while updating invoice ${id}. No later step was dispatched.`,
    recovery: { hint: "Refresh the invoice and verify its fields/status before previewing another update.", retryable: false },
  });
}

function partial(
  ctx: ActionContext,
  id: string,
  failed: string,
  journalDegraded = false,
): Extract<CommitResult, { kind: "partial" }> {
  const receipt = updateReceipt(ctx, id);
  return {
    kind: "partial",
    receipt: journalDegraded
      ? {
          ...receipt,
          warnings: [{
            code: "operation_journal_degraded",
            message: "Clockify confirmed the status change, but its full local step record could not be saved.",
          }],
        }
      : receipt,
    message: journalDegraded
      ? `Invoice ${id} fields and status were applied, but the local status journal did not settle fully.`
      : `Invoice ${id} was updated partially; ${failed} did not complete.`,
    recovery: {
      hint: journalDegraded
        ? "Refresh the invoice and verify both applied changes; do not retry this combined operation."
        : "Refresh the invoice, then preview only the missing change.",
      retryable: false,
    },
  };
}

export async function commitInvoiceUpdate(input: {
  ctx: ActionContext;
  operation: ConfirmableOperation;
  payload: InvoiceUpdatePayload;
}): Promise<CommitResult> {
  let index = 0;
  let completed = 0;
  let name: string | undefined;
  const originalTarget = input.operation.targetSnapshots?.find((snapshot) => snapshot.ref.type === "invoice");
  if (!originalTarget) return errorReceipt({ action: input.operation.actionName, code: "stale_target", message: "The invoice target is missing. Create a fresh preview." });
  if (input.payload.updateBody) {
    let verificationFailure: "stale_target" | "stale_parent" | undefined;
    const fields = await executeDurableRiskyStep({
      ctx: input.ctx,
      operation: input.operation,
      planStepId: "update-invoice-fields",
      index,
      name: "Update invoice fields",
      preparedDetail: { targetSnapshots: input.operation.targetSnapshots ?? [] },
      dispatch: async () => {
        const verified = await verifyTargetSnapshots(input.operation.targetSnapshots ?? [], (snapshot) => fetchSnapshot(input.ctx, snapshot));
        if (!verified.ok) {
          verificationFailure = verified.code;
          throw new DefinitiveWriteFailure("VERIFY", "update-invoice-fields", verified.code);
        }
        const result = await dispatchWithReconciliation({
          dispatch: () => input.ctx.clockify.updateInvoiceFields(input.payload.id, input.payload.updateBody!),
          reconcile: async () => {
            const row = await reconcileExactUpdate(
              () => input.ctx.clockify.getInvoice(input.payload.id),
              input.payload.expectedAfterFields,
              (invoice) => invoice,
            );
            return row ? { id: row.id, name: row.number ?? row.id } : undefined;
          },
        });
        const entity = result.value;
        name = entity.name;
        return { externalId: entity.id, effect: { updated: { type: "invoice", id: entity.id } }, detail: { reconciled: result.reconciled } };
      },
    });
    index += 1;
    if (verificationFailure) return errorReceipt({ action: input.operation.actionName, code: verificationFailure, message: "The invoice or replacement client changed before the field update.", recovery: { hint: "Refresh the invoice and preview again." } });
    if (fields.status === "outcome_unknown") return unknown(input.operation, input.payload.id);
    if (fields.status === "definitive_failed") {
      return errorReceipt({
        action: input.operation.actionName,
        code: "write_failed",
        message: "Clockify definitively rejected the invoice field update.",
        recovery: { hint: "Correct the fields and preview again.", retryable: true },
      });
    }
    completed += 1;
    if (isJournalDegradedStep(fields) && input.payload.status) {
      return partial(input.ctx, input.payload.id, "the status step was not dispatched after journal degradation");
    }
    if (isJournalDegradedStep(fields)) {
      return withJournalDegradedWarning(updateReceipt(input.ctx, input.payload.id, name));
    }
  }
  if (input.payload.status) {
    const expectedBeforeStatus = input.payload.expectedAfterFields ?? originalTarget.projection as Record<string, unknown>;
    const statusTarget = captureTargetSnapshot("target", originalTarget.ref, expectedBeforeStatus);
    let verificationFailure: "stale_target" | "stale_parent" | undefined;
    const status = await executeDurableRiskyStep({
      ctx: input.ctx,
      operation: input.operation,
      planStepId: "update-invoice-status",
      index,
      name: "Update invoice status",
      preparedDetail: { targetSnapshots: [statusTarget] },
      dispatch: async () => {
        const verified = await verifyTargetSnapshots([statusTarget], (snapshot) => fetchSnapshot(input.ctx, snapshot));
        if (!verified.ok) {
          verificationFailure = verified.code;
          throw new DefinitiveWriteFailure("VERIFY", "update-invoice-status", verified.code);
        }
        const result = await dispatchWithReconciliation({
          dispatch: () => input.ctx.clockify.updateInvoiceStatus(input.payload.id, input.payload.status!),
          reconcile: async () => {
            const row = await reconcileExactUpdate(
              () => input.ctx.clockify.getInvoice(input.payload.id),
              input.payload.expectedAfterStatus,
              (invoice) => invoice,
            );
            return row ? { id: row.id, name: row.number ?? row.id } : undefined;
          },
        });
        const entity = result.value;
        name ??= entity.name;
        return { externalId: entity.id, effect: { status: input.payload.status }, detail: { reconciled: result.reconciled } };
      },
    });
    if (verificationFailure) {
      return completed > 0
        ? partial(input.ctx, input.payload.id, "the invoice changed before the status update")
        : errorReceipt({ action: input.operation.actionName, code: verificationFailure, message: "The invoice changed before the status update.", recovery: { hint: "Refresh the invoice and preview again." } });
    }
    if (status.status === "outcome_unknown") return unknown(input.operation, input.payload.id);
    if (status.status === "definitive_failed") {
      return completed > 0
        ? partial(input.ctx, input.payload.id, "the status update")
        : errorReceipt({
            action: input.operation.actionName,
            code: "write_failed",
            message: "Clockify definitively rejected the invoice status update.",
            recovery: { hint: "Correct the status and preview again.", retryable: true },
          });
    }
    if (isJournalDegradedStep(status)) {
      if (completed > 0) {
        return partial(input.ctx, input.payload.id, "the local status journal", true);
      }
      return withJournalDegradedWarning(updateReceipt(input.ctx, input.payload.id, name));
    }
  }
  return updateReceipt(input.ctx, input.payload.id, name);
}
