import { describe, expect, it } from "vitest";
import { commitConfirmedOperation, executeAction } from "../../src/harness/actions.js";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import { getAction } from "../../src/harness/catalog.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import type { ActionContext } from "../../src/harness/action.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import {
  TIME_OFF_BALANCE_USER_BATCH_MAX,
  TIME_OFF_BALANCE_USER_MATERIAL_MAX,
  TIME_OFF_POLICY_SCOPE_GROUP_BATCH_MAX,
  TIME_OFF_POLICY_SCOPE_USER_BATCH_MAX,
} from "../../src/harness/safety-limits.js";

const NOW = new Date("2026-06-06T00:00:00.000Z");

const TIME_OFF_POLICY_API_ACTIONS = [
  "clockify_time_off_policies_list",
  "clockify_time_off_policies_get",
  "clockify_time_off_policies_create",
  "clockify_time_off_policies_update",
  "clockify_time_off_policies_archive",
] as const;

const TIME_OFF_REQUEST_API_ACTIONS = [
  "clockify_time_off_requests_list",
  "clockify_time_off_requests_delete",
  "clockify_time_off_requests_create_days",
  "clockify_time_off_requests_create_hours",
] as const;

const INTERNAL_ONLY_TIME_OFF_REQUEST_ACTIONS = [
  "clockify_time_off_requests_create",
  "clockify_time_off_requests_get",
] as const;

function makeContext(fake: FakeWorkspace): ActionContext {
  return {
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    policy: defaultAdminPolicy(),
    clockify: fake.client,
    now: () => NOW,
    timeZone: "UTC",
    weekStartsOn: 1,
  };
}

describe("v2 time off policy API actions", () => {
  it("exposes bounded policy CRUD actions on MODEL_API", () => {
    const modelNames = new Set(MODEL_API_ACTION_CATALOG.actions.map((action) => action.name));
    for (const name of TIME_OFF_POLICY_API_ACTIONS) {
      expect(modelNames.has(name), name).toBe(true);
      expect(getAction(name)?.apiExposure).toBe("api");
    }
    const create = getAction("clockify_time_off_policies_create");
    const update = getAction("clockify_time_off_policies_update");
    const userIdsField = create?.materialFields?.find(
      (field): field is Extract<typeof field, { kind: "array_item" }> =>
        field.kind === "array_item" && field.containerPath === "/userIds",
    );
    const groupIdsField = create?.materialFields?.find(
      (field): field is Extract<typeof field, { kind: "array_item" }> =>
        field.kind === "array_item" && field.containerPath === "/userGroupIds",
    );
    const updateUserIdsField = update?.materialFields?.find(
      (field): field is Extract<typeof field, { kind: "array_item" }> =>
        field.kind === "array_item" && field.containerPath === "/userIds",
    );
    expect(userIdsField?.maxItems).toBe(TIME_OFF_POLICY_SCOPE_USER_BATCH_MAX);
    expect(groupIdsField?.maxItems).toBe(TIME_OFF_POLICY_SCOPE_GROUP_BATCH_MAX);
    expect(updateUserIdsField?.maxItems).toBe(TIME_OFF_POLICY_SCOPE_USER_BATCH_MAX);
  });
});

