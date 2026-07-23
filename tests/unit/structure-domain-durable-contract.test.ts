import { describe, expect, it } from "vitest";
import type { ActionDefinition } from "../../src/harness/action.js";
import { CLIENT_ACTIONS } from "../../src/harness/workflows/clients.js";
import { ENTRY_ACTIONS } from "../../src/harness/workflows/entries.js";
import { PROJECT_ACTIONS } from "../../src/harness/workflows/projects.js";
import { PROJECT_API_ACTIONS } from "../../src/harness/api-actions/projects.js";
import { TASK_API_ACTIONS } from "../../src/harness/api-actions/tasks.js";
import { CLIENT_API_ACTIONS } from "../../src/harness/api-actions/clients.js";
import { TAG_ACTIONS } from "../../src/harness/workflows/tags.js";
import { TASK_ACTIONS } from "../../src/harness/workflows/tasks.js";
import { TIME_TRACKING_ACTIONS } from "../../src/harness/workflows/time-tracking.js";

const EXPECTED_WRITES = [
  "clockify_start_timer",
  "clockify_stop_timer",
  "clockify_log_work",
  "clockify_fix_entry",
  "clockify_entries_delete",
  "clockify_entries_mark_invoiced",
  "clockify_projects_create",
  "clockify_projects_from_template",
  "clockify_projects_update",
  "clockify_projects_archive",
  "clockify_projects_delete",
  "clockify_projects_delete_archived",
  "clockify_projects_rate_update",
  "clockify_projects_member_hourly_rate_update",
  "clockify_projects_member_cost_rate_update",
  "clockify_projects_estimate_update",
  "clockify_projects_memberships_update",
  "clockify_projects_memberships_replace",
  "clockify_tasks_create",
  "clockify_tasks_update",
  "clockify_tasks_delete",
  "clockify_tasks_rate_update",
  "clockify_tasks_delete_completed",
  "clockify_tasks_status_update",
  "clockify_tasks_assignees_replace",
  "clockify_tasks_hourly_rate_update",
  "clockify_tasks_cost_rate_update",
  "clockify_clients_create",
  "clockify_clients_create_base",
  "clockify_clients_update",
  "clockify_clients_archive",
  "clockify_clients_delete",
  "clockify_clients_delete_archived",
  "clockify_tags_create",
  "clockify_tags_update",
  "clockify_tags_delete",
] as const;

const actions = [
  ...TIME_TRACKING_ACTIONS,
  ...ENTRY_ACTIONS,
  ...PROJECT_ACTIONS,
  ...PROJECT_API_ACTIONS,
  ...TASK_ACTIONS,
  ...TASK_API_ACTIONS,
  ...CLIENT_ACTIONS,
  ...CLIENT_API_ACTIONS,
  ...TAG_ACTIONS,
];

function action(name: string): ActionDefinition {
  const found = actions.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing action ${name}`);
  return found;
}

describe("Phase 5 structure and time-domain durable contracts", () => {
  it.each(EXPECTED_WRITES)("declares a complete durable contract for %s", (name) => {
    const candidate = action(name);
    expect(candidate.mutationWorkflow).toBe("durable");
    expect(candidate.mutationContract).toBeDefined();
    expect(candidate.mutationContract?.targeting.mode).not.toBe("deferred");
    expect(candidate.mutationContract?.reconciliation.requiresCompleteEvidence).toBe(true);
    expect(candidate.mutationContract?.reconciliation.stepBound).toBe(true);
  });
});
