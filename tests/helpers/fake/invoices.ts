import type { WorkspaceClient } from "../../../src/clockify/client.js";
import type {
  InvoiceDetail,
  InvoiceItem,
  InvoicePayment,
  InvoiceSummary,
} from "../../../src/clockify/ports/invoices.js";
import type { FakeContext } from "./state.js";

export function makeFakeInvoices({ state, seed, bump, nextId }: FakeContext): Pick<
  WorkspaceClient,
  | "listInvoices"
  | "getInvoice"
  | "listInvoiceItems"
  | "listInvoicePayments"
  | "exportInvoice"
  | "createInvoice"
  | "updateInvoice"
  | "deleteInvoice"
  | "addInvoiceItem"
  | "deleteInvoiceItem"
  | "createInvoicePayment"
  | "deleteInvoicePayment"
  | "importInvoiceTime"
> {
  return {
    async listInvoices(filter) {
      bump("listInvoices");
      const rows = filter?.status
        ? state.invoices.filter((i) => i.status === filter.status)
        : state.invoices;
      return rows.map((inv): InvoiceSummary => {
        const { items: _items, ...summary } = inv;
        void _items;
        return summary;
      });
    },
    async getInvoice(id) {
      bump("getInvoice");
      return state.invoices.find((i) => i.id === id) ?? null;
    },
    async listInvoiceItems(id) {
      bump("listInvoiceItems");
      return state.invoices.find((i) => i.id === id)?.items ?? [];
    },
    async listInvoicePayments(id) {
      bump("listInvoicePayments");
      return state.invoicePayments[id] ?? [];
    },
    async exportInvoice(id) {
      bump("exportInvoice");
      void id;
      return { contentType: "application/pdf", bytes: 4, base64: "JVBERg==", truncated: false };
    },
    async createInvoice(input) {
      bump("createInvoice");
      const invoice: InvoiceDetail = {
        id: nextId("invoice"),
        number: input.number,
        clientId: input.clientId,
        currency: input.currency,
        status: "UNSENT",
        items: [],
      };
      state.invoices.push(invoice);
      return { id: invoice.id, name: invoice.number ?? invoice.id };
    },
    async updateInvoice(id, { patch, status }) {
      bump("updateInvoice");
      const index = state.invoices.findIndex((i) => i.id === id);
      if (index >= 0) {
        const base = state.invoices[index];
        state.invoices[index] = {
          ...base,
          ...(patch ?? {}),
          ...(status ? { status } : {}),
        } as InvoiceDetail;
        return { id, name: state.invoices[index].number ?? id };
      }
      return { id, name: id };
    },
    async deleteInvoice(id) {
      bump("deleteInvoice");
      state.invoices = state.invoices.filter((i) => i.id !== id);
      delete state.invoicePayments[id];
      state.deleted.push({ entityType: "invoice", id });
    },
    async addInvoiceItem(id, item) {
      bump("addInvoiceItem");
      if (seed.failAddInvoiceItem) {
        throw new Error(`Invoice item type with name ${String(item.itemType)} not found.`);
      }
      const invoice = state.invoices.find((i) => i.id === id);
      if (invoice) {
        const line: InvoiceItem = {
          order: invoice.items.length,
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPriceMinor,
          itemType: item.itemType,
        };
        invoice.items.push(line);
      }
    },
    async deleteInvoiceItem(id, index) {
      bump("deleteInvoiceItem");
      const invoice = state.invoices.find((i) => i.id === id);
      if (invoice) invoice.items = invoice.items.filter((it) => it.order !== index);
    },
    async createInvoicePayment(id, payment) {
      bump("createInvoicePayment");
      const record: InvoicePayment = {
        id: nextId("pay"),
        amount: payment.amountMinor,
        note: payment.note,
        paymentDate: payment.paymentDate,
      };
      (state.invoicePayments[id] ??= []).push(record);
      return record;
    },
    async deleteInvoicePayment(id, paymentId) {
      bump("deleteInvoicePayment");
      state.invoicePayments[id] = (state.invoicePayments[id] ?? []).filter((p) => p.id !== paymentId);
    },
    async importInvoiceTime(id, range) {
      bump("importInvoiceTime");
      void id;
      void range;
    },
  };
}
