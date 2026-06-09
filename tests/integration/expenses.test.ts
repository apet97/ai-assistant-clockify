import { describe, expect, it } from "vitest";
import { commitConfirmedOperation, executeAction } from "../../src/harness/actions.js";
import { type AdminPolicy, defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import type { ActionContext } from "../../src/harness/action.js";

const NOW = new Date("2026-06-06T00:00:00.000Z");
function makeContext(fake: FakeWorkspace, policy: AdminPolicy = defaultAdminPolicy()): ActionContext {
  return { workspaceId: "ws-1", adminUserId: "admin-1", policy, clockify: fake.client, now: () => NOW };
}
const seed = () => ({
  expenses: [{ id: "x1", name: "Taxi", notes: "Taxi", date: "2026-06-06T00:00:00Z", categoryId: "c1" }],
  expenseCategories: [{ id: "c1", name: "Travel" }],
});

describe("expense actions", () => {
  it("clockify_expenses_list lists expenses and is read-gated", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({ actionName: "clockify_expenses_list", args: {}, context: makeContext(fake) });
    if (result.kind === "receipt" && result.receipt.ok) expect((result.receipt.data as any).count).toBe(1);
    else throw new Error("expected receipt");

    const off = defaultAdminPolicy();
    off.groups.expenses = "off";
    const denied = await executeAction({ actionName: "clockify_expenses_list", args: {}, context: makeContext(fake, off) });
    if (denied.kind === "receipt" && !denied.receipt.ok) expect(denied.receipt.code).toBe("policy_denied");
    else throw new Error("expected policy_denied");
  });

  it("clockify_expenses_get fetches one expense", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({ actionName: "clockify_expenses_get", args: { id: "x1" }, context: makeContext(fake) });
    if (result.kind === "receipt" && result.receipt.ok) expect((result.receipt.data as any).entity).toMatchObject({ id: "x1", notes: "Taxi" });
    else throw new Error("expected receipt");
  });

  it("clockify_expenses_categories_list lists categories (read)", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({ actionName: "clockify_expenses_categories_list", args: {}, context: makeContext(fake) });
    if (result.kind === "receipt" && result.receipt.ok) expect((result.receipt.data as any).count).toBe(1);
    else throw new Error("expected receipt");
  });

  it("clockify_expenses_create previews billing, stores minor units + admin owner, commits once", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({
      actionName: "clockify_expenses_create",
      args: { amount: 125, date: "2026-06-06", categoryId: "c1", notes: "AIASSIST_SMOKE_exp" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("billing");
    // major 125.00 -> 12500 minor, stored already-converted in the payload
    expect(preview.operation.payload).toMatchObject({ input: { amountMinor: 12500, categoryId: "c1" } });
    expect(fake.counts.createExpense ?? 0).toBe(0);
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.createExpense).toBe(1);
    expect(fake.state.expenses.find((e) => e.notes === "AIASSIST_SMOKE_exp")).toBeDefined();
  });

  it("clockify_expenses_create resolves a RELATIVE date server-side (live: the model sent the literal string 'today' to the wire → Clockify 400)", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({
      actionName: "clockify_expenses_create",
      args: { amount: 12, date: "today", categoryId: "c1", notes: "12 miles" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    // ctx.now is 2026-06-06 — the harness does the calendar math, never the model
    expect((preview.operation.payload as any).input.date).toBe("2026-06-06");
  });

  it("clockify_expenses_create defaults an omitted date to today", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({
      actionName: "clockify_expenses_create",
      args: { amount: 12, categoryId: "c1" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect((preview.operation.payload as any).input.date).toBe("2026-06-06");
  });

  it("clockify_expenses_update resolves a relative date the same way", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({
      actionName: "clockify_expenses_update",
      args: { id: "x1", date: "yesterday" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    const payload = preview.operation.payload as any;
    expect(payload.changeFields).toEqual(expect.arrayContaining(["DATE"]));
    expect(payload.values.date).toBe("2026-06-05");
  });

  it("clockify_expenses_update derives changeFields from the provided fields", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({
      actionName: "clockify_expenses_update",
      args: { id: "x1", notes: "Taxi to airport", amount: 50 },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("billing");
    const payload = preview.operation.payload as any;
    expect(payload.changeFields).toEqual(expect.arrayContaining(["NOTES", "AMOUNT"]));
    expect(payload.values).toMatchObject({ amountMinor: 5000, notes: "Taxi to airport" });
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.updateExpense).toBe(1);
    expect(fake.state.expenses[0].notes).toBe("Taxi to airport");
  });

  it("clockify_expenses_delete previews destructive+billing then deletes once", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({ actionName: "clockify_expenses_delete", args: { id: "x1", notes: "Taxi" }, context: makeContext(fake) });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toEqual(expect.arrayContaining(["destructive", "billing"]));
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.deleteExpense).toBe(1);
    expect(fake.state.expenses.find((e) => e.id === "x1")).toBeUndefined();
  });

  it("clockify_expenses_categories_create previews billing then creates once", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({ actionName: "clockify_expenses_categories_create", args: { name: "AIASSIST_SMOKE_cat" }, context: makeContext(fake) });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("billing");
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.createExpenseCategory).toBe(1);
    expect(fake.state.expenseCategories.find((c) => c.name === "AIASSIST_SMOKE_cat")).toBeDefined();
  });

  it("clockify_expenses_categories_update previews then renames", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({ actionName: "clockify_expenses_categories_update", args: { id: "c1", name: "Travel & Lodging" }, context: makeContext(fake) });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("billing");
    await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(fake.counts.updateExpenseCategory).toBe(1);
    expect(fake.state.expenseCategories[0].name).toBe("Travel & Lodging");
  });

  it("clockify_expenses_categories_delete previews destructive+billing then deletes", async () => {
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({ actionName: "clockify_expenses_categories_delete", args: { id: "c1", name: "Travel" }, context: makeContext(fake) });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toEqual(expect.arrayContaining(["destructive", "billing"]));
    await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(fake.counts.deleteExpenseCategory).toBe(1);
    expect(fake.state.expenseCategories.find((c) => c.id === "c1")).toBeUndefined();
  });
});
