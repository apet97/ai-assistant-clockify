import { z } from "zod";
import { defineAction, type ActionDefinition } from "../action.js";
import { successReceipt } from "../receipts.js";

/**
 * Typed invoice workflows (goclmcp §2.6). Reads (list/get/items_list/
 * payments_list/export) execute immediately; every mutation is risky and runs
 * preview→commit. Risk classes follow the plan's D3 mapping: create/update/
 * items_add/import = `billing`; delete/items_delete add `destructive`; payments
 * create = `payment`; payment delete = `destructive`+`payment`. All gated by the
 * `invoices` feature group. Amounts use `amountUnit`/`unitPriceUnit` (default
 * `major`) and are stored ALREADY CONVERTED to minor units in the operation
 * payload, so `commit` never re-derives them.
 */

const INV = "invoices" as const;

/** Live invoice statuses (DRAFT is rejected by Clockify; use UNSENT for draft-like). */
const invoiceStatusSchema = z.enum(["UNSENT", "SENT", "PAID", "PARTIALLY_PAID", "VOID", "OVERDUE"]);

/** Resolve a major/minor amount to the integer minor units (cents) Clockify wants. */
function toMinor(amount: number, unit: "major" | "minor"): number {
  return unit === "minor" ? Math.round(amount) : Math.round(amount * 100);
}

const listInvoices = defineAction({
  name: "clockify_invoices_list",
  description: "List invoices (optional live status filter).",
  featureGroup: INV,
  risks: ["read"],
  schema: z.object({ status: invoiceStatusSchema.optional() }),
  async handler(ctx, args) {
    const items = await ctx.clockify.listInvoices(args.status ? { status: args.status } : undefined);
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_invoices_list",
        entity: "invoice",
        ids: { workspaceId: ctx.workspaceId },
        data: { count: items.length, items },
      }),
    };
  },
});

const getInvoice = defineAction({
  name: "clockify_invoices_get",
  description: "Fetch a single invoice by id (line items embedded).",
  featureGroup: INV,
  risks: ["read"],
  schema: z.object({ id: z.string().min(1) }),
  async handler(ctx, args) {
    const entity = await ctx.clockify.getInvoice(args.id);
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_invoices_get",
        entity: "invoice",
        ids: { workspaceId: ctx.workspaceId },
        data: { entity },
      }),
    };
  },
});

const listInvoiceItems = defineAction({
  name: "clockify_invoices_items_list",
  description: "List the line items on an invoice.",
  featureGroup: INV,
  risks: ["read"],
  schema: z.object({ id: z.string().min(1) }),
  async handler(ctx, args) {
    const items = await ctx.clockify.listInvoiceItems(args.id);
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_invoices_items_list",
        entity: "invoice",
        ids: { workspaceId: ctx.workspaceId, invoiceId: args.id },
        data: { count: items.length, items },
      }),
    };
  },
});

const listInvoicePayments = defineAction({
  name: "clockify_invoices_payments_list",
  description: "List the payments recorded against an invoice.",
  featureGroup: INV,
  risks: ["read"],
  schema: z.object({ id: z.string().min(1) }),
  async handler(ctx, args) {
    const items = await ctx.clockify.listInvoicePayments(args.id);
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_invoices_payments_list",
        entity: "invoice",
        ids: { workspaceId: ctx.workspaceId, invoiceId: args.id },
        data: { count: items.length, items },
      }),
    };
  },
});

const exportInvoice = defineAction({
  name: "clockify_invoices_export",
  description: "Export an invoice as a PDF (base64). Read — no confirmation.",
  featureGroup: INV,
  risks: ["read"],
  schema: z.object({ id: z.string().min(1), format: z.enum(["PDF"]).optional() }),
  async handler(ctx, args) {
    const exp = await ctx.clockify.exportInvoice(args.id, args.format);
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_invoices_export",
        entity: "invoice",
        ids: { workspaceId: ctx.workspaceId, invoiceId: args.id },
        data: { contentType: exp.contentType, bytes: exp.bytes, truncated: exp.truncated, base64: exp.base64 },
        warnings: exp.truncated
          ? [
              {
                code: "export_truncated",
                message: `Invoice PDF is ${exp.bytes} bytes, over the inline cap; base64 omitted. Export it from the Clockify UI.`,
              },
            ]
          : undefined,
      }),
    };
  },
});

