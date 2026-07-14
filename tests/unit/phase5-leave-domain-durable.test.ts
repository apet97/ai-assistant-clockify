import { describe, expect, it } from "vitest";
import { getAction } from "../../src/harness/catalog.js";
import { commitConfirmedOperation, executeAction } from "../../src/harness/actions.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import type { ActionContext } from "../../src/harness/action.js";
import { AmbiguousWriteOutcome } from "../../src/clockify/write-outcome.js";

const OWNED_WRITES = [
  "clockify_expenses_create",
  "clockify_expenses_update",
  "clockify_expenses_delete",
  "clockify_expenses_categories_create",
  "clockify_expenses_categories_update",
  "clockify_expenses_categories_delete",
  "clockify_custom_fields_create",
  "clockify_custom_fields_update",
  "clockify_custom_fields_delete",
  "clockify_custom_fields_set_value_project",
  "clockify_custom_fields_set_value_entry",
  "clockify_time_off_policies_create",
  "clockify_time_off_policies_update",
  "clockify_time_off_policies_archive",
  "clockify_time_off_requests_create",
  "clockify_time_off_requests_delete",
  "clockify_time_off_approve",
  "clockify_time_off_deny",
  "clockify_time_off_balance_update",
  "clockify_holidays_create",
  "clockify_holidays_update",
  "clockify_holidays_delete",
] as const;

const INVOICE_TARGET_WRITES = [
  "clockify_invoices_update",
  "clockify_invoices_items_add",
  "clockify_invoices_items_delete",
  "clockify_invoices_payments_create",
  "clockify_invoices_payments_delete",
  "clockify_invoices_import_time",
] as const;

