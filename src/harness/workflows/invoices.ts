import { z } from "zod";
import { zNumberLike } from "../arg-shapes.js";
import {
  clarifyResult,
  defineAction,
  defineReadAction,
  defineRiskyAction,
  type ActionContext,
  type ActionDefinition,
  type ActionResult,
  type RiskyClarifyResult,
  type TargetSnapshot,
} from "../action.js";
import { errorReceipt, listReceipt, successReceipt, type SuccessReceipt } from "../receipts.js";
import type { ListResult } from "../../clockify/types.js";
import { fromMinor, toMinor } from "../money.js";
import { THIRTY_DAYS_MS } from "../../durations.js";
import { describePatch, resolveDateRange, resolveEntityRef, resolveInstant, resolveRelativeDay } from "./resolve.js";
import { discoverItemTypes, resolveItemType, itemTypeClarify, taxApplyFlag } from "./invoices-schema.js";
import { buildInvoiceCreateProvenance } from "../invoice-provenance.js";
import {
  buildInvoiceCreatePayload,
  commitInvoiceCreate,
  type InvoiceCreatePayload,
} from "../invoice-create-workflow.js";
import { commitInvoiceUpdate, type InvoiceUpdatePayload } from "../invoice-update-workflow.js";
import {
  commitInvoicePaymentCreate,
  type InvoicePaymentCreatePayload,
} from "../invoice-payment-workflow.js";
import { paymentBaseline } from "../invoice-reconciliation.js";
import { billingFingerprint } from "../billing-fingerprint.js";
import { commitSingleDurableRiskyStep, executeDurableRiskyStep } from "../durable-risky-write.js";
import { durableMutationContract } from "../durable-mutation-contract.js";
import { captureTargetSnapshot, verifyTargetSnapshots } from "../target-snapshots.js";
import { dispatchWithReconciliation } from "./structure-durable.js";
import { DefinitiveWriteFailure } from "../../clockify/write-outcome.js";

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
const invoiceCreateContract = durableMutationContract({
  source: "confirmed",
  targeting: { mode: "create_no_target" },
  strategies: ["create", "update"],
  unreconciledStepIds: ["create-invoice"],
});
const invoiceTargetContract = (strategy: "update" | "delete" | "state-command" | "composed") => durableMutationContract({
  source: "confirmed",
  targeting: { mode: "snapshots", relations: ["target"] },
  strategies: [strategy],
});
const invoiceSnapshotContract = (
  relations: ["target" | "parent", ...Array<"target" | "parent">],
  strategy: "create" | "update" | "delete" | "state-command" | "composed",
) => durableMutationContract({ source: "confirmed", targeting: { mode: "snapshots", relations }, strategies: [strategy] });

async function captureInvoiceSnapshot(ctx: ActionContext, id: string, relation: "target" | "parent" = "target"): Promise<TargetSnapshot | undefined> {
  const invoice = await ctx.clockify.getInvoice(id);
  return invoice ? captureTargetSnapshot(relation, { type: "invoice", id: invoice.id, name: invoice.number }, invoice) : undefined;
}

async function fetchInvoiceMutationSnapshot(ctx: ActionContext, snapshot: TargetSnapshot) {
  if (snapshot.ref.type === "invoice") {
    const invoice = await ctx.clockify.getInvoice(snapshot.ref.id);
    return invoice ? { ref: { type: "invoice", id: invoice.id, ...(invoice.number ? { name: invoice.number } : {}) }, projection: invoice, truncated: false } : undefined;
  }
  if (snapshot.ref.type === "invoice_items") {
    const items = await ctx.clockify.listRawInvoiceItems(snapshot.ref.id);
    return { ref: snapshot.ref, projection: items.rows, truncated: items.truncated };
  }
  if (snapshot.ref.type === "client") {
    const client = await ctx.clockify.getClient(snapshot.ref.id);
    return client ? { ref: { type: "client", id: client.id, name: client.name }, projection: client, truncated: false } : undefined;
  }
  if (snapshot.ref.type === "project") {
    const project = await ctx.clockify.getProject(snapshot.ref.id);
    return project ? { ref: { type: "project", id: project.id, name: project.name }, projection: project, truncated: false } : undefined;
  }
  const invoiceId = snapshot.ref.type === "invoice_payment"
    ? snapshot.ref.id.slice(0, snapshot.ref.id.indexOf(":"))
    : snapshot.ref.id;
  const payments = await ctx.clockify.listInvoicePayments(invoiceId!);
  if (snapshot.ref.type === "invoice_payment") {
    const paymentId = snapshot.ref.id.slice(invoiceId!.length + 1);
    const matches = payments.rows.filter((payment) => payment.id === paymentId);
    return matches.length === 1 ? { ref: snapshot.ref, projection: matches[0], truncated: payments.truncated } : undefined;
  }
  return { ref: snapshot.ref, projection: payments.rows, truncated: payments.truncated };
}

async function verifyInvoiceMutationSnapshots(ctx: ActionContext, snapshots: readonly TargetSnapshot[]) {
  return verifyTargetSnapshots(snapshots, (snapshot) => fetchInvoiceMutationSnapshot(ctx, snapshot));
}

/** Live invoice statuses (DRAFT is rejected by Clockify; use UNSENT for draft-like). */
const invoiceStatusSchema = z.enum(["UNSENT", "SENT", "PAID", "PARTIALLY_PAID", "VOID", "OVERDUE"]);

function nowDate(ctx: ActionContext): Date {
  return (ctx.now ?? (() => new Date()))();
}

/**
 * The shared "an invoice line/import changed this invoice" commit receipt —
 * items_add / items_delete / import_time all touch a live invoice doc without
 * creating or deleting the invoice itself, so they report it as `updated`. One
 * copy so the three receipts can't drift. The create/payment/delete receipts
 * stay distinct (they report created/deleted refs, not a bare invoice update).
 */
function invoiceUpdatedReceipt(ctx: ActionContext, action: string, invoiceId: string): SuccessReceipt {
  return successReceipt({
    action,
    entity: "invoice",
    ids: { workspaceId: ctx.workspaceId, invoiceId },
    changed: { updated: [{ type: "invoice", id: invoiceId }] },
  });
}

