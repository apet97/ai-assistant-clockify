import { z } from "zod";
import {
  defineAction,
  defineReadAction,
  defineRiskyAction,
  type ActionContext,
  type ActionDefinition,
  type ActionResult,
  type RiskyClarifyResult,
} from "../action.js";
import { successReceipt, type SuccessReceipt, type Warning } from "../receipts.js";
import { describePatch, matchByName, resolveEntityRef, suggestOptions } from "./resolve.js";

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

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
function nowDate(ctx: ActionContext): Date {
  return (ctx.now ?? (() => new Date()))();
}

/**
 * Invoice item types are workspace-CONFIGURED NAMES (live-verified via the REST
 * API: `itemType` must match a configured name — not an enum or id — and the
 * names vary per workspace; "NEW DEFAULT" only happens to be one workspace's
 * default). Clockify exposes NO endpoint to list or create them, but every line
 * item stores its `itemType` name, so we DISCOVER the valid names from the
 * workspace's existing invoices (bounded scan) rather than blindly sending a
 * guess. Returns the distinct configured names (empty on a workspace that has
 * never had an invoice line item).
 *
 * `invoices` lets a caller that JUST fetched the invoice list (e.g.
 * `resolveInvoiceRef`) share it, so an item-add preview issues exactly one
 * `listInvoices`. Only the ≤12 most-recent invoices are scanned, and their
 * detail GETs run with bounded concurrency (each is a real `GET /invoices/{id}`)
 * so the preview's discovery scan overlaps instead of awaiting one at a time.
 */
const MAX_INVOICES_SCANNED_FOR_TYPES = 12;
const ITEM_TYPE_SCAN_CONCURRENCY = 4;
async function discoverItemTypes(
  ctx: ActionContext,
  invoices?: ReadonlyArray<{ id: string }>,
): Promise<string[]> {
  const all = invoices ?? (await ctx.clockify.listInvoices());
  const scanned = all.slice(0, MAX_INVOICES_SCANNED_FOR_TYPES);
  const names = new Set<string>();
  // Bounded-concurrency scan: chunk the ≤12 detail GETs so up to
  // ITEM_TYPE_SCAN_CONCURRENCY are in flight at once (kind to the add-on rate
  // limit) instead of one strictly-sequential await per invoice.
  for (let i = 0; i < scanned.length; i += ITEM_TYPE_SCAN_CONCURRENCY) {
    const chunk = scanned.slice(i, i + ITEM_TYPE_SCAN_CONCURRENCY);
    const itemLists = await Promise.all(chunk.map((inv) => ctx.clockify.listInvoiceItems(inv.id)));
    for (const items of itemLists) for (const it of items) if (it.itemType) names.add(it.itemType);
  }
  return [...names];
}

type ItemTypeResolution =
  | { ok: true; itemType: string }
  | { ok: false; options: string[] };

/**
 * Resolve a requested (or omitted) item type against the workspace's discovered
 * types: a case-insensitive match yields the canonical name; an unknown request
 * when types DO exist asks the admin to choose (never a raw 404); an omitted type
 * defaults to the first configured one. When NOTHING is discoverable (a fresh
 * workspace), fall back to the requested value or "NEW DEFAULT" and let the
 * commit-time warning surface the platform constraint.
 */
function resolveItemType(discovered: string[], requested?: string): ItemTypeResolution {
  if (discovered.length === 0) return { ok: true, itemType: requested ?? "NEW DEFAULT" };
  if (!requested) return { ok: true, itemType: discovered[0] };
  const match = discovered.find((d) => d.toLowerCase() === requested.toLowerCase());
  return match ? { ok: true, itemType: match } : { ok: false, options: discovered };
}

function itemTypeClarify(options: string[]): { clarify: string; options: { id: string; label: string }[] } {
  return {
    clarify: `This workspace's invoice item types are: ${options.join(", ")}. Which should I use? (I can't create a new type via the API — add a line item once in the Clockify invoice editor and it auto-creates a type I can then reuse.)`,
    options: options.map((t) => ({ id: t, label: t })),
  };
}

