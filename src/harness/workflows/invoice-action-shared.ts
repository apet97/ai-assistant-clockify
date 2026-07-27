import { z } from "zod";
import { zNumberLike } from "../arg-shapes.js";
import type {
  ActionContext,
  CommitResult,
  ConfirmableOperation,
  RiskyClarifyResult,
  RiskyPreviewResult,
  TargetSnapshot,
} from "../action.js";
import { successReceipt } from "../receipts.js";
import { THIRTY_DAYS_MS } from "../../durations.js";
import { describePatch, resolveEntityRef, resolveInstant } from "./resolve.js";
import { dispatchWithReconciliation } from "./structure-durable.js";
import { commitInvoiceUpdate, type InvoiceUpdatePayload } from "../invoice-update-workflow.js";
import { captureTargetSnapshot } from "../target-snapshots.js";
import {
  invoiceCreateFingerprint,
  invoiceDetailFingerprint,
  type InvoiceCreateIntent,
} from "../invoice-reconciliation.js";
import { INVOICE_CREATE_RECONCILIATION_CANDIDATE_MAX } from "../safety-limits.js";
import type { CreateInvoiceInput } from "../../clockify/ports/invoices.js";
import {
  captureInvoiceSnapshot,
  invoiceStatusSchema,
  resolveInvoiceRef,
} from "./invoices.js";

export const invoiceFieldsUpdateSchema = z
  .object({
    id: z.string().min(1),
    number: z.string().optional(),
    issuedDate: z.string().optional(),
    currency: z.string().optional(),
    dueDate: z.string().optional(),
    note: z.string().optional(),
    subject: z.string().optional(),
    clientId: z.string().optional(),
    taxPercent: zNumberLike(z.number().min(0).max(100)).optional(),
    tax2Percent: zNumberLike(z.number().min(0).max(100)).optional(),
    discountPercent: zNumberLike(z.number().min(0).max(100)).optional(),
  })
  .refine(
    (v) =>
      v.number !== undefined ||
      v.issuedDate !== undefined ||
      v.currency !== undefined ||
      v.dueDate !== undefined ||
      v.note !== undefined ||
      v.subject !== undefined ||
      v.clientId !== undefined ||
      v.taxPercent !== undefined ||
      v.tax2Percent !== undefined ||
      v.discountPercent !== undefined,
    { message: "Provide at least one field to change." },
  );

export const invoiceStatusUpdateSchema = z.object({
  id: z.string().min(1),
  status: invoiceStatusSchema,
});

export const invoiceCreateBaseSchema = z
  .object({
    clientId: z.string().min(1).optional(),
    clientName: z.string().min(1).optional(),
    number: z.string().min(1).optional(),
    issuedDate: z.string().min(1).optional(),
    currency: z.string().min(1).optional(),
    dueDate: z.string().min(1).optional(),
  })
  .refine((v) => v.clientId !== undefined || v.clientName !== undefined, {
    message: "Provide the client id or its exact name.",
  });

function nowDate(ctx: ActionContext): Date {
  return (ctx.now ?? (() => new Date()))();
}

async function reconcileCreatedInvoiceBase(
  ctx: ActionContext,
  beforeIds: readonly string[],
  base: CreateInvoiceInput,
) {
  const after = await ctx.clockify.listInvoices();
  if (after.truncated) return undefined;
  const baseline = new Set(beforeIds);
  const candidateIds = after.rows
    .map((row) => row.id)
    .filter((id): id is string => typeof id === "string" && !baseline.has(id));
  if (candidateIds.length > INVOICE_CREATE_RECONCILIATION_CANDIDATE_MAX) return undefined;
  const intent: InvoiceCreateIntent = { base, enrichment: {}, items: [] };
  const fingerprint = invoiceCreateFingerprint(intent);
  const matches = [];
  for (const id of candidateIds) {
    const detail = await ctx.clockify.getInvoice(id);
    if (detail && invoiceDetailFingerprint(detail, intent) === fingerprint) {
      matches.push(detail);
    }
  }
  return matches.length === 1 ? matches[0]! : undefined;
}