function rawAddedItemMatches(row: Record<string, unknown>, item: Parameters<ActionContext["clockify"]["addInvoiceItemAtomic"]>[1]): boolean {
  if (row.itemType !== item.itemType || row.description !== item.description || row.quantity !== item.quantity) return false;
  if ((row.applyTaxes ?? "NONE") !== (item.applyTaxes ?? "NONE")) return false;
  if (item.unitPriceMinor !== undefined) {
    const raw = row.unitPrice;
    if (raw !== item.unitPriceMinor && raw !== item.unitPriceMinor * 100) return false;
  }
  return true;
}

function invoiceStepFailure(action: string, status: string) {
  return errorReceipt({
    action,
    code: status === "outcome_unknown" ? "commit_outcome_unknown" : "write_failed",
    message: status === "outcome_unknown"
      ? "Clockify did not provide a definitive response and the exact invoice post-state could not be established."
      : "Clockify definitively rejected the invoice change.",
    recovery: status === "outcome_unknown"
      ? { hint: "Inspect the exact invoice state before deciding whether to retry.", retryable: false }
      : { hint: "Correct the request and preview it again.", retryable: true },
  });
}

/**
 * The success arm of {@link resolveInvoiceRef}, discriminated on HOW the invoice
 * was resolved so the "currency + invoices both known, or both unknown" coupling
 * is in the TYPE, not just prose:
 *
 * - `resolvedFrom: "list"` — the ref was a number / non-hex id, so the invoice
 *   LIST was fetched: `invoices` (for item-type discovery reuse) and the
 *   invoice's `currency` (for an amount-preview affix) are both available.
 * - `resolvedFrom: "id"` — the ref was a real 24-hex id, so resolveEntityRef
 *   short-circuited WITHOUT listing: neither `invoices` nor `currency` is known
 *   (discoverItemTypes then fetches lazily; the amount preview shows the figure
 *   unlabelled).
 */
type ResolvedInvoice =
  | { ok: true; resolvedFrom: "id"; id: string; number?: string }
  | {
      ok: true;
      resolvedFrom: "list";
      id: string;
      number?: string;
      currency?: string;
      invoices: ListResult<{ id: string }>;
    };

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
): Promise<ResolvedInvoice | { ok: false; clarify: RiskyClarifyResult }> {
  // Capture the fetched invoice list once so item-type discovery can reuse it
  // (an item-add preview must issue exactly one listInvoices, not two). When the
  // ref is already a real id, resolveEntityRef never lists — leave it undefined
  // and let discoverItemTypes fetch lazily only if it's actually needed.
  let invoices: ListResult<{ id: string }> | undefined;
  const resolved = await resolveEntityRef<{ id: string; name: string; currency?: string }>(
    { id: ref.id, name: ref.number },
    {
      noun: "invoice",
      verb,
      list: async () => {
        const list = await ctx.clockify.listInvoices();
        invoices = { rows: list.rows, truncated: list.truncated };
        // Carry the currency through so an amount preview (item-add/payment) can
        // label the figure with the invoice's actual currency.
        return {
          rows: list.rows.map((inv) => ({ id: inv.id, name: inv.number ?? inv.id, currency: inv.currency })),
          truncated: list.truncated,
        };
      },
    },
  );
  if (!resolved.ok) return resolved;
  // `invoices` is set IFF the list was fetched (a number/non-hex id) — the same
  // condition under which `currency` is known. The raw-id fast path leaves both
  // unknown. Encode that coupling with the discriminant.
  return invoices !== undefined
    ? { ok: true, resolvedFrom: "list", id: resolved.id, number: resolved.name, currency: resolved.entity?.currency, invoices }
    : { ok: true, resolvedFrom: "id", id: resolved.id, number: resolved.name };
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
  read(ctx: ActionContext, id: string, args: Record<string, unknown>): Promise<SuccessReceipt | ReturnType<typeof errorReceipt>>;
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
      if (!resolved.ok) return clarifyResult(resolved.clarify);
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
    const { rows, truncated } = await ctx.clockify.listInvoices(args.status ? { status: args.status } : undefined);
    return listReceipt({
      action: "clockify_invoices_list",
      entity: "invoice",
      ids: { workspaceId: ctx.workspaceId },
      rows,
      truncated,
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
    const { rows, truncated } = await ctx.clockify.listInvoiceItems(id);
    return listReceipt({
      action: "clockify_invoices_items_list",
      entity: "invoice",
      ids: { workspaceId: ctx.workspaceId, invoiceId: id },
      rows,
      truncated,
    });
  },
});

const listInvoicePayments = defineInvoiceRead({
  name: "clockify_invoices_payments_list",
  description: "List the payments recorded against an invoice (by invoice id or `number`).",
  async read(ctx, id) {
    const { rows, truncated } = await ctx.clockify.listInvoicePayments(id);
    return listReceipt({
      action: "clockify_invoices_payments_list",
      entity: "invoice",
      ids: { workspaceId: ctx.workspaceId, invoiceId: id },
      rows,
      truncated,
    });
  },
});

const exportInvoice = defineInvoiceRead({
  name: "clockify_invoices_export",
  description:
    "Export an invoice as a short-lived authenticated PDF artifact, by invoice id or `number`. Read — no confirmation.",
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
    if (!ctx.saveArtifact) {
      return errorReceipt({
        action: "clockify_invoices_export",
        code: "artifact_unavailable",
        message: "The secure artifact store is unavailable; no PDF data was exposed.",
      });
    }
    const artifact = ctx.saveArtifact({
      contentType: exp.contentType,
      filename: `clockify-invoice-${id}.pdf`,
      bytes: exp.bytes,
    });
    return successReceipt({
      action: "clockify_invoices_export",
      entity: "invoice",
      ids: { workspaceId: ctx.workspaceId, invoiceId: id },
      data: {
        contentType: exp.contentType,
        bytes: exp.bytes.byteLength,
        artifact: {
          id: artifact.id,
          downloadUrl: `/api/artifacts/${artifact.id}`,
          expiresAt: artifact.expiresAt,
        },
      },
    });
  },
});

/** A line item the planner can attach when creating the invoice. */
const invoiceItemSchema = z.object({
  description: z.string().optional(),
  quantity: zNumberLike(z.number().positive()).optional(),
  amount: zNumberLike(z.number().nonnegative()).optional(),
  /** `major` (e.g. 100.00) is converted ×100 to the minor units Clockify wants. */
  amountUnit: z.enum(["major", "minor"]).optional(),
  itemType: z.string().min(1).optional(),
  applyTaxes: z.enum(["TAX1", "TAX2", "TAX1TAX2", "NONE"]).optional(),
});

