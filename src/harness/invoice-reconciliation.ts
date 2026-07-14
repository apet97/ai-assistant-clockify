import type {
  AddInvoiceItemInput,
  CreateInvoiceInput,
  InvoiceDetail,
  InvoicePayment,
} from "../clockify/ports/invoices.js";
import type { ListResult } from "../clockify/types.js";
import { billingFingerprint, normalizeBillingDate } from "./billing-fingerprint.js";

export interface InvoiceCreateIntent {
  base: CreateInvoiceInput;
  enrichment: Record<string, unknown>;
  items: AddInvoiceItemInput[];
}

function controlledItem(item: AddInvoiceItemInput) {
  return {
    itemType: item.itemType,
    description: item.description,
    quantity: item.quantity,
    unitPrice: item.unitPriceMinor,
    applyTaxes: item.applyTaxes ?? "NONE",
  };
}

export function invoiceCreateProjection(intent: InvoiceCreateIntent): unknown {
  return {
    clientId: intent.base.clientId,
    number: intent.base.number,
    issuedDate: normalizeBillingDate(intent.base.issuedDate),
    dueDate: normalizeBillingDate(intent.base.dueDate),
    currency: intent.base.currency,
    ...(Object.hasOwn(intent.enrichment, "note") ? { note: intent.enrichment.note } : {}),
    ...(Object.hasOwn(intent.enrichment, "subject") ? { subject: intent.enrichment.subject } : {}),
    ...(typeof intent.enrichment.taxPercent === "number"
      ? { tax: intent.enrichment.taxPercent * 100 }
      : {}),
    ...(typeof intent.enrichment.tax2Percent === "number"
      ? { tax2: intent.enrichment.tax2Percent * 100 }
      : {}),
    ...(typeof intent.enrichment.discountPercent === "number"
      ? { discount: intent.enrichment.discountPercent * 100 }
      : {}),
    items: intent.items.map(controlledItem),
  };
}

export function invoiceDetailProjection(detail: InvoiceDetail, intent: InvoiceCreateIntent): unknown {
  return {
    clientId: detail.clientId,
    number: detail.number,
    issuedDate: normalizeBillingDate(detail.issuedDate),
    dueDate: normalizeBillingDate(detail.dueDate),
    currency: detail.currency,
    ...(Object.hasOwn(intent.enrichment, "note") ? { note: detail.note } : {}),
    ...(Object.hasOwn(intent.enrichment, "subject") ? { subject: detail.subject } : {}),
    ...(typeof intent.enrichment.taxPercent === "number" ? { tax: detail.tax } : {}),
    ...(typeof intent.enrichment.tax2Percent === "number" ? { tax2: detail.tax2 } : {}),
    ...(typeof intent.enrichment.discountPercent === "number" ? { discount: detail.discount } : {}),
    items: detail.items.map((item) => ({
      itemType: item.itemType,
      description: item.description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      applyTaxes: item.applyTaxes ?? "NONE",
    })),
  };
}

export function invoiceCreateFingerprint(intent: InvoiceCreateIntent): string {
  return billingFingerprint(invoiceCreateProjection(intent));
}

export function invoiceDetailFingerprint(detail: InvoiceDetail, intent: InvoiceCreateIntent): string {
  return billingFingerprint(invoiceDetailProjection(detail, intent));
}

export interface PaymentBaseline {
  ids: string[];
  truncated: boolean;
}

export function paymentBaseline(result: ListResult<InvoicePayment>): PaymentBaseline {
  return {
    ids: result.rows.flatMap((row) => typeof row.id === "string" ? [row.id] : []),
    truncated: result.truncated,
  };
}

export function matchNewPayment(input: {
  baseline: PaymentBaseline;
  after: ListResult<InvoicePayment>;
  amountMinor: number;
  paymentDate: string;
  note?: string;
}): { authoritative: boolean; id?: string; matches: number; reason?: string } {
  if (input.baseline.truncated || input.after.truncated) {
    return { authoritative: false, matches: 0, reason: "truncated" };
  }
  const before = new Set(input.baseline.ids);
  const date = normalizeBillingDate(input.paymentDate);
  const matches = input.after.rows.filter((row) =>
    typeof row.id === "string" && !before.has(row.id) &&
    row.amount === input.amountMinor &&
    normalizeBillingDate(row.paymentDate) === date &&
    row.note === input.note
  );
  return matches.length === 1
    ? { authoritative: true, id: matches[0]!.id, matches: 1 }
    : { authoritative: false, matches: matches.length, reason: "non_unique" };
}