/**
 * The planner refers to invoices by their NUMBER at least as often as by id —
 * the live loop sent `/invoices/INV-…` on every single invoice call, each one a
 * confirmed-then-failed commit. Resolve either form (id, number, or a number in
 * the id slot) against the workspace's invoices at preview time.
 */
async function resolveInvoiceRef(
  ctx: ActionContext,
  ref: { id?: string; number?: string },
  verb: string,
): Promise<
  | { ok: true; id: string; number?: string; invoices?: ReadonlyArray<{ id: string }> }
  | { ok: false; clarify: RiskyClarifyResult }
> {
  // Capture the fetched invoice list once so item-type discovery can reuse it
  // (an item-add preview must issue exactly one listInvoices, not two). When the
  // ref is already a real id, resolveEntityRef never lists — leave it undefined
  // and let discoverItemTypes fetch lazily only if it's actually needed.
  let invoices: ReadonlyArray<{ id: string }> | undefined;
  const resolved = await resolveEntityRef(
    { id: ref.id, name: ref.number },
    {
      noun: "invoice",
      verb,
      list: async () => {
        const list = await ctx.clockify.listInvoices();
        invoices = list;
        return list.map((inv) => ({ id: inv.id, name: inv.number ?? inv.id }));
      },
    },
  );
  if (!resolved.ok) return resolved;
  // `invoices` stays undefined when resolveEntityRef short-circuited on a real
  // 24-hex id (no list fetched) — discoverItemTypes then fetches lazily so a
  // real-id item-add still discovers types instead of scanning an empty list.
  return { ok: true, id: resolved.id, number: resolved.name, invoices };
}

/** Identity schema for invoice reads: an id, or a number (either slot works). */
const invoiceRefSchema = z
  .object({ id: z.string().min(1).optional(), number: z.string().min(1).optional() })
  .refine((v) => v.id !== undefined || v.number !== undefined, {
    message: "Provide the invoice id or its number.",
  });

/** Read-with-resolution helper: clarify on an unresolvable ref, else the receipt. */
function defineInvoiceRead(def: {
  name: string;
  description: string;
  schema?: z.ZodTypeAny;
  read(ctx: ActionContext, id: string, args: Record<string, unknown>): Promise<SuccessReceipt>;
}): ActionDefinition {
  return defineAction({
    name: def.name,
    description: def.description,
    featureGroup: INV,
    risks: ["read"],
    schema: def.schema ?? invoiceRefSchema,
    async handler(ctx, args): Promise<ActionResult> {
      const typed = args as { id?: string; number?: string };
      const resolved = await resolveInvoiceRef(ctx, typed, "fetch");
      if (!resolved.ok) {
        return { kind: "clarify", message: resolved.clarify.clarify, options: resolved.clarify.options };
      }
      return { kind: "receipt", receipt: await def.read(ctx, resolved.id, args as Record<string, unknown>) };
    },
  });
}

const listInvoices = defineReadAction({
  name: "clockify_invoices_list",
  description: "List invoices (optional live status filter).",
  group: INV,
  schema: z.object({ status: invoiceStatusSchema.optional() }),
  async handler(ctx, args) {
    const items = await ctx.clockify.listInvoices(args.status ? { status: args.status } : undefined);
    return successReceipt({
      action: "clockify_invoices_list",
      entity: "invoice",
      ids: { workspaceId: ctx.workspaceId },
      data: { count: items.length, items },
    });
  },
});

const getInvoice = defineInvoiceRead({
  name: "clockify_invoices_get",
  description:
    "Fetch a single invoice by id or by its `number` (line items embedded) — both resolved server-side.",
  async read(ctx, id) {
    const entity = await ctx.clockify.getInvoice(id);
    return successReceipt({
      action: "clockify_invoices_get",
      entity: "invoice",
      ids: { workspaceId: ctx.workspaceId },
      data: { entity },
    });
  },
});

const listInvoiceItems = defineInvoiceRead({
  name: "clockify_invoices_items_list",
  description: "List the line items on an invoice (by invoice id or `number`).",
  async read(ctx, id) {
    const items = await ctx.clockify.listInvoiceItems(id);
    return successReceipt({
      action: "clockify_invoices_items_list",
      entity: "invoice",
      ids: { workspaceId: ctx.workspaceId, invoiceId: id },
      data: { count: items.length, items },
    });
  },
});

