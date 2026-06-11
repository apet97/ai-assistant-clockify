import { MAX_PAGES, PAGE_SIZE, type RestCore } from "./core.js";
import type { EntitySummary } from "../types.js";
import type {
  InvoicePort,
  InvoiceSummary,
  InvoiceItem,
  InvoiceDetail,
  InvoicePayment,
} from "../ports/invoices.js";

/** Clockify date fields want a full ISO datetime; normalize a bare YYYY-MM-DD. */
function toClockifyDate(d: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00Z` : d;
}

/**
 * Largest export the receipt will carry inline (1 MB raw → base64). Over this,
 * the bytes are reported but `base64` is omitted with `truncated:true` so the
 * caller surfaces an explicit warning — never a silent cap.
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

function mapSummary(raw: any): InvoiceSummary {
  const out: InvoiceSummary = { id: raw.id };
  if (raw.number !== undefined) out.number = raw.number;
  if (raw.clientId !== undefined) out.clientId = raw.clientId;
  if (raw.clientName !== undefined) out.clientName = raw.clientName;
  if (raw.status !== undefined) out.status = raw.status;
  if (raw.currency !== undefined) out.currency = raw.currency;
  if (raw.amount !== undefined) out.amount = raw.amount;
  if (raw.balance !== undefined) out.balance = raw.balance;
  return out;
}

/**
 * Item money scales are MIXED on the wire (live-probed 2026-06-10): `unitPrice`
 * is minor×100 (hundredths of a cent) while `amount` is plain minor —
 * Clockify computes amount = unitPrice × quantity / 100. Sending plain minor
 * unitPrice billed a $1000 item as $10. Map reads back to all-minor.
 */
const UNIT_PRICE_WIRE_SCALE = 100;

function mapItem(raw: any): InvoiceItem {
  const out: InvoiceItem = {};
  if (raw.order !== undefined) out.order = raw.order;
  if (raw.description !== undefined) out.description = raw.description;
  if (raw.quantity !== undefined) out.quantity = raw.quantity;
  if (typeof raw.unitPrice === "number") out.unitPrice = Math.round(raw.unitPrice / UNIT_PRICE_WIRE_SCALE);
  else if (raw.unitPrice !== undefined) out.unitPrice = raw.unitPrice;
  if (raw.amount !== undefined) out.amount = raw.amount;
  if (raw.itemType !== undefined) out.itemType = raw.itemType;
  return out;
}

function mapDetail(raw: any): InvoiceDetail {
  const items = Array.isArray(raw.items) ? raw.items.map(mapItem) : [];
  return { ...mapSummary(raw), items };
}

function mapPayment(raw: any): InvoicePayment {
  const out: InvoicePayment = {};
  if (raw.id !== undefined) out.id = raw.id;
  else if (raw._id !== undefined) out.id = raw._id;
  if (raw.amount !== undefined) out.amount = raw.amount;
  if (raw.note !== undefined) out.note = raw.note;
  // The wire field in the payments LIST is `date` (probed); `paymentDate` only
  // appears in the request body. Accept both.
  const date = raw.paymentDate ?? raw.date;
  if (date !== undefined) out.paymentDate = date;
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
  async function listPaymentsRaw(id: string): Promise<any[]> {
    const env = (await core.call("api", "GET", `${ws}/invoices/${id}/payments`)) as
      | { payments?: any[]; items?: any[]; data?: any[] }
      | any[]
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
      const base: Record<string, string> = {};
      if (filter?.status) base.statuses = filter.status; // wire param is `statuses` (plural)
      const out: InvoiceSummary[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const qs = new URLSearchParams({ ...base, page: String(page), "page-size": String(PAGE_SIZE) });
        const env = (await core.call("api", "GET", `${ws}/invoices?${qs.toString()}`)) as
          | { invoices?: any[] }
          | any[]
          | null;
        const rows = Array.isArray(env) ? env : (env?.invoices ?? []);
        out.push(...rows.map(mapSummary));
        if (rows.length < PAGE_SIZE) break;
      }
      return out;
    },
    async getInvoice(id) {
      const raw = await core.call("api", "GET", `${ws}/invoices/${id}`, undefined, true);
      return raw ? mapDetail(raw) : null;
    },
    async listInvoiceItems(id) {
      // GET /invoices/{id}/items 405s; items are embedded in the single-GET.
      const detail = await core.call("api", "GET", `${ws}/invoices/${id}`, undefined, true);
      const items = (detail as any)?.items;
      return Array.isArray(items) ? items.map(mapItem) : [];
    },
    async listInvoicePayments(id) {
      return (await listPaymentsRaw(id)).map(mapPayment);
    },
    async exportInvoice(id, format = "PDF") {
      const fmt = format.toUpperCase();
      if (fmt !== "PDF") {
        throw new Error(`invoice export format must be PDF; Clockify does not produce ${format}`);
      }
      const qs = new URLSearchParams({ format: "PDF", userLocale: "en-US" });
      const { contentType, bytes } = await core.getBinary("api", `${ws}/invoices/${id}/export?${qs.toString()}`);
      if (bytes.byteLength > EXPORT_MAX_BYTES) {
        return { contentType, bytes: bytes.byteLength, truncated: true };
      }
      return {
        contentType,
        bytes: bytes.byteLength,
        base64: Buffer.from(bytes).toString("base64"),
        truncated: false,
      };
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
      const before = new Set((await listPaymentsRaw(id)).map((p: any) => p.id ?? p._id));
      const body: Record<string, unknown> = {
        amount: payment.amountMinor,
        paymentDate: toClockifyDate(payment.paymentDate),
        ...(payment.note !== undefined ? { note: payment.note } : {}),
      };
      await core.call("api", "POST", `${ws}/invoices/${id}/payments`, body);
      const created = (await listPaymentsRaw(id)).find((p: any) => !before.has(p.id ?? p._id));
      return created ? mapPayment(created) : {};
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
