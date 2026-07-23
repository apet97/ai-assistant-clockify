import type { FakeWorkspaceSeed } from "./fake-clockify.js";
import type { FakeListFamily } from "./fake/state.js";

/** Shared isolated fake seed ids reused across read-parity fixtures. */
export const READ_PARITY_BASE_SEED: FakeWorkspaceSeed = {
  projects: [
    { id: "p1", name: "Website", archived: false },
    { id: "tpl-1", name: "Onboarding template", archived: false },
  ],
  tasks: [{ id: "t1", name: "Design", projectId: "p1", status: "ACTIVE" }],
  clients: [{ id: "c1", name: "Acme" }],
  tags: [{ id: "tag1", name: "Billable" }],
  users: [{ id: "admin-1", name: "Admin", email: "admin@example.com" }],
  groups: [{ id: "g1", name: "Team" }],
  entries: [
    {
      id: "e1",
      description: "Focus",
      start: "2026-06-05T09:00:00.000Z",
      end: "2026-06-05T10:00:00.000Z",
      userId: "admin-1",
    },
  ],
  invoices: [
    {
      id: "inv1",
      number: "INV-1",
      clientId: "c1",
      currency: "GBP",
      status: "UNSENT",
      items: [{ order: 0, description: "Discovery", quantity: 1, unitPrice: 10000, itemType: "TIME" }],
    },
  ],
  expenses: [{ id: "exp1", description: "Travel", total: 5000, userId: "admin-1", date: "2026-06-05T12:00:00.000Z" }],
  expenseCategories: [{ id: "ec1", name: "Travel" }],
  customFields: [{ id: "cf1", name: "Priority", type: "TEXT" }],
  timeOffPolicies: [{ id: "pol1", name: "Vacation", timeUnit: "DAYS" }],
  timeOffRequests: [],
  holidays: [{ id: "h1", name: "Team day", startDate: "2026-12-25", endDate: "2026-12-25" }],
  schedulingAssignments: [{ id: "a1", userId: "admin-1", projectId: "p1", start: "2026-06-01", end: "2026-06-30" }],
  approvals: [],
  webhooks: [{ id: "wh1", name: "Notify", url: "https://example.com/h", webhookEvent: "TIME_ENTRY_CREATED" }],
};

export interface ReadParityFixture {
  args: Record<string, unknown>;
  seed?: FakeWorkspaceSeed;
  listFamily?: FakeListFamily;
  truncationArgs?: Record<string, unknown>;
  unicodeSeed?: FakeWorkspaceSeed;
  unicodeAssertion?: (data: unknown) => boolean;
  addonUnavailable?: boolean;
  authClass?: "addon" | "api_key";
}

