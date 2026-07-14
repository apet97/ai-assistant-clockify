import type { WorkspaceClient } from "../../clockify/client.js";
import type { ListResult } from "../../clockify/types.js";
import type { ReconciliationBinding, ReconciliationCandidate, ReconciliationResult, ReconciliationStrategy } from "../reconciliation.js";
import { reconcileExternalMutation } from "../reconciliation.js";
import { sanitizedFingerprint } from "../safe-json.js";
import type { StartupReconciliationCandidate } from "../startup-reconciliation.js";
import { invoiceDetailFingerprint, matchNewPayment, type InvoiceCreateIntent } from "../invoice-reconciliation.js";

type StartupStep = StartupReconciliationCandidate["steps"][number];

/** Startup reconciliation is read-only by construction. In particular, none of
 * the atomic mutation, compatibility mutation, or compensation methods are in
 * this capability. */
export type LeaveBillingStartupReconciliationReadClient = Pick<WorkspaceClient,
  | "listExpenses" | "getExpense" | "listExpenseCategories"
  | "listCustomFields" | "getCustomField"
  | "listTimeOffPolicies" | "getTimeOffPolicy" | "getTimeOffPolicyMutationState"
  | "listTimeOffRequests" | "getTimeOffRequest" | "getTimeOffBalance"
  | "listHolidays" | "getHolidayMutationState"
  | "listInvoices" | "getInvoice" | "listRawInvoiceItems" | "listInvoicePayments"
  | "getProject" | "getProjectMutationState" | "getClient" | "getClientMutationState"
  | "getTag" | "prepareTagUpdate" | "getEntry" | "getWebhook" | "getGroup"
>;

interface HandlerInput {
  binding: ReconciliationBinding;
  candidate: StartupReconciliationCandidate;
  step: StartupStep;
  clockify: LeaveBillingStartupReconciliationReadClient;
}

type Handler = (input: HandlerInput) => Promise<ReconciliationResult>;

const metadata = {
  clockify_expenses_create: { "create-expense": "create" },
  clockify_expenses_update: { "update-expense": "update" },
  clockify_expenses_delete: { "delete-expense": "delete" },
  clockify_expenses_categories_create: { "create-expense-category": "create" },
  clockify_expenses_categories_update: {
    "rename-expense-category": "update",
    "set-expense-category-status": "state-command",
  },
  clockify_expenses_categories_delete: {
    "archive-expense-category": "state-command",
    "delete-expense-category": "delete",
  },
  clockify_custom_fields_create: { "create-custom-field": "create" },
  clockify_custom_fields_update: { "update-custom-field": "update" },
  clockify_custom_fields_delete: { "delete-custom-field": "delete" },
  clockify_time_off_policies_create: { "create-time-off-policy": "create" },
  clockify_time_off_policies_update: { "update-time-off-policy": "update" },
  clockify_time_off_policies_archive: { "archive-time-off-policy": "state-command" },
  clockify_time_off_requests_create: { "create-time-off-request": "create" },
  clockify_time_off_requests_delete: { "delete-time-off-request": "delete" },
  clockify_time_off_approve: { "approve-time-off-request": "state-command" },
  clockify_time_off_deny: { "deny-time-off-request": "state-command" },
  clockify_time_off_balance_update: { "update-time-off-balance": "state-command" },
  clockify_holidays_create: { "create-holiday": "create" },
  clockify_holidays_update: { "update-holiday": "update" },
  clockify_holidays_delete: { "delete-holiday": "delete" },
  clockify_invoices_create: {
    "create-invoice": "create",
    "enrich-invoice": "update",
    "add-invoice-item-*": "update",
  },
  clockify_invoices_update: {
    "update-invoice-fields": "update",
    "update-invoice-status": "state-command",
  },
  clockify_invoices_delete: { "delete-invoice": "delete" },
  clockify_invoices_items_add: { "add-invoice-item": "update" },
  clockify_invoices_items_delete: { "delete-invoice-item": "delete" },
  clockify_invoices_payments_create: { "record-payment": "create" },
  clockify_invoices_payments_delete: { "delete-invoice-payment": "delete" },
  clockify_delete_entity: {
    "archive-project": "state-command",
    "archive-client": "state-command",
    "delete-project": "delete",
    "delete-client": "delete",
    "delete-tag": "delete",
    "delete-time_entry": "delete",
    "delete-invoice": "delete",
    "delete-expense": "delete",
    "delete-webhook": "delete",
    "delete-group": "delete",
    "restore-project": "update",
    "restore-client": "update",
  },
  clockify_update_entity: {
    "update-project": "update",
    "update-client": "update",
    "update-tag": "update",
  },
} as const;

