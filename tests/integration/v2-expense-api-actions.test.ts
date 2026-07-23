import { describe, expect, it } from "vitest";
import { commitConfirmedOperation, executeAction } from "../../src/harness/actions.js";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import { getAction } from "../../src/harness/catalog.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import type { ActionContext } from "../../src/harness/action.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";

const NOW = new Date("2026-06-06T00:00:00.000Z");

const EXPENSE_RECORD_API_ACTIONS = [
  "clockify_expenses_list",
  "clockify_expenses_get",
  "clockify_expenses_create",
  "clockify_expenses_update",
  "clockify_expenses_delete",
  "clockify_expenses_categories_list",
  "clockify_expenses_categories_create",
] as const;

const NEW_CATEGORY_API_ACTIONS = [
  "clockify_expenses_categories_rename",
  "clockify_expenses_categories_status_update",
  "clockify_expenses_categories_delete_archived",
] as const;

const INTERNAL_ONLY_EXPENSE_ACTIONS = [
  "clockify_expenses_categories_update",
  "clockify_expenses_categories_delete",
] as const;

function makeContext(fake: FakeWorkspace): ActionContext {
  return {
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    policy: defaultAdminPolicy(),
    clockify: fake.client,
    now: () => NOW,
  };
}

describe("v2 expense API actions", () => {
  it("exposes atomic expense record reads/writes on MODEL_API", () => {
    const modelNames = new Set(MODEL_API_ACTION_CATALOG.actions.map((action) => action.name));
    for (const name of EXPENSE_RECORD_API_ACTIONS) {
      expect(modelNames.has(name), name).toBe(true);
      expect(getAction(name)?.apiExposure).toBe("api");
    }
  });

  it("exposes split category mutations on MODEL_API and hides v1 composites", () => {
    const modelNames = new Set(MODEL_API_ACTION_CATALOG.actions.map((action) => action.name));
    for (const name of NEW_CATEGORY_API_ACTIONS) {
      expect(modelNames.has(name), name).toBe(true);
      expect(getAction(name)?.apiExposure).toBe("api");
    }
    for (const name of INTERNAL_ONLY_EXPENSE_ACTIONS) {
      expect(modelNames.has(name), name).toBe(false);
      expect(getAction(name)?.apiExposure).not.toBe("api");
    }
  });

  it("delete_archived refuses an active expense category", async () => {
    const fake = createFakeWorkspace({
      expenseCategories: [{ id: "c1", name: "Travel", archived: false }],
    });
    const result = await executeAction({
      actionName: "clockify_expenses_categories_delete_archived",
      args: { id: "c1" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    if (result.kind === "clarify") {
      expect(result.message).toContain("still active");
    }
    expect(fake.counts.deleteExpenseCategoryAtomic ?? 0).toBe(0);
  });

  it("delete_archived commits with a single DELETE for an archived category", async () => {
    const fake = createFakeWorkspace({
      expenseCategories: [{ id: "c1", name: "Travel", archived: true }],
    });
    const preview = await executeAction({
      actionName: "clockify_expenses_categories_delete_archived",
      args: { id: "c1" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected preview");
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.deleteExpenseCategoryAtomic).toBe(1);
    expect(fake.counts.setExpenseCategoryArchivedAtomic ?? 0).toBe(0);
  });

  it("status_update archives with one PATCH and rename uses one PUT", async () => {
    const fake = createFakeWorkspace({
      expenseCategories: [{ id: "c1", name: "Travel", archived: false }],
    });
    const statusPreview = await executeAction({
      actionName: "clockify_expenses_categories_status_update",
      args: { id: "c1", archived: true },
      context: makeContext(fake),
    });
    if (statusPreview.kind !== "preview") throw new Error("expected status preview");
    await commitConfirmedOperation(makeContext(fake), statusPreview.operation);
    expect(fake.counts.setExpenseCategoryArchivedAtomic).toBe(1);

    const renamePreview = await executeAction({
      actionName: "clockify_expenses_categories_rename",
      args: { id: "c1", name: "Trips" },
      context: makeContext(fake),
    });
    if (renamePreview.kind !== "preview") throw new Error("expected rename preview");
    await commitConfirmedOperation(makeContext(fake), renamePreview.operation);
    expect(fake.counts.updateExpenseCategoryAtomic).toBe(1);
  });
});
