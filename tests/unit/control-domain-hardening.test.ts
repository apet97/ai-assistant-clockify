import { describe, expect, it } from "vitest";
import { ACTION_CATALOG } from "../../src/harness/catalog.js";

const OWNED_WRITES = [
  "clockify_scheduling_assignments_create",
  "clockify_scheduling_assignments_update",
  "clockify_scheduling_assignments_delete",
  "clockify_scheduling_publish",
  "clockify_approvals_submit",
  "clockify_approvals_approve",
  "clockify_approvals_reject",
  "clockify_approvals_withdraw",
  "clockify_approvals_resubmit",
  "clockify_webhooks_create",
  "clockify_webhooks_update",
  "clockify_webhooks_delete",
  "clockify_users_invite",
  "clockify_users_role_update",
  "clockify_users_rate_update",
  "clockify_users_hourly_rate_update",
  "clockify_users_cost_rate_update",
  "clockify_users_deactivate",
  "clockify_groups_create",
  "clockify_groups_update",
  "clockify_groups_delete",
  "clockify_groups_add_user",
  "clockify_groups_remove_user",
] as const;

describe("phase 5 control-domain mutation contracts", () => {
  it.each(OWNED_WRITES)("migrates %s to the durable workflow contract", (name) => {
    const action = ACTION_CATALOG.find((candidate) => candidate.name === name);
    expect(action, name).toBeDefined();
    expect(action?.mutationWorkflow, name).toBe("durable");
    expect(action?.mutationContract, name).toMatchObject({
      operationData: { normalized: true, nonsecret: true },
      mutationPlan: { exact: true },
      reconciliation: { stepBound: true, requiresCompleteEvidence: true },
    });
  });
});