const listInvoicePayments = defineInvoiceRead({
  name: "clockify_invoices_payments_list",
  description: "List the payments recorded against an invoice (by invoice id or `number`).",
  async read(ctx, id) {
    const items = await ctx.clockify.listInvoicePayments(id);
    return successReceipt({
      action: "clockify_invoices_payments_list",
      entity: "invoice",
      ids: { workspaceId: ctx.workspaceId, invoiceId: id },
      data: { count: items.length, items },
    });
  },
});

const exportInvoice = defineInvoiceRead({
  name: "clockify_invoices_export",
  description:
    "Export an invoice as a PDF (base64), by invoice id or `number`. Read — no confirmation.",
  schema: z
    .object({
      id: z.string().min(1).optional(),
      number: z.string().min(1).optional(),
      format: z.enum(["PDF"]).optional(),
    })
    .refine((v) => v.id !== undefined || v.number !== undefined, {
      message: "Provide the invoice id or its number.",
    }),
  async read(ctx, id, args) {
    const exp = await ctx.clockify.exportInvoice(id, args.format as "PDF" | undefined);
    return successReceipt({
      action: "clockify_invoices_export",
      entity: "invoice",
      ids: { workspaceId: ctx.workspaceId, invoiceId: id },
      data: { contentType: exp.contentType, bytes: exp.bytes, truncated: exp.truncated, base64: exp.base64 },
      warnings: exp.truncated
        ? [
            {
              code: "export_truncated",
              message: `Invoice PDF is ${exp.bytes} bytes, over the inline cap; base64 omitted. Export it from the Clockify UI.`,
            },
          ]
        : undefined,
    });
  },
});

/** A line item the planner can attach when creating the invoice. */
const invoiceItemSchema = z.object({
  description: z.string().optional(),
  quantity: z.number().positive().optional(),
  amount: z.number().nonnegative().optional(),
  /** `major` (e.g. 100.00) is converted ×100 to the minor units Clockify wants. */
  amountUnit: z.enum(["major", "minor"]).default("major"),
  itemType: z.string().min(1).optional(),
  applyTaxes: z.enum(["TAX1", "TAX2", "TAX1TAX2", "NONE"]).optional(),
});