const createInvoice = defineRiskyAction({
  name: "clockify_invoices_create",
  description:
    "Create an invoice for a client (by `clientName` — resolved server-side — or `clientId`). `issuedDate`/`dueDate` accept YYYY-MM-DD or a relative day/period (today, next monday, next month — resolved server-side; never guess a calendar date); `number`, dates, and `currency` default when omitted (a generated number, today, +30 days, USD). Optionally pass `items` (description, quantity, amount) to add line items in the same step — use this for \"create an invoice and add an item\" so the new invoice id is resolved server-side. Set the invoice tax/discount with `taxPercent`/`tax2Percent`/`discountPercent` (whole percents, e.g. 3 for 3%) — when a tax rate is set, the line items you add are taxed by default (Clockify item-based tax). Billing action — previews and requires confirmation.",
  group: INV,
  risks: ["billing"],
  mutationWorkflow: "durable",
  mutationContract: invoiceCreateContract,
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
      // Invoice-level tax/discount as whole percents (Clockify item-based tax —
      // the RATE lives on the invoice; items carry the apply flag). "3" → 3.
      taxPercent: zNumberLike(z.number().min(0).max(100)).optional(),
      tax2Percent: zNumberLike(z.number().min(0).max(100)).optional(),
      discountPercent: zNumberLike(z.number().min(0).max(100)).optional(),
    })
    .refine((v) => v.clientId !== undefined || v.clientName !== undefined, {
      message: "Provide the client id or its exact name.",
    }),
  async preview(ctx, args) {
    // Resolve the client ref — a NAME in either slot (the planner has just
    // created/named the client, or put the name where the id belongs) becomes a
    // verified id; unknown/ambiguous clarifies. Billing must never wire an
    // unverified ref.
    const client = await resolveEntityRef(
      { id: args.clientId, name: args.clientName },
      {
        noun: "client",
        verb: "invoice",
        list: (f) => ctx.clockify.listClients(f),
        notFoundHint: "Or should I create the client first?",
      },
    );
    if (!client.ok) return client.clarify;
    const clientId = client.id;
    const clientName = client.name ?? args.clientName;

    // Default the required fields the planner usually omits. Dates resolve
    // server-side ("today"/"next month" must never reach a billing wire raw);
    // unresolvable ⇒ clarify, never send. BOTH the issued and due dates resolve
    // at the START edge (an invoice date is a calendar day, not a window end —
    // "due next month" = the 1st, not the 31st; pinned by invoices.test.ts:170),
    // so resolveDateRange (which forces the END edge for `to`) doesn't fit here.
    // The shared range helper IS used in importInvoiceTime, where from→start /
    // to→end is exactly right. Defaults: issued = now (full instant), due = +30d.
    const now = nowDate(ctx);
    const stamp = now.toISOString().replace(/[^0-9]/g, "").slice(0, 14);
    const number = args.number ?? `INV-${stamp}`;
    const issuedDate = args.issuedDate !== undefined ? resolveInstant(now, args.issuedDate, "start", ctx.timeZone) : now.toISOString();
    const dueDate = args.dueDate !== undefined ? resolveInstant(now, args.dueDate, "start", ctx.timeZone) : new Date(now.getTime() + THIRTY_DAYS_MS).toISOString();
    const badDates = [
      args.issuedDate !== undefined && issuedDate === undefined ? `issued date "${args.issuedDate}"` : undefined,
      args.dueDate !== undefined && dueDate === undefined ? `due date "${args.dueDate}"` : undefined,
    ].filter((value): value is string => value !== undefined);
    if (badDates.length || issuedDate === undefined || dueDate === undefined) {
      return {
        clarify: `I couldn't make sense of the ${badDates.join(" and ")} — give me a calendar date (YYYY-MM-DD) or something like today, next monday, or next month.`,
      };
    }
    const currency = args.currency ?? "USD";

    const base = {
      clientId,
      number,
      issuedDate,
      currency,
      dueDate,
    };

    // Build the line items (amounts converted to minor units now, so commit never
    // re-derives them). Resolve each item's type against the workspace's actual
    // configured types — if a named type isn't configured (and some ARE), clarify
    // with the real list instead of creating a doomed $0 invoice.
    const invoiceBaseline = await ctx.clockify.listInvoices();
    const discovered = args.items?.length
      ? await discoverItemTypes(ctx, invoiceBaseline)
      : { rows: [], truncated: false };
    // Item-based tax: when the create sets a rate, its items default to taxed
    // (matches Clockify's checked-by-default TAX/TAX2 columns). An explicit
    // per-item applyTaxes still wins.
    const defaultApplyTaxes = taxApplyFlag(args.taxPercent !== undefined, args.tax2Percent !== undefined);
    const items: Array<{ itemType: string; description?: string; quantity?: number; unitPriceMinor?: number; applyTaxes?: string }> = [];
    for (const it of args.items ?? []) {
      const resolved = resolveItemType(discovered, it.itemType);
      if (!resolved.ok) return itemTypeClarify(resolved.options, resolved.incomplete);
      items.push({
        itemType: resolved.itemType,
        // Clockify REQUIRES description + quantity on the items POST (live: 400
        // "Description is required."); default them visibly in the preview.
        description: it.description ?? resolved.itemType,
        quantity: it.quantity ?? 1,
        ...(it.amount !== undefined ? { unitPriceMinor: toMinor(it.amount, it.amountUnit ?? "major") } : {}),
        ...(it.applyTaxes !== undefined
          ? { applyTaxes: it.applyTaxes }
          : defaultApplyTaxes !== undefined
            ? { applyTaxes: defaultApplyTaxes }
            : {}),
      });
    }
    // Invoice-level tax/discount live on the invoice doc (POST /invoices ignores
    // them) — applied in commit via the verified GET-then-PUT update path.
    const enrichment: Record<string, unknown> = {};
    if (args.note !== undefined) enrichment.note = args.note;
    if (args.subject !== undefined) enrichment.subject = args.subject;
    if (args.taxPercent !== undefined) enrichment.taxPercent = args.taxPercent;
    if (args.tax2Percent !== undefined) enrichment.tax2Percent = args.tax2Percent;
    if (args.discountPercent !== undefined) enrichment.discountPercent = args.discountPercent;

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
          `${it.unitPriceMinor !== undefined ? ` @ ${fromMinor(it.unitPriceMinor)} ${currency}` : ""}`,
      ),
    ];
    if (args.taxPercent !== undefined) expectedChanges.push(`Tax ${args.taxPercent}%`);
    if (args.tax2Percent !== undefined) expectedChanges.push(`Tax 2 ${args.tax2Percent}%`);
    if (args.discountPercent !== undefined) expectedChanges.push(`Discount ${args.discountPercent}%`);

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
        ...(items.length && discovered.rows.length === 0
          ? [
              "This workspace has no invoice item type yet, so the line item(s) can't be added and the total will be $0. Add one line item manually in the Clockify invoice editor once — it auto-creates a type — and I can add items here from then on.",
            ]
          : []),
        ...(defaulted.length ? [`Defaulted: ${defaulted.join(", ")} — say the values to override.`] : []),
      ],
      payload: buildInvoiceCreatePayload({
        base,
        enrichment,
        items,
        provenance: buildInvoiceCreateProvenance(args),
        invoiceBaseline: {
          ids: invoiceBaseline.rows.map((invoice) => invoice.id),
          truncated: invoiceBaseline.truncated,
        },
      }),
      mutationPlan: {
        mode: "curated",
        steps: [
          {
            id: "create-invoice",
            kind: "primary" as const,
            ...(Object.keys(enrichment).length === 0 && items.length === 0
              ? { reconciliationStrategy: "create" as const }
              : {}),
          },
          ...(Object.keys(enrichment).length
            ? [{ id: "enrich-invoice", kind: "primary" as const, reconciliationStrategy: "update" as const }]
            : []),
          ...items.map((_item, index) => ({
            id: `add-invoice-item-${index}`,
            kind: "primary" as const,
            reconciliationStrategy: "update" as const,
          })),
        ],
      },
    };
  },
  async commit(ctx, payload, operation) {
    return commitInvoiceCreate({ ctx, operation, payload: payload as unknown as InvoiceCreatePayload });
  },
  // Operation identity is primary: retries/reconfirms of this exact stored
  // operation dedupe, while two independently previewed identical invoices remain
  // intentional and are both allowed.
  idempotencyKey(_payload, operation) {
    return operation.operationId;
  },
});

