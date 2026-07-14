import type { ActionDefinition } from "./action.js";

export interface ExternalMutationCompatibilityException {
  actionName: string;
  migrateIn: "phase-4-invoice-workflows" | "phase-5-remaining-write-classes";
}

const PHASE_4_ACTIONS = [
  "clockify_invoices_create",
  "clockify_invoices_update",
  "clockify_invoices_delete",
  "clockify_invoices_items_add",
  "clockify_invoices_items_delete",
  "clockify_invoices_payments_create",
  "clockify_invoices_payments_delete",
  "clockify_invoices_import_time",
] as const;

const PHASE_5_ACTIONS = [
  "clockify_start_timer",
  "clockify_stop_timer",
  "clockify_log_work",
  "clockify_fix_entry",
  "clockify_entries_delete",
  "clockify_entries_mark_invoiced",
  "clockify_create_work_package",
  "clockify_projects_create",
  "clockify_projects_from_template",
  "clockify_projects_update",
  "clockify_projects_archive",
  "clockify_projects_delete",
  "clockify_projects_rate_update",
  "clockify_projects_estimate_update",
  "clockify_projects_memberships_update",
  "clockify_tasks_create",
  "clockify_tasks_update",
  "clockify_tasks_delete",
  "clockify_tasks_rate_update",
  "clockify_clients_create",
  "clockify_clients_update",
  "clockify_clients_delete",
  "clockify_tags_update",
  "clockify_tags_delete",
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
  "clockify_users_deactivate",
  "clockify_groups_create",
  "clockify_groups_update",
  "clockify_groups_delete",
  "clockify_groups_add_user",
  "clockify_groups_remove_user",
  "clockify_delete_entity",
  "clockify_update_entity",
  "clockify_onboard_user",
  "clockify_setup_project",
  "clockify_setup_task",
] as const;

/** Temporary, reviewable bridge while phases 4-5 migrate every named action. */
export const EXTERNAL_MUTATION_COMPATIBILITY_EXCEPTIONS: readonly ExternalMutationCompatibilityException[] = [
  ...PHASE_4_ACTIONS.map((actionName) => ({ actionName, migrateIn: "phase-4-invoice-workflows" as const })),
  ...PHASE_5_ACTIONS.map((actionName) => ({ actionName, migrateIn: "phase-5-remaining-write-classes" as const })),
];

function isExternalWrite(action: ActionDefinition): boolean {
  return action.name.startsWith("clockify_") && action.risks.some((risk) => risk !== "read");
}

function hasDurableMutationPath(action: ActionDefinition): boolean {
  return action.mutationWorkflow === "durable" ||
    (typeof action.prepareSafeWrite === "function" && typeof action.executeSafeWrite === "function");
}

export function mutationCatalogCoverage(
  actions: ReadonlyArray<ActionDefinition>,
  exceptions = EXTERNAL_MUTATION_COMPATIBILITY_EXCEPTIONS,
): { uncovered: string[]; invalidExceptions: string[] } {
  const byName = new Map(actions.map((action) => [action.name, action]));
  const exceptionNames = new Set<string>();
  const invalidExceptions: string[] = [];
  for (const exception of exceptions) {
    const action = byName.get(exception.actionName);
    if (exceptionNames.has(exception.actionName)) invalidExceptions.push(`duplicate:${exception.actionName}`);
    else if (!action) invalidExceptions.push(`missing:${exception.actionName}`);
    else if (!isExternalWrite(action)) invalidExceptions.push(`not_external:${exception.actionName}`);
    else if (hasDurableMutationPath(action)) invalidExceptions.push(`already_migrated:${exception.actionName}`);
    exceptionNames.add(exception.actionName);
  }
  return {
    uncovered: actions
      .filter((action) => isExternalWrite(action) && !hasDurableMutationPath(action) && !exceptionNames.has(action.name))
      .map((action) => action.name)
      .sort(),
    invalidExceptions: invalidExceptions.sort(),
  };
}
