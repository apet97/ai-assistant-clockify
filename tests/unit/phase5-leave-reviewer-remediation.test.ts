import { describe, expect, it } from "vitest";
import { createStore } from "../../src/db/store.js";
import { actionFingerprint, catalogHash } from "../../src/harness/catalog.js";
import { commitConfirmedOperation, executeAction } from "../../src/harness/actions.js";
import { hashOperation } from "../../src/harness/confirmations.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import type { ActionContext } from "../../src/harness/action.js";
import { AmbiguousWriteOutcome } from "../../src/clockify/write-outcome.js";
import { createFakeWorkspace, type FakeWorkspace, type FakeWorkspaceSeed } from "../helpers/fake-clockify.js";

function context(fake: FakeWorkspace): ActionContext {
  return {
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    policy: defaultAdminPolicy(),
    clockify: fake.client,
    now: () => new Date("2026-07-14T09:00:00Z"),
    timeZone: "UTC",
    weekStartsOn: 1,
  };
}

async function prepare(fake: FakeWorkspace, actionName: string, args: unknown) {
  const preview = await executeAction({ actionName, args, context: context(fake) });
  if (preview.kind !== "preview") throw new Error(`expected ${actionName} preview, got ${preview.kind}`);
  const store = createStore(":memory:");
  store.prepareOperationRun({
    id: preview.operation.operationId,
    confirmationId: `confirmation-${preview.operation.operationId}`,
    sessionId: "session-1",
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    actionName,
    actionFingerprint: actionFingerprint(actionName)!,
    catalogHash: catalogHash(),
    operationHash: hashOperation(preview.operation),
    operation: preview.operation,
    mutationPlan: preview.operation.mutationPlan,
  });
  store.markOperationExecuting(preview.operation.operationId);
  return {
    operation: preview.operation,
    store,
    commitContext: { ...context(fake), mutationJournal: store.mutationStepJournal(preview.operation.operationId) },
  };
}

type CreateCase = {
  action: string;
  args: unknown;
  seed: FakeWorkspaceSeed;
  interloperId: string;
  interleave(fake: FakeWorkspace): void;
  failAfterApply(fake: FakeWorkspace): void;
};

