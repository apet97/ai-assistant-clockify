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
      "clockify_manage_time_off",
      "clockify_manage_schedule",
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

  it("catalogForModel exposes only name/description/featureGroup/risks (no schema or handler)", () => {
    const entries = catalogForModel();
    expect(entries.length).toBe(ACTION_CATALOG.length);
    for (const entry of entries) {
      expect(entry).not.toHaveProperty("schema");
      expect(entry).not.toHaveProperty("handler");
      expect(entry.name).toBeTruthy();
      expect(entry.risks.length).toBeGreaterThan(0);
    }
  });
});
