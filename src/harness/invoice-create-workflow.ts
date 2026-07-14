import type {
  ActionContext,
  CommitResult,
  ConfirmableOperation,
} from "./action.js";
import type {
  AddInvoiceItemInput,
  CreateInvoiceInput,
  InvoiceDetail,
} from "../clockify/ports/invoices.js";
import type { InvoiceCreateProvenance } from "./invoice-provenance.js";
import {
  invoiceCreateFingerprint,
  invoiceDetailFingerprint,
  type InvoiceCreateIntent,
} from "./invoice-reconciliation.js";
import { executeDurableRiskyStep } from "./durable-risky-write.js";
import { isJournalDegradedStep, withJournalDegradedWarning } from "./mutation-workflow.js";
import { errorReceipt, successReceipt, type SuccessReceipt } from "./receipts.js";
import type { JournaledMutationStep } from "./mutation-contract.js";

export interface InvoiceCreatePayload extends InvoiceCreateIntent, Record<string, unknown> {
  provenance: InvoiceCreateProvenance;
  invoiceBaseline: { ids: string[]; truncated: boolean };
  finalFingerprint: string;
}

export function buildInvoiceCreatePayload(input: {
  base: CreateInvoiceInput;
  enrichment: Record<string, unknown>;
  items: AddInvoiceItemInput[];
  provenance: InvoiceCreateProvenance;
  invoiceBaseline: { ids: string[]; truncated: boolean };
}): InvoiceCreatePayload {
  const intent = { base: input.base, enrichment: input.enrichment, items: input.items };
  return {
    ...input,
    finalFingerprint: invoiceCreateFingerprint(intent),
  };
}

function createdReceipt(
  ctx: ActionContext,
  invoice: { id: string; name?: string },
  requested: number,
  added: number,
): SuccessReceipt {
  return successReceipt({
    action: "clockify_invoices_create",
    entity: "invoice",
    ids: { workspaceId: ctx.workspaceId },
    changed: { created: [{ type: "invoice", id: invoice.id, name: invoice.name }] },
    data: requested ? { itemsRequested: requested, itemsAdded: added } : undefined,
  });
}

function partialCreate(
  ctx: ActionContext,
  invoice: { id: string; name?: string },
  requested: number,
  added: number,
  failedStep: string,
  degraded = false,
): Extract<CommitResult, { kind: "partial" }> {
  const receipt = createdReceipt(ctx, invoice, requested, added);
  return {
    kind: "partial",
    receipt: {
      ...receipt,
      warnings: [{
        code: degraded ? "operation_journal_degraded" : "invoice_partially_created",
        message: degraded
          ? "Clockify confirmed a step, but its full local journal record could not be saved."
          : `The invoice exists, but ${failedStep} was not completed.`,
      }],
    },
    message: `Invoice ${invoice.name ?? invoice.id} exists, but ${failedStep} did not complete.`,
    recovery: {
      hint: `Open invoice ${invoice.name ?? invoice.id} in Clockify, review the completed fields/items, and apply only the missing change. The created invoice can also be deleted manually.`,
      retryable: false,
    },
  };
}