const createCases: CreateCase[] = [
  {
    action: "clockify_expenses_create",
    args: { amount: 12, categoryId: "cat-1", notes: "Taxi" },
    seed: { expenseCategories: [{ id: "cat-1", name: "Travel", archived: false }] },
    interloperId: "interloper-expense",
    interleave: (fake) => fake.state.expenses.push({ id: "interloper-expense", name: "Taxi", notes: "Taxi", date: "2026-07-14", categoryId: "cat-1", userId: "admin-1", total: 1_200, quantity: 1 }),
    failAfterApply(fake) {
      const apply = fake.client.createExpenseAtomic.bind(fake.client);
      fake.client.createExpenseAtomic = async (input) => { await apply(input); throw new AmbiguousWriteOutcome("POST", "/expenses", "socket closed"); };
    },
  },
  {
    action: "clockify_expenses_categories_create",
    args: { name: "Travel" },
    seed: {},
    interloperId: "interloper-category",
    interleave: (fake) => fake.state.expenseCategories.push({ id: "interloper-category", name: "Travel", archived: false }),
    failAfterApply(fake) {
      const apply = fake.client.createExpenseCategoryAtomic.bind(fake.client);
      fake.client.createExpenseCategoryAtomic = async (input) => { await apply(input); throw new AmbiguousWriteOutcome("POST", "/expense-categories", "socket closed"); };
    },
  },
  {
    action: "clockify_custom_fields_create",
    args: { name: "Priority", fieldType: "TXT" },
    seed: {},
    interloperId: "interloper-field",
    interleave: (fake) => fake.state.customFields.push({ id: "interloper-field", name: "Priority", type: "TXT", status: "VISIBLE", required: false }),
    failAfterApply(fake) {
      const apply = fake.client.createCustomFieldAtomic.bind(fake.client);
      fake.client.createCustomFieldAtomic = async (input) => { await apply(input); throw new AmbiguousWriteOutcome("POST", "/custom-fields", "socket closed"); };
    },
  },
  {
    action: "clockify_time_off_policies_create",
    args: { name: "Vacation" },
    seed: {},
    interloperId: "interloper-policy",
    interleave: (fake) => fake.state.timeOffPolicies.push({ id: "interloper-policy", name: "Vacation", status: "ACTIVE", timeUnit: "DAYS", requiresApproval: false, userIds: ["admin-1"] }),
    failAfterApply(fake) {
      const apply = fake.client.createTimeOffPolicyAtomic.bind(fake.client);
      fake.client.createTimeOffPolicyAtomic = async (input) => { await apply(input); throw new AmbiguousWriteOutcome("POST", "/time-off/policies", "socket closed"); };
    },
  },
  {
    action: "clockify_time_off_requests_create",
    args: { policyId: "pol-1", start: "tomorrow", end: "tomorrow" },
    seed: { timeOffPolicies: [{ id: "pol-1", name: "Vacation", status: "ACTIVE", timeUnit: "DAYS" }] },
    interloperId: "interloper-request",
    interleave: (fake) => fake.state.timeOffRequests.push({ id: "interloper-request", policyId: "pol-1", userId: "admin-1", status: "PENDING", start: "2026-07-15", end: "2026-07-15", days: 1, halfDay: false } as never),
    failAfterApply(fake) {
      const apply = fake.client.createTimeOffRequestAtomic.bind(fake.client);
      fake.client.createTimeOffRequestAtomic = async (policyId, input) => { await apply(policyId, input); throw new AmbiguousWriteOutcome("POST", "/time-off/requests", "socket closed"); };
    },
  },
];

function createdId(result: Awaited<ReturnType<typeof commitConfirmedOperation>>): string | undefined {
  if (!("ok" in result) || !result.ok) return undefined;
  return result.changed?.created?.[0]?.id;
}

