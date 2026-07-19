import type { WorkspaceClient } from "../../../src/clockify/client.js";
import type {
  InvoiceDetail,
  InvoiceItem,
  InvoicePayment,
  InvoiceSummary,
} from "../../../src/clockify/ports/invoices.js";
import { fakeListResult, type FakeContext } from "./state.js";
import { AmbiguousWriteOutcome, DefinitiveWriteFailure } from "../../../src/clockify/write-outcome.js";

export function makeFakeInvoices({ state, seed, bump, nextId }: FakeContext): Pick<
  WorkspaceClient,
  | "listInvoices"
  | "getInvoice"
  | "listInvoiceItems"
  | "listRawInvoiceItems"
  | "listInvoicePayments"
  | "exportInvoice"
  | "createInvoice"
  | "createInvoiceBase"
  | "prepareInvoiceFieldUpdate"
  | "updateInvoice"
  | "updateInvoiceFields"
  | "updateInvoiceStatus"
  | "deleteInvoice"
  | "deleteInvoiceAtomic"
  | "addInvoiceItem"
  | "addInvoiceItemAtomic"
  | "deleteInvoiceItem"
  | "deleteInvoiceItemAtomic"
  | "createInvoicePayment"
  | "createInvoicePaymentAtomic"
  | "deleteInvoicePayment"
  | "deleteInvoicePaymentAtomic"
  | "importInvoiceTime"
  | "importInvoiceTimeAtomic"