const createInvoice = defineAction({
  name: "clockify_invoices_create",
  description:
    "Create an invoice for a client. Billing action — previews and requires confirmation. Requires number, issuedDate, currency, and dueDate.",
  featureGroup: INV,
  risks: ["billing"],
  schema: z.object({
    clientId: z.string().min(1),
    clientName: z.string().optional(),
    number: z.string().min(1),
    issuedDate: z.string().min(1), // full ISO or YYYY-MM-DD
    currency: z.string().min(1),
    dueDate: z.string().min(1), // full ISO or YYYY-MM-DD
    note: z.string().optional(),
    subject: z.string().optional(),
  }),
  async handler(ctx, args) {
    const input = {
      clientId: args.clientId,
      number: args.number,
      issuedDate: args.issuedDate,
      currency: args.currency,
      dueDate: args.dueDate,
      ...(args.note !== undefined ? { note: args.note } : {}),
      ...(args.subject !== undefined ? { subject: args.subject } : {}),
    };
    return {
      kind: "preview",
      preview: {
        actionLabel: "Create invoice",
        featureGroup: INV,
        riskLabels: ["billing"],
        targets: [{ type: "client", id: args.clientId, name: args.clientName }],
        expectedChanges: [
          `Create invoice ${args.number} for ${args.clientName ?? args.clientId}`,
          `Issued ${args.issuedDate}, due ${args.dueDate}, ${args.currency}`,
        ],
        reversibility: "You can delete the invoice afterward.",
        warnings: ["This creates a billing document."],
      },
      operation: {
        actionName: "clockify_invoices_create",
        featureGroup: INV,
        risks: ["billing"],
        payload: { input },
      },
    };
  },
  async commit(ctx, operation) {
    const { input } = operation.payload as { input: Parameters<typeof ctx.clockify.createInvoice>[0] };
    const invoice = await ctx.clockify.createInvoice(input);
    return successReceipt({
      action: "clockify_invoices_create",
      entity: "invoice",
      ids: { workspaceId: ctx.workspaceId },
      changed: { created: [{ type: "invoice", id: invoice.id, name: invoice.name }] },
    });
  },
});

const updateInvoice = defineAction({
  name: "clockify_invoices_update",
  description:
    "Update an invoice (note/subject/number/dates/currency/client, or status). Billing action — previews and requires confirmation.",
  featureGroup: INV,
  risks: ["billing"],
  schema: z
    .object({
      id: z.string().min(1),
      number: z.string().optional(),
      issuedDate: z.string().optional(),
      currency: z.string().optional(),
      dueDate: z.string().optional(),
      note: z.string().optional(),
      subject: z.string().optional(),
      clientId: z.string().optional(),
      status: invoiceStatusSchema.optional(),
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
        v.status !== undefined,
      { message: "Provide at least one field to change." },
    ),
  async handler(ctx, args) {
    const patch: Record<string, unknown> = {
      ...(args.number !== undefined ? { number: args.number } : {}),
      ...(args.issuedDate !== undefined ? { issuedDate: args.issuedDate } : {}),
      ...(args.currency !== undefined ? { currency: args.currency } : {}),
      ...(args.dueDate !== undefined ? { dueDate: args.dueDate } : {}),
      ...(args.note !== undefined ? { note: args.note } : {}),
      ...(args.subject !== undefined ? { subject: args.subject } : {}),
      ...(args.clientId !== undefined ? { clientId: args.clientId } : {}),
    };
    const changes = Object.keys(patch).map((k) => `set ${k}`);
    if (args.status !== undefined) changes.push(`set status ${args.status}`);
    return {
      kind: "preview",
      preview: {
        actionLabel: "Update invoice",
        featureGroup: INV,
        riskLabels: ["billing"],
        targets: [{ type: "invoice", id: args.id }],
        expectedChanges: changes,
        reversibility: "You can update the invoice again to revert most fields.",
        warnings: ["Updating an invoice changes a live billing document."],
      },
      operation: {
        actionName: "clockify_invoices_update",
        featureGroup: INV,
        risks: ["billing"],
        payload: { id: args.id, patch, ...(args.status !== undefined ? { status: args.status } : {}) },
      },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { id: string; patch: Record<string, unknown>; status?: string };
    const updated = await ctx.clockify.updateInvoice(payload.id, { patch: payload.patch, status: payload.status });
    return successReceipt({
      action: "clockify_invoices_update",
      entity: "invoice",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "invoice", id: updated.id, name: updated.name }] },
    });
  },
});