const updateInvoice = defineRiskyAction({
  name: "clockify_invoices_update",
  description:
    "Update an invoice (note/subject/number/dates/currency/client, status, or tax/discount). `id` accepts the invoice id or its NUMBER (resolved server-side); `number` sets a NEW number. Set tax/discount with `taxPercent`/`tax2Percent`/`discountPercent` (whole percents, e.g. 3 for 3%). Billing action — previews and requires confirmation.",
  group: INV,
  risks: ["billing"],
  mutationWorkflow: "durable",
  mutationContract: durableMutationContract({
    source: "confirmed",
    targeting: { mode: "snapshots", relations: ["target", "parent"] },
    strategies: ["update", "state-command"],
  }),
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
      // Whole percents (Clockify item-based tax — the rate lives on the invoice). "3" → 3.
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
        v.status !== undefined ||
        v.taxPercent !== undefined ||
        v.tax2Percent !== undefined ||
        v.discountPercent !== undefined,
      { message: "Provide at least one field to change." },
    ),
  async preview(ctx, args) {
    const resolved = await resolveInvoiceRef(ctx, { id: args.id }, "update");
    if (!resolved.ok) return resolved.clarify;
    const target = await captureInvoiceSnapshot(ctx, resolved.id);
    if (!target) return { clarify: `Invoice ${resolved.number ?? resolved.id} could not be verified.` };

    // Resolve identity + dates server-side BEFORE they reach the billing PUT —
    // the same invariant the create path enforces. A relative/garbled date
    // ("next month") or an unverified client ref must clarify here, never wire
    // raw (the REST adapter only normalizes a bare YYYY-MM-DD, so an unresolved
    // string would otherwise reach the live invoice unchanged).
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
    const changes = describePatch(patch);
    if (args.status !== undefined) changes.push(`set status → ${args.status}`);
    let updateBody: Record<string, unknown> | undefined;
    if (Object.keys(patch).length > 0) {
      try {
        updateBody = await ctx.clockify.prepareInvoiceFieldUpdate(resolved.id, patch);
      } catch {
        return { clarify: "I couldn't read the current invoice fields safely. Refresh the invoice and preview the update again." };
      }
    }
    const currentProjection = structuredClone(target.projection as Record<string, unknown>);
    const expectedAfterFields: Record<string, unknown> = { ...currentProjection };
    for (const key of ["number", "issuedDate", "currency", "dueDate", "note", "subject", "clientId"] as const) {
      if (Object.hasOwn(patch, key)) expectedAfterFields[key] = patch[key];
    }
    if (typeof patch.taxPercent === "number") expectedAfterFields.tax = patch.taxPercent * 100;
    if (typeof patch.tax2Percent === "number") expectedAfterFields.tax2 = patch.tax2Percent * 100;
    if (typeof patch.discountPercent === "number") expectedAfterFields.discount = patch.discountPercent * 100;
    const expectedAfterStatus = { ...expectedAfterFields, ...(args.status !== undefined ? { status: args.status } : {}) };
    const statusTarget = captureTargetSnapshot("target", target.ref, expectedAfterFields);
    return {
      actionLabel: "Update invoice",
      targets: [{ type: "invoice", id: resolved.id, name: resolved.number }],
      expectedChanges: changes,
      reversibility: "You can update the invoice again to revert most fields.",
      warnings: ["Updating an invoice changes a live billing document."],
      payload: {
        id: resolved.id,
        patch,
        ...(updateBody ? { updateBody } : {}),
        ...(args.status !== undefined ? { status: args.status } : {}),
        expectedAfterFields,
        expectedAfterStatus,
      },
      targetSnapshots: [target, ...(clientSnapshot ? [clientSnapshot] : [])],
      mutationPlan: {
        mode: "curated",
        steps: [
          ...(updateBody ? [{ id: "update-invoice-fields", kind: "primary" as const, targetFingerprint: target.fingerprint, reconciliationStrategy: "update" as const }] : []),
          ...(args.status !== undefined
            ? [{ id: "update-invoice-status", kind: "primary" as const, targetFingerprint: statusTarget.fingerprint, reconciliationStrategy: "state-command" as const }]
            : []),
        ],
      },
    };
  },
  async commit(ctx, payload, operation) {
    return commitInvoiceUpdate({ ctx, operation, payload: payload as InvoiceUpdatePayload });
  },
});

