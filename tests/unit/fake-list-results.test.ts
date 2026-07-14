import { describe, expect, it } from "vitest";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";
import type { FakeListFamily } from "../helpers/fake/state.js";

type ListCall = (client: ReturnType<typeof createFakeWorkspace>["client"]) => Promise<unknown>;

const FAMILIES: Array<[FakeListFamily, ListCall]> = [
  ["listApprovals", (c) => c.listApprovals()],
  ["searchAuditLog", (c) => c.searchAuditLog({ actions: ["CREATE_PROJECT"], start: "s", end: "e" })],
  ["listEntityChanges", (c) => c.listEntityChanges("created")],
  ["listClients", (c) => c.listClients()],
  ["listCurrencies", (c) => c.listCurrencies()],
  ["listCustomFields", (c) => c.listCustomFields()],
  ["listExpenses", (c) => c.listExpenses()],
  ["listExpenseCategories", (c) => c.listExpenseCategories()],
  ["listHolidays", (c) => c.listHolidays()],
  ["listHolidaysInPeriod", (c) => c.listHolidaysInPeriod({ assignedTo: "u1", start: "s", end: "e" })],
  ["listInvoices", (c) => c.listInvoices()],
  ["listInvoiceItems", (c) => c.listInvoiceItems("inv1")],
  ["listInvoicePayments", (c) => c.listInvoicePayments("inv1")],
  ["listProjects", (c) => c.listProjects()],
  ["getProjectMemberships", (c) => c.getProjectMemberships("p1")],
  ["listAssignments", (c) => c.listAssignments()],
  ["getProjectScheduleTotals", (c) => c.getProjectScheduleTotals({ start: "s", end: "e" })],
  ["listTags", (c) => c.listTags()],
  ["listTasks", (c) => c.listTasks("p1")],
  ["getEntries", (c) => c.getEntries({ userId: "u1" })],
  ["listTimeOffPolicies", (c) => c.listTimeOffPolicies()],
  ["listTimeOffRequests", (c) => c.listTimeOffRequests()],
  ["getTimeOffBalance", (c) => c.getTimeOffBalance("u1")],
  ["listUsers", (c) => c.listUsers()],
  ["listGroups", (c) => c.listGroups()],
  ["listWebhooks", (c) => c.listWebhooks()],
  ["listWebhookEvents", (c) => c.listWebhookEvents()],
  ["listWebhookLogs", (c) => c.listWebhookLogs("w1")],
  ["listTemplates", (c) => c.listTemplates()],
];

describe("fake complete-list fidelity", () => {
  it.each(FAMILIES)("%s exposes its own truncation control", async (family, call) => {
    const fake = createFakeWorkspace({
      listTruncated: { [family]: true },
    });
    await expect(call(fake.client)).resolves.toMatchObject({
      rows: expect.any(Array),
      truncated: true,
    });
  });
});
