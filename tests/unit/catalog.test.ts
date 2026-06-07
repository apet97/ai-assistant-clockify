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
      "clockify_manage_expense",
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
