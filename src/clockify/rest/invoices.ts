import type { RestCore } from "./core.js";
import type { EntitySummary } from "../client.js";
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

/** Clockify's per-page cap for list endpoints; the invoices envelope is paged the same way. */
const PAGE_SIZE = 200;
const MAX_PAGES = 50;

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
 * `invoiceUpdateBodyFromExisting`.
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
  "discountPercent",
  "tax2Percent",
  "taxPercent",
  "visibleZeroFields",
] as const;

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

function mapItem(raw: any): InvoiceItem {
  const out: InvoiceItem = {};
  if (raw.order !== undefined) out.order = raw.order;
  if (raw.description !== undefined) out.description = raw.description;
  if (raw.quantity !== undefined) out.quantity = raw.quantity;
  if (raw.unitPrice !== undefined) out.unitPrice = raw.unitPrice;
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
  if (raw.paymentDate !== undefined) out.paymentDate = raw.paymentDate;
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
      const env = (await core.call("api", "GET", `${ws}/invoices/${id}/payments`)) as
        | { payments?: any[]; items?: any[]; data?: any[] }
        | any[]
        | null;
      const rows = Array.isArray(env) ? env : (env?.payments ?? env?.items ?? env?.data ?? []);
      return rows.map(mapPayment);
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
      const body: Record<string, unknown> = {
        clientId: input.clientId,
        number: input.number,
        issuedDate: toClockifyDate(input.issuedDate),
        currency: input.currency,
        dueDate: toClockifyDate(input.dueDate),
        status: "UNSENT",
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.subject !== undefined ? { subject: input.subject } : {}),
      };
      const inv = (await core.call("api", "POST", `${ws}/invoices`, body)) as { id: string; number?: string };
      return { id: inv.id, name: inv.number ?? input.number };
    },
    async updateInvoice(id, { patch, status }): Promise<EntitySummary> {
      let number: string | undefined;
      if (patch && Object.keys(patch).length > 0) {
        const existing = ((await core.call("api", "GET", `${ws}/invoices/${id}`)) ?? {}) as Record<string, unknown>;
        const body: Record<string, unknown> = {};
        for (const key of INVOICE_EDITABLE_FIELDS) {
          if (existing[key] !== undefined) body[key] = existing[key];
        }
        Object.assign(body, patch);
        if (typeof body.issuedDate === "string") body.issuedDate = toClockifyDate(body.issuedDate);
        if (typeof body.dueDate === "string") body.dueDate = toClockifyDate(body.dueDate);
        const updated = (await core.call("api", "PUT", `${ws}/invoices/${id}`, body)) as { number?: string };
        number = updated?.number ?? (existing.number as string | undefined);
      }
      if (status) {
        await core.call("api", "PATCH", `${ws}/invoices/${id}/status`, { invoiceStatus: status });
      }
      return { id, name: number ?? id };
    },
    async deleteInvoice(id) {
      await core.call("api", "DELETE", `${ws}/invoices/${id}`);
    },
    async addInvoiceItem(id, item) {
      const body: Record<string, unknown> = {
        ...(item.description !== undefined ? { description: item.description } : {}),
        ...(item.quantity !== undefined ? { quantity: item.quantity } : {}),
        ...(item.unitPriceMinor !== undefined ? { unitPrice: item.unitPriceMinor } : {}),
        applyTaxes: item.applyTaxes ?? "NONE",
        itemType: item.itemType,
      };
      await core.call("api", "POST", `${ws}/invoices/${id}/items`, body);
    },
    async deleteInvoiceItem(id, index) {
      await core.call("api", "DELETE", `${ws}/invoices/${id}/items/${index}`);
    },
    async createInvoicePayment(id, payment): Promise<InvoicePayment> {
      const body: Record<string, unknown> = {
        amount: payment.amountMinor,
        paymentDate: toClockifyDate(payment.paymentDate),
        ...(payment.note !== undefined ? { note: payment.note } : {}),
      };
      const created = (await core.call("api", "POST", `${ws}/invoices/${id}/payments`, body)) as any;
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
