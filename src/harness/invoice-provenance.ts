export type ValueProvenance = "explicit" | "generated";

export interface InvoiceItemProvenance {
  description: ValueProvenance;
  quantity: ValueProvenance;
  amount: ValueProvenance;
  amountUnit: ValueProvenance;
  itemType: ValueProvenance;
  applyTaxes: ValueProvenance;
}

export interface InvoiceCreateProvenance {
  number: ValueProvenance;
  issuedDate: ValueProvenance;
  dueDate: ValueProvenance;
  currency: ValueProvenance;
  note: ValueProvenance;
  subject: ValueProvenance;
  taxPercent: ValueProvenance;
  tax2Percent: ValueProvenance;
  discountPercent: ValueProvenance;
  items: InvoiceItemProvenance[];
}

type SourceItem = {
  description?: unknown;
  quantity?: unknown;
  amount?: unknown;
  amountUnit?: unknown;
  itemType?: unknown;
  applyTaxes?: unknown;
};

const source = (value: unknown): ValueProvenance => value === undefined ? "generated" : "explicit";

export function buildInvoiceCreateProvenance(args: {
  number?: unknown;
  issuedDate?: unknown;
  dueDate?: unknown;
  currency?: unknown;
  note?: unknown;
  subject?: unknown;
  taxPercent?: unknown;
  tax2Percent?: unknown;
  discountPercent?: unknown;
  items?: SourceItem[];
}): InvoiceCreateProvenance {
  return {
    number: source(args.number),
    issuedDate: source(args.issuedDate),
    dueDate: source(args.dueDate),
    currency: source(args.currency),
    note: source(args.note),
    subject: source(args.subject),
    taxPercent: source(args.taxPercent),
    tax2Percent: source(args.tax2Percent),
    discountPercent: source(args.discountPercent),
    items: (args.items ?? []).map((item) => ({
      description: source(item.description),
      quantity: source(item.quantity),
      amount: source(item.amount),
      amountUnit: source(item.amountUnit),
      itemType: source(item.itemType),
      applyTaxes: source(item.applyTaxes),
    })),
  };
}
