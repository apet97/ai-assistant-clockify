import { describe, expect, it } from "vitest";
import { hashOperation } from "../../src/harness/confirmations.js";
import { getAction } from "../../src/harness/catalog.js";
import { undoMutationPlan } from "../../src/harness/undo.js";
import {
  chargeHostCallBudget,
  withHostCallBudget,
  withReservedHostCallBudget,
} from "../../src/clockify/request-governor.js";
import {
  APPROVAL_PENDING_BATCH_MAX,
  bindMutationPlanHostCalls,
  CONFIRMED_REQUEST_PRE_RESERVATION_HOST_CALLS,
  estimateMutationPlanHostCalls,
  estimateSetupProjectHostCalls,
  GROUP_MEMBER_BATCH_MAX,
  INVOICE_IMPORT_PROJECT_BATCH_MAX,
  INVOICE_ITEM_BATCH_MAX,
  INVOICE_CREATE_RECONCILIATION_CANDIDATE_MAX,
  MARK_INVOICED_ENTRY_BATCH_MAX,
  ONBOARD_GROUP_BATCH_MAX,
  SETUP_TASK_ASSIGNEE_BATCH_MAX,
  SETUP_PROJECT_MEMBER_BATCH_MAX,
  SETUP_PROJECT_RATE_BATCH_MAX,
  TIME_OFF_BALANCE_USER_BATCH_MAX,
  TURN_HOST_CALL_LIMIT,
} from "../../src/harness/safety-limits.js";

