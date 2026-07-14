import type {
  ActionContext,
  CommitResult,
  ConfirmableOperation,
} from "./action.js";
import type { CreateInvoicePaymentInput } from "../clockify/ports/invoices.js";
import {
  matchNewPayment,
  type PaymentBaseline,
} from "./invoice-reconciliation.js";
import { executeDurableRiskyStep } from "./durable-risky-write.js";
import { isJournalDegradedStep, withJournalDegradedWarning } from "./mutation-workflow.js";
import { errorReceipt, successReceipt, type SuccessReceipt } from "./receipts.js";

export interface InvoicePaymentCreatePayload extends Record<string, unknown> {
  invoiceId: string;
  payment: CreateInvoicePaymentInput;
  paymentBaseline: PaymentBaseline;
}

function paymentSuccess(
  ctx: ActionContext,
  invoiceId: string,
  paymentId?: string,
): SuccessReceipt {
  return paymentId
    ? successReceipt({
        action: "clockify_invoices_payments_create",
        entity: "invoice",
        ids: { workspaceId: ctx.workspaceId, invoiceId },
        changed: { created: [{ type: "payment", id: paymentId }] },
      })
    : successReceipt({
        action: "clockify_invoices_payments_create",
        entity: "invoice",
        ids: { workspaceId: ctx.workspaceId, invoiceId },
        changed: { updated: [{ type: "invoice", id: invoiceId }] },
        warnings: [{
          code: "payment_id_unknown",
          message: "Payment recorded, but its id could not be determined authoritatively.",
        }],
      });
}

async function readPaymentMatch(
  ctx: ActionContext,
  payload: InvoicePaymentCreatePayload,
  baseline: PaymentBaseline,
) {
  const after = await ctx.clockify.listInvoicePayments(payload.invoiceId);
  return matchNewPayment({
    baseline,
    after,
    amountMinor: payload.payment.amountMinor,
    paymentDate: payload.payment.paymentDate,
    note: payload.payment.note,
  });
}

function tryRecordReconciliation(input: {
  ctx: ActionContext;
  stepId: string;
  evidence: unknown;
  authoritative: boolean;
}): boolean {
  if (!input.ctx.mutationJournal) return true;
  try {
    input.ctx.mutationJournal.recordReconciliation(
      input.stepId,
      input.evidence,
      input.authoritative,
    );
    return true;
  } catch {
    return false;
  }
}

export async function commitInvoicePaymentCreate(input: {
  ctx: ActionContext;
  operation: ConfirmableOperation;
  payload: InvoicePaymentCreatePayload;
}): Promise<CommitResult> {
  let baseline: PaymentBaseline;
  try {
    const current = await input.ctx.clockify.listInvoicePayments(input.payload.invoiceId);
    if (current.truncated) {
      return errorReceipt({
        action: input.operation.actionName,
        code: "payment_baseline_unavailable",
        message: "Clockify returned an incomplete payment list immediately before dispatch. No payment was posted.",
        recovery: { hint: "Refresh the invoice and preview the payment again when the complete list is available.", retryable: true },
      });
    }
    baseline = {
      ids: current.rows.flatMap((row) => typeof row.id === "string" ? [row.id] : []),
      truncated: false,
    };
  } catch {
    return errorReceipt({
      action: input.operation.actionName,
      code: "payment_baseline_unavailable",
      message: "The payment list could not be read immediately before dispatch. No payment was posted.",
      recovery: { hint: "Refresh and preview the payment again after Clockify reads recover.", retryable: true },
    });
  }
  const step = await executeDurableRiskyStep({
    ctx: input.ctx,
    operation: input.operation,
    planStepId: "record-payment",
    index: 0,
    name: "Record invoice payment",
    preparedDetail: {
      preDispatch: {
        strategy: "invoice_payment_baseline",
        ids: baseline.ids,
        truncated: false,
      },
    },
    dispatch: async () => {
      await input.ctx.clockify.createInvoicePaymentAtomic(input.payload.invoiceId, input.payload.payment);
      return { effect: { updated: { type: "invoice", id: input.payload.invoiceId } } };
    },
  });

  if (step.status === "definitive_failed") {
    return errorReceipt({
      action: input.operation.actionName,
      code: "write_failed",
      message: "Clockify definitively rejected the payment.",
      recovery: { hint: "Correct the payment details and preview again.", retryable: true },
    });
  }

  if (step.status === "outcome_unknown") {
    let match: Awaited<ReturnType<typeof readPaymentMatch>>;
    try {
      match = await readPaymentMatch(input.ctx, input.payload, baseline);
    } catch (error) {
      tryRecordReconciliation({
        ctx: input.ctx,
        stepId: step.id,
        evidence: {
          strategy: "invoice_payment_exact_new_row",
          authoritative: false,
          reason: "read_failed",
          errorType: error instanceof Error ? error.name : "UnknownError",
        },
        authoritative: false,
      });
      return errorReceipt({
        action: input.operation.actionName,
        code: "commit_outcome_unknown",
        message: "Clockify may have recorded the payment, but its outcome cannot be identified authoritatively.",
        recovery: { hint: "Inspect the invoice payment list before deciding whether to retry.", retryable: false },
      });
    }
    const evidence = {
      strategy: "invoice_payment_exact_new_row",
      baselineComplete: true,
      authoritative: match.authoritative,
      matches: match.matches,
      ...(match.reason ? { reason: match.reason } : {}),
      ...(match.id ? { matchedId: match.id } : {}),
    };
    const recorded = tryRecordReconciliation({
      ctx: input.ctx,
      stepId: step.id,
      evidence,
      authoritative: match.authoritative,
    });
    if (recorded && match.authoritative && match.id) {
      try {
        input.ctx.mutationJournal?.settleReconciledStep(step.id, "succeeded", {
          externalId: match.id,
          effect: { created: { type: "payment", id: match.id } },
          detail: { authoritativeReconciliation: true },
        });
        return paymentSuccess(input.ctx, input.payload.invoiceId, match.id);
      } catch {
        tryRecordReconciliation({
          ctx: input.ctx,
          stepId: step.id,
          evidence: { ...evidence, reason: "reconciliation_settlement_failed" },
          authoritative: false,
        });
      }
    }
    return errorReceipt({
      action: input.operation.actionName,
      code: "commit_outcome_unknown",
      message: "Clockify may have recorded the payment, but its outcome cannot be identified authoritatively.",
      recovery: { hint: "Inspect the invoice payment list before deciding whether to retry.", retryable: false },
    });
  }

  let receipt: SuccessReceipt;
  try {
    const match = await readPaymentMatch(input.ctx, input.payload, baseline);
    receipt = paymentSuccess(
      input.ctx,
      input.payload.invoiceId,
      match.authoritative ? match.id : undefined,
    );
  } catch {
    // The POST itself is known successful. A failed read cannot rewrite it as
    // unknown or failure; omit unsafe payment identity/undo instead.
    receipt = paymentSuccess(input.ctx, input.payload.invoiceId);
  }
  return isJournalDegradedStep(step) ? withJournalDegradedWarning(receipt) : receipt;
}
