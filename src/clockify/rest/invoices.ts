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
import { AmbiguousWriteOutcome } from "../write-outcome.js";

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
const INVOICE_STRING_FIELDS = [
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
] as const;

const INVOICE_NUMBER_FIELDS = ["discountPercent", "taxPercent", "tax2Percent"] as const;
const INVOICE_REQUIRED_STRING_FIELDS = ["currency", "dueDate", "issuedDate", "number"] as const;
const INVOICE_REQUIRED_NUMBER_FIELDS = ["discountPercent", "taxPercent", "tax2Percent"] as const;
const TAX_TYPES = new Set(["COMPOUND", "SIMPLE", "NONE"]);
const VISIBLE_ZERO_FIELDS = new Set(["TAX", "TAX_2", "DISCOUNT"]);

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
  if (typeof raw.discount === "number") out.discount = raw.discount;
  if (typeof raw.issuedDate === "string") out.issuedDate = raw.issuedDate;
  if (typeof raw.dueDate === "string") out.dueDate = raw.dueDate;
  if (typeof raw.note === "string") out.note = raw.note;
  if (typeof raw.subject === "string") out.subject = raw.subject;
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
  if (raw.applyTaxes !== undefined) out.applyTaxes = raw.applyTaxes as string;
  if (raw.taxAmount !== undefined) out.taxAmount = raw.taxAmount as number;
  if (raw.tax2Amount !== undefined) out.tax2Amount = raw.tax2Amount as number;
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

  function createBody(input: Parameters<InvoicePort["createInvoiceBase"]>[0]): Record<string, unknown> {
    return {
      clientId: input.clientId,
      number: input.number,
      issuedDate: toClockifyDate(input.issuedDate),
      currency: input.currency,
      dueDate: toClockifyDate(input.dueDate),
    };
  }

  function itemBody(item: Parameters<InvoicePort["addInvoiceItemAtomic"]>[1]): Record<string, unknown> {
    return {
      ...(item.description !== undefined ? { description: item.description } : {}),
      ...(item.quantity !== undefined ? { quantity: item.quantity } : {}),
      ...(item.unitPriceMinor !== undefined
        ? { unitPrice: item.unitPriceMinor * UNIT_PRICE_WIRE_SCALE }
        : {}),
      applyTaxes: item.applyTaxes ?? "NONE",
      itemType: item.itemType,
    };
  }

  async function prepareInvoiceFieldUpdateImpl(
    id: string,
    patch: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const existing = ((await core.call("api", "GET", `${ws}/invoices/${id}`)) ?? {}) as Record<string, unknown>;
    const body: Record<string, unknown> = {};
    for (const key of INVOICE_STRING_FIELDS) {
      if (typeof existing[key] === "string") body[key] = existing[key];
    }
    for (const key of INVOICE_NUMBER_FIELDS) {
      if (typeof existing[key] === "number" && Number.isFinite(existing[key])) body[key] = existing[key];
    }
    for (const [getKey, putKey] of INVOICE_PERCENT_FIELDS) {
      const value = existing[getKey];
      if (typeof value === "number" && Number.isFinite(value)) body[putKey] = value / 100;
    }
    if (typeof existing.taxType === "string" && TAX_TYPES.has(existing.taxType)) {
      body.taxType = existing.taxType;
    }
    if (typeof existing.visibleZeroFields === "string" && VISIBLE_ZERO_FIELDS.has(existing.visibleZeroFields)) {
      body.visibleZeroFields = existing.visibleZeroFields;
    } else if (
      Array.isArray(existing.visibleZeroFields)
      && existing.visibleZeroFields.every((value): value is string => typeof value === "string" && VISIBLE_ZERO_FIELDS.has(value))
      && new Set(existing.visibleZeroFields).size === existing.visibleZeroFields.length
    ) {
      body.visibleZeroFields = [...existing.visibleZeroFields];
    }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if ((INVOICE_STRING_FIELDS as readonly string[]).includes(key)) {
        if (typeof value !== "string") throw new Error(`invoice_update_invalid_${key}`);
        body[key] = value;
        continue;
      }
      if ((INVOICE_NUMBER_FIELDS as readonly string[]).includes(key)) {
        if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`invoice_update_invalid_${key}`);
        body[key] = value;
        continue;
      }
      if (key === "taxType") {
        if (typeof value !== "string" || !TAX_TYPES.has(value)) throw new Error("invoice_update_invalid_taxType");
        body[key] = value;
        continue;
      }
      if (key === "visibleZeroFields") {
        if (typeof value === "string" && VISIBLE_ZERO_FIELDS.has(value)) {
          body[key] = value;
          continue;
        }
        if (
          Array.isArray(value)
          && value.every((item): item is string => typeof item === "string" && VISIBLE_ZERO_FIELDS.has(item))
          && new Set(value).size === value.length
        ) {
          body[key] = [...value];
          continue;
        }
        throw new Error("invoice_update_invalid_visibleZeroFields");
      }
      // The PUT schema is closed: never forward a read-only/computed or unknown key.
    }
    for (const key of INVOICE_REQUIRED_STRING_FIELDS) {
      if (typeof body[key] !== "string" || body[key].length === 0) {
        throw new Error(`invoice_update_missing_or_invalid_${key}`);
      }
    }
    for (const key of INVOICE_REQUIRED_NUMBER_FIELDS) {
      if (typeof body[key] !== "number" || !Number.isFinite(body[key])) {
        throw new Error(`invoice_update_missing_or_invalid_${key}`);
      }
    }
    if (typeof body.issuedDate === "string") body.issuedDate = toClockifyDate(body.issuedDate);
    if (typeof body.dueDate === "string") body.dueDate = toClockifyDate(body.dueDate);
    return body;
  }

  async function updateInvoiceFieldsImpl(id: string, body: Record<string, unknown>): Promise<EntitySummary> {
    const updated = (await core.mutate("api", "PUT", `${ws}/invoices/${id}`, body)) as
      | { number?: string }
      | null;
    const number = updated?.number ?? (body.number as string | undefined);
    return { id, name: number ?? id };
  }

  async function updateInvoiceStatusImpl(id: string, status: string): Promise<EntitySummary> {
    await core.mutate("api", "PATCH", `${ws}/invoices/${id}/status`, { invoiceStatus: status });
    return { id, name: id };
  }

  async function createInvoiceBaseImpl(input: Parameters<InvoicePort["createInvoiceBase"]>[0]): Promise<EntitySummary> {
    const inv = (await core.mutate("api", "POST", `${ws}/invoices`, createBody(input))) as
      | { id?: unknown; number?: unknown }
      | null;
    if (typeof inv?.id !== "string" || inv.id.length === 0) {
      throw new AmbiguousWriteOutcome(
        "POST",
        `${ws}/invoices`,
        "Clockify returned a successful invoice response without a usable id.",
      );
    }
    return { id: inv.id, name: typeof inv.number === "string" ? inv.number : input.number };
  }

  async function deleteInvoiceImpl(id: string): Promise<void> {
    await core.mutate("api", "DELETE", `${ws}/invoices/${id}`);
  }

  async function addInvoiceItemImpl(
    id: string,
    item: Parameters<InvoicePort["addInvoiceItemAtomic"]>[1],
  ): Promise<void> {
    await core.mutate("api", "POST", `${ws}/invoices/${id}/items`, itemBody(item));
  }

  async function deleteInvoiceItemImpl(id: string, index: number): Promise<void> {
    await core.mutate("api", "DELETE", `${ws}/invoices/${id}/items/${index}`);
  }

  async function createInvoicePaymentImpl(
    id: string,
    payment: Parameters<InvoicePort["createInvoicePaymentAtomic"]>[1],
  ): Promise<void> {
    await core.mutate("api", "POST", `${ws}/invoices/${id}/payments`, {
      amount: payment.amountMinor,
      paymentDate: toClockifyDate(payment.paymentDate),
      ...(payment.note !== undefined ? { note: payment.note } : {}),
    });
  }

  async function deleteInvoicePaymentImpl(id: string, paymentId: string): Promise<void> {
    await core.mutate("api", "DELETE", `${ws}/invoices/${id}/payments/${paymentId}`);
  }

  async function importInvoiceTimeImpl(
    id: string,
    range: Parameters<InvoicePort["importInvoiceTimeAtomic"]>[1],
  ): Promise<void> {
    const projectFilter: Record<string, unknown> = { contains: "CONTAINS", status: "ALL" };
    if (range.projectIds?.length) projectFilter.ids = range.projectIds;
    await core.mutate("api", "POST", `${ws}/invoices/${id}/items/import`, {
      from: toClockifyDate(range.from),
      to: toClockifyDate(range.to),
      importExpenses: false,
      timeEntryGroupType: "DETAILED",
      projectFilter,
    });
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
    async listRawInvoiceItems(id) {
      const detail = (await core.call("api", "GET", `${ws}/invoices/${id}`, undefined, true)) as
        | { items?: Record<string, unknown>[] }
        | null;
      return { rows: Array.isArray(detail?.items) ? detail.items : [], truncated: false };
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
    async createInvoiceBase(input): Promise<EntitySummary> {
      return createInvoiceBaseImpl(input);
    },
    async createInvoice(input): Promise<EntitySummary> {
      const inv = await createInvoiceBaseImpl(input);
      if (input.note !== undefined || input.subject !== undefined) {
        const patch: Record<string, unknown> = {};
        if (input.note !== undefined) patch.note = input.note;
        if (input.subject !== undefined) patch.subject = input.subject;
        const body = await prepareInvoiceFieldUpdateImpl(inv.id, patch);
        return updateInvoiceFieldsImpl(inv.id, body);
      }
      return inv;
    },
    async prepareInvoiceFieldUpdate(id, patch) {
      return prepareInvoiceFieldUpdateImpl(id, patch);
    },
    async updateInvoice(id, opts): Promise<EntitySummary> {
      let entity: EntitySummary = { id, name: id };
      let compatibilityName: string | undefined;
      if (opts.patch && Object.keys(opts.patch).length > 0) {
        const body = await prepareInvoiceFieldUpdateImpl(id, opts.patch);
        entity = await updateInvoiceFieldsImpl(id, body);
      }
      if (opts.status && (!opts.patch || Object.keys(opts.patch).length === 0)) {
        const existing = ((await core.call("api", "GET", `${ws}/invoices/${id}`)) ?? {}) as Record<string, unknown>;
        if (typeof existing.number === "string") compatibilityName = existing.number;
      }
      if (opts.status) entity = await updateInvoiceStatusImpl(id, opts.status);
      if (compatibilityName) entity = { id, name: compatibilityName };
      return entity;
    },
    async updateInvoiceFields(id, patch) {
      return updateInvoiceFieldsImpl(id, patch);
    },
    async updateInvoiceStatus(id, status) {
      return updateInvoiceStatusImpl(id, status);
    },
    async deleteInvoiceAtomic(id) {
      await deleteInvoiceImpl(id);
    },
    async deleteInvoice(id) {
      await deleteInvoiceImpl(id);
    },
    async addInvoiceItemAtomic(id, item) {
      await addInvoiceItemImpl(id, item);
    },
    async addInvoiceItem(id, item) {
      await addInvoiceItemImpl(id, item);
    },
    async deleteInvoiceItemAtomic(id, index) {
      await deleteInvoiceItemImpl(id, index);
    },
    async deleteInvoiceItem(id, index) {
      await deleteInvoiceItemImpl(id, index);
    },
    async createInvoicePaymentAtomic(id, payment) {
      await createInvoicePaymentImpl(id, payment);
    },
    async createInvoicePayment(id, payment): Promise<InvoicePayment> {
      // The POST response is the updated INVOICE document, not the payment
      // (live-probed) — mapping it as a payment put the invoice's id/amount in
      // the receipt. Diff the payments list around the POST to return the
      // genuinely new payment instead.
      const before = new Set((await listPaymentsRaw(id)).map((p) => p.id ?? p._id));
      const paymentDate = toClockifyDate(payment.paymentDate);
      await createInvoicePaymentImpl(id, payment);
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
    async deleteInvoicePaymentAtomic(id, paymentId) {
      await deleteInvoicePaymentImpl(id, paymentId);
    },
    async deleteInvoicePayment(id, paymentId) {
      await deleteInvoicePaymentImpl(id, paymentId);
    },
    async importInvoiceTimeAtomic(id, range) {
      await importInvoiceTimeImpl(id, range);
    },
    async importInvoiceTime(id, range) {
      await importInvoiceTimeImpl(id, range);
    },
  };
}