describe("deterministic mutation host-call bounds", () => {
  it("derives the approve-all ceiling from the worst-case confirmation call budget", () => {
    expect(CONFIRMED_REQUEST_PRE_RESERVATION_HOST_CALLS + 3 * APPROVAL_PENDING_BATCH_MAX + 1)
      .toBeLessThanOrEqual(TURN_HOST_CALL_LIMIT);
    expect(CONFIRMED_REQUEST_PRE_RESERVATION_HOST_CALLS + 3 * (APPROVAL_PENDING_BATCH_MAX + 1) + 1)
      .toBeGreaterThan(TURN_HOST_CALL_LIMIT);
  });

  it("pins exact maximum and maximum + 1 arithmetic under the 60-call turn budget", () => {
    const steps = (count: number, prefix: string) => Array.from({ length: count }, (_, index) => ({
      id: `${prefix}${index}`,
      kind: "primary" as const,
    }));

    expect(CONFIRMED_REQUEST_PRE_RESERVATION_HOST_CALLS + estimateMutationPlanHostCalls("clockify_groups_add_user", {}, {
      mode: "batch", steps: steps(GROUP_MEMBER_BATCH_MAX, "add-user-to-group-"),
    })).toBe(60);
    expect(CONFIRMED_REQUEST_PRE_RESERVATION_HOST_CALLS + estimateMutationPlanHostCalls("clockify_groups_add_user", {}, {
      mode: "batch", steps: steps(GROUP_MEMBER_BATCH_MAX + 1, "add-user-to-group-"),
    })).toBe(64);
    expect(CONFIRMED_REQUEST_PRE_RESERVATION_HOST_CALLS + 4 * ONBOARD_GROUP_BATCH_MAX + 4).toBe(59);
    expect(CONFIRMED_REQUEST_PRE_RESERVATION_HOST_CALLS + 4 * (ONBOARD_GROUP_BATCH_MAX + 1) + 4).toBe(63);
    expect(CONFIRMED_REQUEST_PRE_RESERVATION_HOST_CALLS + 6 + 2 * INVOICE_ITEM_BATCH_MAX).toBe(59);
    expect(CONFIRMED_REQUEST_PRE_RESERVATION_HOST_CALLS + 6 + 2 * (INVOICE_ITEM_BATCH_MAX + 1)).toBe(61);
    expect(estimateSetupProjectHostCalls({
      memberCount: SETUP_PROJECT_MEMBER_BATCH_MAX,
      rateCount: 0,
      hasClient: true,
    })).toBe(56);
    expect(estimateSetupProjectHostCalls({
      memberCount: SETUP_PROJECT_MEMBER_BATCH_MAX + 1,
      rateCount: 0,
      hasClient: true,
    })).toBe(58);
    expect(estimateSetupProjectHostCalls({
      memberCount: SETUP_PROJECT_RATE_BATCH_MAX,
      rateCount: SETUP_PROJECT_RATE_BATCH_MAX,
      hasClient: true,
    })).toBe(50);
    expect(estimateSetupProjectHostCalls({ memberCount: 5, rateCount: 5, hasClient: true })).toBe(65);
  });

  it("admits the setup-project maximum after cold route auth and two confirmation role calls", async () => {
    const supported = estimateSetupProjectHostCalls({
      memberCount: SETUP_PROJECT_MEMBER_BATCH_MAX,
      rateCount: 0,
      hasClient: true,
    });
    const unsupported = estimateSetupProjectHostCalls({
      memberCount: SETUP_PROJECT_MEMBER_BATCH_MAX + 1,
      rateCount: 0,
      hasClient: true,
    });

    await withHostCallBudget(async () => {
      chargeHostCallBudget();
      chargeHostCallBudget();
      chargeHostCallBudget();
      await expect(withReservedHostCallBudget(supported, async () => "reserved")).resolves.toBe("reserved");
    });
    await withHostCallBudget(async () => {
      chargeHostCallBudget();
      chargeHostCallBudget();
      chargeHostCallBudget();
      expect(() => withReservedHostCallBudget(unsupported, async () => "never"))
        .toThrow("Clockify host-call budget exceeded");
    });
  });

  it("binds the estimated cost into the persisted/hashable plan surface", () => {
    const plan = bindMutationPlanHostCalls("clockify_invoices_create", {}, {
      mode: "curated",
      steps: [
        { id: "create-invoice", kind: "primary" },
        { id: "enrich-invoice", kind: "primary" },
        { id: "add-invoice-item-0", kind: "primary" },
      ],
    });

    expect(plan.maxHostCalls).toBe(8);
    expect(hashOperation(plan)).not.toBe(hashOperation({ ...plan, maxHostCalls: 9 }));
  });

  it("reserves the complete bounded base-only invoice reconciliation scan", () => {
    expect(bindMutationPlanHostCalls("clockify_invoices_create", {}, {
      mode: "single",
      steps: [{ id: "create-invoice", kind: "primary" }],
    }).maxHostCalls).toBe(4 + INVOICE_CREATE_RECONCILIATION_CANDIDATE_MAX);
  });

  it("does not clamp an unsupported generic plan into the 60-call budget", () => {
    const plan = {
      mode: "batch" as const,
      steps: Array.from({ length: 16 }, (_, index) => ({ id: `step-${index}`, kind: "primary" as const })),
    };
    expect(estimateMutationPlanHostCalls("clockify_test_generic", {}, plan)).toBe(128);
    expect(bindMutationPlanHostCalls("clockify_test_generic", {}, plan).maxHostCalls).toBe(128);
  });

  it("reserves the ninth call needed to reconcile a project create with a client parent", () => {
    const plan = bindMutationPlanHostCalls(
      "clockify_projects_create",
      {
        body: { name: "Apollo", clientId: "client-1" },
        targetSnapshots: [{ ref: { type: "client", id: "client-1" }, fingerprint: "parent" }],
      },
      {
        mode: "single",
        steps: [{ id: "create-project", kind: "primary", reconciliationStrategy: "create" }],
      },
    );

    expect(plan.maxHostCalls).toBe(9);
  });

  it("binds invoice-import project verification into the physical-call estimate", () => {
    const projectIds = Array.from({ length: 6 }, (_, index) => `project-${index}`);
    const plan = bindMutationPlanHostCalls(
      "clockify_invoices_import_time",
      {
        invoiceId: "invoice-1",
        range: { from: "2026-07-01", to: "2026-07-31", projectIds },
        targetSnapshots: [
          { ref: { type: "invoice", id: "invoice-1" }, fingerprint: "invoice" },
          ...projectIds.map((id) => ({ ref: { type: "project", id }, fingerprint: id })),
        ],
      },
      {
        mode: "single",
        steps: [{ id: "import-invoice-time", kind: "primary" }],
      },
    );

    expect(plan.maxHostCalls).toBe(9);
  });

  it("binds undo into the same pre-dispatch reservation contract", () => {
    expect(undoMutationPlan([{ type: "tag", id: "tag-1" }]).maxHostCalls).toBe(2);
    expect(undoMutationPlan([{ type: "project", id: "project-1" }]).maxHostCalls).toBe(5);
  });

  it("keeps the maximal offered work-package undo below the 60-call persistence ceiling", () => {
    const plan = undoMutationPlan([
      { type: "tag", id: "tag-1" },
      { type: "client", id: "client-1" },
      { type: "project", id: "project-1" },
      { type: "task", id: "task-1", projectId: "project-1" },
      { type: "time_entry", id: "entry-1" },
    ]);

    expect(plan.steps).toHaveLength(8);
    expect(plan.maxHostCalls).toBe(19);
    expect(plan.maxHostCalls).toBeLessThanOrEqual(TURN_HOST_CALL_LIMIT);
  });

  it("derives coupled single-step array ceilings from their physical-call estimators", () => {
    expect(3 + 2 * MARK_INVOICED_ENTRY_BATCH_MAX + 2).toBeLessThanOrEqual(TURN_HOST_CALL_LIMIT);
    expect(MARK_INVOICED_ENTRY_BATCH_MAX).toBe(21);
    expect(3 + INVOICE_IMPORT_PROJECT_BATCH_MAX + 3).toBeLessThanOrEqual(TURN_HOST_CALL_LIMIT);
    expect(INVOICE_IMPORT_PROJECT_BATCH_MAX).toBe(19);
    expect(3 + 3 * SETUP_TASK_ASSIGNEE_BATCH_MAX + 11).toBeLessThanOrEqual(TURN_HOST_CALL_LIMIT);
    expect(3 + 3 * (SETUP_TASK_ASSIGNEE_BATCH_MAX + 1) + 11).toBeGreaterThan(TURN_HOST_CALL_LIMIT);
    expect(3 + 2 * TIME_OFF_BALANCE_USER_BATCH_MAX + 3).toBeLessThanOrEqual(TURN_HOST_CALL_LIMIT);
    expect(3 + 2 * (TIME_OFF_BALANCE_USER_BATCH_MAX + 1) + 3).toBeGreaterThan(TURN_HOST_CALL_LIMIT);
  });

  it("binds coupled array costs and rejects maximum-plus-one at schema entry", () => {
    const ids = (count: number) => Array.from({ length: count }, (_, index) => `id-${index}`);
    expect(estimateMutationPlanHostCalls("clockify_entries_mark_invoiced", { ids: ids(4) }, {
      mode: "single", steps: [{ id: "mark-entries-invoiced", kind: "primary" }],
    })).toBe(10);
    expect(estimateMutationPlanHostCalls("clockify_setup_task", {
      assigneeIds: ids(4), rate: { amountMinor: 1, kind: "hourly" },
    }, {
      mode: "curated", steps: [{ id: "create-task", kind: "primary" }, { id: "set-task-rate", kind: "primary" }],
    })).toBe(23);
    expect(estimateMutationPlanHostCalls("clockify_time_off_balance_update", { userIds: ids(4) }, {
      mode: "single", steps: [{ id: "update-time-off-balance", kind: "primary" }],
    })).toBe(11);

    expect(getAction("clockify_entries_mark_invoiced")!.schema.safeParse({
      ids: ids(MARK_INVOICED_ENTRY_BATCH_MAX + 1), invoiced: true,
    }).success).toBe(false);
    expect(getAction("clockify_invoices_import_time")!.schema.safeParse({
      invoiceId: "invoice-1", from: "2026-07-01", to: "2026-07-31",
      projectIds: ids(INVOICE_IMPORT_PROJECT_BATCH_MAX + 1),
    }).success).toBe(false);
    expect(getAction("clockify_setup_task")!.schema.safeParse({
      projectId: "project-1", name: "Task", assignees: ids(SETUP_TASK_ASSIGNEE_BATCH_MAX + 1), rate: 1,
    }).success).toBe(false);
    expect(getAction("clockify_time_off_balance_update")!.schema.safeParse({
      policyId: "policy-1", userIds: ids(TIME_OFF_BALANCE_USER_BATCH_MAX + 1), value: 1,
    }).success).toBe(false);
  });

  it("separates raw argument cardinality from exact mutation-step cardinality", () => {
    expect(getAction("clockify_invoices_create")!.writeAuthority!.cardinality).toMatchObject({
      maxExecutions: INVOICE_ITEM_BATCH_MAX + 2,
      maxArgumentItems: INVOICE_ITEM_BATCH_MAX,
    });
    expect(getAction("clockify_onboard_user")!.writeAuthority!.cardinality).toMatchObject({
      maxExecutions: ONBOARD_GROUP_BATCH_MAX + 1,
      maxArgumentItems: ONBOARD_GROUP_BATCH_MAX,
    });
    expect(getAction("clockify_setup_project")!.writeAuthority!.cardinality).toMatchObject({
      maxExecutions: SETUP_PROJECT_RATE_BATCH_MAX + 2,
      maxArgumentItems: SETUP_PROJECT_RATE_BATCH_MAX,
    });
  });
});