const deleteInvoice = defineRiskyAction({
  name: "clockify_invoices_delete",
  description:
    "Delete an invoice, by id or by its `number` (resolved server-side). Destructive billing action — previews and requires confirmation.",
  group: INV,
  risks: ["destructive", "billing"],
  mutationWorkflow: "durable",
  mutationContract: invoiceTargetContract("delete"),
  schema: z
    .object({ id: z.string().min(1).optional(), number: z.string().min(1).optional() })
    .refine((v) => v.id !== undefined || v.number !== undefined, {
      message: "Provide the invoice id or its number.",
    }),
  async preview(ctx, args) {
    const resolved = await resolveInvoiceRef(ctx, args, "delete");
    if (!resolved.ok) return resolved.clarify;
    const detail = await ctx.clockify.getInvoice(resolved.id);
    if (!detail) return { clarify: `Invoice ${resolved.number ?? resolved.id} could not be verified.` };
    const number = resolved.number ?? args.number;
    const targetSnapshot = captureTargetSnapshot("target", { type: "invoice", id: resolved.id, name: number }, detail);
    return {
      actionLabel: "Delete invoice",
      targets: [{ type: "invoice", id: resolved.id, name: number }],
      expectedChanges: [`Delete invoice ${number ?? resolved.id}`],
      reversibility: "This cannot be undone.",
      warnings: ["Deleting an invoice permanently removes a billing document."],
      payload: { id: resolved.id, number },
      targetSnapshots: [targetSnapshot],
      mutationPlan: { mode: "single", steps: [{ id: "delete-invoice", kind: "primary", targetFingerprint: targetSnapshot.fingerprint, reconciliationStrategy: "delete" }] },
    };
  },
  async commit(ctx, payload, operation) {
    const { id, number } = payload as { id: string; number?: string };
    const snapshots = operation.targetSnapshots as TargetSnapshot[] | undefined;
    return commitSingleDurableRiskyStep({
      ctx,
      operation,
      planStepId: "delete-invoice",
      name: "Delete invoice",
      dispatch: async () => {
        await ctx.clockify.deleteInvoiceAtomic(id);
        return { effect: { deleted: { type: "invoice", id, name: number } } };
      },
      verification: {
        snapshots: snapshots ?? [],
        fetchSnapshot: async (snapshot: TargetSnapshot) => {
          const current = await ctx.clockify.getInvoice(snapshot.ref.id);
          return current
            ? { ref: { type: "invoice", id: current.id, ...(current.number ? { name: current.number } : {}) }, projection: current, truncated: false }
            : undefined;
        },
      },
      success: () => successReceipt({
        action: "clockify_invoices_delete",
        entity: "invoice",
        ids: { workspaceId: ctx.workspaceId },
        changed: { deleted: [{ type: "invoice", id, name: number }] },
      }),
    });
  },
});

