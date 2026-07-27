import { defineRiskyAction, type ActionDefinition } from "../action.js";
import { durableMutationContract } from "../durable-mutation-contract.js";
import { defineStructureDurableSafeWriteAction, mutationPlan } from "../workflows/structure-durable.js";
import { INVOICE_API_METADATA } from "../workflows/invoices.js";
import {
  commitInvoiceFieldsUpdate,
  commitInvoiceStatusUpdate,
  dispatchInvoiceCreateBase,
  invoiceCreateBaseSchema,
  invoiceFieldsUpdateSchema,
  invoiceStatusUpdateSchema,
  prepareInvoiceCreateBase,
  previewInvoiceFieldsUpdate,
  previewInvoiceStatusUpdate,
} from "../workflows/invoice-action-shared.js";
import type { CreateInvoiceInput } from "../../clockify/ports/invoices.js";

const INV = "invoices" as const;

const createBase = defineStructureDurableSafeWriteAction({
  ...INVOICE_API_METADATA.clockify_invoices_create_base,
  name: "clockify_invoices_create_base",
  description:
    "Create an invoice with only the minimal POST body (client, number, issued/due dates, currency). Enrichment fields and line items require separate follow-up operations. Safe write — executes immediately when policy allows.",
  group: INV,
  stepName: "Create invoice base",
  mutationContract: durableMutationContract({
    source: "safe",
    targeting: { mode: "create_no_target" },
    strategies: ["create"],
  }),
  schema: invoiceCreateBaseSchema,
  async prepare(ctx, args) {
    const prepared = await prepareInvoiceCreateBase(ctx, args);
    if (prepared.kind === "clarify") return prepared;
    return {
      operation: prepared.operation,
      mutationPlan: mutationPlan([{ id: "create-invoice-base", strategy: "create" }]),
    };
  },
  async prepareDispatch(_ctx, operation) {
    const typed = operation as { base: CreateInvoiceInput; beforeIds: string[] };
    return {
      preparedDetail: {
        preDispatch: {
          strategy: "invoice_create_baseline",
          ids: typed.beforeIds,
          truncated: false,
        },
        base: typed.base,
      },
      state: { beforeIds: typed.beforeIds, base: typed.base },
    };
  },
  async dispatch(ctx, _operation, state) {
    return dispatchInvoiceCreateBase(ctx, state);
  },
});

const fieldsUpdate = defineRiskyAction({
  name: "clockify_invoices_fields_update",
  ...INVOICE_API_METADATA.clockify_invoices_fields_update,
  description:
    "Update invoice fields (note/subject/number/dates/currency/client, or tax/discount percents) with one fields PUT. Status changes use clockify_invoices_status_update. Billing action — previews and requires confirmation.",
  group: INV,
  risks: ["billing"],
  mutationWorkflow: "durable",
  mutationContract: durableMutationContract({
    source: "confirmed",
    targeting: { mode: "snapshots", relations: ["target", "parent"] },
    strategies: ["update"],
  }),
  schema: invoiceFieldsUpdateSchema,
  preview: (ctx, args) => previewInvoiceFieldsUpdate(ctx, args),
  commit: (ctx, payload, operation) => commitInvoiceFieldsUpdate(ctx, payload, operation),
});

const statusUpdate = defineRiskyAction({
  name: "clockify_invoices_status_update",
  ...INVOICE_API_METADATA.clockify_invoices_status_update,
  description:
    "Update an invoice's status with one status PATCH. Field changes use clockify_invoices_fields_update. Billing action — previews and requires confirmation.",
  group: INV,
  risks: ["billing"],
  mutationWorkflow: "durable",
  mutationContract: durableMutationContract({
    source: "confirmed",
    targeting: { mode: "snapshots", relations: ["target"] },
    strategies: ["state-command"],
  }),
  schema: invoiceStatusUpdateSchema,
  preview: (ctx, args) => previewInvoiceStatusUpdate(ctx, args),
  commit: (ctx, payload, operation) => commitInvoiceStatusUpdate(ctx, payload, operation),
});

export const INVOICE_API_ACTIONS: ActionDefinition[] = [
  createBase,
  fieldsUpdate,
  statusUpdate,
];