const createInvoice = defineRiskyAction({
  name: "clockify_invoices_create",
  description:
    "Create an invoice for a client (by `clientName` — resolved server-side — or `clientId`). `number`, `issuedDate`, `dueDate`, and `currency` default when omitted (a generated number, today, +30 days, USD). Optionally pass `items` (description, quantity, amount) to add line items in the same step — use this for \"create an invoice and add an item\" so the new invoice id is resolved server-side. Billing action — previews and requires confirmation.",
  group: INV,
  risks: ["billing"],
  schema: z
    .object({
      clientId: z.string().min(1).optional(),
      clientName: z.string().min(1).optional(),
      number: z.string().min(1).optional(),
      issuedDate: z.string().min(1).optional(), // full ISO or YYYY-MM-DD
      currency: z.string().min(1).optional(),
      dueDate: z.string().min(1).optional(), // full ISO or YYYY-MM-DD
      note: z.string().optional(),
      subject: z.string().optional(),
      items: z.array(invoiceItemSchema).optional(),
    })
    .refine((v) => v.clientId !== undefined || v.clientName !== undefined, {
      message: "Provide the client id or its exact name.",
    }),
  async preview(ctx, args) {
    // Resolve the client by name when no id was supplied — the planner has just
    // created/named the client and should not be asked for its id.
    let clientId = args.clientId;
    let clientName = args.clientName;
    if (!clientId) {
      const clients = await ctx.clockify.listClients();
      const match = matchByName(clients, clientName as string);
      if (match.kind === "none") {
        const options = suggestOptions(clients, clientName as string);
        return {
          clarify: options.length
            ? `I couldn't find an active client named "${clientName}". Did you mean one of these, or should I create it?`
            : `There are no active clients named "${clientName}". Want me to create it first?`,
          options: options.length ? options : undefined,
        };
      }
      if (match.kind === "many") {
        return {
          clarify: `Several active clients are named "${clientName}". Which one?`,
          options: match.matches.map((c) => ({ id: c.id, label: c.name })),
        };
      }
      clientId = match.entity.id;
      clientName = match.entity.name;
    }

    // Default the required fields the planner usually omits.
    const now = nowDate(ctx);
    const stamp = now.toISOString().replace(/[^0-9]/g, "").slice(0, 14);
    const number = args.number ?? `INV-${stamp}`;
    const issuedDate = args.issuedDate ?? now.toISOString();
    const dueDate = args.dueDate ?? new Date(now.getTime() + THIRTY_DAYS_MS).toISOString();
    const currency = args.currency ?? "USD";

    const input = {
      clientId,
      number,
      issuedDate,
      currency,
      dueDate,
      ...(args.note !== undefined ? { note: args.note } : {}),
      ...(args.subject !== undefined ? { subject: args.subject } : {}),
    };

    // Build the line items (amounts converted to minor units now, so commit never
    // re-derives them). Resolve each item's type against the workspace's actual
    // configured types — if a named type isn't configured (and some ARE), clarify
    // with the real list instead of creating a doomed $0 invoice.
    const discovered = args.items?.length ? await discoverItemTypes(ctx) : [];
    const items: Array<{ itemType: string; description?: string; quantity?: number; unitPriceMinor?: number; applyTaxes?: string }> = [];
    for (const it of args.items ?? []) {
      const resolved = resolveItemType(discovered, it.itemType);
      if (!resolved.ok) return itemTypeClarify(resolved.options);
      items.push({
        itemType: resolved.itemType,
        // Clockify REQUIRES description + quantity on the items POST (live: 400
        // "Description is required."); default them visibly in the preview.
        description: it.description ?? resolved.itemType,
        quantity: it.quantity ?? 1,
        ...(it.amount !== undefined ? { unitPriceMinor: toMinor(it.amount, it.amountUnit) } : {}),
        ...(it.applyTaxes !== undefined ? { applyTaxes: it.applyTaxes } : {}),
      });
    }

    const defaulted = [
      args.number === undefined ? "number" : null,
      args.issuedDate === undefined ? "issued date" : null,
      args.dueDate === undefined ? "due date" : null,
      args.currency === undefined ? `currency (${currency})` : null,
    ].filter(Boolean);

    const expectedChanges = [
      `Create invoice ${number} for ${clientName ?? clientId}`,
      `Issued ${issuedDate.slice(0, 10)}, due ${dueDate.slice(0, 10)}, ${currency}`,
      ...items.map(
        (it) =>
          `Add item${it.description ? ` "${it.description}"` : ""}` +
          `${it.quantity !== undefined ? ` ×${it.quantity}` : ""}` +
          `${it.unitPriceMinor !== undefined ? ` @ ${(it.unitPriceMinor / 100).toFixed(2)} ${currency}` : ""}`,
      ),
    ];

    return {
      actionLabel: "Create invoice",
      targets: [{ type: "client", id: clientId, name: clientName }],
      expectedChanges,
      reversibility: "You can delete the invoice afterward.",
      warnings: [
        "This creates a billing document.",
        // Phase 4 — surface the platform constraint in the PREVIEW, not after
        // confirm. Only when the workspace has NO discoverable item type (none has
        // ever been auto-created by a manual line item) will the item(s) be skipped
        // → a $0 total. When types WERE discovered, the items apply, so no caveat.
        ...(items.length && discovered.length === 0
          ? [
              "This workspace has no invoice item type yet, so the line item(s) can't be added and the total will be $0. Add one line item manually in the Clockify invoice editor once — it auto-creates a type — and I can add items here from then on.",
            ]
          : []),
        ...(defaulted.length ? [`Defaulted: ${defaulted.join(", ")} — say the values to override.`] : []),
      ],
      payload: { input, items },
    };
  },
  async commit(ctx, payload) {
    const { input, items } = payload as {
      input: Parameters<typeof ctx.clockify.createInvoice>[0];
      items?: Array<Parameters<typeof ctx.clockify.addInvoiceItem>[1]>;
    };
    const invoice = await ctx.clockify.createInvoice(input);
    // Add the line items onto the just-created invoice. A failed item is reported
    // (partial failure is never hidden), not silently dropped — the invoice exists.
    const warnings: Warning[] = [];
    let added = 0;
    for (const item of items ?? []) {
      try {
        await ctx.clockify.addInvoiceItem(invoice.id, item);
        added += 1;
      } catch (error) {
        const raw = error instanceof Error ? error.message : "error";
        // Invoice item types are auto-created when a line item is added in the
        // Clockify UI; a workspace that's never had one has none. Make that
        // actionable instead of a raw 404 (there's no "settings" screen for them).
        const actionable = /item type/i.test(raw)
          ? "this workspace has no matching invoice item type. Add a line item once in the Clockify invoice editor (it auto-creates a type), or tell me an existing item type name."
          : raw.slice(0, 120);
        warnings.push({
          code: "item_not_added",
          message: `Line item${item.description ? ` "${item.description}"` : ""} could not be added: ${actionable}`,
        });
      }
    }
    return successReceipt({
      action: "clockify_invoices_create",
      entity: "invoice",
      ids: { workspaceId: ctx.workspaceId },
      changed: { created: [{ type: "invoice", id: invoice.id, name: invoice.name }] },
      data: items && items.length ? { itemsRequested: items.length, itemsAdded: added } : undefined,
      warnings: warnings.length ? warnings : undefined,
    });
  },
  // Dedupe by the invoice's SEMANTIC identity (client + items + currency + notes),
  // excluding the auto-generated number/issuedDate/dueDate — so confirming the same
  // "invoice qwen for 1000" twice within the window can't create a second invoice.
  idempotencyKey(payload) {
    const { input, items } = payload as {
      input: { clientId?: string; currency?: string; note?: string; subject?: string };
      items?: unknown;
    };
    return JSON.stringify({
      clientId: input.clientId,
      currency: input.currency,
      note: input.note,
      subject: input.subject,
      items,
    });
  },
});

