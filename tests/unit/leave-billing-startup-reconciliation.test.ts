import { describe, expect, it, vi } from "vitest";
import {
  LEAVE_BILLING_STARTUP_RECONCILIATION,
  LEAVE_BILLING_STARTUP_RECONCILIATION_HANDLER_COUNT,
  hasLeaveBillingStartupReconciliationHandler,
  reconcileWithLeaveBillingStartupRegistry,
  type LeaveBillingStartupReconciliationReadClient,
} from "../../src/harness/workflows/leave-billing-startup-reconciliation.js";

const EXPECTED_BINDINGS = [
  ["clockify_expenses_create", "create-expense", "create"],
  ["clockify_expenses_update", "update-expense", "update"],
  ["clockify_expenses_delete", "delete-expense", "delete"],
  ["clockify_expenses_categories_create", "create-expense-category", "create"],
  ["clockify_expenses_categories_update", "rename-expense-category", "update"],
  ["clockify_expenses_categories_update", "set-expense-category-status", "state-command"],
  ["clockify_expenses_categories_delete", "archive-expense-category", "state-command"],
  ["clockify_expenses_categories_delete", "delete-expense-category", "delete"],
  ["clockify_custom_fields_create", "create-custom-field", "create"],
  ["clockify_custom_fields_update", "update-custom-field", "update"],
  ["clockify_custom_fields_delete", "delete-custom-field", "delete"],
  ["clockify_time_off_policies_create", "create-time-off-policy", "create"],
  ["clockify_time_off_policies_update", "update-time-off-policy", "update"],
  ["clockify_time_off_policies_archive", "archive-time-off-policy", "state-command"],
  ["clockify_time_off_requests_create", "create-time-off-request", "create"],
  ["clockify_time_off_requests_delete", "delete-time-off-request", "delete"],
  ["clockify_time_off_approve", "approve-time-off-request", "state-command"],
  ["clockify_time_off_deny", "deny-time-off-request", "state-command"],
  ["clockify_time_off_balance_update", "update-time-off-balance", "state-command"],
  ["clockify_holidays_create", "create-holiday", "create"],
  ["clockify_holidays_update", "update-holiday", "update"],
  ["clockify_holidays_delete", "delete-holiday", "delete"],
  ["clockify_invoices_create", "create-invoice", "create"],
  ["clockify_invoices_create", "enrich-invoice", "update"],
  ["clockify_invoices_create", "add-invoice-item-*", "update"],
  ["clockify_invoices_update", "update-invoice-fields", "update"],
  ["clockify_invoices_update", "update-invoice-status", "state-command"],
  ["clockify_invoices_delete", "delete-invoice", "delete"],
  ["clockify_invoices_items_add", "add-invoice-item", "update"],
  ["clockify_invoices_items_delete", "delete-invoice-item", "delete"],
  ["clockify_invoices_payments_create", "record-payment", "create"],
  ["clockify_invoices_payments_delete", "delete-invoice-payment", "delete"],
  ["clockify_delete_entity", "archive-project", "state-command"],
  ["clockify_delete_entity", "archive-client", "state-command"],
  ["clockify_delete_entity", "delete-project", "delete"],
  ["clockify_delete_entity", "delete-client", "delete"],
  ["clockify_delete_entity", "delete-tag", "delete"],
  ["clockify_delete_entity", "delete-time_entry", "delete"],
  ["clockify_delete_entity", "delete-invoice", "delete"],
  ["clockify_delete_entity", "delete-expense", "delete"],
  ["clockify_delete_entity", "delete-webhook", "delete"],
  ["clockify_delete_entity", "delete-group", "delete"],
  ["clockify_delete_entity", "restore-project", "update"],
  ["clockify_delete_entity", "restore-client", "update"],
  ["clockify_update_entity", "update-project", "update"],
  ["clockify_update_entity", "update-client", "update"],
  ["clockify_update_entity", "update-tag", "update"],
] as const;

type Strategy = typeof EXPECTED_BINDINGS[number][2];

function input(options: {
  actionName: string;
  planStepId: string;
  strategy: Strategy;
  operation: unknown;
  evidence?: unknown;
  clockify: LeaveBillingStartupReconciliationReadClient;
}) {
  const binding = {
    operationId: "operation", stepId: "step", planStepId: options.planStepId,
    strategy: options.strategy, actionName: options.actionName,
    actionFingerprint: "action-fingerprint", catalogHash: "catalog-hash",
  } as const;
  const step = {
    id: "step", status: "outcome_unknown", kind: "primary" as const,
    planStepId: options.planStepId, strategy: options.strategy,
    evidence: options.evidence ?? {},
  };
  return {
    binding,
    candidate: {
      id: "operation", status: "outcome_unknown", workspaceId: "workspace", adminUserId: "admin",
      actionName: options.actionName, actionFingerprint: "action-fingerprint", catalogHash: "catalog-hash",
      operation: options.operation, steps: [step],
    },
    step,
    clockify: options.clockify,
  };
}