const addInvoiceItem = defineRiskyAction({
  name: "clockify_invoices_items_add",
  description:
    "Add a line item to an invoice. An amount alone is enough — description (defaults to the item type), quantity (1) and itemType (discovered from the workspace) all default server-side, so don't ask the admin for them. Billing action — previews and requires confirmation. `itemType` names a workspace-configured invoice item type; pass the one the admin asked for (e.g. \"service\") — the harness checks it against the workspace's actual types and, if it isn't configured, asks the admin to pick from the real list (it never guesses).",
  group: INV,
  risks: ["billing"],
  mutationWorkflow: "durable",
  mutationContract: invoiceSnapshotContract(["parent"], "update"),
  schema: z.object({
    invoiceId: z.string().min(1),
    itemType: z.string().min(1).optional(),
    description: z.string().optional(),
    quantity: zNumberLike(z.number().positive()).optional(),
    unitPrice: zNumberLike(z.number().nonnegative()).optional(),
    /** `major` (e.g. 125.00) is converted ×100 to the minor units Clockify wants. */
    unitPriceUnit: z.enum(["major", "minor"]).default("major"),
    applyTaxes: z.enum(["TAX1", "TAX2", "TAX1TAX2", "NONE"]).optional(),
  }),
  async preview(ctx, args) {
    const invoice = await resolveInvoiceRef(ctx, { id: args.invoiceId }, "add an item to");
    if (!invoice.ok) return invoice.clarify;
    const parent = await captureInvoiceSnapshot(ctx, invoice.id, "parent");
    if (!parent) return { clarify: `Invoice ${invoice.number ?? invoice.id} could not be verified.` };
    // Resolve the item type against the workspace's actual configured types
    // (discovered from existing line items) — never a blind "NEW DEFAULT".
    // Reuse the invoice list resolveInvoiceRef just fetched (only the list path
    // has it; the raw-id path leaves it undefined and discoverItemTypes fetches
    // lazily), so this preview issues a single listInvoices instead of two.
    const reuseInvoices = invoice.resolvedFrom === "list" ? invoice.invoices : undefined;
    const discovered = await discoverItemTypes(ctx, reuseInvoices);
    const resolved = resolveItemType(discovered, args.itemType);
    if (!resolved.ok) return itemTypeClarify(resolved.options, resolved.incomplete);
    const itemType = resolved.itemType;
    const quantity = args.quantity ?? 1;
    const unitPriceMinor =
      args.unitPrice !== undefined ? toMinor(args.unitPrice, args.unitPriceUnit) : undefined;
    // Item-based tax: a new item on an already-taxed invoice is taxed by default
    // (Clockify's TAX/TAX2 columns default checked) — but never flag tax on an
    // invoice with NO rate. Read the current rate from the detail; explicit wins.
    let applyTaxes = args.applyTaxes;
    if (applyTaxes === undefined) {
      const detail = await ctx.clockify.getInvoice(invoice.id);
      const hasTax1 = typeof detail?.tax === "number" && detail.tax > 0;
      const hasTax2 = typeof detail?.tax2 === "number" && detail.tax2 > 0;
      applyTaxes = taxApplyFlag(hasTax1, hasTax2);
    }
    const item: Record<string, unknown> = {
      itemType,
      // Clockify REQUIRES description + quantity on the items POST (live: 400
      // "Description is required."); default them visibly in the preview.
      description: args.description ?? itemType,
      quantity,
      ...(unitPriceMinor !== undefined ? { unitPriceMinor } : {}),
      ...(applyTaxes !== undefined ? { applyTaxes } : {}),
    };
    // Show the quantity AND the unit price (the human/major figure, never the
    // 100x wire integer) on the card — the admin confirms a billing amount, so a
    // model-garbled price must be catchable before Confirm, the same as
    // create-with-items. Currency is appended when the invoice's is known (only
    // the list path carries it; the raw-id fast path shows the figure unlabelled).
    const currency = invoice.resolvedFrom === "list" ? invoice.currency : undefined;
    const currencySuffix = currency ? ` ${currency}` : "";
    const expectedChange =
      `Add ${itemType} item${args.description ? ` "${args.description}"` : ""}` +
      ` ×${quantity}` +
      (unitPriceMinor !== undefined ? ` @ ${fromMinor(unitPriceMinor)}${currencySuffix}` : "");
    return {
      actionLabel: "Add invoice item",
      targets: [{ type: "invoice", id: invoice.id, name: invoice.number }],
      expectedChanges: [expectedChange],
      reversibility: "You can delete the line item afterward.",
      warnings: ["This changes a live billing document."],
      payload: { invoiceId: invoice.id, item },
      targetSnapshots: [parent],
      mutationPlan: { mode: "single", steps: [{ id: "add-invoice-item", kind: "primary", targetFingerprint: parent.fingerprint, reconciliationStrategy: "update" }] },
    };
  },
  async commit(ctx, payload, operation) {
    const typed = payload as {
      invoiceId: string;
      item: Parameters<typeof ctx.clockify.addInvoiceItem>[1];
    };
    const baseline = await ctx.clockify.listRawInvoiceItems(typed.invoiceId);
    if (baseline.truncated) return errorReceipt({ action: operation.actionName, code: "item_baseline_unavailable", message: "Clockify returned an incomplete invoice-item baseline. No item was added." });
    let verificationFailure: "stale_target" | "stale_parent" | undefined;
    const snapshots = operation.targetSnapshots ?? [];
    const step = await executeDurableRiskyStep({
      ctx, operation, planStepId: "add-invoice-item", index: 0, name: "Add invoice item",
      preparedDetail: { preDispatch: { strategy: "invoice_item_add_raw_baseline", rows: baseline.rows, truncated: false }, targetSnapshots: snapshots },
      dispatch: async () => {
        const verified = await verifyInvoiceMutationSnapshots(ctx, snapshots);
        if (!verified.ok) {
          verificationFailure = verified.code;
          throw new DefinitiveWriteFailure("VERIFY", "add-invoice-item", verified.code);
        }
        const result = await dispatchWithReconciliation({
          dispatch: async () => { await ctx.clockify.addInvoiceItemAtomic(typed.invoiceId, typed.item); return true as const; },
          reconcile: async () => {
            const after = await ctx.clockify.listRawInvoiceItems(typed.invoiceId);
            if (after.truncated || after.rows.length !== baseline.rows.length + 1) return undefined;
            if (billingFingerprint(after.rows.slice(0, baseline.rows.length)) !== billingFingerprint(baseline.rows)) return undefined;
            return rawAddedItemMatches(after.rows[after.rows.length - 1]!, typed.item) ? true as const : undefined;
          },
        });
        return { effect: { addedItem: { invoiceId: typed.invoiceId } }, detail: { reconciled: result.reconciled } };
      },
    });
    if (verificationFailure) return errorReceipt({ action: operation.actionName, code: verificationFailure, message: "The invoice changed before the item add. No item was sent." });
    return step.status === "succeeded" ? invoiceUpdatedReceipt(ctx, "clockify_invoices_items_add", typed.invoiceId) : invoiceStepFailure(operation.actionName, step.status);
  },
});

const deleteInvoiceItem = defineRiskyAction({
  name: "clockify_invoices_items_delete",
  description:
    "Delete an invoice line item by its index (line order). Destructive billing action — previews and requires confirmation.",
  group: INV,
  risks: ["destructive", "billing"],
  mutationWorkflow: "durable",
  mutationContract: invoiceSnapshotContract(["target", "parent"], "delete"),
  schema: z.object({ invoiceId: z.string().min(1), index: z.number().int().nonnegative() }),
  async preview(ctx, args) {
    const invoice = await resolveInvoiceRef(ctx, { id: args.invoiceId }, "delete an item from");
    if (!invoice.ok) return invoice.clarify;
    const parent = await captureInvoiceSnapshot(ctx, invoice.id, "parent");
    if (!parent) return { clarify: `Invoice ${invoice.number ?? invoice.id} could not be verified.` };
    const items = await ctx.clockify.listRawInvoiceItems(invoice.id);
    const selectedItem = items.rows[args.index];
    if (!selectedItem) {
      return {
        clarify: items.truncated
          ? `Clockify returned an incomplete invoice item list, so I can't verify index ${args.index}. Use a narrower invoice view and preview again.`
          : `Invoice ${invoice.number ?? invoice.id} has no line item at index ${args.index}.`,
      };
    }
    if (items.truncated) {
      return { clarify: "Clockify returned an incomplete invoice item list, so I can't authorize deletion. Refresh the invoice and preview again." };
    }
    const rawItems = structuredClone(items.rows);
    const rawItemsFingerprint = billingFingerprint(rawItems);
    const target = captureTargetSnapshot("target", { type: "invoice_items", id: invoice.id }, rawItems);
    const itemSnapshot = structuredClone(selectedItem);
    const itemDescription = typeof itemSnapshot.description === "string"
      ? itemSnapshot.description
      : undefined;
    return {
      actionLabel: "Delete invoice item",
      targets: [{ type: "invoice", id: invoice.id, name: invoice.number }],
      expectedChanges: [
        `Delete invoice line item #${args.index}${itemDescription ? ` "${itemDescription}"` : ""}`,
      ],
      reversibility: "This cannot be undone; re-add the line to restore it.",
      warnings: ["This changes a live billing document."],
      payload: { invoiceId: invoice.id, index: args.index, itemSnapshot, rawItems, rawItemsFingerprint },
      targetSnapshots: [target, parent],
      mutationPlan: {
        mode: "single",
        steps: [{ id: "delete-invoice-item", kind: "primary", targetFingerprint: target.fingerprint, reconciliationStrategy: "delete" }],
      },
    };
  },
  async commit(ctx, payload, operation) {
    const { invoiceId, index, rawItems } = payload as {
      invoiceId: string;
      index: number;
      rawItems: Record<string, unknown>[];
    };
    const expectedRemaining = rawItems.filter((_row, rowIndex) => rowIndex !== index);
    let verificationFailure: "stale_target" | "stale_parent" | undefined;
    const snapshots = operation.targetSnapshots ?? [];
    const step = await executeDurableRiskyStep({
      ctx, operation, planStepId: "delete-invoice-item", index: 0, name: "Delete invoice item",
      preparedDetail: { targetSnapshots: snapshots, expectedRemaining },
      dispatch: async () => {
        const verified = await verifyInvoiceMutationSnapshots(ctx, snapshots);
        if (!verified.ok) {
          verificationFailure = verified.code;
          throw new DefinitiveWriteFailure("VERIFY", "delete-invoice-item", verified.code);
        }
        const result = await dispatchWithReconciliation({
          dispatch: async () => { await ctx.clockify.deleteInvoiceItemAtomic(invoiceId, index); return true as const; },
          reconcile: async () => {
            const after = await ctx.clockify.listRawInvoiceItems(invoiceId);
            return !after.truncated && billingFingerprint(after.rows) === billingFingerprint(expectedRemaining) ? true as const : undefined;
          },
        });
        return { effect: { deletedItemIndex: index, invoiceId }, detail: { reconciled: result.reconciled } };
      },
    });
    if (verificationFailure) return errorReceipt({ action: operation.actionName, code: verificationFailure, message: "The invoice items changed before deletion. No delete was sent." });
    return step.status === "succeeded" ? invoiceUpdatedReceipt(ctx, "clockify_invoices_items_delete", invoiceId) : invoiceStepFailure(operation.actionName, step.status);
  },
});