const updateInvoice = defineRiskyAction({
  name: "clockify_invoices_update",
  description:
    "Update an invoice (note/subject/number/dates/currency/client, or status). `id` accepts the invoice id or its NUMBER (resolved server-side); `number` sets a NEW number. Billing action — previews and requires confirmation.",
  group: INV,
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
  async preview(ctx, args) {
    const resolved = await resolveInvoiceRef(ctx, { id: args.id }, "update");
    if (!resolved.ok) return resolved.clarify;
    const patch: Record<string, unknown> = {
      ...(args.number !== undefined ? { number: args.number } : {}),
      ...(args.issuedDate !== undefined ? { issuedDate: args.issuedDate } : {}),
      ...(args.currency !== undefined ? { currency: args.currency } : {}),
      ...(args.dueDate !== undefined ? { dueDate: args.dueDate } : {}),
      ...(args.note !== undefined ? { note: args.note } : {}),
      ...(args.subject !== undefined ? { subject: args.subject } : {}),
      ...(args.clientId !== undefined ? { clientId: args.clientId } : {}),
    };
    const changes = describePatch(patch);
    if (args.status !== undefined) changes.push(`set status → ${args.status}`);
    return {
      actionLabel: "Update invoice",
      targets: [{ type: "invoice", id: resolved.id, name: resolved.number }],
      expectedChanges: changes,
      reversibility: "You can update the invoice again to revert most fields.",
      warnings: ["Updating an invoice changes a live billing document."],
      payload: { id: resolved.id, patch, ...(args.status !== undefined ? { status: args.status } : {}) },
    };
  },
  async commit(ctx, payload) {
    const typed = payload as { id: string; patch: Record<string, unknown>; status?: string };
    const updated = await ctx.clockify.updateInvoice(typed.id, { patch: typed.patch, status: typed.status });
    return successReceipt({
      action: "clockify_invoices_update",
      entity: "invoice",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "invoice", id: updated.id, name: updated.name }] },
    });
  },
});

