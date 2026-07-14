import type { ActionContext, CommitResult, ConfirmableOperation } from "./action.js";
import { executeDurableRiskyStep } from "./durable-risky-write.js";
import { isJournalDegradedStep, withJournalDegradedWarning } from "./mutation-workflow.js";
import { errorReceipt, successReceipt, type SuccessReceipt } from "./receipts.js";

export interface InvoiceUpdatePayload extends Record<string, unknown> {
  id: string;
  patch: Record<string, unknown>;
  updateBody?: Record<string, unknown>;
  status?: string;
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
  if (input.payload.updateBody) {
    const fields = await executeDurableRiskyStep({
      ctx: input.ctx,
      operation: input.operation,
      planStepId: "update-invoice-fields",
      index,
      name: "Update invoice fields",
      dispatch: async () => {
        const entity = await input.ctx.clockify.updateInvoiceFields(input.payload.id, input.payload.updateBody!);
        name = entity.name;
        return { externalId: entity.id, effect: { updated: { type: "invoice", id: entity.id } } };
      },
    });
    index += 1;
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
    const status = await executeDurableRiskyStep({
      ctx: input.ctx,
      operation: input.operation,
      planStepId: "update-invoice-status",
      index,
      name: "Update invoice status",
      dispatch: async () => {
        const entity = await input.ctx.clockify.updateInvoiceStatus(input.payload.id, input.payload.status!);
        name ??= entity.name;
        return { externalId: entity.id, effect: { status: input.payload.status } };
      },
    });
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