export const READ_PARITY_FIXTURES: Record<string, ReadParityFixture> = {
  clockify_projects_list: { args: {}, listFamily: "listProjects" },
  clockify_projects_get: { args: { id: "p1" } },
  clockify_tasks_list: { args: { projectId: "p1" }, listFamily: "listTasks" },
  clockify_tasks_get: { args: { projectId: "p1", id: "t1" } },
  clockify_clients_list: { args: {}, listFamily: "listClients" },
  clockify_clients_get: { args: { id: "c1" } },
  clockify_tags_list: { args: {}, listFamily: "listTags" },
  clockify_tags_get: { args: { id: "tag1" } },
  clockify_templates_list: { args: {}, listFamily: "listTemplates" },
  clockify_templates_get: { args: { name: "Onboarding template" } },
  clockify_entries_list: {
    args: { start: "today", end: "today" },
    listFamily: "getEntries",
    truncationArgs: { start: "today", end: "today" },
  },
  clockify_entries_get: { args: { id: "e1" } },
  clockify_reports_summary: { args: { dateRangeStart: "today", dateRangeEnd: "today", groups: ["PROJECT"] } },
  clockify_reports_detailed: { args: { dateRangeStart: "today", dateRangeEnd: "today" } },
  clockify_reports_weekly: { args: { dateRangeStart: "this_week", dateRangeEnd: "this_week" } },
  clockify_entity_changes_created: { args: {}, listFamily: "listEntityChanges" },
  clockify_entity_changes_updated: { args: {}, listFamily: "listEntityChanges" },
  clockify_entity_changes_deleted: { args: {}, listFamily: "listEntityChanges" },
  clockify_workspace_get: { args: {} },
  clockify_webhooks_list: { args: {}, listFamily: "listWebhooks", addonUnavailable: true, authClass: "api_key" },
  clockify_webhooks_get: { args: { id: "wh1" }, addonUnavailable: true, authClass: "api_key" },
  clockify_webhooks_logs: { args: { id: "wh1" }, addonUnavailable: true, authClass: "api_key" },
  clockify_invoices_list: { args: {}, listFamily: "listInvoices" },
  clockify_invoices_get: { args: { id: "inv1" } },
  clockify_invoices_payments_list: { args: { id: "inv1" }, listFamily: "listInvoicePayments" },
  clockify_invoices_export: { args: { id: "inv1" } },
  clockify_expenses_list: { args: {}, listFamily: "listExpenses" },
  clockify_expenses_get: { args: { id: "exp1" } },
  clockify_expenses_categories_list: { args: {}, listFamily: "listExpenseCategories" },
  clockify_custom_fields_list: { args: {}, listFamily: "listCustomFields" },
  clockify_users_list: { args: {}, listFamily: "listUsers" },
  clockify_groups_list: { args: {}, listFamily: "listGroups" },
  clockify_time_off_policies_list: { args: {}, listFamily: "listTimeOffPolicies" },
  clockify_time_off_policies_get: { args: { id: "pol1" } },
  clockify_time_off_requests_list: { args: {}, listFamily: "listTimeOffRequests" },
  clockify_time_off_balance_get: { args: { userId: "me" } },
  clockify_holidays_list: { args: {}, listFamily: "listHolidays" },
  clockify_holidays_in_period: {
    args: { start: "2026-01-01", end: "2026-12-31" },
    listFamily: "listHolidaysInPeriod",
    truncationArgs: { start: "2026-01-01", end: "2026-12-31", assignedTo: "me" },
  },
  clockify_scheduling_assignments_list: { args: {}, listFamily: "listAssignments" },
  clockify_scheduling_user_totals: { args: { start: "2026-06-01", end: "2026-06-30" } },
  clockify_scheduling_project_totals_all: { args: { start: "2026-06-01", end: "2026-06-30" } },
  clockify_scheduling_project_totals_one: { args: { projectId: "p1", start: "2026-06-01", end: "2026-06-30" } },
  clockify_approvals_list: { args: {}, listFamily: "listApprovals" },
};

/** Unicode preservation seed merged into list/get reads that surface entity names. */
export function unicodeSeedForAction(actionName: string): FakeWorkspaceSeed | undefined {
  switch (actionName) {
    case "clockify_projects_list":
    case "clockify_projects_get":
      return { projects: [{ id: "p-unicode", name: "Café résumé 日本", archived: false }] };
    case "clockify_clients_list":
    case "clockify_clients_get":
      return { clients: [{ id: "c-unicode", name: "Société générale" }] };
    case "clockify_tags_list":
    case "clockify_tags_get":
      return { tags: [{ id: "tag-unicode", name: "Über-billable" }] };
    default:
      return undefined;
  }
}

export function unicodeArgsForAction(actionName: string): Record<string, unknown> | undefined {
  switch (actionName) {
    case "clockify_projects_get":
      return { id: "p-unicode" };
    case "clockify_clients_get":
      return { id: "c-unicode" };
    case "clockify_tags_get":
      return { id: "tag-unicode" };
    default:
      return undefined;
  }
}

export function expectedUnicodeSubstring(actionName: string): string | undefined {
  switch (actionName) {
    case "clockify_projects_list":
    case "clockify_projects_get":
      return "Café résumé 日本";
    case "clockify_clients_list":
    case "clockify_clients_get":
      return "Société générale";
    case "clockify_tags_list":
    case "clockify_tags_get":
      return "Über-billable";
    default:
      return undefined;
  }
}