const deleteInvoice = defineRiskyAction({
  name: "clockify_invoices_delete",
  description:
    "Delete an invoice, by id or by its `number` (resolved server-side). Destructive billing action — previews and requires confirmation.",
  group: INV,
  risks: ["destructive", "billing"],
  schema: z
    .object({ id: z.string().min(1).optional(), number: z.string().min(1).optional() })
    .refine((v) => v.id !== undefined || v.number !== undefined, {
      message: "Provide the invoice id or its number.",
    }),
  async preview(ctx, args) {
    const resolved = await resolveInvoiceRef(ctx, args, "delete");
    if (!resolved.ok) return resolved.clarify;
    const number = resolved.number ?? args.number;
    return {
      actionLabel: "Delete invoice",
      targets: [{ type: "invoice", id: resolved.id, name: number }],
      expectedChanges: [`Delete invoice ${number ?? resolved.id}`],
      reversibility: "This cannot be undone.",
      warnings: ["Deleting an invoice permanently removes a billing document."],
      payload: { id: resolved.id, number },
    };
  },
  async commit(ctx, payload) {
    const { id, number } = payload as { id: string; number?: string };
    await ctx.clockify.deleteInvoice(id);
    return successReceipt({
      action: "clockify_invoices_delete",
      entity: "invoice",
      ids: { workspaceId: ctx.workspaceId },
      changed: { deleted: [{ type: "invoice", id, name: number }] },
    });
  },
});

const addInvoiceItem = defineRiskyAction({
  name: "clockify_invoices_items_add",
  description:
    "Add a line item to an invoice. An amount alone is enough — description (defaults to the item type), quantity (1) and itemType (discovered from the workspace) all default server-side, so don't ask the admin for them. Billing action — previews and requires confirmation. `itemType` names a workspace-configured invoice item type; pass the one the admin asked for (e.g. \"service\") — the harness checks it against the workspace's actual types and, if it isn't configured, asks the admin to pick from the real list (it never guesses).",
  group: INV,
  risks: ["billing"],
  schema: z.object({
    invoiceId: z.string().min(1),
    itemType: z.string().min(1).optional(),
    description: z.string().optional(),
    quantity: z.number().positive().optional(),
    unitPrice: z.number().nonnegative().optional(),
    /** `major` (e.g. 125.00) is converted ×100 to the minor units Clockify wants. */
    unitPriceUnit: z.enum(["major", "minor"]).default("major"),
    applyTaxes: z.enum(["TAX1", "TAX2", "TAX1TAX2", "NONE"]).optional(),
  }),
  async preview(ctx, args) {
    const invoice = await resolveInvoiceRef(ctx, { id: args.invoiceId }, "add an item to");
    if (!invoice.ok) return invoice.clarify;
    // Resolve the item type against the workspace's actual configured types
    // (discovered from existing line items) — never a blind "NEW DEFAULT".
    // Reuse the invoice list resolveInvoiceRef just fetched, so this preview
    // issues a single listInvoices instead of two.
    const discovered = await discoverItemTypes(ctx, invoice.invoices);
    const resolved = resolveItemType(discovered, args.itemType);
    if (!resolved.ok) return itemTypeClarify(resolved.options);
    const itemType = resolved.itemType;
    const item: Record<string, unknown> = {
      itemType,
      // Clockify REQUIRES description + quantity on the items POST (live: 400
      // "Description is required."); default them visibly in the preview.
      description: args.description ?? itemType,
      quantity: args.quantity ?? 1,
      ...(args.unitPrice !== undefined ? { unitPriceMinor: toMinor(args.unitPrice, args.unitPriceUnit) } : {}),
      ...(args.applyTaxes !== undefined ? { applyTaxes: args.applyTaxes } : {}),
    };
    return {
      actionLabel: "Add invoice item",
      targets: [{ type: "invoice", id: invoice.id, name: invoice.number }],
      expectedChanges: [`Add ${itemType} item${args.description ? ` "${args.description}"` : ""}`],
      reversibility: "You can delete the line item afterward.",
      warnings: ["This changes a live billing document."],
      payload: { invoiceId: invoice.id, item },
    };
  },
  async commit(ctx, payload) {
    const typed = payload as {
      invoiceId: string;
      item: Parameters<typeof ctx.clockify.addInvoiceItem>[1];
    };
    await ctx.clockify.addInvoiceItem(typed.invoiceId, typed.item);
    return successReceipt({
      action: "clockify_invoices_items_add",
      entity: "invoice",
      ids: { workspaceId: ctx.workspaceId, invoiceId: typed.invoiceId },
      changed: { updated: [{ type: "invoice", id: typed.invoiceId }] },
    });
  },
});