for (const steps of Object.values(metadata)) Object.freeze(steps);
export const LEAVE_BILLING_STARTUP_RECONCILIATION = Object.freeze(metadata);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function payloadOf(candidate: StartupReconciliationCandidate): Record<string, unknown> | undefined {
  const operation = record(candidate.operation);
  return record(operation?.payload) ?? operation;
}

function evidenceOf(step: StartupStep): Record<string, unknown> | undefined {
  return record(step.evidence);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function invalidInput(input: HandlerInput): ReconciliationResult {
  return { authoritative: false, reason: "invalid_evidence", binding: input.binding, evidence: { complete: false } };
}

function candidate(type: string, id: string, projection: unknown): ReconciliationCandidate {
  return { ref: { type, id }, projection };
}

function reconcile(input: HandlerInput, options: {
  strategy: ReconciliationStrategy;
  readEvidence(): Promise<ListResult<ReconciliationCandidate>>;
  matches(item: ReconciliationCandidate): boolean;
}): Promise<ReconciliationResult> {
  return reconcileExternalMutation({
    strategy: options.strategy,
    binding: input.binding,
    expected: { actionFingerprint: input.candidate.actionFingerprint, catalogHash: input.candidate.catalogHash },
    readEvidence: () => options.readEvidence(),
    matches: (item) => options.matches(item),
  });
}

function preDispatchIds(input: HandlerInput): string[] | undefined {
  const preDispatch = record(evidenceOf(input.step)?.preDispatch);
  return preDispatch?.truncated === false ? stringArray(preDispatch.ids) : undefined;
}

function singleRead(input: HandlerInput, options: {
  strategy: "update" | "delete" | "state-command";
  type: string;
  id: string;
  read(): Promise<unknown>;
  matches(projection: unknown): boolean;
}): Promise<ReconciliationResult> {
  return reconcile(input, {
    strategy: options.strategy,
    async readEvidence() {
      const row = await options.read();
      return { rows: row == null ? [] : [candidate(options.type, options.id, row)], truncated: false };
    },
    matches: (item) => item.ref.id === options.id && options.matches(item.projection),
  });
}

function exact(value: unknown, expected: unknown): boolean {
  return sanitizedFingerprint(value) === sanitizedFingerprint(expected);
}

function containsExpected(value: unknown, expected: Record<string, unknown>): boolean {
  const actual = record(value);
  return !!actual && Object.entries(expected).every(([key, expectedValue]) => exact(actual[key], expectedValue));
}

function createFromList<T extends { id: string }>(input: HandlerInput, options: {
  type: string;
  list(): Promise<ListResult<T>>;
  matches(row: T): boolean;
  project?(row: T): unknown;
  baselineIds?: string[];
}): Promise<ReconciliationResult> | ReconciliationResult {
  const ids = options.baselineIds ?? preDispatchIds(input);
  if (!ids) return invalidInput(input);
  const baseline = new Set(ids);
  return reconcile(input, {
    strategy: "create",
    async readEvidence() {
      const listed = await options.list();
      return {
        truncated: listed.truncated,
        rows: listed.rows.filter((row) => !baseline.has(row.id))
          .map((row) => candidate(options.type, row.id, options.project?.(row) ?? row)),
      };
    },
    matches: (item) => options.matches(item.projection as T),
  });
}

async function allExpenseCategories(clockify: LeaveBillingStartupReconciliationReadClient) {
  const [active, archived] = await Promise.all([
    clockify.listExpenseCategories({ archived: false }),
    clockify.listExpenseCategories({ archived: true }),
  ]);
  return {
    truncated: active.truncated || archived.truncated,
    rows: [...new Map([...active.rows, ...archived.rows].map((row) => [row.id, row])).values()],
  };
}

function sameExpense(row: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  const expectedTotal = expected.amount !== undefined
    ? Number(expected.amount) * 100 * (typeof expected.quantity === "number" ? expected.quantity : 1)
    : expected.amountMinor;
  if (expectedTotal !== undefined && row.total !== expectedTotal) return false;
  if (typeof expected.date === "string" && String(row.date).slice(0, 10) !== expected.date.slice(0, 10)) return false;
  for (const key of ["categoryId", "userId", "notes", "billable", "projectId", "taskId"] as const) {
    if (Object.hasOwn(expected, key) && row[key] !== expected[key]) return false;
  }
  return true;
}

const createExpense: Handler = async (input) => {
  const expected = record(payloadOf(input.candidate)?.input);
  if (!expected) return invalidInput(input);
  return await createFromList(input, {
    type: "expense", list: () => input.clockify.listExpenses(),
    matches: (row) => sameExpense(row as unknown as Record<string, unknown>, expected),
  });
};

const updateExpense: Handler = async (input) => {
  const payload = payloadOf(input.candidate);
  const id = stringValue(payload?.id);
  const expected = record(payload?.updateBody);
  return id && expected ? singleRead(input, {
    strategy: "update", type: "expense", id, read: () => input.clockify.getExpense(id),
    matches: (row) => sameExpense(record(row) ?? {}, expected),
  }) : invalidInput(input);
};

const deleteExpense: Handler = async (input) => {
  const id = stringValue(payloadOf(input.candidate)?.id);
  return id ? singleRead(input, { strategy: "delete", type: "expense", id, read: () => input.clockify.getExpense(id), matches: () => true }) : invalidInput(input);
};

const createExpenseCategory: Handler = async (input) => {
  const name = stringValue(payloadOf(input.candidate)?.name);
  if (!name) return invalidInput(input);
  return await createFromList(input, { type: "expense_category", list: () => allExpenseCategories(input.clockify), matches: (row) => row.name === name });
};

function categoryRead(input: HandlerInput, strategy: "update" | "delete" | "state-command", matches: (row: Record<string, unknown>) => boolean) {
  const payload = payloadOf(input.candidate);
  const id = stringValue(payload?.id);
  if (!id) return Promise.resolve(invalidInput(input));
  return reconcile(input, {
    strategy,
    async readEvidence() {
      const listed = await allExpenseCategories(input.clockify);
      return { truncated: listed.truncated, rows: listed.rows.map((row) => candidate("expense_category", row.id, row)) };
    },
    matches: (item) => item.ref.id === id && matches(record(item.projection) ?? {}),
  });
}

const renameExpenseCategory: Handler = (input) => {
  const name = stringValue(payloadOf(input.candidate)?.name);
  return name ? categoryRead(input, "update", (row) => row.name === name) : Promise.resolve(invalidInput(input));
};
const setExpenseCategoryStatus: Handler = (input) => {
  const archived = payloadOf(input.candidate)?.archived;
  return typeof archived === "boolean" ? categoryRead(input, "state-command", (row) => row.archived === archived) : Promise.resolve(invalidInput(input));
};
const archiveExpenseCategory: Handler = (input) => categoryRead(input, "state-command", (row) => row.archived === true);
const deleteExpenseCategory: Handler = (input) => categoryRead(input, "delete", () => true);

function sameCustomField(row: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return row.name === expected.name && row.type === expected.type &&
    (row.status ?? "VISIBLE") === (expected.status ?? "VISIBLE") &&
    (row.required ?? false) === (expected.required ?? false) &&
    exact(row.allowedValues ?? [], expected.allowedValues ?? []);
}

const createCustomField: Handler = async (input) => {
  const expected = record(payloadOf(input.candidate)?.input);
  if (!expected) return invalidInput(input);
  return await createFromList(input, { type: "custom_field", list: () => input.clockify.listCustomFields(), matches: (row) => sameCustomField(row as unknown as Record<string, unknown>, expected) });
};
const updateCustomField: Handler = async (input) => {
  const payload = payloadOf(input.candidate); const id = stringValue(payload?.id); const expected = record(payload?.updateBody);
  return id && expected ? singleRead(input, { strategy: "update", type: "custom_field", id, read: () => input.clockify.getCustomField(id), matches: (row) => sameCustomField(record(row) ?? {}, expected) }) : invalidInput(input);
};
const deleteCustomField: Handler = async (input) => {
  const id = stringValue(payloadOf(input.candidate)?.id);
  return id ? singleRead(input, { strategy: "delete", type: "custom_field", id, read: () => input.clockify.getCustomField(id), matches: () => true }) : invalidInput(input);
};

function samePolicy(row: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  if (typeof expected.name === "string" && row.name !== expected.name) return false;
  if ((row.status ?? "ACTIVE") !== (expected.status ?? "ACTIVE")) return false;
  if ((row.timeUnit ?? "DAYS") !== (expected.timeUnit ?? "DAYS")) return false;
  if ((row.requiresApproval ?? false) !== (expected.requiresApproval ?? false)) return false;
  if ((row.negativeBalance ?? false) !== (expected.negativeBalance ?? false)) return false;
  if (Object.hasOwn(expected, "daysPerYear") && row.daysPerYear !== expected.daysPerYear) return false;
  const users = Array.isArray(expected.userIds) && expected.userIds.length ? expected.userIds : typeof expected.userId === "string" ? [expected.userId] : [];
  return exact([...(Array.isArray(row.userIds) ? row.userIds : [])].sort(), [...users].sort()) &&
    exact([...(Array.isArray(row.userGroupIds) ? row.userGroupIds : [])].sort(), [...(Array.isArray(expected.userGroupIds) ? expected.userGroupIds : [])].sort());
}

const createTimeOffPolicy: Handler = async (input) => {
  const expected = record(payloadOf(input.candidate)?.input);
  if (!expected) return invalidInput(input);
  return await createFromList(input, { type: "time_off_policy", list: () => input.clockify.listTimeOffPolicies(), matches: (row) => samePolicy(row as unknown as Record<string, unknown>, expected) });
};
const updateTimeOffPolicy: Handler = async (input) => {
  const payload = payloadOf(input.candidate); const id = stringValue(payload?.id); const expected = record(payload?.updateBody)?.body;
  return id && record(expected) ? singleRead(input, { strategy: "update", type: "time_off_policy", id, read: () => input.clockify.getTimeOffPolicyMutationState(id), matches: (row) => exact(row, expected) }) : invalidInput(input);
};
const archiveTimeOffPolicy: Handler = async (input) => {
  const payload = payloadOf(input.candidate); const id = stringValue(payload?.id); const archived = payload?.archived;
  return id && typeof archived === "boolean" ? singleRead(input, { strategy: "state-command", type: "time_off_policy", id, read: () => input.clockify.getTimeOffPolicy(id), matches: (row) => record(row)?.status === (archived ? "ARCHIVED" : "ACTIVE") }) : invalidInput(input);
};

function sameRequest(row: Record<string, unknown>, policyId: string, expected: Record<string, unknown>, adminUserId: string): boolean {
  const hours = expected.timeUnit === "HOURS";
  const days = hours ? undefined : expected.days ?? Math.round((Date.parse(`${String(expected.end).slice(0, 10)}T00:00:00Z`) - Date.parse(`${String(expected.start).slice(0, 10)}T00:00:00Z`)) / 86_400_000) + 1;
  return row.policyId === policyId && row.userId === adminUserId && row.status === "PENDING" &&
    row.start === expected.start && row.end === expected.end && (row.timeUnit ?? (hours ? "HOURS" : "DAYS")) === (hours ? "HOURS" : "DAYS") &&
    row.days === days && (row.halfDay ?? false) === (expected.halfDay ?? false) &&
    (Object.hasOwn(expected, "note") ? row.note === expected.note : row.note === undefined);
}

const createTimeOffRequest: Handler = async (input) => {
  const payload = payloadOf(input.candidate); const policyId = stringValue(payload?.policyId); const expected = record(payload?.input); const admin = stringValue(input.candidate.adminUserId);
  if (!policyId || !expected || !admin) return invalidInput(input);
  return await createFromList(input, { type: "time_off_request", list: () => input.clockify.listTimeOffRequests(), matches: (row) => sameRequest(row as unknown as Record<string, unknown>, policyId, expected, admin) });
};
const deleteTimeOffRequest: Handler = async (input) => {
  const id = stringValue(payloadOf(input.candidate)?.requestId);
  return id ? singleRead(input, { strategy: "delete", type: "time_off_request", id, read: () => input.clockify.getTimeOffRequest(id), matches: () => true }) : invalidInput(input);
};
function timeOffDecision(status: "APPROVED" | "REJECTED"): Handler {
  return async (input) => {
    const payload = payloadOf(input.candidate); const id = stringValue(payload?.requestId);
    return id ? singleRead(input, { strategy: "state-command", type: "time_off_request", id, read: () => input.clockify.getTimeOffRequest(id), matches: (row) => record(row)?.status === status && (!Object.hasOwn(payload ?? {}, "note") || record(row)?.note === payload?.note) }) : invalidInput(input);
  };
}
const updateTimeOffBalance: Handler = async (input) => {
  const payload = payloadOf(input.candidate); const policyId = stringValue(payload?.policyId); const userIds = stringArray(payload?.userIds); const expected = Array.isArray(payload?.expectedBalances) ? payload.expectedBalances : undefined;
  if (!policyId || !userIds || !expected) return invalidInput(input);
  return reconcile(input, {
    strategy: "state-command",
    async readEvidence() {
      const reads = await Promise.all(userIds.map((id) => input.clockify.getTimeOffBalance(id)));
      const rows = reads.flatMap((read) => read.rows).filter((row) => row.policyId === policyId);
      return { rows: [candidate("time_off_balance", `${policyId}:${[...userIds].sort().join(",")}`, rows)], truncated: reads.some((read) => read.truncated) };
    },
    matches: (item) => expected.every((raw) => { const wanted = record(raw); return wanted && Array.isArray(item.projection) && item.projection.some((row) => row.userId === wanted.userId && row.balance === wanted.balance); }),
  });
};

function sameHoliday(row: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return row.name === expected.name && row.startDate === expected.startDate && row.endDate === (expected.endDate ?? expected.startDate) &&
    (row.occursAnnually ?? false) === (expected.occursAnnually ?? false) &&
    exact([...(Array.isArray(row.userIds) ? row.userIds : [])].sort(), [...(Array.isArray(expected.userIds) ? expected.userIds : [])].sort()) &&
    exact([...(Array.isArray(row.userGroupIds) ? row.userGroupIds : [])].sort(), [...(Array.isArray(expected.userGroupIds) ? expected.userGroupIds : [])].sort()) &&
    (row.everyoneIncludingNew ?? false) === (expected.everyoneIncludingNew ?? false);
}
const createHoliday: Handler = async (input) => {
  const payload = payloadOf(input.candidate); const body = record(payload?.body); const ids = stringArray(payload?.baselineIds);
  if (!body || !ids) return invalidInput(input);
  return await createFromList(input, { type: "holiday", baselineIds: ids, list: () => input.clockify.listHolidays(), matches: (row) => sameHoliday(row as unknown as Record<string, unknown>, body) });
};
const updateHoliday: Handler = async (input) => {
  const payload = payloadOf(input.candidate); const id = stringValue(payload?.id); const expected = record(payload?.updateBody);
  return id && expected ? singleRead(input, { strategy: "update", type: "holiday", id, read: () => input.clockify.getHolidayMutationState(id), matches: (row) => sameHoliday(record(row) ?? {}, expected) }) : invalidInput(input);
};
const deleteHoliday: Handler = async (input) => {
  const id = stringValue(payloadOf(input.candidate)?.id);
  return id ? singleRead(input, { strategy: "delete", type: "holiday", id, read: () => input.clockify.getHolidayMutationState(id), matches: () => true }) : invalidInput(input);
};

function evidenceString(input: HandlerInput, key: string): string | undefined {
  const evidence = evidenceOf(input.step); return stringValue(evidence?.[key]) ?? stringValue(record(evidence?.preDispatch)?.[key]);
}

const createInvoice: Handler = async (input) => {
  const payload = payloadOf(input.candidate);
  const base = record(payload?.base); const enrichment = record(payload?.enrichment); const items = payload?.items;
  const ids = preDispatchIds(input);
  if (!base || !enrichment || !Array.isArray(items) || items.length > 0 || Object.keys(enrichment).length > 0 || !ids) return invalidInput(input);
  const baseline = new Set(ids);
  return reconcile(input, {
    strategy: "create",
    async readEvidence() {
      const listed = await input.clockify.listInvoices(); const rows: ReconciliationCandidate[] = [];
      for (const invoice of listed.rows) {
        if (baseline.has(invoice.id)) continue;
        const detail = await input.clockify.getInvoice(invoice.id);
        if (detail) rows.push(candidate("invoice", detail.id, detail));
      }
      return { rows, truncated: listed.truncated };
    },
    matches: (item) => invoiceDetailFingerprint(item.projection as never, { base, enrichment, items } as unknown as InvoiceCreateIntent) === payload?.finalFingerprint,
  });
};

const enrichInvoice: Handler = async (input) => {
  const payload = payloadOf(input.candidate); const id = evidenceString(input, "invoiceId"); const enrichment = record(payload?.enrichment);
  return id && enrichment ? singleRead(input, { strategy: "update", type: "invoice", id, read: () => input.clockify.getInvoice(id), matches: (row) => containsExpected(row, enrichment) }) : invalidInput(input);
};
const addCreateInvoiceItem: Handler = async (input) => {
  const match = /^add-invoice-item-(\d+)$/.exec(input.step.planStepId); const payload = payloadOf(input.candidate); const id = evidenceString(input, "invoiceId"); const items = payload?.items;
  const index = match ? Number(match[1]) : -1; const expected = Array.isArray(items) ? record(items[index]) : undefined; const before = record(evidenceOf(input.step)?.preDispatch)?.rows;
  if (!id || !expected || !Array.isArray(before)) return invalidInput(input);
  return reconcile(input, { strategy: "update", async readEvidence() { const listed = await input.clockify.listRawInvoiceItems(id); return { rows: [candidate("invoice_items", id, listed.rows)], truncated: listed.truncated }; }, matches: (item) => Array.isArray(item.projection) && item.projection.length === before.length + 1 && exact(item.projection.slice(0, before.length), before) && containsExpected(item.projection.at(-1), expected) });
};
const updateInvoiceFields: Handler = async (input) => {
  const payload = payloadOf(input.candidate); const id = stringValue(payload?.id); const expected = record(payload?.expectedAfterFields);
  return id && expected ? singleRead(input, { strategy: "update", type: "invoice", id, read: () => input.clockify.getInvoice(id), matches: (row) => exact(row, expected) }) : invalidInput(input);
};
const updateInvoiceStatus: Handler = async (input) => {
  const payload = payloadOf(input.candidate); const id = stringValue(payload?.id); const status = stringValue(payload?.status);
  return id && status ? singleRead(input, { strategy: "state-command", type: "invoice", id, read: () => input.clockify.getInvoice(id), matches: (row) => record(row)?.status === status }) : invalidInput(input);
};
const deleteInvoice: Handler = async (input) => { const id = stringValue(payloadOf(input.candidate)?.id); return id ? singleRead(input, { strategy: "delete", type: "invoice", id, read: () => input.clockify.getInvoice(id), matches: () => true }) : invalidInput(input); };
const addInvoiceItem: Handler = async (input) => {
  const payload = payloadOf(input.candidate); const id = stringValue(payload?.invoiceId); const expected = record(payload?.item); const pre = record(evidenceOf(input.step)?.preDispatch); const before = pre?.rows;
  if (!id || !expected || pre?.truncated !== false || !Array.isArray(before)) return invalidInput(input);
  return reconcile(input, { strategy: "update", async readEvidence() { const listed = await input.clockify.listRawInvoiceItems(id); return { rows: [candidate("invoice_items", id, listed.rows)], truncated: listed.truncated }; }, matches: (item) => Array.isArray(item.projection) && item.projection.length === before.length + 1 && exact(item.projection.slice(0, before.length), before) && containsExpected(item.projection.at(-1), expected) });
};
const deleteInvoiceItem: Handler = async (input) => {
  const payload = payloadOf(input.candidate); const id = stringValue(payload?.invoiceId); const expected = evidenceOf(input.step)?.expectedRemaining;
  if (!id || !Array.isArray(expected)) return invalidInput(input);
  return reconcile(input, { strategy: "delete", async readEvidence() { const listed = await input.clockify.listRawInvoiceItems(id); return { rows: exact(listed.rows, expected) ? [] : [candidate("invoice_items", id, listed.rows)], truncated: listed.truncated }; }, matches: () => true });
};
const recordPayment: Handler = async (input) => {
  const payload = payloadOf(input.candidate); const id = stringValue(payload?.invoiceId); const payment = record(payload?.payment); const ids = preDispatchIds(input);
  if (!id || !payment || !ids || typeof payment.amountMinor !== "number" || typeof payment.paymentDate !== "string") return invalidInput(input);
  return reconcile(input, { strategy: "create", async readEvidence() { const listed = await input.clockify.listInvoicePayments(id); return { rows: listed.rows.map((row) => candidate("invoice_payment", row.id ?? "missing-id", row)), truncated: listed.truncated }; }, matches: (item) => matchNewPayment({ baseline: { ids, truncated: false }, after: { rows: [item.projection as never], truncated: false }, amountMinor: payment.amountMinor as number, paymentDate: payment.paymentDate as string, ...(typeof payment.note === "string" ? { note: payment.note } : {}) }).authoritative });
};
const deleteInvoicePayment: Handler = async (input) => {
  const payload = payloadOf(input.candidate); const invoiceId = stringValue(payload?.invoiceId); const paymentId = stringValue(payload?.paymentId);
  if (!invoiceId || !paymentId) return invalidInput(input);
  return reconcile(input, { strategy: "delete", async readEvidence() { const listed = await input.clockify.listInvoicePayments(invoiceId); return { rows: listed.rows.filter((row) => typeof row.id === "string").map((row) => candidate("invoice_payment", row.id!, row)), truncated: listed.truncated }; }, matches: (item) => item.ref.id === paymentId });
};

async function adminRead(input: HandlerInput, type: string, id: string): Promise<unknown> {
  if (type === "project") return input.clockify.getProjectMutationState(id);
  if (type === "client") return input.clockify.getClientMutationState(id);
  if (type === "tag") { try { return await input.clockify.prepareTagUpdate(id, {}); } catch { return null; } }
  if (type === "time_entry") return input.clockify.getEntry(id);
  if (type === "invoice") return input.clockify.getInvoice(id);
  if (type === "expense") return input.clockify.getExpense(id);
  if (type === "webhook") return input.clockify.getWebhook(id);
  return input.clockify.getGroup(id).then((group) => group ? { id: group.id, name: group.name, userIds: [...(group.userIds ?? [])].sort() } : group);
}

function adminState(type: "project" | "client", expectedArchived: boolean): Handler {
  return async (input) => {
    const payload = payloadOf(input.candidate); const id = stringValue(payload?.id);
    return id && payload?.entityType === type ? singleRead(input, { strategy: "state-command", type, id, read: () => adminRead(input, type, id), matches: (row) => record(row)?.archived === expectedArchived }) : invalidInput(input);
  };
}
function adminDelete(type: string): Handler {
  return async (input) => { const payload = payloadOf(input.candidate); const id = stringValue(payload?.id); return id && payload?.entityType === type ? singleRead(input, { strategy: "delete", type, id, read: () => adminRead(input, type, id), matches: () => true }) : invalidInput(input); };
}
function adminRestore(type: "project" | "client"): Handler {
  return async (input) => { const payload = payloadOf(input.candidate); const id = stringValue(payload?.id); const body = record(payload?.restoreBody); return id && body && payload?.entityType === type ? singleRead(input, { strategy: "update", type, id, read: () => adminRead(input, type, id), matches: (row) => exact(row, body) }) : invalidInput(input); };
}
function adminUpdate(type: "project" | "client" | "tag"): Handler {
  return async (input) => { const payload = payloadOf(input.candidate); const id = stringValue(payload?.id); const body = record(payload?.body); return id && body && payload?.entityType === type ? singleRead(input, { strategy: "update", type, id, read: () => adminRead(input, type, id), matches: (row) => exact(row, body) }) : invalidInput(input); };
}

const handlers = new Map<string, Handler>([
  ["clockify_expenses_create\0create-expense", createExpense], ["clockify_expenses_update\0update-expense", updateExpense], ["clockify_expenses_delete\0delete-expense", deleteExpense],
  ["clockify_expenses_categories_create\0create-expense-category", createExpenseCategory], ["clockify_expenses_categories_update\0rename-expense-category", renameExpenseCategory], ["clockify_expenses_categories_update\0set-expense-category-status", setExpenseCategoryStatus], ["clockify_expenses_categories_delete\0archive-expense-category", archiveExpenseCategory], ["clockify_expenses_categories_delete\0delete-expense-category", deleteExpenseCategory],
  ["clockify_custom_fields_create\0create-custom-field", createCustomField], ["clockify_custom_fields_update\0update-custom-field", updateCustomField], ["clockify_custom_fields_delete\0delete-custom-field", deleteCustomField],
  ["clockify_time_off_policies_create\0create-time-off-policy", createTimeOffPolicy], ["clockify_time_off_policies_update\0update-time-off-policy", updateTimeOffPolicy], ["clockify_time_off_policies_archive\0archive-time-off-policy", archiveTimeOffPolicy], ["clockify_time_off_requests_create\0create-time-off-request", createTimeOffRequest], ["clockify_time_off_requests_delete\0delete-time-off-request", deleteTimeOffRequest], ["clockify_time_off_approve\0approve-time-off-request", timeOffDecision("APPROVED")], ["clockify_time_off_deny\0deny-time-off-request", timeOffDecision("REJECTED")], ["clockify_time_off_balance_update\0update-time-off-balance", updateTimeOffBalance],
  ["clockify_holidays_create\0create-holiday", createHoliday], ["clockify_holidays_update\0update-holiday", updateHoliday], ["clockify_holidays_delete\0delete-holiday", deleteHoliday],
  ["clockify_invoices_create\0create-invoice", createInvoice], ["clockify_invoices_create\0enrich-invoice", enrichInvoice], ["clockify_invoices_create\0add-invoice-item-*", addCreateInvoiceItem], ["clockify_invoices_update\0update-invoice-fields", updateInvoiceFields], ["clockify_invoices_update\0update-invoice-status", updateInvoiceStatus], ["clockify_invoices_delete\0delete-invoice", deleteInvoice], ["clockify_invoices_items_add\0add-invoice-item", addInvoiceItem], ["clockify_invoices_items_delete\0delete-invoice-item", deleteInvoiceItem], ["clockify_invoices_payments_create\0record-payment", recordPayment], ["clockify_invoices_payments_delete\0delete-invoice-payment", deleteInvoicePayment],
  ["clockify_delete_entity\0archive-project", adminState("project", true)], ["clockify_delete_entity\0archive-client", adminState("client", true)],
  ...["project", "client", "tag", "time_entry", "invoice", "expense", "webhook", "group"].map((type) => [`clockify_delete_entity\0delete-${type}`, adminDelete(type)] as [string, Handler]),
  ["clockify_delete_entity\0restore-project", adminRestore("project")], ["clockify_delete_entity\0restore-client", adminRestore("client")],
  ["clockify_update_entity\0update-project", adminUpdate("project")], ["clockify_update_entity\0update-client", adminUpdate("client")], ["clockify_update_entity\0update-tag", adminUpdate("tag")],
]);

const declaredKeys = Object.entries(LEAVE_BILLING_STARTUP_RECONCILIATION).flatMap(([actionName, steps]) => Object.keys(steps).map((planStepId) => `${actionName}\0${planStepId}`));
if (declaredKeys.length !== handlers.size || declaredKeys.some((key) => !handlers.has(key))) throw new Error("leave_billing_startup_reconciliation_registry_incomplete");

export const LEAVE_BILLING_STARTUP_RECONCILIATION_HANDLER_COUNT = handlers.size;

function handlerFor(actionName: string, planStepId: string): Handler | undefined {
  const exactHandler = handlers.get(`${actionName}\0${planStepId}`);
  if (exactHandler) return exactHandler;
  return actionName === "clockify_invoices_create" && /^add-invoice-item-\d+$/.test(planStepId)
    ? handlers.get(`${actionName}\0add-invoice-item-*`)
    : undefined;
}

export function hasLeaveBillingStartupReconciliationHandler(actionName: string, planStepId: string): boolean {
  return handlerFor(actionName, planStepId) !== undefined;
}

export async function reconcileWithLeaveBillingStartupRegistry(input: HandlerInput): Promise<ReconciliationResult> {
  const handler = handlerFor(input.candidate.actionName, input.step.planStepId);
  return handler ? handler(input) : { authoritative: false, reason: "handler_missing", binding: input.binding, evidence: { complete: false } };
}