describe("Task 8 reviewer remediation", () => {
  it.each(createCases)("refreshes and persists the $action baseline immediately before dispatch", async (test) => {
    const fake = createFakeWorkspace(test.seed);
    const prepared = await prepare(fake, test.action, test.args);
    test.interleave(fake);
    test.failAfterApply(fake);

    const result = await commitConfirmedOperation(prepared.commitContext, prepared.operation);
    expect(result).toMatchObject({ ok: true });
    expect(createdId(result)).not.toBe(test.interloperId);
    expect(prepared.store.listOperationSteps(prepared.operation.operationId)).toMatchObject([{
      status: "succeeded",
      detail: { preDispatch: { ids: expect.arrayContaining([test.interloperId]), truncated: false } },
    }]);
    prepared.store.close();
  });

  it("uses custom-field defaults in ambiguous create matching", async () => {
    const fake = createFakeWorkspace();
    const prepared = await prepare(fake, "clockify_custom_fields_create", { name: "Priority", fieldType: "TXT" });
    const apply = fake.client.createCustomFieldAtomic.bind(fake.client);
    fake.client.createCustomFieldAtomic = async (input) => {
      await apply(input);
      fake.state.customFields.push({ id: "decoy-field", name: input.name, type: input.type, status: "HIDDEN", required: false });
      throw new AmbiguousWriteOutcome("POST", "/custom-fields", "socket closed");
    };
    const result = await commitConfirmedOperation(prepared.commitContext, prepared.operation);
    expect(result).toMatchObject({ ok: true });
    expect(createdId(result)).not.toBe("decoy-field");
    prepared.store.close();
  });

  it("uses policy unit/status/defaults in ambiguous create matching", async () => {
    const fake = createFakeWorkspace();
    const prepared = await prepare(fake, "clockify_time_off_policies_create", { name: "Vacation" });
    const apply = fake.client.createTimeOffPolicyAtomic.bind(fake.client);
    fake.client.createTimeOffPolicyAtomic = async (input) => {
      await apply(input);
      fake.state.timeOffPolicies.push({ id: "decoy-policy", name: input.name, status: "ARCHIVED", timeUnit: "HOURS", requiresApproval: false, userIds: ["admin-1"] });
      throw new AmbiguousWriteOutcome("POST", "/time-off/policies", "socket closed");
    };
    const result = await commitConfirmedOperation(prepared.commitContext, prepared.operation);
    expect(result).toMatchObject({ ok: true });
    expect(createdId(result)).not.toBe("decoy-policy");
    prepared.store.close();
  });

  it("uses requester and DAYS period defaults in ambiguous request matching", async () => {
    const fake = createFakeWorkspace({ timeOffPolicies: [{ id: "pol-1", name: "Vacation", status: "ACTIVE", timeUnit: "DAYS" }] });
    const prepared = await prepare(fake, "clockify_time_off_requests_create", { policyId: "pol-1", start: "tomorrow", end: "tomorrow" });
    const apply = fake.client.createTimeOffRequestAtomic.bind(fake.client);
    fake.client.createTimeOffRequestAtomic = async (policyId, input) => {
      await apply(policyId, input);
      fake.state.timeOffRequests.push({ id: "decoy-request", policyId, userId: "someone-else", status: "PENDING", start: input.start, end: input.end, days: 1, halfDay: false } as never);
      throw new AmbiguousWriteOutcome("POST", "/time-off/requests", "socket closed");
    };
    const result = await commitConfirmedOperation(prepared.commitContext, prepared.operation);
    expect(result).toMatchObject({ ok: true });
    expect(createdId(result)).not.toBe("decoy-request");
    prepared.store.close();
  });

  it("uses holiday defaults and everyoneIncludingNew in ambiguous create matching", async () => {
    const fake = createFakeWorkspace();
    const apply = fake.client.createHolidayAtomic.bind(fake.client);
    fake.client.createHolidayAtomic = async (input) => {
      await apply(input);
      fake.state.holidays.push({ id: "decoy-holiday", name: input.name, startDate: input.startDate, endDate: input.endDate ?? input.startDate, occursAnnually: true, userIds: input.userIds, everyoneIncludingNew: true });
      throw new AmbiguousWriteOutcome("POST", "/holidays", "socket closed");
    };
    const result = await executeAction({
      actionName: "clockify_holidays_create",
      args: { name: "Founders Day", startDate: "2026-07-20", userIds: ["me"] },
      context: context(fake),
    });
    expect(result).toMatchObject({ kind: "receipt", receipt: { ok: true } });
    if (result.kind !== "receipt" || !result.receipt.ok) throw new Error("expected successful create receipt");
    expect(result.receipt.changed?.created?.[0]?.id).not.toBe("decoy-holiday");
  });

  it("preserves quantity when computing the expected expense total", async () => {
    const fake = createFakeWorkspace({
      expenses: [{ id: "expense-1", name: "Hotel", notes: "Hotel", userId: "admin-1", categoryId: "cat-1", date: "2026-07-14", total: 2_000, quantity: 2 }],
      expenseCategories: [{ id: "cat-1", name: "Travel", archived: false }],
    });
    const prepared = await prepare(fake, "clockify_expenses_update", { id: "expense-1", amount: 15 });
    const result = await commitConfirmedOperation(prepared.commitContext, prepared.operation);
    expect(result).toMatchObject({ ok: true });
    expect(fake.state.expenses[0]?.total).toBe(3_000);
    prepared.store.close();
  });

  it("captures entry replacement source and body from the same authoritative read", async () => {
    const fake = createFakeWorkspace({
      entries: [{ id: "entry-1", start: "2026-07-14T08:00:00Z", customFieldValues: [{ customFieldId: "other", value: "before" }] } as never],
      customFields: [{ id: "field-1", name: "Priority", type: "TXT" }],
    });
    const prepareOriginal = fake.client.prepareEntryCustomFieldValue.bind(fake.client);
    fake.client.prepareEntryCustomFieldValue = async (...args) => {
      (fake.state.timeEntries[0] as unknown as { customFieldValues: unknown[] }).customFieldValues = [{ customFieldId: "other", value: "authoritative" }];
      return prepareOriginal(...args);
    };
    const preview = await executeAction({ actionName: "clockify_custom_fields_set_value_entry", args: { entryId: "entry-1", fieldId: "field-1", value: "high" }, context: context(fake) });
    if (preview.kind !== "preview") throw new Error("expected preview");
    const prepared = (preview.operation.payload as { prepared: { source: unknown } }).prepared;
    expect(preview.operation.targetSnapshots?.[0]?.projection).toEqual(prepared.source);
  });

  it("captures policy replacement source and body from the same authoritative read", async () => {
    const fake = createFakeWorkspace({ timeOffPolicies: [{ id: "policy-1", name: "Vacation", status: "ACTIVE", timeUnit: "DAYS" }] });
    const prepareOriginal = fake.client.prepareTimeOffPolicyUpdate.bind(fake.client);
    fake.client.prepareTimeOffPolicyUpdate = async (...args) => {
      (fake.state.timeOffPolicies[0] as unknown as Record<string, unknown>).unknownWireField = { keep: "exactly" };
      return prepareOriginal(...args);
    };
    const preview = await executeAction({ actionName: "clockify_time_off_policies_update", args: { id: "policy-1", name: "Vacation 2027" }, context: context(fake) });
    if (preview.kind !== "preview") throw new Error("expected preview");
    const prepared = (preview.operation.payload as { updateBody: { source: unknown } }).updateBody;
    expect(preview.operation.targetSnapshots?.[0]?.projection).toEqual(prepared.source);
  });

  it("captures holiday replacement source and body from the same authoritative read", async () => {
    const fake = createFakeWorkspace({ holidays: [{ id: "holiday-1", name: "Founders Day", startDate: "2026-07-20", userIds: ["admin-1"], everyoneIncludingNew: false }] });
    const prepareOriginal = fake.client.prepareHolidayUpdate.bind(fake.client);
    fake.client.prepareHolidayUpdate = async (...args) => {
      fake.state.holidays[0]!.everyoneIncludingNew = true;
      return prepareOriginal(...args);
    };
    const preview = await executeAction({ actionName: "clockify_holidays_update", args: { id: "holiday-1", name: "Founders Day 2027" }, context: context(fake) });
    if (preview.kind !== "preview") throw new Error("expected preview");
    const prepared = (preview.operation.payload as { updateBody: { source: unknown } }).updateBody;
    expect(preview.operation.targetSnapshots?.[0]?.projection).toEqual(prepared.source);
  });

  it("rejects a valid-looking but nonexistent expense category id", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_expenses_create",
      args: { amount: 10, categoryId: "aaaaaaaaaaaaaaaaaaaaaaaa" },
      context: context(fake),
    });
    expect(result.kind).toBe("clarify");
    expect(fake.counts.createExpenseAtomic ?? 0).toBe(0);
  });

  it("orders and execution-connects every expense create parent snapshot", async () => {
    const ids = { category: "aaaaaaaaaaaaaaaaaaaaaaaa", owner: "bbbbbbbbbbbbbbbbbbbbbbbb", project: "cccccccccccccccccccccccc", task: "dddddddddddddddddddddddd" };
    const fake = createFakeWorkspace({
      expenseCategories: [{ id: ids.category, name: "Travel", archived: false }],
      users: [{ id: ids.owner, name: "Owner" }],
      projects: [{ id: ids.project, name: "Roadshow" }],
      tasks: [{ id: ids.task, name: "Flights", projectId: ids.project }],
    });
    const preview = await executeAction({
      actionName: "clockify_expenses_create",
      args: { amount: 10, categoryId: ids.category, userId: ids.owner, projectId: ids.project, taskId: ids.task },
      context: context(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected preview");
    expect(preview.operation.targetSnapshots?.map((snapshot) => snapshot.ref.type)).toEqual(["expense_category", "user", "project", "task"]);
    fake.state.expenseCategories[0]!.name = "Changed after preview";
    const result = await commitConfirmedOperation(context(fake), preview.operation);
    expect(result).toMatchObject({ ok: false, code: "stale_parent" });
    expect(fake.counts.createExpenseAtomic ?? 0).toBe(0);
  });

  it("orders every expense update target and parent snapshot", async () => {
    const ids = { category: "aaaaaaaaaaaaaaaaaaaaaaaa", owner: "bbbbbbbbbbbbbbbbbbbbbbbb", project: "cccccccccccccccccccccccc", task: "dddddddddddddddddddddddd" };
    const fake = createFakeWorkspace({
      expenses: [{ id: "expense-1", name: "Taxi", notes: "Taxi", categoryId: ids.category, userId: ids.owner, projectId: ids.project, taskId: ids.task, date: "2026-07-14", total: 1000, quantity: 1 }],
      expenseCategories: [{ id: ids.category, name: "Travel", archived: false }],
      users: [{ id: ids.owner, name: "Owner" }],
      projects: [{ id: ids.project, name: "Roadshow" }],
      tasks: [{ id: ids.task, name: "Flights", projectId: ids.project }],
    });
    const preview = await executeAction({ actionName: "clockify_expenses_update", args: { id: "expense-1", notes: "Airport taxi" }, context: context(fake) });
    if (preview.kind !== "preview") throw new Error("expected preview");
    expect(preview.operation.targetSnapshots?.map((snapshot) => snapshot.ref.type)).toEqual(["expense", "expense_category", "user", "project", "task"]);
  });

  it("verifies the time-off request parent only after its durable step is executing", async () => {
    const fake = createFakeWorkspace({ timeOffPolicies: [{ id: "policy-1", name: "Vacation", status: "ACTIVE", timeUnit: "DAYS" }] });
    const prepared = await prepare(fake, "clockify_time_off_requests_create", { policyId: "policy-1", start: "tomorrow", end: "tomorrow" });
    const read = fake.client.getTimeOffPolicyMutationState.bind(fake.client);
    let statusAtVerification: string | undefined;
    fake.client.getTimeOffPolicyMutationState = async (id) => {
      statusAtVerification = prepared.store.listOperationSteps(prepared.operation.operationId)[0]?.status;
      return read(id);
    };
    const result = await commitConfirmedOperation(prepared.commitContext, prepared.operation);
    expect(result).toMatchObject({ ok: true });
    expect(statusAtVerification).toBe("executing");
    prepared.store.close();
  });

  it.each([
    { action: "clockify_expenses_categories_update", args: { id: "category-1", name: "Travel 2", archived: true }, step: "set-expense-category-status" },
    { action: "clockify_expenses_categories_delete", args: { id: "category-1" }, step: "delete-expense-category" },
  ])("execution-connects the derived category snapshot for $step", async ({ action, args, step }) => {
    const fake = createFakeWorkspace({ expenseCategories: [{ id: "category-1", name: "Travel", archived: false }] });
    const prepared = await prepare(fake, action, args);
    const list = fake.client.listExpenseCategories.bind(fake.client);
    let statusAtDerivedVerification: string | undefined;
    fake.client.listExpenseCategories = async (filter) => {
      const derived = prepared.store.listOperationSteps(prepared.operation.operationId).find((row) => row.planStepId === step);
      if (derived) statusAtDerivedVerification = derived.status;
      return list(filter);
    };
    const result = await commitConfirmedOperation(prepared.commitContext, prepared.operation);
    expect(result).toMatchObject({ ok: true });
    expect(statusAtDerivedVerification).toBe("executing");
    prepared.store.close();
  });

  it("rejects a valid-looking nonexistent replacement invoice client", async () => {
    const fake = createFakeWorkspace({ invoices: [{ id: "aaaaaaaaaaaaaaaaaaaaaaaa", number: "INV-1", clientId: "old-client", currency: "USD", issuedDate: "2026-07-01", dueDate: "2026-07-31", status: "UNSENT", items: [] }] });
    const result = await executeAction({
      actionName: "clockify_invoices_update",
      args: { id: "aaaaaaaaaaaaaaaaaaaaaaaa", clientId: "bbbbbbbbbbbbbbbbbbbbbbbb" },
      context: context(fake),
    });
    expect(result.kind).toBe("clarify");
  });

  it("verifies each invoice update step while executing and derives the post-field snapshot", async () => {
    const invoiceId = "aaaaaaaaaaaaaaaaaaaaaaaa";
    const fake = createFakeWorkspace({ invoices: [{ id: invoiceId, number: "INV-1", clientId: "client-1", currency: "USD", issuedDate: "2026-07-01", dueDate: "2026-07-31", status: "UNSENT", note: "before", items: [] }] });
    const prepared = await prepare(fake, "clockify_invoices_update", { id: invoiceId, note: "after", status: "SENT" });
    const get = fake.client.getInvoice.bind(fake.client);
    let statusAtSecondVerification: string | undefined;
    fake.client.getInvoice = async (id) => {
      const second = prepared.store.listOperationSteps(prepared.operation.operationId).find((row) => row.planStepId === "update-invoice-status");
      if (second) statusAtSecondVerification = second.status;
      return get(id);
    };
    const result = await commitConfirmedOperation(prepared.commitContext, prepared.operation);
    expect(result).toMatchObject({ ok: true });
    expect(statusAtSecondVerification).toBe("executing");
    expect(fake.state.invoices[0]).toMatchObject({ note: "after", status: "SENT" });
    prepared.store.close();
  });

  it.each(["updateInvoiceFields", "updateInvoiceStatus"] as const)("reconciles an ambiguous exact invoice %s", async (fault) => {
    const invoiceId = "aaaaaaaaaaaaaaaaaaaaaaaa";
    const fake = createFakeWorkspace({
      invoices: [{ id: invoiceId, number: "INV-1", clientId: "client-1", currency: "USD", issuedDate: "2026-07-01", dueDate: "2026-07-31", status: "UNSENT", note: "before", items: [] }],
      invoiceFaults: { [fault]: { outcome: "ambiguous", applyBeforeThrow: true } },
    });
    const args = fault === "updateInvoiceFields" ? { id: invoiceId, note: "after" } : { id: invoiceId, status: "SENT" };
    const prepared = await prepare(fake, "clockify_invoices_update", args);
    const result = await commitConfirmedOperation(prepared.commitContext, prepared.operation);
    expect(result).toMatchObject({ ok: true });
    prepared.store.close();
  });

  it("verifies the payment parent inside the same executing step as its fresh baseline", async () => {
    const invoiceId = "aaaaaaaaaaaaaaaaaaaaaaaa";
    const fake = createFakeWorkspace({ invoices: [{ id: invoiceId, number: "INV-1", clientId: "client-1", currency: "USD", issuedDate: "2026-07-01", dueDate: "2026-07-31", status: "SENT", items: [] }] });
    const prepared = await prepare(fake, "clockify_invoices_payments_create", { invoiceId, amount: 50, paymentDate: "today" });
    const get = fake.client.getInvoice.bind(fake.client);
    let statusAtVerification: string | undefined;
    fake.client.getInvoice = async (id) => {
      statusAtVerification = prepared.store.listOperationSteps(prepared.operation.operationId)[0]?.status;
      return get(id);
    };
    const result = await commitConfirmedOperation(prepared.commitContext, prepared.operation);
    expect(result).toMatchObject({ ok: true });
    expect(statusAtVerification).toBe("executing");
    expect(prepared.store.listOperationSteps(prepared.operation.operationId)[0]?.detail).toMatchObject({ preDispatch: { strategy: "invoice_payment_baseline", truncated: false } });
    prepared.store.close();
  });

  it("reconciles an ambiguous invoice-item add from a fresh raw ordered baseline", async () => {
    const invoiceId = "aaaaaaaaaaaaaaaaaaaaaaaa";
    const fake = createFakeWorkspace({
      invoices: [{ id: invoiceId, number: "INV-1", clientId: "client-1", currency: "USD", status: "UNSENT", items: [{ order: 0, description: "Old", quantity: 1, unitPrice: 100, itemType: "TIME" }] }],
      invoiceFaults: { addInvoiceItemAtomic: { outcome: "ambiguous", applyBeforeThrow: true } },
    });
    const prepared = await prepare(fake, "clockify_invoices_items_add", { invoiceId, itemType: "TIME", description: "New", quantity: 2, unitPrice: 5 });
    const result = await commitConfirmedOperation(prepared.commitContext, prepared.operation);
    expect(result).toMatchObject({ ok: true });
    expect(prepared.store.listOperationSteps(prepared.operation.operationId)[0]?.detail).toMatchObject({ preDispatch: { strategy: "invoice_item_add_raw_baseline", truncated: false } });
    prepared.store.close();
  });

  it.each([
    { action: "clockify_invoices_items_delete", args: { invoiceId: "aaaaaaaaaaaaaaaaaaaaaaaa", index: 0 }, fault: "deleteInvoiceItemAtomic" },
    { action: "clockify_invoices_payments_delete", args: { invoiceId: "aaaaaaaaaaaaaaaaaaaaaaaa", paymentId: "payment-1" }, fault: "deleteInvoicePaymentAtomic" },
  ] as const)("reconciles complete post-state after ambiguous $fault", async ({ action, args, fault }) => {
    const invoiceId = "aaaaaaaaaaaaaaaaaaaaaaaa";
    const fake = createFakeWorkspace({
      invoices: [{ id: invoiceId, number: "INV-1", clientId: "client-1", currency: "USD", status: "SENT", items: [{ order: 0, description: "Old", quantity: 1, unitPrice: 100, itemType: "TIME" }] }],
      invoiceFaults: { [fault]: { outcome: "ambiguous", applyBeforeThrow: true } },
    });
    fake.state.invoicePayments[invoiceId] = [{ id: "payment-1", amount: 5000, paymentDate: "2026-07-14", note: "paid" }];
    const prepared = await prepare(fake, action, args);
    const result = await commitConfirmedOperation(prepared.commitContext, prepared.operation);
    expect(result).toMatchObject({ ok: true });
    prepared.store.close();
  });

  it("verifies every invoice-import project and leaves the unobservable step unreconciled", async () => {
    const invoiceId = "aaaaaaaaaaaaaaaaaaaaaaaa";
    const projectId = "bbbbbbbbbbbbbbbbbbbbbbbb";
    const fake = createFakeWorkspace({
      invoices: [{ id: invoiceId, number: "INV-1", clientId: "client-1", currency: "USD", status: "UNSENT", items: [] }],
      projects: [{ id: projectId, name: "Roadshow" }],
    });
    const preview = await executeAction({ actionName: "clockify_invoices_import_time", args: { invoiceId, from: "today", to: "today", projectIds: [projectId] }, context: context(fake) });
    if (preview.kind !== "preview") throw new Error("expected preview");
    expect(preview.operation.targetSnapshots?.map((snapshot) => snapshot.ref.type)).toEqual(["invoice", "project"]);
    expect(preview.operation.mutationPlan?.steps[0]).not.toHaveProperty("reconciliationStrategy");
    const missing = await executeAction({ actionName: "clockify_invoices_import_time", args: { invoiceId, from: "today", to: "today", projectIds: ["cccccccccccccccccccccccc"] }, context: context(fake) });
    expect(missing.kind).toBe("clarify");
  });
});