const deleteInvoice = defineAction({
  name: "clockify_invoices_delete",
  description: "Delete an invoice. Destructive billing action — previews and requires confirmation.",
  featureGroup: INV,
  risks: ["destructive", "billing"],
  schema: z.object({ id: z.string().min(1), number: z.string().optional() }),
  async handler(ctx, args) {
    return {
      kind: "preview",
      preview: {
        actionLabel: "Delete invoice",
        featureGroup: INV,
        riskLabels: ["destructive", "billing"],
        targets: [{ type: "invoice", id: args.id, name: args.number }],
        expectedChanges: [`Delete invoice ${args.number ?? args.id}`],
        reversibility: "This cannot be undone.",
        warnings: ["Deleting an invoice permanently removes a billing document."],
      },
      operation: {
        actionName: "clockify_invoices_delete",
        featureGroup: INV,
        risks: ["destructive", "billing"],
        payload: { id: args.id, number: args.number },
      },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { id: string; number?: string };
    await ctx.clockify.deleteInvoice(payload.id);
    return successReceipt({
      action: "clockify_invoices_delete",
      entity: "invoice",
      ids: { workspaceId: ctx.workspaceId },
      changed: { deleted: [{ type: "invoice", id: payload.id, name: payload.number }] },
    });
  },
});

const addInvoiceItem = defineAction({
  name: "clockify_invoices_items_add",
  description:
    "Add a line item to an invoice. Billing action — previews and requires confirmation. `itemType` is required.",
  featureGroup: INV,
  risks: ["billing"],
  schema: z.object({
    invoiceId: z.string().min(1),
    itemType: z.string().min(1),
    description: z.string().optional(),
    quantity: z.number().positive().optional(),
    unitPrice: z.number().nonnegative().optional(),
    /** `major` (e.g. 125.00) is converted ×100 to the minor units Clockify wants. */
    unitPriceUnit: z.enum(["major", "minor"]).default("major"),
    applyTaxes: z.enum(["TAX1", "TAX2", "TAX1TAX2", "NONE"]).optional(),
  }),
  async handler(ctx, args) {
    const item: Record<string, unknown> = {
      itemType: args.itemType,
      ...(args.description !== undefined ? { description: args.description } : {}),
      ...(args.quantity !== undefined ? { quantity: args.quantity } : {}),
      ...(args.unitPrice !== undefined ? { unitPriceMinor: toMinor(args.unitPrice, args.unitPriceUnit) } : {}),
      ...(args.applyTaxes !== undefined ? { applyTaxes: args.applyTaxes } : {}),
    };
    return {
      kind: "preview",
      preview: {
        actionLabel: "Add invoice item",
        featureGroup: INV,
        riskLabels: ["billing"],
        targets: [{ type: "invoice", id: args.invoiceId }],
        expectedChanges: [`Add ${args.itemType} item${args.description ? ` "${args.description}"` : ""}`],
        reversibility: "You can delete the line item afterward.",
        warnings: ["This changes a live billing document."],
      },
      operation: {
        actionName: "clockify_invoices_items_add",
        featureGroup: INV,
        risks: ["billing"],
        payload: { invoiceId: args.invoiceId, item },
      },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as {
      invoiceId: string;
      item: Parameters<typeof ctx.clockify.addInvoiceItem>[1];
    };
    await ctx.clockify.addInvoiceItem(payload.invoiceId, payload.item);
    return successReceipt({
      action: "clockify_invoices_items_add",
      entity: "invoice",
      ids: { workspaceId: ctx.workspaceId, invoiceId: payload.invoiceId },
      changed: { updated: [{ type: "invoice", id: payload.invoiceId }] },
    });
  },
});

const deleteInvoiceItem = defineAction({
  name: "clockify_invoices_items_delete",
  description:
    "Delete an invoice line item by its index (line order). Destructive billing action — previews and requires confirmation.",
  featureGroup: INV,
  risks: ["destructive", "billing"],
  schema: z.object({ invoiceId: z.string().min(1), index: z.number().int().nonnegative() }),
  async handler(ctx, args) {
    return {
      kind: "preview",
      preview: {
        actionLabel: "Delete invoice item",
        featureGroup: INV,
        riskLabels: ["destructive", "billing"],
        targets: [{ type: "invoice", id: args.invoiceId }],
        expectedChanges: [`Delete invoice line item #${args.index}`],
        reversibility: "This cannot be undone; re-add the line to restore it.",
        warnings: ["This changes a live billing document."],
      },
      operation: {
        actionName: "clockify_invoices_items_delete",
        featureGroup: INV,
        risks: ["destructive", "billing"],
        payload: { invoiceId: args.invoiceId, index: args.index },
      },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { invoiceId: string; index: number };
    await ctx.clockify.deleteInvoiceItem(payload.invoiceId, payload.index);
    return successReceipt({
      action: "clockify_invoices_items_delete",
      entity: "invoice",
      ids: { workspaceId: ctx.workspaceId, invoiceId: payload.invoiceId },
      changed: { updated: [{ type: "invoice", id: payload.invoiceId }] },
    });
  },
});

const createInvoicePayment = defineAction({
  name: "clockify_invoices_payments_create",
  description:
    "Record a payment against an invoice. Payment action — previews and requires confirmation.",
  featureGroup: INV,
  risks: ["payment"],
  schema: z.object({
    invoiceId: z.string().min(1),
    amount: z.number().positive(),
    /** `major` (e.g. 50.00) is converted ×100 to the minor units Clockify wants. */
    amountUnit: z.enum(["major", "minor"]).default("major"),
    paymentDate: z.string().min(1), // full ISO or YYYY-MM-DD
    note: z.string().optional(),
  }),
  async handler(ctx, args) {
    const amountMinor = toMinor(args.amount, args.amountUnit);
    const payment = {
      amountMinor,
      paymentDate: args.paymentDate,
      ...(args.note !== undefined ? { note: args.note } : {}),
    };
    return {
      kind: "preview",
      preview: {
        actionLabel: "Record invoice payment",
        featureGroup: INV,
        riskLabels: ["payment"],
        targets: [{ type: "invoice", id: args.invoiceId }],
        expectedChanges: [`Record a payment of ${amountMinor} (minor units) dated ${args.paymentDate}`],
        reversibility: "You can delete the payment afterward.",
        warnings: ["This records money received against a live invoice."],
      },
      operation: {
        actionName: "clockify_invoices_payments_create",
        featureGroup: INV,
        risks: ["payment"],
        payload: { invoiceId: args.invoiceId, payment },
      },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as {
      invoiceId: string;
      payment: Parameters<typeof ctx.clockify.createInvoicePayment>[1];
    };
    const created = await ctx.clockify.createInvoicePayment(payload.invoiceId, payload.payment);
    return successReceipt({
      action: "clockify_invoices_payments_create",
      entity: "invoice",
      ids: { workspaceId: ctx.workspaceId, invoiceId: payload.invoiceId },
      changed: { created: [{ type: "payment", id: created.id ?? "payment" }] },
    });
  },
});

const deleteInvoicePayment = defineAction({
  name: "clockify_invoices_payments_delete",
  description:
    "Delete a recorded invoice payment. Destructive payment action — previews and requires confirmation.",
  featureGroup: INV,
  risks: ["destructive", "payment"],
  schema: z.object({ invoiceId: z.string().min(1), paymentId: z.string().min(1) }),
  async handler(ctx, args) {
    return {
      kind: "preview",
      preview: {
        actionLabel: "Delete invoice payment",
        featureGroup: INV,
        riskLabels: ["destructive", "payment"],
        targets: [{ type: "invoice", id: args.invoiceId }],
        expectedChanges: [`Delete payment ${args.paymentId}`],
        reversibility: "This cannot be undone; re-record the payment to restore it.",
        warnings: ["This removes a recorded payment from a live invoice."],
      },
      operation: {
        actionName: "clockify_invoices_payments_delete",
        featureGroup: INV,
        risks: ["destructive", "payment"],
        payload: { invoiceId: args.invoiceId, paymentId: args.paymentId },
      },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { invoiceId: string; paymentId: string };
    await ctx.clockify.deleteInvoicePayment(payload.invoiceId, payload.paymentId);
    return successReceipt({
      action: "clockify_invoices_payments_delete",
      entity: "invoice",
      ids: { workspaceId: ctx.workspaceId, invoiceId: payload.invoiceId },
      changed: { deleted: [{ type: "payment", id: payload.paymentId }] },
    });
  },
});

const importInvoiceTime = defineAction({
  name: "clockify_invoices_import_time",
  description:
    "Import billable time entries into an invoice by date range. Billing action — previews and requires confirmation.",
  featureGroup: INV,
  risks: ["billing"],
  schema: z.object({
    invoiceId: z.string().min(1),
    from: z.string().min(1), // full ISO or YYYY-MM-DD
    to: z.string().min(1), // full ISO or YYYY-MM-DD
    projectIds: z.array(z.string().min(1)).optional(),
  }),
  async handler(ctx, args) {
    const range = {
      from: args.from,
      to: args.to,
      ...(args.projectIds !== undefined ? { projectIds: args.projectIds } : {}),
    };
    return {
      kind: "preview",
      preview: {
        actionLabel: "Import time into invoice",
        featureGroup: INV,
        riskLabels: ["billing"],
        targets: [{ type: "invoice", id: args.invoiceId }],
        expectedChanges: [`Import billable time from ${args.from} to ${args.to}`],
        reversibility: "Delete the imported line items to revert.",
        warnings: ["This adds billable time as invoice line items."],
      },
      operation: {
        actionName: "clockify_invoices_import_time",
        featureGroup: INV,
        risks: ["billing"],
        payload: { invoiceId: args.invoiceId, range },
      },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as {
      invoiceId: string;
      range: Parameters<typeof ctx.clockify.importInvoiceTime>[1];
    };
    await ctx.clockify.importInvoiceTime(payload.invoiceId, payload.range);
    return successReceipt({
      action: "clockify_invoices_import_time",
      entity: "invoice",
      ids: { workspaceId: ctx.workspaceId, invoiceId: payload.invoiceId },
      changed: { updated: [{ type: "invoice", id: payload.invoiceId }] },
    });
  },
});

export const INVOICE_ACTIONS: ActionDefinition[] = [
  listInvoices,
  getInvoice,
  listInvoiceItems,
  listInvoicePayments,
  exportInvoice,
  createInvoice,
  updateInvoice,
  deleteInvoice,
  addInvoiceItem,
  deleteInvoiceItem,
  createInvoicePayment,
  deleteInvoicePayment,
  importInvoiceTime,
];