const deleteInvoiceItem = defineRiskyAction({
  name: "clockify_invoices_items_delete",
  description:
    "Delete an invoice line item by its index (line order). Destructive billing action — previews and requires confirmation.",
  group: INV,
  risks: ["destructive", "billing"],
  schema: z.object({ invoiceId: z.string().min(1), index: z.number().int().nonnegative() }),
  async preview(ctx, args) {
    const invoice = await resolveInvoiceRef(ctx, { id: args.invoiceId }, "delete an item from");
    if (!invoice.ok) return invoice.clarify;
    return {
      actionLabel: "Delete invoice item",
      targets: [{ type: "invoice", id: invoice.id, name: invoice.number }],
      expectedChanges: [`Delete invoice line item #${args.index}`],
      reversibility: "This cannot be undone; re-add the line to restore it.",
      warnings: ["This changes a live billing document."],
      payload: { invoiceId: invoice.id, index: args.index },
    };
  },
  async commit(ctx, payload) {
    const { invoiceId, index } = payload as { invoiceId: string; index: number };
    await ctx.clockify.deleteInvoiceItem(invoiceId, index);
    return successReceipt({
      action: "clockify_invoices_items_delete",
      entity: "invoice",
      ids: { workspaceId: ctx.workspaceId, invoiceId },
      changed: { updated: [{ type: "invoice", id: invoiceId }] },
    });
  },
});

const createInvoicePayment = defineRiskyAction({
  name: "clockify_invoices_payments_create",
  description:
    "Record a payment against an invoice. Payment action — previews and requires confirmation.",
  group: INV,
  risks: ["payment"],
  schema: z.object({
    invoiceId: z.string().min(1),
    amount: z.number().positive(),
    /** `major` (e.g. 50.00) is converted ×100 to the minor units Clockify wants. */
    amountUnit: z.enum(["major", "minor"]).default("major"),
    paymentDate: z.string().min(1), // full ISO or YYYY-MM-DD
    note: z.string().optional(),
  }),
  async preview(ctx, args) {
    const invoice = await resolveInvoiceRef(ctx, { id: args.invoiceId }, "record a payment against");
    if (!invoice.ok) return invoice.clarify;
    const amountMinor = toMinor(args.amount, args.amountUnit);
    const payment = {
      amountMinor,
      paymentDate: args.paymentDate,
      ...(args.note !== undefined ? { note: args.note } : {}),
    };
    return {
      actionLabel: "Record invoice payment",
      targets: [{ type: "invoice", id: invoice.id, name: invoice.number }],
      // Show the HUMAN amount (major units), matching the item preview's
      // `(unitPriceMinor / 100).toFixed(2)` formatting — never the 100x wire
      // integer, which would read as $5000 on a $50 payment. Minor units stay
      // in the payload only.
      expectedChanges: [
        `Record a payment of ${(amountMinor / 100).toFixed(2)} dated ${args.paymentDate}`,
      ],
      reversibility: "You can delete the payment afterward.",
      warnings: ["This records money received against a live invoice."],
      payload: { invoiceId: invoice.id, payment },
    };
  },
  async commit(ctx, payload) {
    const typed = payload as {
      invoiceId: string;
      payment: Parameters<typeof ctx.clockify.createInvoicePayment>[1];
    };
    const created = await ctx.clockify.createInvoicePayment(typed.invoiceId, typed.payment);
    // The payment id comes from a list-diff around the POST and can be
    // undetermined (concurrent payment, id-less rows). Never invent one — when
    // it's unknown, record the invoice itself as updated and warn honestly
    // rather than fabricating a payment EntityRef with a placeholder id.
    return created.id
      ? successReceipt({
          action: "clockify_invoices_payments_create",
          entity: "invoice",
          ids: { workspaceId: ctx.workspaceId, invoiceId: typed.invoiceId },
          changed: { created: [{ type: "payment", id: created.id }] },
        })
      : successReceipt({
          action: "clockify_invoices_payments_create",
          entity: "invoice",
          ids: { workspaceId: ctx.workspaceId, invoiceId: typed.invoiceId },
          changed: { updated: [{ type: "invoice", id: typed.invoiceId }] },
          warnings: [
            {
              code: "payment_id_unknown",
              message: "Payment recorded, but its id could not be determined from the invoice.",
            },
          ],
        });
  },
});