export async function prepareInvoiceCreateBase(
  ctx: ActionContext,
  args: z.infer<typeof invoiceCreateBaseSchema>,
) {
  const client = await resolveEntityRef(
    { id: args.clientId, name: args.clientName },
    {
      noun: "client",
      verb: "invoice",
      list: (f) => ctx.clockify.listClients(f),
      notFoundHint: "Or should I create the client first?",
    },
  );
  if (!client.ok) return { kind: "clarify" as const, clarify: client.clarify.clarify };
  const now = nowDate(ctx);
  const stamp = now.toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const issuedDate = args.issuedDate !== undefined
    ? resolveInstant(now, args.issuedDate, "start", ctx.timeZone)
    : now.toISOString();
  const dueDate = args.dueDate !== undefined
    ? resolveInstant(now, args.dueDate, "start", ctx.timeZone)
    : new Date(now.getTime() + THIRTY_DAYS_MS).toISOString();
  const badDates = [
    args.issuedDate !== undefined && issuedDate === undefined ? `issued date "${args.issuedDate}"` : undefined,
    args.dueDate !== undefined && dueDate === undefined ? `due date "${args.dueDate}"` : undefined,
  ].filter((value): value is string => value !== undefined);
  if (badDates.length || issuedDate === undefined || dueDate === undefined) {
    return {
      kind: "clarify" as const,
      clarify: `I couldn't make sense of the ${badDates.join(" and ")} — give me a calendar date (YYYY-MM-DD) or something like today, next monday, or next month.`,
    };
  }
  const baseline = await ctx.clockify.listInvoices();
  if (baseline.truncated) {
    return {
      kind: "clarify" as const,
      clarify: "Clockify returned an incomplete invoice list, so I can't establish a safe create baseline. Retry when a complete list is available.",
    };
  }
  const base: CreateInvoiceInput = {
    clientId: client.id,
    number: args.number ?? `INV-${stamp}`,
    issuedDate,
    dueDate,
    currency: args.currency ?? "USD",
  };
  return {
    operation: {
      base,
      beforeIds: baseline.rows.map((row) => row.id),
    },
  };
}

export async function dispatchInvoiceCreateBase(
  ctx: ActionContext,
  state: { beforeIds: string[]; base: CreateInvoiceInput },
) {
  const result = await dispatchWithReconciliation({
    dispatch: () => ctx.clockify.createInvoiceBase(state.base),
    reconcile: async () => {
      const detail = await reconcileCreatedInvoiceBase(ctx, state.beforeIds, state.base);
      return detail ? { id: detail.id, name: detail.number ?? detail.id } : undefined;
    },
  });
  const invoice = result.value;
  const created = { type: "invoice" as const, id: invoice.id, name: invoice.name };
  return {
    result: successReceipt({
      action: "clockify_invoices_create_base",
      entity: "invoice",
      ids: { workspaceId: ctx.workspaceId },
      changed: { created: [created] },
    }),
    externalId: invoice.id,
    effect: { created },
    detail: { reconciled: result.reconciled, baselineComplete: true },
  };
}

