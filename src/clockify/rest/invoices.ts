import type { RestCore } from "./core.js";
import { toClockifyDate } from "./wire-dates.js";
import type { EntitySummary } from "../types.js";
import type {
  InvoicePort,
  InvoiceSummary,
  InvoiceItem,
  InvoiceDetail,
  InvoicePayment,
} from "../ports/invoices.js";

/**
 * Hard binary limit. The core checks Content-Length and streamed chunks before
 * returning accepted bytes to the short-lived artifact store.
 */
const EXPORT_MAX_BYTES = 1_000_000;

/**
 * Editable invoice fields copied from the current invoice before a PUT update.
 * Clockify's `PUT /invoices/{id}` REPLACES the document, but rejects the
 * read-only/computed fields it returns on GET (amount, balance, items, status,
 * subtotal, taxAmount, …). So the update rebuilds a clean body from this
 * whitelist of existing values, then merges the caller's patch. Status changes
 * go through a separate `PATCH /status` (never the PUT body). Mirrors goclmcp
 * `invoiceUpdateBodyFromExisting` EXCEPT for tax/discount — see
 * {@link INVOICE_PERCENT_FIELDS}; goclmcp copies the `*Percent` names from the
 * GET, which never exist there, and inherits the silent-zeroing bug.
 */
const INVOICE_EDITABLE_FIELDS = [
  "clientId",
  "companyId",
  "currency",
  "dueDate",
  "issuedDate",
  "billFrom",
  "clientAddress",
  "note",
  "number",
  "subject",
  "taxType",
  "visibleZeroFields",
] as const;

/**
 * Tax/discount are asymmetric on the wire (live-probed 2026-06-10): the GET
 * returns them as `discount`/`tax`/`tax2`, ×100-scaled ints (PUT
 * discountPercent=10 reads back as discount=1000), while the PUT body wants
 * `discountPercent`/`taxPercent`/`tax2Percent` as plain percents. Copying the
 * `*Percent` names from the GET silently ZEROED tax/discount on every field
 * update — so map name AND scale here.
 */
const INVOICE_PERCENT_FIELDS: ReadonlyArray<readonly [getKey: string, putKey: string]> = [
  ["discount", "discountPercent"],
  ["tax", "taxPercent"],
  ["tax2", "tax2Percent"],
];

function mapSummary(raw: Record<string, unknown>): InvoiceSummary {
  const out: InvoiceSummary = { id: raw.id as string };
  if (raw.number !== undefined) out.number = raw.number as string;
  if (raw.clientId !== undefined) out.clientId = raw.clientId as string;
  if (raw.clientName !== undefined) out.clientName = raw.clientName as string;
  if (raw.status !== undefined) out.status = raw.status as string;
  if (raw.currency !== undefined) out.currency = raw.currency as string;
  if (raw.amount !== undefined) out.amount = raw.amount as number;
  if (raw.balance !== undefined) out.balance = raw.balance as number;
  if (typeof raw.tax === "number") out.tax = raw.tax;
  if (typeof raw.tax2 === "number") out.tax2 = raw.tax2;
  return out;
}

/**
 * Item money scales are MIXED on the wire (live-probed 2026-06-10): `unitPrice`
 * is minor×100 (hundredths of a cent) while `amount` is plain minor —
 * Clockify computes amount = unitPrice × quantity / 100. Sending plain minor
 * unitPrice billed a $1000 item as $10. Map reads back to all-minor.
 */
const UNIT_PRICE_WIRE_SCALE = 100;

function mapItem(raw: Record<string, unknown>): InvoiceItem {
  const out: InvoiceItem = {};
  if (raw.order !== undefined) out.order = raw.order as number;
  if (raw.description !== undefined) out.description = raw.description as string;
  if (raw.quantity !== undefined) out.quantity = raw.quantity as number;
  if (typeof raw.unitPrice === "number") out.unitPrice = Math.round(raw.unitPrice / UNIT_PRICE_WIRE_SCALE);
  else if (raw.unitPrice !== undefined) out.unitPrice = raw.unitPrice as number;
  if (raw.amount !== undefined) out.amount = raw.amount as number;
  if (raw.itemType !== undefined) out.itemType = raw.itemType as string;
  return out;
}

function mapDetail(raw: Record<string, unknown>): InvoiceDetail {
  const items = Array.isArray(raw.items)
    ? (raw.items as Record<string, unknown>[]).map(mapItem)
    : [];
  return { ...mapSummary(raw), items };
}

/**
 * Payment row as read from the payments LIST. Live shape (probed): a bare array
 * of `{id, amount, date, note, author}`; the `_id`/`paymentDate` keys are
 * defensive fallbacks {@link mapPayment} accepts.
 */
type PaymentRow = {
  id?: string;
  _id?: string;
  amount?: number;
  note?: string;
  paymentDate?: string;
  date?: string;
};

