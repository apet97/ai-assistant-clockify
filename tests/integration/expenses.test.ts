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

  it("clockify_expenses_list resolves relative start/end server-side (no raw date word on the wire)", async () => {
    // NOW is 2026-06-06. A planner emits date WORDS; they must resolve like
    // entries_list, not reach Clockify raw (which silently returns empty).
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({
      actionName: "clockify_expenses_list",
      args: { start: "yesterday", end: "today" },
      context: makeContext(fake),
    });
    if (result.kind !== "receipt" || !result.receipt.ok) throw new Error(`expected a success receipt, got ${result.kind}`);
    const window = (result.receipt.data as any).window;
    expect(window.start).toBe("2026-06-05T00:00:00.000Z");
    expect(window.end).toBe("2026-06-06T23:59:59.999Z");
  });

  it("clockify_expenses_list clarifies on an unparseable date instead of sending it raw", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({
      actionName: "clockify_expenses_list",
      args: { start: "whenever it suits" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
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

  it("clockify_expenses_create logs for another user by name (defaults to the admin, clarifies on unknown)", async () => {
    const fake = createFakeWorkspace({
      expenseCategories: [{ id: "c1", name: "Travel" }],
      users: [
        { id: "u-mike", name: "Mike Admin" },
        { id: "admin-1", name: "Me" },
      ],
    });
    // For another user by exact name → the resolved owner, not the admin.
    const forMike = await executeAction({
      actionName: "clockify_expenses_create",
      args: { amount: 50, categoryName: "Travel", userName: "Mike Admin" },
      context: makeContext(fake),
    });
    if (forMike.kind !== "preview") throw new Error("expected a preview");
    expect((forMike.operation.payload as any).input.userId).toBe("u-mike");
    expect(forMike.preview.expectedChanges.join(" ")).toContain("Mike Admin");

    // No owner given → defaults to the admin.
    const forMe = await executeAction({
      actionName: "clockify_expenses_create",
      args: { amount: 50, categoryName: "Travel" },
      context: makeContext(fake),
    });
    if (forMe.kind !== "preview") throw new Error("expected a preview");
    expect((forMe.operation.payload as any).input.userId).toBe("admin-1");

    // Unknown user → clarify at preview, never confirm-then-fail.
    const ghost = await executeAction({
      actionName: "clockify_expenses_create",
      args: { amount: 50, categoryName: "Travel", userName: "Ghost" },
      context: makeContext(fake),
    });
    expect(ghost.kind).toBe("clarify");
  });

  it("clockify_expenses_create previews the amount in major units, never raw minor with a '(minor units)' debug label", async () => {
    // The admin asked for $75; the preview must read "75.00", never the wire
    // value 7500 nor the internal "(minor units)" annotation (truthfulness).
    const fake = createFakeWorkspace(seed());
    const preview = await executeAction({
      actionName: "clockify_expenses_create",
      args: { amount: 75, categoryId: "c1" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    const change = preview.preview.expectedChanges.join(" ");
    expect(change).toContain("75.00");
    expect(change).not.toContain("(minor units)");
    expect(change).not.toContain("7500");
  });

  it("clockify_expenses_create resolves the category by NAME (categoryName, or a name in the categoryId slot) — live-loop FIX 1", async () => {
    const fake = createFakeWorkspace(seed());
    const byName = await executeAction({
      actionName: "clockify_expenses_create",
      args: { amount: 10, categoryName: "travel" },
      context: makeContext(fake),
    });
    if (byName.kind !== "preview") throw new Error("expected a preview");
    expect((byName.operation.payload as any).input.categoryId).toBe("c1");

    const inIdSlot = await executeAction({
      actionName: "clockify_expenses_create",
      args: { amount: 10, categoryId: "Travel" },
      context: makeContext(fake),
    });
    if (inIdSlot.kind !== "preview") throw new Error("expected a preview");
    expect((inIdSlot.operation.payload as any).input.categoryId).toBe("c1");
  });

  it("clockify_expenses_create clarifies with the real category list on an unknown category (item 171: NO_SUCH_CAT was previewed)", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({
      actionName: "clockify_expenses_create",
      args: { amount: 10, categoryId: "NO_SUCH_CAT" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    if (result.kind === "clarify") expect(result.options?.map((o) => o.id)).toContain("c1");
    expect(fake.counts.createExpense ?? 0).toBe(0);
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

  it("clockify_expenses_create resolves weekday words and clarifies on garbage dates", async () => {
    // NOW is 2026-06-06, a Saturday → "next monday" = 2026-06-08.
    const fake = createFakeWorkspace(seed());
    const weekday = await executeAction({
      actionName: "clockify_expenses_create",
      args: { amount: 5, date: "next monday", categoryId: "c1" },
      context: makeContext(fake),
    });
    if (weekday.kind !== "preview") throw new Error("expected a preview");
    expect((weekday.operation.payload as any).input.date).toBe("2026-06-08");

    const garbage = await executeAction({
      actionName: "clockify_expenses_create",
      args: { amount: 5, date: "someday", categoryId: "c1" },
      context: makeContext(fake),
    });
    expect(garbage.kind).toBe("clarify");
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

  it("clockify_expenses_create resolves project/task NAMES (either slot) to verified ids in the payload", async () => {
    const fake = createFakeWorkspace({
      expenseCategories: [{ id: "c1", name: "Travel" }],
      projects: [{ id: "p-apollo", name: "Apollo" }],
      tasks: [{ id: "t-design", name: "Design", projectId: "p-apollo" }],
    });
    const preview = await executeAction({
      actionName: "clockify_expenses_create",
      args: { amount: 50, categoryName: "Travel", projectName: "Apollo", taskName: "Design" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect((preview.operation.payload as any).input).toMatchObject({ projectId: "p-apollo", taskId: "t-design" });
    // Truthful preview: the card names the project, not an opaque id.
    expect(preview.preview.expectedChanges.join(" ")).toContain('project "Apollo"');

    // The planner habit: a NAME in the projectId SLOT resolves too.
    const slot = await executeAction({
      actionName: "clockify_expenses_create",
      args: { amount: 50, categoryName: "Travel", projectId: "Apollo" },
      context: makeContext(fake),
    });
    if (slot.kind !== "preview") throw new Error("expected a preview");
    expect((slot.operation.payload as any).input.projectId).toBe("p-apollo");
  });

  it("clockify_expenses_create clarifies on an unknown project — never previews a doomed commit", async () => {
    const fake = createFakeWorkspace({
      expenseCategories: [{ id: "c1", name: "Travel" }],
      projects: [{ id: "p-apollo", name: "Apollo" }],
    });
    const result = await executeAction({
      actionName: "clockify_expenses_create",
      args: { amount: 50, categoryName: "Travel", projectName: "Apolo" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    if (result.kind === "clarify") expect(result.options?.map((o) => o.id)).toContain("p-apollo");
    expect(fake.counts.createExpense ?? 0).toBe(0);
  });

  it("clockify_expenses_update resolves project/task names; preview shows the NAME, payload carries the id", async () => {
    const fake = createFakeWorkspace({
      ...seed(),
      projects: [{ id: "p-apollo", name: "Apollo" }],
      tasks: [{ id: "t-design", name: "Design", projectId: "p-apollo" }],
    });
    const preview = await executeAction({
      actionName: "clockify_expenses_update",
      args: { id: "x1", projectName: "Apollo", taskName: "Design" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    const payload = preview.operation.payload as any;
    expect(payload.changeFields).toEqual(expect.arrayContaining(["PROJECT", "TASK"]));
    expect(payload.values).toMatchObject({ projectId: "p-apollo", taskId: "t-design" });
    // The preview line shows the resolved NAME (the value the admin can verify).
    expect(preview.preview.expectedChanges.join(" ")).toContain("Apollo");
    expect(preview.preview.expectedChanges.join(" ")).not.toContain("p-apollo");
  });

  it("clockify_expenses_update clarifies on a task name with no project to scope it", async () => {
    const fake = createFakeWorkspace(seed());
    const result = await executeAction({
      actionName: "clockify_expenses_update",
      args: { id: "x1", taskName: "Design" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    expect(fake.counts.updateExpense ?? 0).toBe(0);
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

  it("categories_update ARCHIVES a category by currentName — 'archive category X' used to preview a RENAME (live item 176)", async () => {
    const fake = createFakeWorkspace({ expenseCategories: [{ id: "c1", name: "Travel" }] });
    const preview = await executeAction({
      actionName: "clockify_expenses_categories_update",
      args: { currentName: "Travel", archived: true },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error(`expected a preview, got ${preview.kind}`);
    expect(preview.preview.expectedChanges.join(" ")).toMatch(/archive/i);
    expect(preview.preview.expectedChanges.join(" ")).not.toMatch(/rename/i);
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.state.expenseCategories[0].archived).toBe(true);
    expect(fake.counts.setExpenseCategoryArchived).toBe(1);
  });

  it("categories_update UNARCHIVES an archived category by name (the archived target must resolve)", async () => {
    const fake = createFakeWorkspace({ expenseCategories: [{ id: "c1", name: "Travel", archived: true }] });
    const preview = await executeAction({
      actionName: "clockify_expenses_categories_update",
      args: { currentName: "Travel", archived: false },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error(`expected a preview, got ${preview.kind}`);
    await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(fake.state.expenseCategories[0].archived).toBe(false);
  });

  it("categories_delete resolves a NAME in the id slot — incl. an ARCHIVED category (live regression: 'delete category RGCAT' sent the NAME to the wire → 400)", async () => {
    const fake = createFakeWorkspace({
      expenseCategories: [{ id: "c9", name: "AIASSIST_LOOP_RGCAT", archived: true }],
    });
    const preview = await executeAction({
      actionName: "clockify_expenses_categories_delete",
      args: { id: "AIASSIST_LOOP_RGCAT" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error(`expected a preview, got ${preview.kind}`);
    expect((preview.operation.payload as { id: string }).id).toBe("c9");
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.state.expenseCategories.find((c) => c.id === "c9")).toBeUndefined();
  });

  it("categories_delete clarifies on an unknown name instead of a doomed commit", async () => {
    const fake = createFakeWorkspace({ expenseCategories: [{ id: "c1", name: "Travel" }] });
    const result = await executeAction({
      actionName: "clockify_expenses_categories_delete",
      args: { name: "NO_SUCH_CATEGORY" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    expect(fake.counts.deleteExpenseCategory ?? 0).toBe(0);
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