describe("phase 5 leave and billing-adjacent durable contracts", () => {
  it.each(OWNED_WRITES)("migrates %s to an exact durable mutation contract", (name) => {
    const action = getAction(name);
    expect(action, name).toBeDefined();
    expect(action?.mutationWorkflow, name).toBe("durable");
    expect(action?.mutationContract, name).toMatchObject({
      operationData: { normalized: true, nonsecret: true },
      mutationPlan: { exact: true },
      reconciliation: { stepBound: true, requiresCompleteEvidence: true },
    });
  });

  it.each(INVOICE_TARGET_WRITES)("removes deferred targeting from %s", (name) => {
    const action = getAction(name);
    expect(action?.mutationContract?.targeting.mode, name).toBe("snapshots");
  });

  const context = (fake: FakeWorkspace): ActionContext => ({
    workspaceId: "ws-1", adminUserId: "admin-1", policy: defaultAdminPolicy(), clockify: fake.client,
    now: () => new Date("2026-07-14T09:00:00Z"),
  });

  it("rejects stale financial expense targets before any atomic PUT", async () => {
    const fake = createFakeWorkspace({
      expenses: [{ id: "exp-1", name: "Taxi", notes: "Taxi", date: "2026-07-14", categoryId: "cat-1", total: 1_000, quantity: 1, userId: "admin-1" }],
      expenseCategories: [{ id: "cat-1", name: "Travel", archived: false }],
    });
    const preview = await executeAction({ actionName: "clockify_expenses_update", args: { id: "exp-1", notes: "Airport" }, context: context(fake) });
    if (preview.kind !== "preview") throw new Error("expected expense preview");
    fake.state.expenses[0]!.total = 2_000;
    const result = await commitConfirmedOperation(context(fake), preview.operation);
    expect(result).toMatchObject({ ok: false, code: "stale_target" });
    expect(fake.counts.updateExpenseAtomic ?? 0).toBe(0);
  });

  it("rejects custom-field and holiday target drift before host dispatch", async () => {
    const fake = createFakeWorkspace({
      customFields: [{ id: "cf-1", name: "Priority", type: "TXT", status: "VISIBLE" }],
      holidays: [{ id: "hol-1", name: "Founders Day", startDate: "2026-08-01", endDate: "2026-08-01", userIds: ["admin-1"] }],
    });
    const field = await executeAction({ actionName: "clockify_custom_fields_update", args: { id: "cf-1", name: "Severity" }, context: context(fake) });
    if (field.kind !== "preview") throw new Error("expected custom-field preview");
    fake.state.customFields[0]!.status = "ARCHIVED";
    expect(await commitConfirmedOperation(context(fake), field.operation)).toMatchObject({ ok: false, code: "stale_target" });
    expect(fake.counts.updateCustomFieldAtomic ?? 0).toBe(0);

    const holiday = await executeAction({ actionName: "clockify_holidays_update", args: { id: "hol-1", name: "Foundation Day" }, context: context(fake) });
    if (holiday.kind !== "preview") throw new Error("expected holiday preview");
    fake.state.holidays[0]!.startDate = "2026-08-02";
    expect(await commitConfirmedOperation(context(fake), holiday.operation)).toMatchObject({ ok: false, code: "stale_target" });
    expect(fake.counts.updateHolidayAtomic ?? 0).toBe(0);
  });

  it("binds request creation to the exact DAYS/HOURS parent policy snapshot", async () => {
    const fake = createFakeWorkspace({ timeOffPolicies: [{ id: "pol-1", name: "Vacation", status: "ACTIVE", timeUnit: "DAYS" }] });
    const preview = await executeAction({ actionName: "clockify_time_off_requests_create", args: { policyId: "pol-1", start: "tomorrow", end: "tomorrow" }, context: context(fake) });
    if (preview.kind !== "preview") throw new Error("expected request preview");
    expect(preview.operation.targetSnapshots?.map((snapshot) => snapshot.relation)).toEqual(["parent"]);
    fake.state.timeOffPolicies[0]!.timeUnit = "HOURS";
    expect(await commitConfirmedOperation(context(fake), preview.operation)).toMatchObject({ ok: false, code: "stale_parent" });
    expect(fake.counts.createTimeOffRequestAtomic ?? 0).toBe(0);
  });

  it("prepares normalized holiday-create intent and dispatches exactly one atomic POST", async () => {
    const fake = createFakeWorkspace({
      users: [{ id: "admin-1", name: "Admin", email: "admin@example.com", status: "ACTIVE" }],
    });
    const action = getAction("clockify_holidays_create")!;
    const args = { name: "Foundation Day", startDate: "tomorrow", userIds: ["me"] };
    const prepared = await action.prepareSafeWrite!(context(fake), args);
    expect(prepared).toMatchObject({
      operation: { body: { name: "Foundation Day", startDate: "2026-07-15", userIds: ["admin-1"] } },
      mutationPlan: { mode: "single", steps: [{ id: "create-holiday", reconciliationStrategy: "create" }] },
    });

    const result = await executeAction({ actionName: action.name, args, context: context(fake) });
    expect(result).toMatchObject({ kind: "receipt", receipt: { ok: true } });
    expect(fake.counts.createHolidayAtomic).toBe(1);
  });

  it("clarifies an invalid holiday date before authorization or host dispatch", async () => {
    const fake = createFakeWorkspace({
      users: [{ id: "admin-1", name: "Admin", email: "admin@example.com", status: "ACTIVE" }],
    });
    const result = await executeAction({
      actionName: "clockify_holidays_create",
      args: { name: "Impossible Day", startDate: "2026-02-30", userIds: ["me"] },
      context: context(fake),
    });
    expect(result).toMatchObject({ kind: "clarify", message: expect.stringContaining("start date") });
    expect(fake.counts.createHolidayAtomic ?? 0).toBe(0);
  });

  it("authoritatively reconciles a socket-close-after-apply expense create from a complete baseline", async () => {
    const fake = createFakeWorkspace({ expenseCategories: [{ id: "cat-1", name: "Travel", archived: false }] });
    const preview = await executeAction({
      actionName: "clockify_expenses_create",
      args: { amount: 12, categoryId: "cat-1", notes: "Taxi" },
      context: context(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected expense preview");
    const apply = fake.client.createExpenseAtomic.bind(fake.client);
    fake.client.createExpenseAtomic = async (input) => {
      await apply(input);
      throw new AmbiguousWriteOutcome("POST", "/expenses", "socket closed after apply");
    };

    const result = await commitConfirmedOperation(context(fake), preview.operation);
    expect(result).toMatchObject({ ok: true });
    expect(fake.counts.createExpenseAtomic).toBe(1);
    expect(fake.state.expenses).toHaveLength(1);
  });

  it("keeps an ambiguous create unknown when complete evidence has multiple exact candidates", async () => {
    const fake = createFakeWorkspace({ expenseCategories: [{ id: "cat-1", name: "Travel", archived: false }] });
    const preview = await executeAction({
      actionName: "clockify_expenses_create",
      args: { amount: 12, categoryId: "cat-1", notes: "Taxi" },
      context: context(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected expense preview");
    const apply = fake.client.createExpenseAtomic.bind(fake.client);
    fake.client.createExpenseAtomic = async (input) => {
      await apply(input);
      fake.state.expenses.push({ ...fake.state.expenses.at(-1)!, id: "duplicate-expense" });
      throw new AmbiguousWriteOutcome("POST", "/expenses", "proxy returned 502");
    };

    const result = await commitConfirmedOperation(context(fake), preview.operation);
    expect(result).toMatchObject({ ok: false, code: "commit_outcome_unknown" });
    expect(fake.counts.createExpenseAtomic).toBe(1);
  });

  it("refuses create reconciliation when its pre-dispatch list baseline is truncated", async () => {
    const fake = createFakeWorkspace({
      expenseCategories: [{ id: "cat-1", name: "Travel", archived: false }],
      listTruncated: { listExpenses: true },
    });
    const result = await executeAction({
      actionName: "clockify_expenses_create",
      args: { amount: 12, categoryId: "cat-1" },
      context: context(fake),
    });
    expect(result.kind).toBe("clarify");
    expect(fake.counts.createExpenseAtomic ?? 0).toBe(0);
  });

  it.each([
    ["clockify_invoices_update", { id: "inv-1", note: "changed" }, "updateInvoiceFields"],
    ["clockify_invoices_items_add", { invoiceId: "inv-1", itemType: "TIME", unitPrice: 5 }, "addInvoiceItemAtomic"],
    ["clockify_invoices_payments_create", { invoiceId: "inv-1", amount: 5, paymentDate: "2026-07-14" }, "createInvoicePaymentAtomic"],
    ["clockify_invoices_import_time", { invoiceId: "inv-1", from: "today", to: "today" }, "importInvoiceTimeAtomic"],
  ] as const)("rejects invoice/parent drift for %s", async (actionName, args, count) => {
    const fake = createFakeWorkspace({
      clients: [{ id: "client-1", name: "Acme" }],
      invoices: [{ id: "inv-1", number: "INV-1", clientId: "client-1", currency: "USD", status: "UNSENT", items: [{ order: 0, description: "Time", quantity: 1, unitPrice: 100, itemType: "TIME" }] }],
    });
    const preview = await executeAction({ actionName, args, context: context(fake) });
    if (preview.kind !== "preview") throw new Error(`expected ${actionName} preview`);
    fake.state.invoices[0]!.status = "SENT";
    const result = await commitConfirmedOperation(context(fake), preview.operation);
    expect(result).toMatchObject({ ok: false, code: expect.stringMatching(/^stale_(target|parent)$/) });
    expect(fake.counts[count] ?? 0).toBe(0);
  });
});