function mapPayment(raw: Record<string, unknown>): InvoicePayment {
  const out: InvoicePayment = {};
  if (raw.id !== undefined) out.id = raw.id as string;
  else if (raw._id !== undefined) out.id = raw._id as string;
  if (raw.amount !== undefined) out.amount = raw.amount as number;
  if (raw.note !== undefined) out.note = raw.note as string;
  // The wire field in the payments LIST is `date` (probed); `paymentDate` only
  // appears in the request body. Accept both.
  const date = raw.paymentDate ?? raw.date;
  if (date !== undefined) out.paymentDate = date as string;
  return out;
}

/**
 * Typed invoice REST module (goclmcp §2.6). Reads are immediate; the risky
 * methods run only from a handler's `commit`. Shapes pinned by the live probe +
 * unit tests: list is an envelope (`{total, invoices:[…]}`), so it cannot use
 * `core.paginate` (which expects bare arrays); items come from the single-GET
 * because `GET /items` 405s; item delete is by `order` index; the payment date
 * field is `paymentDate`; status changes go through `PATCH /status`.
 */
export function makeInvoiceRest(core: RestCore, workspaceId: string): InvoicePort {
  const ws = `/workspaces/${workspaceId}`;

  // Live shape (probed): a bare array of {id, amount, date, note, author}.
  // The envelope keys are a defensive fallback only.
  async function listPaymentsRaw(id: string): Promise<PaymentRow[]> {
    const env = (await core.call("api", "GET", `${ws}/invoices/${id}/payments`)) as
      | { payments?: PaymentRow[]; items?: PaymentRow[]; data?: PaymentRow[] }
      | PaymentRow[]
      | null;
    return Array.isArray(env) ? env : (env?.payments ?? env?.items ?? env?.data ?? []);
  }

  // Closure-scoped so createInvoice can route note/subject through the SAME
  // verified GET-then-clean-PUT path the public update uses (no `this`, which
  // would break once the port is spread into the combined WorkspaceClient).
  async function updateInvoiceImpl(
    id: string,
    { patch, status }: { patch?: Record<string, unknown>; status?: string },
  ): Promise<EntitySummary> {
    const hasPatch = !!patch && Object.keys(patch).length > 0;
    let number: string | undefined;
    // GET once when there is anything to do — it feeds BOTH the clean PUT body
    // (field updates) and the receipt's invoice number (status-only changes).
    if (hasPatch || status) {
      const existing = ((await core.call("api", "GET", `${ws}/invoices/${id}`)) ?? {}) as Record<string, unknown>;
      number = existing.number as string | undefined;
      if (hasPatch) {
        const body: Record<string, unknown> = {};
        for (const key of INVOICE_EDITABLE_FIELDS) {
          if (existing[key] !== undefined) body[key] = existing[key];
        }
        for (const [getKey, putKey] of INVOICE_PERCENT_FIELDS) {
          const value = existing[getKey];
          if (typeof value === "number") body[putKey] = value / 100;
        }
        Object.assign(body, patch);
        if (typeof body.issuedDate === "string") body.issuedDate = toClockifyDate(body.issuedDate);
        if (typeof body.dueDate === "string") body.dueDate = toClockifyDate(body.dueDate);
        const updated = (await core.call("api", "PUT", `${ws}/invoices/${id}`, body)) as { number?: string };
        number = updated?.number ?? number;
      }
    }
    if (status) {
      await core.call("api", "PATCH", `${ws}/invoices/${id}/status`, { invoiceStatus: status });
    }
    return { id, name: number ?? id };
  }

  return {
    async listInvoices(filter) {
      // Envelope list (`{total, invoices:[…]}`); paginate so >50 invoices don't
      // truncate and the MAX_PAGES backstop warning fires when a list is capped.
      const params: Record<string, string> = {};
      if (filter?.status) params.statuses = filter.status; // wire param is `statuses` (plural)
      const result = await core.paginateEnvelope("api", `${ws}/invoices`, "invoices", params);
      return { ...result, rows: (result.rows as Record<string, unknown>[]).map(mapSummary) };
    },
    async getInvoice(id) {
      const raw = await core.call("api", "GET", `${ws}/invoices/${id}`, undefined, true);
      return raw ? mapDetail(raw as Record<string, unknown>) : null;
    },
    async listInvoiceItems(id) {
      // GET /invoices/{id}/items 405s; items are embedded in the single-GET.
      const detail = (await core.call("api", "GET", `${ws}/invoices/${id}`, undefined, true)) as
        | { items?: Record<string, unknown>[] }
        | null;
      const items = detail?.items;
      return { rows: Array.isArray(items) ? items.map(mapItem) : [], truncated: false };
    },
    async listInvoicePayments(id) {
      return { rows: (await listPaymentsRaw(id)).map(mapPayment), truncated: false };
    },
    async exportInvoice(id, format = "PDF") {
      const fmt = format.toUpperCase();
      if (fmt !== "PDF") {
        throw new Error(`invoice export format must be PDF; Clockify does not produce ${format}`);
      }
      const qs = new URLSearchParams({ format: "PDF", userLocale: "en-US" });
      return core.getBinary("api", `${ws}/invoices/${id}/export?${qs.toString()}`, EXPORT_MAX_BYTES);
    },
    async createInvoice(input): Promise<EntitySummary> {
      // POST /invoices accepts ONLY the spec's CreateInvoiceRequest fields
      // (clientId, currency, dueDate, issuedDate, number). note/subject sent
      // here are SILENTLY DROPPED — live-probed 2026-06-11: the POST response
      // and a follow-up GET both show the workspace's default placeholder
      // ("INPUT BILL INFO HERE"), never the supplied text. Apply them via the
      // verified GET-then-clean-PUT update path so the billing doc is truthful.
      const body: Record<string, unknown> = {
        clientId: input.clientId,
        number: input.number,
        issuedDate: toClockifyDate(input.issuedDate),
        currency: input.currency,
        dueDate: toClockifyDate(input.dueDate),
        status: "UNSENT",
      };
      const inv = (await core.call("api", "POST", `${ws}/invoices`, body)) as { id: string; number?: string };
      if (input.note !== undefined || input.subject !== undefined) {
        const patch: Record<string, unknown> = {};
        if (input.note !== undefined) patch.note = input.note;
        if (input.subject !== undefined) patch.subject = input.subject;
        return updateInvoiceImpl(inv.id, { patch });
      }
      return { id: inv.id, name: inv.number ?? input.number };
    },
    async updateInvoice(id, opts): Promise<EntitySummary> {
      return updateInvoiceImpl(id, opts);
    },
    async deleteInvoice(id) {
      await core.call("api", "DELETE", `${ws}/invoices/${id}`);
    },
    async addInvoiceItem(id, item) {
      const body: Record<string, unknown> = {
        ...(item.description !== undefined ? { description: item.description } : {}),
        ...(item.quantity !== undefined ? { quantity: item.quantity } : {}),
        // minor → the wire's minor×100 scale (see UNIT_PRICE_WIRE_SCALE).
        ...(item.unitPriceMinor !== undefined ? { unitPrice: item.unitPriceMinor * UNIT_PRICE_WIRE_SCALE } : {}),
        applyTaxes: item.applyTaxes ?? "NONE",
        itemType: item.itemType,
      };
      await core.call("api", "POST", `${ws}/invoices/${id}/items`, body);
    },
    async deleteInvoiceItem(id, index) {
      await core.call("api", "DELETE", `${ws}/invoices/${id}/items/${index}`);
    },
    async createInvoicePayment(id, payment): Promise<InvoicePayment> {
      // The POST response is the updated INVOICE document, not the payment
      // (live-probed) — mapping it as a payment put the invoice's id/amount in
      // the receipt. Diff the payments list around the POST to return the
      // genuinely new payment instead.
      const before = new Set((await listPaymentsRaw(id)).map((p) => p.id ?? p._id));
      const paymentDate = toClockifyDate(payment.paymentDate);
      const body: Record<string, unknown> = {
        amount: payment.amountMinor,
        paymentDate,
        ...(payment.note !== undefined ? { note: payment.note } : {}),
      };
      await core.call("api", "POST", `${ws}/invoices/${id}/payments`, body);
      const matches = (await listPaymentsRaw(id))
        .filter((row) => !before.has(row.id ?? row._id))
        .map((row) => mapPayment(row))
        .filter(
          (candidate) =>
            candidate.amount === payment.amountMinor &&
            candidate.paymentDate === paymentDate &&
            candidate.note === payment.note,
        );
      // Concurrent payments can appear between the two lists. An ID is
      // authoritative only when exactly one newly observed row matches every
      // explicit field. Otherwise the payment is recorded but its ID is
      // intentionally unknown, so callers cannot offer an unsafe undo.
      return matches.length === 1 ? matches[0] : {};
    },
    async deleteInvoicePayment(id, paymentId) {
      await core.call("api", "DELETE", `${ws}/invoices/${id}/payments/${paymentId}`);
    },
    async importInvoiceTime(id, range) {
      const projectFilter: Record<string, unknown> = { contains: "CONTAINS", status: "ALL" };
      if (range.projectIds?.length) projectFilter.ids = range.projectIds;
      await core.call("api", "POST", `${ws}/invoices/${id}/items/import`, {
        from: toClockifyDate(range.from),
        to: toClockifyDate(range.to),
        importExpenses: false,
        timeEntryGroupType: "DETAILED",
        projectFilter,
      });
    },
  };
}