const createInvoicePayment = defineRiskyAction({
  name: "clockify_invoices_payments_create",
  description:
    "Record a payment against an invoice. Payment action — previews and requires confirmation.",
  group: INV,
  risks: ["payment"],
  mutationWorkflow: "durable",
  mutationContract: invoiceSnapshotContract(["parent"], "create"),
  schema: z.object({
    invoiceId: z.string().min(1),
    amount: zNumberLike(z.number().positive()),
    /** `major` (e.g. 50.00) is converted ×100 to the minor units Clockify wants. */
    amountUnit: z.enum(["major", "minor"]).optional(),
    paymentDate: z.string().min(1), // full ISO or YYYY-MM-DD
    note: z.string().optional(),
  }),
  async preview(ctx, args) {
    const invoice = await resolveInvoiceRef(ctx, { id: args.invoiceId }, "record a payment against");
    if (!invoice.ok) return invoice.clarify;
    const parent = await captureInvoiceSnapshot(ctx, invoice.id, "parent");
    if (!parent) return { clarify: `Invoice ${invoice.number ?? invoice.id} could not be verified.` };
    const paymentDate = resolveRelativeDay(nowDate(ctx), { date: args.paymentDate }, ctx.timeZone)
      ?? resolveInstant(nowDate(ctx), args.paymentDate, "start", ctx.timeZone);
    if (paymentDate === undefined) {
      return { clarify: `I couldn't make sense of the payment date "${args.paymentDate}" — give me a real calendar date or an offset-bearing ISO datetime.` };
    }
    const amountMinor = toMinor(args.amount, args.amountUnit ?? "major");
    const payment = {
      amountMinor,
      paymentDate,
      ...(args.note !== undefined ? { note: args.note } : {}),
    };
    const payments = await ctx.clockify.listInvoicePayments(invoice.id);
    if (payments.truncated) return { clarify: "Clockify returned an incomplete payment list, so I can't establish a safe pre-dispatch baseline." };
    return {
      actionLabel: "Record invoice payment",
      targets: [{ type: "invoice", id: invoice.id, name: invoice.number }],
      // Show the HUMAN amount (major units), matching the item preview's
      // `fromMinor(...)` formatting — never the 100x wire integer, which would
      // read as $5000 on a $50 payment. Minor units stay in the payload only.
      expectedChanges: [
        `Record a payment of ${fromMinor(amountMinor)} dated ${paymentDate}`,
      ],
      reversibility: "You can delete the payment afterward.",
      warnings: ["This records money received against a live invoice."],
      payload: { invoiceId: invoice.id, payment, paymentBaseline: paymentBaseline(payments) },
      targetSnapshots: [parent],
      mutationPlan: { mode: "single", steps: [{ id: "record-payment", kind: "primary", targetFingerprint: parent.fingerprint, reconciliationStrategy: "create" }] },
    };
  },
  async commit(ctx, payload, operation) {
    return commitInvoicePaymentCreate({
      ctx,
      operation,
      payload: payload as InvoicePaymentCreatePayload,
    });
  },
});

