import type { EntitySummary } from "../types.js";

/** List filter for invoices (live status). */
export interface InvoiceFilter {
  /** Live status: UNSENT | SENT | PAID | PARTIALLY_PAID | VOID | OVERDUE. */
  status?: string;
}

/** Compact invoice view (list shape: `{total, invoices:[…]}`). Amounts are minor units. */
export interface InvoiceSummary {
  id: string;
  number?: string;
  clientId?: string;
  clientName?: string;
  status?: string;
  currency?: string;
  /** Total in minor units (cents), as returned by Clockify. */
  amount?: number;
  /** Outstanding balance in minor units. */
  balance?: number;
  /** Tax 1 / Tax 2 rate as the GET's ×100 integer (PUT taxPercent=3 reads back as tax=300). */
  tax?: number;
  tax2?: number;
}

/** A line item on an invoice. `order` is the index used by the delete-item path. */
export interface InvoiceItem {
  order?: number;
  description?: string;
  quantity?: number;
  /** Minor units (cents). */
  unitPrice?: number;
  /** Minor units (cents). */
  amount?: number;
  itemType?: string;
}

/** Single-GET invoice (superset of {@link InvoiceSummary}) with embedded line items. */
export interface InvoiceDetail extends InvoiceSummary {
  items: InvoiceItem[];
}

/** A payment recorded against an invoice. `amount` is minor units. */
export interface InvoicePayment {
  id?: string;
  amount?: number;
  note?: string;
  paymentDate?: string;
}

/**
 * Result of an invoice export. The PDF bytes are base64-encoded, but only when
 * within the receipt cap — over the cap, `base64` is omitted and `truncated` is
 * set so the caller can surface an explicit warning (no silent truncation).
 */
export interface InvoiceExport {
  contentType: string;
  /** Raw PDF length in bytes (always reported, even when `base64` is omitted). */
  bytes: number;
  base64?: string;
  truncated: boolean;
}

export interface CreateInvoiceInput {
  clientId: string;
  /** Clockify requires all four of number/issuedDate/currency/dueDate on create. */
  number: string;
  issuedDate: string; // full ISO or YYYY-MM-DD (normalized to full ISO)
  currency: string;
  dueDate: string; // full ISO or YYYY-MM-DD (normalized to full ISO)
  note?: string;
  subject?: string;
}

export interface UpdateInvoiceInput {
  /** Editable invoice fields (note/subject/number/dueDate/issuedDate/currency/clientId). */
  patch?: Record<string, unknown>;
  /** Status change, routed to `PATCH /invoices/{id}/status` (separate from the PUT). */
  status?: string;
}

export interface AddInvoiceItemInput {
  /** Required by Clockify; a type name configured in the workspace invoice settings. */
  itemType: string;
  description?: string;
  quantity?: number;
  /** Already converted to minor units (cents) by the action handler. */
  unitPriceMinor?: number;
  /** Tax application enum (TAX1 | TAX2 | TAX1TAX2 | NONE); defaults to NONE. */
  applyTaxes?: string;
}

export interface CreateInvoicePaymentInput {
  /** Already converted to minor units (cents) by the action handler. */
  amountMinor: number;
  /** Wire field is `paymentDate` (NOT `date`). Full ISO or YYYY-MM-DD. */
  paymentDate: string;
  note?: string;
}

export interface ImportInvoiceTimeInput {
  from: string; // full ISO or YYYY-MM-DD
  to: string; // full ISO or YYYY-MM-DD
  projectIds?: string[];
}

/**
 * Invoice slice of the {@link WorkspaceClient} port (goclmcp §2.6). Reads are
 * immediate; create/update/delete + items/payments/import are risky and run only
 * from a handler's `commit`. Gotchas pinned by the live probe + mocked-fetch
 * tests: list is an envelope (`{total, invoices:[…]}`); `GET /items` 405s so items
 * come from the single-GET; item delete is by `order` index; payment field is
 * `paymentDate`; status changes go through a separate `PATCH /status`.
 */
export interface InvoicePort {
  listInvoices(filter?: InvoiceFilter): Promise<InvoiceSummary[]>;
  getInvoice(id: string): Promise<InvoiceDetail | null>;
  listInvoiceItems(id: string): Promise<InvoiceItem[]>;
  listInvoicePayments(id: string): Promise<InvoicePayment[]>;
  exportInvoice(id: string, format?: string): Promise<InvoiceExport>;
  createInvoice(input: CreateInvoiceInput): Promise<EntitySummary>;
  updateInvoice(id: string, input: UpdateInvoiceInput): Promise<EntitySummary>;
  deleteInvoice(id: string): Promise<void>;
  addInvoiceItem(id: string, item: AddInvoiceItemInput): Promise<void>;
  deleteInvoiceItem(id: string, index: number): Promise<void>;
  createInvoicePayment(id: string, payment: CreateInvoicePaymentInput): Promise<InvoicePayment>;
  deleteInvoicePayment(id: string, paymentId: string): Promise<void>;
  importInvoiceTime(id: string, range: ImportInvoiceTimeInput): Promise<void>;
}