describe("v2 time off request API actions", () => {
  it("exposes unit-specific create actions and hides generic/composite wrappers", () => {
    const modelNames = new Set(MODEL_API_ACTION_CATALOG.actions.map((action) => action.name));
    for (const name of TIME_OFF_REQUEST_API_ACTIONS) {
      expect(modelNames.has(name), name).toBe(true);
      expect(getAction(name)?.apiExposure).toBe("api");
    }
    for (const name of INTERNAL_ONLY_TIME_OFF_REQUEST_ACTIONS) {
      expect(modelNames.has(name), name).toBe(false);
      expect(getAction(name)?.apiExposure).not.toBe("api");
    }
    expect(getAction("clockify_time_off_requests_create_days")?.schema.safeParse({
      policyId: "pol-1",
      start: "2026-07-01",
      end: "2026-07-03",
      days: 3,
    }).success).toBe(true);
    expect(getAction("clockify_time_off_requests_create_hours")?.schema.safeParse({
      policyId: "pol-1",
      start: "2026-07-01T09:00:00Z",
      end: "2026-07-01T13:00:00Z",
    }).success).toBe(true);
    expect(getAction("clockify_time_off_requests_create_hours")?.schema.safeParse({
      policyId: "pol-1",
      start: "2026-07-01T09:00:00Z",
      end: "2026-07-01T13:00:00Z",
      days: 1,
    }).success).toBe(false);
  });

  it("create_days commit uses operation.actionName on the receipt", async () => {
    const fake = createFakeWorkspace({
      timeOffPolicies: [{ id: "pol-1", name: "Vacation", status: "ACTIVE", timeUnit: "DAYS" }],
    });
    const preview = await executeAction({
      actionName: "clockify_time_off_requests_create_days",
      args: { policyId: "pol-1", start: "2026-07-01", end: "2026-07-01" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected preview");
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    if (receipt.ok) expect(receipt.action).toBe("clockify_time_off_requests_create_days");
  });
});

describe("v2 time off balance API actions", () => {
  it("exposes bounded balance read/update on MODEL_API", () => {
    const modelNames = new Set(MODEL_API_ACTION_CATALOG.actions.map((action) => action.name));
    expect(modelNames.has("clockify_time_off_balance_get")).toBe(true);
    expect(modelNames.has("clockify_time_off_balance_update")).toBe(true);
    const update = getAction("clockify_time_off_balance_update");
    const userIdsField = update?.materialFields?.find(
      (field): field is Extract<typeof field, { kind: "array_item" }> =>
        field.kind === "array_item" && field.containerPath === "/userIds",
    );
    expect(userIdsField?.maxItems).toBe(TIME_OFF_BALANCE_USER_BATCH_MAX);
    expect(TIME_OFF_BALANCE_USER_BATCH_MAX).toBeLessThanOrEqual(TIME_OFF_BALANCE_USER_MATERIAL_MAX);
  });
});

const APPROVAL_API_ACTIONS = [
  "clockify_approvals_list",
  "clockify_approvals_submit",
  "clockify_approvals_approve",
  "clockify_approvals_reject",
  "clockify_approvals_withdraw",
  "clockify_approvals_resubmit",
] as const;

const INTERNAL_ONLY_APPROVAL_ACTIONS = [
  "clockify_approvals_get",
  "clockify_approvals_approve_pending",
] as const;

describe("v2 approval API actions", () => {
  it("exposes single-request approval actions on MODEL_API", () => {
    const modelNames = new Set(MODEL_API_ACTION_CATALOG.actions.map((action) => action.name));
    for (const name of APPROVAL_API_ACTIONS) {
      expect(modelNames.has(name), name).toBe(true);
      expect(getAction(name)?.apiExposure).toBe("api");
    }
    for (const name of INTERNAL_ONLY_APPROVAL_ACTIONS) {
      expect(modelNames.has(name), name).toBe(false);
      expect(getAction(name)?.apiExposure).not.toBe("api");
    }
  });
});

const SCHEDULING_ASSIGNMENT_API_ACTIONS = [
  "clockify_scheduling_assignments_list",
  "clockify_scheduling_assignments_create",
  "clockify_scheduling_assignments_update",
  "clockify_scheduling_assignments_delete",
] as const;

describe("v2 scheduling assignment API actions", () => {
  it("exposes assignment CRUD/list on MODEL_API and hides composite get", () => {
    const modelNames = new Set(MODEL_API_ACTION_CATALOG.actions.map((action) => action.name));
    for (const name of SCHEDULING_ASSIGNMENT_API_ACTIONS) {
      expect(modelNames.has(name), name).toBe(true);
      expect(getAction(name)?.apiExposure).toBe("api");
    }
    expect(modelNames.has("clockify_scheduling_assignments_get")).toBe(false);
    expect(getAction("clockify_scheduling_assignments_get")?.apiExposure).toBe("composite");
  });

  it("create commits through the atomic recurring assignment POST", async () => {
    const fake = createFakeWorkspace({
      users: [{ id: "u1", name: "Admin", email: "a@example.com", status: "ACTIVE" }],
      projects: [{ id: "p1", name: "Alpha", archived: false }],
    });
    const result = await executeAction({
      actionName: "clockify_scheduling_assignments_create",
      args: {
        userId: "u1",
        projectId: "p1",
        start: "2026-07-01",
        end: "2026-07-05",
        hoursPerDay: 8,
      },
      context: makeContext(fake),
    });
    if (result.kind !== "receipt" || !result.receipt.ok) throw new Error("expected safe-write receipt");
    expect(fake.counts.createAssignmentAtomic).toBe(1);
  });
});

const SCHEDULING_TOTALS_API_ACTIONS = [
  "clockify_scheduling_project_totals_all",
  "clockify_scheduling_project_totals_one",
  "clockify_scheduling_user_totals",
] as const;

describe("v2 scheduling totals API actions", () => {
  it("exposes split project totals and user totals on MODEL_API", () => {
    const modelNames = new Set(MODEL_API_ACTION_CATALOG.actions.map((action) => action.name));
    for (const name of SCHEDULING_TOTALS_API_ACTIONS) {
      expect(modelNames.has(name), name).toBe(true);
      expect(getAction(name)?.apiExposure).toBe("api");
    }
    expect(modelNames.has("clockify_scheduling_project_totals")).toBe(false);
    expect(getAction("clockify_scheduling_project_totals")?.apiExposure).toBe("generic");
  });

  it("project_totals_all uses POST all-projects totals", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_scheduling_project_totals_all",
      args: { start: "2026-07-01", end: "2026-07-07" },
      context: makeContext(fake),
    });
    if (result.kind !== "receipt" || !result.receipt.ok) throw new Error("expected receipt");
    expect(fake.counts.getAllProjectScheduleTotals).toBe(1);
  });

  it("project_totals_one uses GET one-project totals", async () => {
    const fake = createFakeWorkspace({
      projects: [{ id: "p1", name: "Alpha", archived: false }],
    });
    const result = await executeAction({
      actionName: "clockify_scheduling_project_totals_one",
      args: { start: "2026-07-01", end: "2026-07-07", projectId: "p1" },
      context: makeContext(fake),
    });
    if (result.kind !== "receipt" || !result.receipt.ok) throw new Error("expected receipt");
    expect(fake.counts.getOneProjectScheduleTotals).toBe(1);
  });
});