> {
  const runMutation = async (
    method: keyof NonNullable<typeof seed.invoiceFaults>,
    apply: () => void,
  ): Promise<void> => {
    const fault = seed.invoiceFaults?.[method];
    if (fault?.outcome === "definitive") {
      throw new DefinitiveWriteFailure("POST", `/fake/${String(method)}`, "definitive fake rejection", 400);
    }
    if (fault?.applyBeforeThrow) apply();
    if (fault?.outcome === "ambiguous") {
      throw new AmbiguousWriteOutcome("POST", `/fake/${String(method)}`, "ambiguous fake response", 502);
    }
    apply();
  };

  const createBase = async (input: Parameters<WorkspaceClient["createInvoiceBase"]>[0]) => {
    bump("createInvoiceBase");
    let invoice: InvoiceDetail | undefined;
    await runMutation("createInvoiceBase", () => {
      invoice = {
        id: nextId("invoice"),
        number: input.number,
        clientId: input.clientId,
        currency: input.currency,
        issuedDate: input.issuedDate,
        dueDate: input.dueDate,
        status: "UNSENT",
        items: [],
      };
      state.invoices.push(invoice);
    });
    if (seed.omitCreatedInvoiceId) {
      throw new AmbiguousWriteOutcome("POST", "/fake/createInvoiceBase", "successful response omitted invoice id");
    }
    return { id: invoice!.id, name: invoice!.number ?? invoice!.id };
  };

  const updateFields = async (id: string, patch: Record<string, unknown>) => {
    bump("updateInvoiceFields");
    await runMutation("updateInvoiceFields", () => {
      const index = state.invoices.findIndex((invoice) => invoice.id === id);
      if (index >= 0) {
        state.invoices[index] = {
          ...state.invoices[index],
          ...patch,
          ...(typeof patch.taxPercent === "number" ? { tax: patch.taxPercent * 100 } : {}),
          ...(typeof patch.tax2Percent === "number" ? { tax2: patch.tax2Percent * 100 } : {}),
          ...(typeof patch.discountPercent === "number" ? { discount: patch.discountPercent * 100 } : {}),
        } as InvoiceDetail;
      }
    });
    const invoice = state.invoices.find((candidate) => candidate.id === id);
    return { id, name: invoice?.number ?? id };
  };

  const updateStatus = async (id: string, status: string) => {
    bump("updateInvoiceStatus");
    await runMutation("updateInvoiceStatus", () => {
      const invoice = state.invoices.find((candidate) => candidate.id === id);
      if (invoice) invoice.status = status;
    });
    const invoice = state.invoices.find((candidate) => candidate.id === id);
    return { id, name: invoice?.number ?? id };
  };

  const addItem = async (id: string, item: Parameters<WorkspaceClient["addInvoiceItemAtomic"]>[1]) => {
    bump("addInvoiceItemAtomic");
    if (seed.failAddInvoiceItem) {
      throw new DefinitiveWriteFailure("POST", `/fake/invoices/${id}/items`, `Invoice item type with name ${String(item.itemType)} not found.`, 404);
    }
    await runMutation("addInvoiceItemAtomic", () => {
      const invoice = state.invoices.find((candidate) => candidate.id === id);
      if (!invoice) return;
      invoice.items.push({
        order: invoice.items.length,
        description: item.description,
        quantity: item.quantity,
        unitPrice: item.unitPriceMinor,
        itemType: item.itemType,
        ...(item.applyTaxes === undefined ? {} : { applyTaxes: item.applyTaxes }),
      } as InvoiceItem);
    });
  };

  const postPayment = async (id: string, payment: Parameters<WorkspaceClient["createInvoicePaymentAtomic"]>[1]) => {
    bump("createInvoicePaymentAtomic");
    await runMutation("createInvoicePaymentAtomic", () => {
      const record: InvoicePayment = {
        id: nextId("pay"),
        amount: payment.amountMinor,
        note: payment.note,
        paymentDate: payment.paymentDate,
      };
      (state.invoicePayments[id] ??= []).push(record, ...(seed.concurrentInvoicePayments ?? []));
    });
  };

  const deleteInvoice = async (id: string) => {
    bump("deleteInvoiceAtomic");
    await runMutation("deleteInvoiceAtomic", () => {
      state.invoices = state.invoices.filter((invoice) => invoice.id !== id);
      delete state.invoicePayments[id];
      state.deleted.push({ entityType: "invoice", id });
    });
  };

  const deleteItem = async (id: string, index: number) => {
    bump("deleteInvoiceItemAtomic");
    await runMutation("deleteInvoiceItemAtomic", () => {
      const invoice = state.invoices.find((candidate) => candidate.id === id);
      if (invoice) invoice.items = invoice.items.filter((item) => item.order !== index);
    });
  };

  const deletePayment = async (id: string, paymentId: string) => {
    bump("deleteInvoicePaymentAtomic");
    await runMutation("deleteInvoicePaymentAtomic", () => {
      state.invoicePayments[id] = (state.invoicePayments[id] ?? []).filter((payment) => payment.id !== paymentId);
    });
  };

  const importTime = async (id: string, range: Parameters<WorkspaceClient["importInvoiceTimeAtomic"]>[1]) => {
    bump("importInvoiceTimeAtomic");
    void id;
    void range;
    await runMutation("importInvoiceTimeAtomic", () => undefined);
  };

  return {
    async listInvoices(filter) {
      bump("listInvoices");
      const rows = filter?.status
        ? state.invoices.filter((i) => i.status === filter.status)
        : state.invoices;
      return fakeListResult(seed, "listInvoices", rows.map((inv): InvoiceSummary => {
        const { items: _items, ...summary } = inv;
        void _items;
        return summary;
      }));
    },
    async getInvoice(id) {
      bump("getInvoice");
      return state.invoices.find((i) => i.id === id) ?? null;
    },
    async listInvoiceItems(id) {
      bump("listInvoiceItems");
      return fakeListResult(seed, "listInvoiceItems", state.invoices.find((i) => i.id === id)?.items ?? []);
    },
    async listRawInvoiceItems(id) {
      bump("listRawInvoiceItems");
      return fakeListResult(
        seed,
        "listInvoiceItems",
        structuredClone(state.invoices.find((invoice) => invoice.id === id)?.items ?? []) as Record<string, unknown>[],
      );
    },
    async listInvoicePayments(id) {
      bump("listInvoicePayments");
      if (seed.failPaymentReadAfterPost && (state.invoicePayments[id]?.length ?? 0) > 0) {
        throw new Error("fake payment read failed after post");
      }
      return fakeListResult(seed, "listInvoicePayments", state.invoicePayments[id] ?? []);
    },
    async exportInvoice(id) {
      bump("exportInvoice");
      void id;
      return {
        contentType: "application/pdf",
        bytes: new TextEncoder().encode("%PDF-1.7\nfixture"),
      };
    },
    createInvoiceBase: createBase,
    async createInvoice(input) {
      bump("createInvoice");
      const invoice = await createBase(input);
      if (input.note !== undefined || input.subject !== undefined) {
        await updateFields(invoice.id, {
          ...(input.note === undefined ? {} : { note: input.note }),
          ...(input.subject === undefined ? {} : { subject: input.subject }),
        });
      }
      return invoice;
    },
    async prepareInvoiceFieldUpdate(id, patch) {
      bump("prepareInvoiceFieldUpdate");
      const invoice = state.invoices.find((candidate) => candidate.id === id) ?? { id, items: [] };
      const { items: _items, status: _status, ...editable } = invoice;
      void _items;
      void _status;
      return { ...editable, ...patch };
    },
    updateInvoiceFields: updateFields,
    updateInvoiceStatus: updateStatus,
    async updateInvoice(id, { patch, status }) {
      bump("updateInvoice");
      let result = { id, name: id };
      if (patch && Object.keys(patch).length) result = await updateFields(id, patch);
      if (status) result = await updateStatus(id, status);
      return result;
    },
    deleteInvoiceAtomic: deleteInvoice,
    async deleteInvoice(id) {
      bump("deleteInvoice");
      await deleteInvoice(id);
    },
    addInvoiceItemAtomic: addItem,
    async addInvoiceItem(id, item) {
      bump("addInvoiceItem");
      await addItem(id, item);
    },
    deleteInvoiceItemAtomic: deleteItem,
    async deleteInvoiceItem(id, index) {
      bump("deleteInvoiceItem");
      await deleteItem(id, index);
    },
    createInvoicePaymentAtomic: postPayment,
    async createInvoicePayment(id, payment) {
      bump("createInvoicePayment");
      const before = new Set((state.invoicePayments[id] ?? []).map((row) => row.id));
      await postPayment(id, payment);
      const matches = (state.invoicePayments[id] ?? []).filter((row) =>
        !before.has(row.id) && row.amount === payment.amountMinor &&
        row.paymentDate === payment.paymentDate && row.note === payment.note
      );
      return matches.length === 1 ? matches[0]! : {};
    },
    deleteInvoicePaymentAtomic: deletePayment,
    async deleteInvoicePayment(id, paymentId) {
      bump("deleteInvoicePayment");
      await deletePayment(id, paymentId);
    },
    importInvoiceTimeAtomic: importTime,
    async importInvoiceTime(id, range) {
      bump("importInvoiceTime");
      await importTime(id, range);
    },
  };
}