describe("leave/billing startup reconciliation", () => {
  it("exports one immutable read handler for every declared strategy binding", () => {
    const actual = Object.entries(LEAVE_BILLING_STARTUP_RECONCILIATION).flatMap(([actionName, steps]) =>
      Object.entries(steps).map(([planStepId, strategy]) => [actionName, planStepId, strategy]),
    );
    expect(actual).toEqual(EXPECTED_BINDINGS);
    expect(LEAVE_BILLING_STARTUP_RECONCILIATION_HANDLER_COUNT).toBe(47);
    expect(Object.isFrozen(LEAVE_BILLING_STARTUP_RECONCILIATION)).toBe(true);
    for (const [actionName, steps] of Object.entries(LEAVE_BILLING_STARTUP_RECONCILIATION)) {
      expect(Object.isFrozen(steps), actionName).toBe(true);
      for (const planStepId of Object.keys(steps)) {
        expect(hasLeaveBillingStartupReconciliationHandler(actionName, planStepId)).toBe(true);
      }
    }
    expect(hasLeaveBillingStartupReconciliationHandler("clockify_invoices_create", "add-invoice-item-19")).toBe(true);
    expect(hasLeaveBillingStartupReconciliationHandler("clockify_invoices_create", "add-invoice-item-x")).toBe(false);
    expect(hasLeaveBillingStartupReconciliationHandler("clockify_invoices_import_time", "import-invoice-time")).toBe(false);
    expect(hasLeaveBillingStartupReconciliationHandler("clockify_custom_fields_set_value_project", "set-project-custom-field")).toBe(false);
  });

  it("exposes no Clockify mutation method to a startup handler", () => {
    type Create = "createExpenseAtomic" extends keyof LeaveBillingStartupReconciliationReadClient ? true : false;
    type Update = "updateInvoiceFields" extends keyof LeaveBillingStartupReconciliationReadClient ? true : false;
    type Delete = "deleteTimeOffRequestAtomic" extends keyof LeaveBillingStartupReconciliationReadClient ? true : false;
    const exposed: [Create, Update, Delete] = [false, false, false];
    expect(exposed).toEqual([false, false, false]);
  });

  it.each([
    [[], false, false, "non_unique_or_missing"],
    [[{ id: "new", name: "Travel" }], false, true, "authoritative_match"],
    [[{ id: "one", name: "Travel" }, { id: "two", name: "Travel" }], false, false, "non_unique_or_missing"],
    [[{ id: "new", name: "Travel" }], true, false, "incomplete_evidence"],
  ] as const)("uses the persisted immediate baseline and complete create evidence", async (rows, truncated, authoritative, reason) => {
    const result = await reconcileWithLeaveBillingStartupRegistry(input({
      actionName: "clockify_expenses_categories_create",
      planStepId: "create-expense-category",
      strategy: "create",
      operation: { payload: { name: "Travel", baselineIds: ["preview-only"] } },
      evidence: { preDispatch: { ids: ["old"], truncated: false } },
      clockify: { listExpenseCategories: vi.fn(async () => ({ rows, truncated })) } as never,
    }));
    expect(result).toMatchObject({ authoritative, reason });
  });

  it("rejects a create that has only a preview-time baseline", async () => {
    const listExpenseCategories = vi.fn(async () => ({ rows: [{ id: "new", name: "Travel" }], truncated: false }));
    const result = await reconcileWithLeaveBillingStartupRegistry(input({
      actionName: "clockify_expenses_categories_create", planStepId: "create-expense-category", strategy: "create",
      operation: { payload: { name: "Travel", baselineIds: [] } },
      clockify: { listExpenseCategories } as never,
    }));
    expect(result).toMatchObject({ authoritative: false, reason: "invalid_evidence" });
    expect(listExpenseCategories).not.toHaveBeenCalled();
  });

  it("proves deletes only from a complete absence and exact updates from one raw row", async () => {
    const deleted = await reconcileWithLeaveBillingStartupRegistry(input({
      actionName: "clockify_holidays_delete", planStepId: "delete-holiday", strategy: "delete",
      operation: { payload: { id: "holiday" } },
      clockify: { getHolidayMutationState: vi.fn(async () => null) } as never,
    }));
    expect(deleted).toMatchObject({ authoritative: true, reason: "authoritative_match" });

    const raw = { id: "field", name: "Team", type: "TXT", required: true };
    const updated = await reconcileWithLeaveBillingStartupRegistry(input({
      actionName: "clockify_custom_fields_update", planStepId: "update-custom-field", strategy: "update",
      operation: { payload: { id: "field", updateBody: raw } },
      clockify: { getCustomField: vi.fn(async () => raw) } as never,
    }));
    expect(updated).toMatchObject({ authoritative: true, reason: "authoritative_match" });
  });
});