const deleteInvoicePayment = defineRiskyAction({
  name: "clockify_invoices_payments_delete",
  description:
    "Delete a recorded invoice payment. Destructive payment action — previews and requires confirmation.",
  group: INV,
  risks: ["destructive", "payment"],
  mutationWorkflow: "durable",
  mutationContract: invoiceSnapshotContract(["target", "parent"], "delete"),
  schema: z.object({ invoiceId: z.string().min(1), paymentId: z.string().min(1) }),
  async preview(ctx, args) {
    const invoice = await resolveInvoiceRef(ctx, { id: args.invoiceId }, "delete a payment from");
    if (!invoice.ok) return invoice.clarify;
    const parent = await captureInvoiceSnapshot(ctx, invoice.id, "parent");
    if (!parent) return { clarify: `Invoice ${invoice.number ?? invoice.id} could not be verified.` };
    const payments = await ctx.clockify.listInvoicePayments(invoice.id);
    if (payments.truncated) {
      return { clarify: "Clockify returned an incomplete payment list, so I can't authorize deletion. Refresh the invoice and preview again." };
    }
    const matches = payments.rows.filter((payment) => payment.id === args.paymentId);
    if (matches.length !== 1) {
      return { clarify: `Payment ${args.paymentId} could not be verified uniquely on this invoice.` };
    }
    const paymentSnapshot = structuredClone(matches[0]!);
    const target = captureTargetSnapshot("target", { type: "invoice_payment", id: `${invoice.id}:${args.paymentId}` }, paymentSnapshot);
    return {
      actionLabel: "Delete invoice payment",
      targets: [{ type: "invoice", id: invoice.id, name: invoice.number }],
      expectedChanges: [`Delete payment ${args.paymentId}`],
      reversibility: "This cannot be undone; re-record the payment to restore it.",
      warnings: ["This removes a recorded payment from a live invoice."],
      payload: {
        invoiceId: invoice.id,
        paymentId: args.paymentId,
        paymentSnapshot,
        paymentListTruncated: false,
      },
      targetSnapshots: [target, parent],
      mutationPlan: {
        mode: "single",
        steps: [{ id: "delete-invoice-payment", kind: "primary", targetFingerprint: target.fingerprint, reconciliationStrategy: "delete" }],
      },
    };
  },
  async commit(ctx, payload, operation) {
    const { invoiceId, paymentId } = payload as {
      invoiceId: string;
      paymentId: string;
    };
    let verificationFailure: "stale_target" | "stale_parent" | undefined;
    const snapshots = operation.targetSnapshots ?? [];
    const step = await executeDurableRiskyStep({
      ctx, operation, planStepId: "delete-invoice-payment", index: 0, name: "Delete invoice payment",
      preparedDetail: { targetSnapshots: snapshots, expectedAbsentPaymentId: paymentId },
      dispatch: async () => {
        const verified = await verifyInvoiceMutationSnapshots(ctx, snapshots);
        if (!verified.ok) {
          verificationFailure = verified.code;
          throw new DefinitiveWriteFailure("VERIFY", "delete-invoice-payment", verified.code);
        }
        const result = await dispatchWithReconciliation({
          dispatch: async () => { await ctx.clockify.deleteInvoicePaymentAtomic(invoiceId, paymentId); return true as const; },
          reconcile: async () => {
            const after = await ctx.clockify.listInvoicePayments(invoiceId);
            return !after.truncated && !after.rows.some((payment) => payment.id === paymentId) ? true as const : undefined;
          },
        });
        return { effect: { deleted: { type: "payment", id: paymentId } }, detail: { reconciled: result.reconciled } };
      },
    });
    if (verificationFailure) return errorReceipt({ action: operation.actionName, code: verificationFailure, message: "The invoice payment changed before deletion. No delete was sent." });
    return step.status === "succeeded" ? successReceipt({
        action: "clockify_invoices_payments_delete",
        entity: "invoice",
        ids: { workspaceId: ctx.workspaceId, invoiceId },
        changed: { deleted: [{ type: "payment", id: paymentId }] },
      }) : invoiceStepFailure(operation.actionName, step.status);
  },
});

const importInvoiceTime = defineRiskyAction({
  name: "clockify_invoices_import_time",
  description:
    "Import billable time entries into an invoice by date range. `from`/`to` accept YYYY-MM-DD or a relative day/period (today, last week, this month — resolved server-side; never guess a calendar date). Billing action — previews and requires confirmation.",
  group: INV,
  risks: ["billing"],
  mutationWorkflow: "durable",
  mutationContract: durableMutationContract({
    source: "confirmed",
    targeting: { mode: "snapshots", relations: ["parent"] },
    strategies: ["update"],
    unreconciledStepIds: ["import-invoice-time"],
  }),
  schema: z.object({
    invoiceId: z.string().min(1),
    from: z.string().min(1), // YYYY-MM-DD or a relative day/period (resolved server-side)
    to: z.string().min(1), // YYYY-MM-DD or a relative day/period (resolved server-side)
    projectIds: z.array(z.string().min(1)).optional(),
  }),
  async preview(ctx, args) {
    const invoice = await resolveInvoiceRef(ctx, { id: args.invoiceId }, "import time into");
    if (!invoice.ok) return invoice.clarify;
    const parent = await captureInvoiceSnapshot(ctx, invoice.id, "parent");
    if (!parent) return { clarify: `Invoice ${invoice.number ?? invoice.id} could not be verified.` };
    // A billing wire must never see "today"/"this_month" raw — Clockify 400s
    // "[to] can't be null". from→start-of-day, to→end-of-day (Clockify wants `to`
    // strictly after `from`); unparseable ⇒ clarify, never send.
    const now = nowDate(ctx);
    const dates = resolveDateRange(now, {
      start: { raw: args.from },
      end: { raw: args.to },
      exampleHint: "today, last week, or this month",
      timeZone: ctx.timeZone,
    });
    if (!dates.ok) return { clarify: dates.message };
    // Both edges are required (schema `.min(1)`) and resolved (else `!dates.ok`).
    const from = dates.start as string;
    const to = dates.end as string;
    const range = {
      from,
      to,
      ...(args.projectIds !== undefined ? { projectIds: args.projectIds } : {}),
    };
    const projectSnapshots: TargetSnapshot[] = [];
    for (const projectId of [...new Set(args.projectIds ?? [])]) {
      const project = await ctx.clockify.getProject(projectId);
      if (!project || project.id !== projectId) {
        return { clarify: `Project ${projectId} could not be verified for invoice import.` };
      }
      projectSnapshots.push(captureTargetSnapshot("parent", { type: "project", id: project.id, name: project.name }, project));
    }
    return {
      actionLabel: "Import time into invoice",
      targets: [{ type: "invoice", id: invoice.id, name: invoice.number }],
      expectedChanges: [`Import billable time from ${from.slice(0, 10)} to ${to.slice(0, 10)}`],
      reversibility: "Delete the imported line items to revert.",
      warnings: ["This adds billable time as invoice line items."],
      payload: { invoiceId: invoice.id, range },
      targetSnapshots: [parent, ...projectSnapshots],
      mutationPlan: { mode: "single", steps: [{ id: "import-invoice-time", kind: "primary", targetFingerprint: parent.fingerprint }] },
    };
  },
  async commit(ctx, payload, operation) {
    const typed = payload as {
      invoiceId: string;
      range: Parameters<typeof ctx.clockify.importInvoiceTime>[1];
    };
    return commitSingleDurableRiskyStep({
      ctx,
      operation,
      planStepId: "import-invoice-time",
      name: "Import invoice time",
      verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (snapshot) => fetchInvoiceMutationSnapshot(ctx, snapshot) },
      dispatch: async () => {
        await ctx.clockify.importInvoiceTimeAtomic(typed.invoiceId, typed.range);
        return { effect: { importedTime: { invoiceId: typed.invoiceId } } };
      },
      success: () => invoiceUpdatedReceipt(ctx, "clockify_invoices_import_time", typed.invoiceId),
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