function unknownCreate(action: string, invoice?: { id: string; name?: string }) {
  return errorReceipt({
    action,
    code: "commit_outcome_unknown",
    message: invoice
      ? `Invoice ${invoice.name ?? invoice.id} exists, but Clockify did not give a definitive response for a later step.`
      : "Clockify did not give a definitive response for invoice creation.",
    recovery: {
      hint: invoice
        ? `Review invoice ${invoice.name ?? invoice.id} and its items before deciding what to do next.`
        : "Search Clockify for the exact invoice number and verify its fields before deciding whether to try again.",
      retryable: false,
    },
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

async function reconcileBaseCreate(input: {
  ctx: ActionContext;
  payload: InvoiceCreatePayload;
  baseline: { ids: string[]; truncated: false };
  unknownStep: JournaledMutationStep;
}): Promise<InvoiceDetail | undefined> {
  const evidence: Record<string, unknown> = {
    strategy: "invoice_complete_create_exact",
    baselineComplete: true,
    expectedFingerprint: input.payload.finalFingerprint,
  };
  if (Object.keys(input.payload.enrichment).length > 0 || input.payload.items.length > 0) {
    evidence.reason = "composite_create_not_authoritatively_observable";
    tryRecordReconciliation({
      ctx: input.ctx,
      stepId: input.unknownStep.id,
      evidence,
      authoritative: false,
    });
    return undefined;
  }
  try {
    const after = await input.ctx.clockify.listInvoices();
    evidence.postComplete = !after.truncated;
    if (after.truncated) {
      evidence.reason = "post_list_truncated";
      tryRecordReconciliation({
        ctx: input.ctx,
        stepId: input.unknownStep.id,
        evidence,
        authoritative: false,
      });
      return undefined;
    }
    const baseline = new Set(input.baseline.ids);
    const candidateIds = after.rows
      .map((row) => row.id)
      .filter((id): id is string => typeof id === "string" && !baseline.has(id));
    const matches: InvoiceDetail[] = [];
    for (const id of candidateIds) {
      const detail = await input.ctx.clockify.getInvoice(id);
      if (detail && invoiceDetailFingerprint(detail, input.payload) === input.payload.finalFingerprint) {
        matches.push(detail);
      }
    }
    evidence.candidateCount = candidateIds.length;
    evidence.matchCount = matches.length;
    if (matches.length !== 1) {
      evidence.reason = "non_unique";
      tryRecordReconciliation({
        ctx: input.ctx,
        stepId: input.unknownStep.id,
        evidence,
        authoritative: false,
      });
      return undefined;
    }
    evidence.matchedId = matches[0]!.id;
    if (!tryRecordReconciliation({
      ctx: input.ctx,
      stepId: input.unknownStep.id,
      evidence,
      authoritative: true,
    })) return undefined;
    if (input.ctx.mutationJournal) {
      try {
        input.ctx.mutationJournal.settleReconciledStep(input.unknownStep.id, "succeeded", {
          externalId: matches[0]!.id,
          effect: { created: { type: "invoice", id: matches[0]!.id } },
          detail: { authoritativeReconciliation: true, strategy: "invoice_complete_create_exact" },
        });
      } catch {
        tryRecordReconciliation({
          ctx: input.ctx,
          stepId: input.unknownStep.id,
          evidence: { ...evidence, reason: "reconciliation_settlement_failed" },
          authoritative: false,
        });
        return undefined;
      }
    }
    return matches[0];
  } catch (error) {
    evidence.reason = "read_failed";
    evidence.errorType = error instanceof Error ? error.name : "UnknownError";
    tryRecordReconciliation({
      ctx: input.ctx,
      stepId: input.unknownStep.id,
      evidence,
      authoritative: false,
    });
    return undefined;
  }
}

export async function commitInvoiceCreate(input: {
  ctx: ActionContext;
  operation: ConfirmableOperation;
  payload: InvoiceCreatePayload;
}): Promise<CommitResult> {
  const { ctx, operation, payload } = input;
  let baseline: { ids: string[]; truncated: false };
  try {
    const current = await ctx.clockify.listInvoices();
    if (current.truncated) {
      return errorReceipt({
        action: operation.actionName,
        code: "create_baseline_unavailable",
        message: "Clockify returned an incomplete invoice list immediately before dispatch. No invoice was created.",
        recovery: { hint: "Refresh and preview the invoice again when the complete list is available.", retryable: true },
      });
    }
    baseline = { ids: current.rows.map((row) => row.id), truncated: false };
  } catch {
    return errorReceipt({
      action: operation.actionName,
      code: "create_baseline_unavailable",
      message: "The invoice list could not be read immediately before dispatch. No invoice was created.",
      recovery: { hint: "Refresh and preview the invoice again after Clockify reads recover.", retryable: true },
    });
  }
  const preparedDetail = {
    preDispatch: {
      strategy: "invoice_create_baseline",
      ids: baseline.ids,
      truncated: false,
    },
  };
  let invoice: { id: string; name?: string } | undefined;
  let added = 0;
  const createStep = await executeDurableRiskyStep({
    ctx,
    operation,
    planStepId: "create-invoice",
    index: 0,
    name: "Create invoice",
    preparedDetail,
    dispatch: async () => {
      const created = await ctx.clockify.createInvoiceBase(payload.base);
      invoice = { id: created.id, name: created.name };
      return {
        externalId: created.id,
        effect: { created: { type: "invoice", id: created.id, name: created.name } },
      };
    },
  });
  if (createStep.status === "definitive_failed") {
    return errorReceipt({
      action: operation.actionName,
      code: "write_failed",
      message: "Clockify definitively rejected invoice creation.",
      recovery: { hint: "Correct the invoice details and preview again.", retryable: true },
    });
  }
  if (createStep.status === "outcome_unknown") {
    const reconciled = await reconcileBaseCreate({ ctx, payload, baseline, unknownStep: createStep });
    if (!reconciled) return unknownCreate(operation.actionName);
    invoice = { id: reconciled.id, name: reconciled.number ?? reconciled.id };
  } else if (!invoice && createStep.externalId) {
    invoice = { id: createStep.externalId, name: payload.base.number };
  }
  if (!invoice) return unknownCreate(operation.actionName);
  if (isJournalDegradedStep(createStep)) {
    return operation.mutationPlan?.steps.length === 1
      ? withJournalDegradedWarning(createdReceipt(ctx, invoice, payload.items.length, added))
      : partialCreate(ctx, invoice, payload.items.length, added, "later invoice steps", true);
  }

  let index = 1;
  if (Object.keys(payload.enrichment).length > 0) {
    let body: Record<string, unknown>;
    try {
      body = await ctx.clockify.prepareInvoiceFieldUpdate(invoice.id, payload.enrichment);
    } catch {
      return partialCreate(ctx, invoice, payload.items.length, added, "the enrichment preflight read");
    }
    const enrichment = await executeDurableRiskyStep({
      ctx,
      operation,
      planStepId: "enrich-invoice",
      index,
      name: "Enrich invoice fields",
      dispatch: async () => {
        const updated = await ctx.clockify.updateInvoiceFields(invoice!.id, body);
        return { externalId: updated.id, effect: { updated: { type: "invoice", id: updated.id } } };
      },
    });
    index += 1;
    if (enrichment.status === "outcome_unknown") return unknownCreate(operation.actionName, invoice);
    if (enrichment.status === "definitive_failed") {
      return partialCreate(ctx, invoice, payload.items.length, added, "the requested invoice fields");
    }
    if (isJournalDegradedStep(enrichment)) {
      return partialCreate(ctx, invoice, payload.items.length, added, "later invoice steps", true);
    }
  }

  for (let itemIndex = 0; itemIndex < payload.items.length; itemIndex += 1) {
    const item = payload.items[itemIndex]!;
    const step = await executeDurableRiskyStep({
      ctx,
      operation,
      planStepId: `add-invoice-item-${itemIndex}`,
      index,
      name: `Add invoice item ${itemIndex + 1}`,
      dispatch: async () => {
        await ctx.clockify.addInvoiceItemAtomic(invoice!.id, item);
        return { effect: { addedItem: itemIndex, invoiceId: invoice!.id } };
      },
    });
    index += 1;
    if (step.status === "outcome_unknown") return unknownCreate(operation.actionName, invoice);
    if (step.status === "definitive_failed") {
      return partialCreate(ctx, invoice, payload.items.length, added, `line item ${itemIndex + 1}`);
    }
    added += 1;
    if (isJournalDegradedStep(step)) {
      return partialCreate(ctx, invoice, payload.items.length, added, "later invoice steps", true);
    }
  }
  return createdReceipt(ctx, invoice, payload.items.length, added);
}
