import { describe, expect, it } from "vitest";
import { ACTION_CATALOG, catalogForModel, getAction } from "../../src/harness/catalog.js";
import { requiresConfirmation } from "../../src/harness/risk.js";

describe("catalog", () => {
  it("every action has name, description, feature group, risk labels, schema, and handler", () => {
    expect(ACTION_CATALOG.length).toBeGreaterThan(0);
    for (const action of ACTION_CATALOG) {
      expect(action.name).toBeTruthy();
      expect(action.description).toBeTruthy();
      expect(action.featureGroup).toBeTruthy();
      expect(Array.isArray(action.risks)).toBe(true);
      expect(action.risks.length).toBeGreaterThan(0);
      expect(action.schema).toBeDefined();
      expect(typeof action.handler).toBe("function");
    }
  });

  it("includes the required initial safe actions", () => {
    const names = ACTION_CATALOG.map((a) => a.name);
    for (const required of [
      "clockify_status",
      "clockify_start_timer",
      "clockify_stop_timer",
      "clockify_create_work_package",
      "clockify_log_work",
    ]) {
      expect(names).toContain(required);
    }
  });

  it("includes the expanded Phase 3 actions", () => {
    const names = ACTION_CATALOG.map((a) => a.name);
    for (const required of [
      "clockify_review_day",
      "clockify_review_week",
      "clockify_fix_entry",
      "clockify_list_entities",
      "clockify_get_entity",
      "clockify_update_entity",
      "assistant_show_permissions",
    ]) {
      expect(names).toContain(required);
    }
  });

  it("includes the typed time-entry actions (Phase 1)", () => {
    const names = ACTION_CATALOG.map((a) => a.name);
    for (const required of [
      "clockify_entries_list",
      "clockify_entries_get",
      "clockify_entries_delete",
      "clockify_entries_mark_invoiced",
    ]) {
      expect(names).toContain(required);
    }
  });

  it("includes the typed tag actions (Phase 5)", () => {
    const names = ACTION_CATALOG.map((a) => a.name);
    for (const required of [
      "clockify_tags_list",
      "clockify_tags_get",
      "clockify_tags_create",
      "clockify_tags_update",
      "clockify_tags_delete",
    ]) {
      expect(names).toContain(required);
    }
  });

  it("includes the typed workspace + template actions (Phase 16)", () => {
    const names = ACTION_CATALOG.map((a) => a.name);
    for (const required of ["clockify_workspace_get", "clockify_templates_list", "clockify_templates_get"]) {
      expect(names).toContain(required);
    }
  });

  it("includes the typed audit actions (Phase 15)", () => {
    const names = ACTION_CATALOG.map((a) => a.name);
    for (const required of ["clockify_audit_logs_search", "clockify_entity_changes_list"]) {
      expect(names).toContain(required);
    }
  });

  it("includes the typed report actions (Phase 14)", () => {
    const names = ACTION_CATALOG.map((a) => a.name);
    for (const required of ["clockify_reports_summary", "clockify_reports_detailed", "clockify_reports_weekly"]) {
      expect(names).toContain(required);
    }
  });

  it("includes the typed user + group actions (Phase 13)", () => {
    const names = ACTION_CATALOG.map((a) => a.name);
    for (const required of [
      "clockify_users_list",
      "clockify_users_invite",
      "clockify_users_role_update",
      "clockify_users_deactivate",
      "clockify_groups_list",
      "clockify_groups_get",
      "clockify_groups_create",
      "clockify_groups_update",
      "clockify_groups_delete",
      "clockify_groups_add_user",
      "clockify_groups_remove_user",
    ]) {
      expect(names).toContain(required);
    }
  });

  it("includes the typed webhook actions (Phase 12)", () => {
    const names = ACTION_CATALOG.map((a) => a.name);
    for (const required of [
      "clockify_webhooks_list",
      "clockify_webhooks_get",
      "clockify_webhooks_events",
      "clockify_webhooks_logs",
      "clockify_webhooks_create",
      "clockify_webhooks_update",
      "clockify_webhooks_delete",
    ]) {
      expect(names).toContain(required);
    }
    expect(names).not.toContain("clockify_manage_webhook");
  });

  it("includes the typed approval actions (Phase 11)", () => {
    const names = ACTION_CATALOG.map((a) => a.name);
    for (const required of [
      "clockify_approvals_list",
      "clockify_approvals_get",
      "clockify_approvals_submit",
      "clockify_approvals_approve",
      "clockify_approvals_reject",
      "clockify_approvals_withdraw",
      "clockify_approvals_resubmit",
    ]) {
      expect(names).toContain(required);
    }
  });

  it("includes the typed scheduling actions (Phase 10)", () => {
    const names = ACTION_CATALOG.map((a) => a.name);
    for (const required of [
      "clockify_scheduling_assignments_list",
      "clockify_scheduling_assignments_get",
      "clockify_scheduling_assignments_create",
      "clockify_scheduling_assignments_update",
      "clockify_scheduling_assignments_delete",
      "clockify_scheduling_publish",
      "clockify_scheduling_project_totals",
      "clockify_scheduling_user_totals",
    ]) {
      expect(names).toContain(required);
    }
    expect(names).not.toContain("clockify_manage_schedule");
  });

  it("includes the typed time-off + holiday actions (Phase 9)", () => {
    const names = ACTION_CATALOG.map((a) => a.name);
    for (const required of [
      "clockify_time_off_policies_list",
      "clockify_time_off_policies_get",
      "clockify_time_off_policies_create",
      "clockify_time_off_policies_update",
      "clockify_time_off_policies_archive",
      "clockify_time_off_requests_list",
      "clockify_time_off_requests_get",
      "clockify_time_off_requests_create",
      "clockify_time_off_requests_delete",
      "clockify_time_off_approve",
      "clockify_time_off_deny",
      "clockify_time_off_balance_get",
      "clockify_time_off_balance_update",
      "clockify_holidays_list",
      "clockify_holidays_get",
      "clockify_holidays_in_period",
      "clockify_holidays_create",
      "clockify_holidays_update",
      "clockify_holidays_delete",
    ]) {
      expect(names).toContain(required);
    }
    // the generic manage_time_off was superseded by the typed approve/deny
    expect(names).not.toContain("clockify_manage_time_off");
  });

  it("includes the typed custom-field actions (Phase 8)", () => {
    const names = ACTION_CATALOG.map((a) => a.name);
    for (const required of [
      "clockify_custom_fields_list",
      "clockify_custom_fields_get",
      "clockify_custom_fields_create",
      "clockify_custom_fields_update",
      "clockify_custom_fields_delete",
      "clockify_custom_fields_set_value_project",
      "clockify_custom_fields_set_value_entry",
    ]) {
      expect(names).toContain(required);
    }
  });

  it("includes the typed expense actions (Phase 7)", () => {
    const names = ACTION_CATALOG.map((a) => a.name);
    for (const required of [
      "clockify_expenses_list",
      "clockify_expenses_get",
      "clockify_expenses_create",
      "clockify_expenses_update",
      "clockify_expenses_delete",
      "clockify_expenses_categories_list",
      "clockify_expenses_categories_create",
      "clockify_expenses_categories_update",
      "clockify_expenses_categories_delete",
    ]) {
      expect(names).toContain(required);
    }
    // the generic manage_expense was superseded by the typed expense actions
    expect(names).not.toContain("clockify_manage_expense");
  });

  it("includes the typed invoice actions (Phase 6)", () => {
    const names = ACTION_CATALOG.map((a) => a.name);
    for (const required of [
      "clockify_invoices_list",
      "clockify_invoices_get",
      "clockify_invoices_create",
      "clockify_invoices_update",
      "clockify_invoices_delete",
      "clockify_invoices_items_list",
      "clockify_invoices_items_add",
      "clockify_invoices_items_delete",
      "clockify_invoices_payments_list",
      "clockify_invoices_payments_create",
      "clockify_invoices_payments_delete",
      "clockify_invoices_import_time",
      "clockify_invoices_export",
    ]) {
      expect(names).toContain(required);
    }
    // the generic prepare_invoice was superseded by clockify_invoices_create
    expect(names).not.toContain("clockify_prepare_invoice");
  });

  it("includes the typed client actions (Phase 4)", () => {
    const names = ACTION_CATALOG.map((a) => a.name);
    for (const required of [
      "clockify_clients_list",
      "clockify_clients_get",
      "clockify_clients_create",
      "clockify_clients_update",
      "clockify_clients_delete",
    ]) {
      expect(names).toContain(required);
    }
  });

  it("includes the typed task actions (Phase 3)", () => {
    const names = ACTION_CATALOG.map((a) => a.name);
    for (const required of [
      "clockify_tasks_list",
      "clockify_tasks_get",
      "clockify_tasks_create",
      "clockify_tasks_update",
      "clockify_tasks_delete",
      "clockify_tasks_rate_update",
    ]) {
      expect(names).toContain(required);
    }
  });

  it("includes the typed project actions (Phase 2)", () => {
    const names = ACTION_CATALOG.map((a) => a.name);
    for (const required of [
      "clockify_projects_list",
      "clockify_projects_get",
      "clockify_projects_create",
      "clockify_projects_from_template",
      "clockify_projects_update",
      "clockify_projects_archive",
      "clockify_projects_delete",
      "clockify_projects_rate_update",
      "clockify_projects_estimate_update",
      "clockify_projects_memberships_update",
    ]) {
      expect(names).toContain(required);
    }
  });

  it("every confirmation-required action provides a commit() (so it cannot mutate without one)", () => {
    for (const action of ACTION_CATALOG) {
      if (requiresConfirmation(action.risks)) {
        expect(typeof action.commit).toBe("function");
      }
    }
  });

  it("getAction returns the definition or undefined", () => {
    expect(getAction("clockify_status")?.name).toBe("clockify_status");
    expect(getAction("does_not_exist")).toBeUndefined();
  });

  it("catalogForModel exposes name/description/featureGroup/risks/args (no schema or handler)", () => {
    const entries = catalogForModel();
    expect(entries.length).toBe(ACTION_CATALOG.length);
    for (const entry of entries) {
      expect(entry).not.toHaveProperty("schema");
      expect(entry).not.toHaveProperty("handler");
      expect(entry.name).toBeTruthy();
      expect(entry.risks.length).toBeGreaterThan(0);
      // Phase 1B: a terse, non-empty argument signature derived from the schema.
      expect(typeof entry.args).toBe("string");
      expect(entry.args.length).toBeGreaterThan(0);
    }
  });
});