const deleteInvoicePayment = defineRiskyAction({
  name: "clockify_invoices_payments_delete",
  description:
    "Delete a recorded invoice payment. Destructive payment action — previews and requires confirmation.",
  group: INV,
  risks: ["destructive", "payment"],
  schema: z.object({ invoiceId: z.string().min(1), paymentId: z.string().min(1) }),
  async preview(ctx, args) {
    const invoice = await resolveInvoiceRef(ctx, { id: args.invoiceId }, "delete a payment from");
    if (!invoice.ok) return invoice.clarify;
    return {
      actionLabel: "Delete invoice payment",
      targets: [{ type: "invoice", id: invoice.id, name: invoice.number }],
      expectedChanges: [`Delete payment ${args.paymentId}`],
      reversibility: "This cannot be undone; re-record the payment to restore it.",
      warnings: ["This removes a recorded payment from a live invoice."],
      payload: { invoiceId: invoice.id, paymentId: args.paymentId },
    };
  },
  async commit(ctx, payload) {
    const { invoiceId, paymentId } = payload as { invoiceId: string; paymentId: string };
    await ctx.clockify.deleteInvoicePayment(invoiceId, paymentId);
    return successReceipt({
      action: "clockify_invoices_payments_delete",
      entity: "invoice",
      ids: { workspaceId: ctx.workspaceId, invoiceId },
      changed: { deleted: [{ type: "payment", id: paymentId }] },
    });
  },
});

const importInvoiceTime = defineRiskyAction({
  name: "clockify_invoices_import_time",
  description:
    "Import billable time entries into an invoice by date range. Billing action — previews and requires confirmation.",
  group: INV,
  risks: ["billing"],
  schema: z.object({
    invoiceId: z.string().min(1),
    from: z.string().min(1), // full ISO or YYYY-MM-DD
    to: z.string().min(1), // full ISO or YYYY-MM-DD
    projectIds: z.array(z.string().min(1)).optional(),
  }),
  async preview(ctx, args) {
    const invoice = await resolveInvoiceRef(ctx, { id: args.invoiceId }, "import time into");
    if (!invoice.ok) return invoice.clarify;
    const range = {
      from: args.from,
      to: args.to,
      ...(args.projectIds !== undefined ? { projectIds: args.projectIds } : {}),
    };
    return {
      actionLabel: "Import time into invoice",
      targets: [{ type: "invoice", id: invoice.id, name: invoice.number }],
      expectedChanges: [`Import billable time from ${args.from} to ${args.to}`],
      reversibility: "Delete the imported line items to revert.",
      warnings: ["This adds billable time as invoice line items."],
      payload: { invoiceId: invoice.id, range },
    };
  },
  async commit(ctx, payload) {
    const typed = payload as {
      invoiceId: string;
      range: Parameters<typeof ctx.clockify.importInvoiceTime>[1];
    };
    await ctx.clockify.importInvoiceTime(typed.invoiceId, typed.range);
    return successReceipt({
      action: "clockify_invoices_import_time",
      entity: "invoice",
      ids: { workspaceId: ctx.workspaceId, invoiceId: typed.invoiceId },
      changed: { updated: [{ type: "invoice", id: typed.invoiceId }] },
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