export async function previewInvoiceFieldsUpdate(
  ctx: ActionContext,
  args: z.infer<typeof invoiceFieldsUpdateSchema>,
): Promise<RiskyPreviewResult | RiskyClarifyResult> {
  const resolved = await resolveInvoiceRef(ctx, { id: args.id }, "update");
  if (!resolved.ok) return resolved.clarify;
  const target = await captureInvoiceSnapshot(ctx, resolved.id);
  if (!target) return { clarify: `Invoice ${resolved.number ?? resolved.id} could not be verified.` };

  const now = nowDate(ctx);
  const issuedDate = args.issuedDate !== undefined ? resolveInstant(now, args.issuedDate, "start", ctx.timeZone) : undefined;
  const dueDate = args.dueDate !== undefined ? resolveInstant(now, args.dueDate, "start", ctx.timeZone) : undefined;
  const badDates = [
    args.issuedDate !== undefined && issuedDate === undefined ? `issued date "${args.issuedDate}"` : undefined,
    args.dueDate !== undefined && dueDate === undefined ? `due date "${args.dueDate}"` : undefined,
  ].filter((value): value is string => value !== undefined);
  if (badDates.length) {
    return {
      clarify: `I couldn't make sense of the ${badDates.join(" and ")} — give me a calendar date (YYYY-MM-DD) or something like today, next monday, or next month.`,
    };
  }
  let clientId: string | undefined;
  let clientSnapshot: TargetSnapshot | undefined;
  if (args.clientId !== undefined) {
    const client = await resolveEntityRef(
      { id: args.clientId },
      {
        noun: "client",
        verb: "invoice",
        list: (f) => ctx.clockify.listClients(f),
        notFoundHint: "Or should I create the client first?",
        verifyId: true,
      },
    );
    if (!client.ok) return client.clarify;
    clientId = client.id;
    const clientRow = await ctx.clockify.getClient(client.id);
    if (!clientRow) return { clarify: "The replacement invoice client could not be verified." };
    clientSnapshot = captureTargetSnapshot("parent", { type: "client", id: clientRow.id, name: clientRow.name }, clientRow);
  }

  const patch: Record<string, unknown> = {
    ...(args.number !== undefined ? { number: args.number } : {}),
    ...(issuedDate !== undefined ? { issuedDate } : {}),
    ...(args.currency !== undefined ? { currency: args.currency } : {}),
    ...(dueDate !== undefined ? { dueDate } : {}),
    ...(args.note !== undefined ? { note: args.note } : {}),
    ...(args.subject !== undefined ? { subject: args.subject } : {}),
    ...(clientId !== undefined ? { clientId } : {}),
    ...(args.taxPercent !== undefined ? { taxPercent: args.taxPercent } : {}),
    ...(args.tax2Percent !== undefined ? { tax2Percent: args.tax2Percent } : {}),
    ...(args.discountPercent !== undefined ? { discountPercent: args.discountPercent } : {}),
  };
  let updateBody: Record<string, unknown>;
  try {
    updateBody = await ctx.clockify.prepareInvoiceFieldUpdate(resolved.id, patch);
  } catch {
    return { clarify: "I couldn't read the current invoice fields safely. Refresh the invoice and preview the update again." };
  }
  const currentProjection = structuredClone(target.projection as Record<string, unknown>);
  const expectedAfterFields: Record<string, unknown> = { ...currentProjection };
  for (const key of ["number", "issuedDate", "currency", "dueDate", "note", "subject", "clientId"] as const) {
    if (Object.hasOwn(patch, key)) expectedAfterFields[key] = patch[key];
  }
  if (typeof patch.taxPercent === "number") expectedAfterFields.tax = patch.taxPercent * 100;
  if (typeof patch.tax2Percent === "number") expectedAfterFields.tax2 = patch.tax2Percent * 100;
  if (typeof patch.discountPercent === "number") expectedAfterFields.discount = patch.discountPercent * 100;

  return {
    actionLabel: "Update invoice fields",
    targets: [{ type: "invoice", id: resolved.id, name: resolved.number }],
    expectedChanges: describePatch(patch),
    reversibility: "You can update the invoice again to revert most fields.",
    warnings: ["Updating an invoice changes a live billing document."],
    payload: {
      id: resolved.id,
      patch,
      updateBody,
      expectedAfterFields,
    },
    targetSnapshots: [target, ...(clientSnapshot ? [clientSnapshot] : [])],
    mutationPlan: {
      mode: "single",
      steps: [{ id: "update-invoice-fields", kind: "primary", targetFingerprint: target.fingerprint, reconciliationStrategy: "update" }],
    },
  };
}

export async function previewInvoiceStatusUpdate(
  ctx: ActionContext,
  args: z.infer<typeof invoiceStatusUpdateSchema>,
): Promise<RiskyPreviewResult | RiskyClarifyResult> {
  const resolved = await resolveInvoiceRef(ctx, { id: args.id }, "update");
  if (!resolved.ok) return resolved.clarify;
  const target = await captureInvoiceSnapshot(ctx, resolved.id);
  if (!target) return { clarify: `Invoice ${resolved.number ?? resolved.id} could not be verified.` };

  const currentProjection = structuredClone(target.projection as Record<string, unknown>);
  const expectedAfterStatus = { ...currentProjection, status: args.status };
  const statusTarget = captureTargetSnapshot("target", target.ref, currentProjection);

  return {
    actionLabel: "Update invoice status",
    targets: [{ type: "invoice", id: resolved.id, name: resolved.number }],
    expectedChanges: [`set status → ${args.status}`],
    reversibility: "You can update the invoice status again.",
    warnings: ["Updating an invoice changes a live billing document."],
    payload: {
      id: resolved.id,
      status: args.status,
      expectedAfterFields: currentProjection,
      expectedAfterStatus,
    },
    targetSnapshots: [statusTarget],
    mutationPlan: {
      mode: "single",
      steps: [{ id: "update-invoice-status", kind: "primary", targetFingerprint: statusTarget.fingerprint, reconciliationStrategy: "state-command" }],
    },
  };
}

export function commitInvoiceFieldsUpdate(
  ctx: ActionContext,
  payload: Record<string, unknown>,
  operation: ConfirmableOperation,
): Promise<CommitResult> {
  return commitInvoiceUpdate({
    ctx,
    operation,
    payload: payload as InvoiceUpdatePayload,
  });
}

export function commitInvoiceStatusUpdate(
  ctx: ActionContext,
  payload: Record<string, unknown>,
  operation: ConfirmableOperation,
): Promise<CommitResult> {
  return commitInvoiceUpdate({
    ctx,
    operation,
    payload: payload as InvoiceUpdatePayload,
  });
}
