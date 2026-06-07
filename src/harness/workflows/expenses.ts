import { z } from "zod";
import { defineAction, type ActionDefinition } from "../action.js";
import { successReceipt } from "../receipts.js";

/**
 * Typed expense workflows (goclmcp §2.7). Reads (list/get/categories_list)
 * execute immediately; create/update/delete + category writes are risky and run
 * preview→commit. Risk classes (plan D3): create/update/categories_create/
 * categories_update = `billing`; delete/categories_delete add `destructive`. All
 * gated by the `expenses` feature group. `amount` uses `amountUnit` (default
 * `major`) and is stored ALREADY CONVERTED to minor units in the payload; the
 * expense REST module sends MAJOR units on the wire (this surface's format).
 * `userId` (the expense owner) is injected from the admin at commit — never the
 * model — and create/update are `multipart/form-data`.
 */

const EXP = "expenses" as const;

/** Resolve a major/minor amount to integer minor units (cents). */
function toMinor(amount: number, unit: "major" | "minor"): number {
  return unit === "minor" ? Math.round(amount) : Math.round(amount * 100);
}

/** Fields stored in the create payload (userId is added from the admin at commit). */
interface StoredExpense {
  amountMinor: number;
  date: string;
  categoryId: string;
  notes?: string;
  billable?: boolean;
  projectId?: string;
  taskId?: string;
}

const listExpenses = defineAction({
  name: "clockify_expenses_list",
  description: "List expenses (optional start/end date range).",
  featureGroup: EXP,
  risks: ["read"],
  schema: z.object({ start: z.string().optional(), end: z.string().optional() }),
  async handler(ctx, args) {
    const items = await ctx.clockify.listExpenses(args);
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_expenses_list",
        entity: "expense",
        ids: { workspaceId: ctx.workspaceId },
        data: { count: items.length, items },
      }),
    };
  },
});

const getExpense = defineAction({
  name: "clockify_expenses_get",
  description: "Fetch a single expense by id.",
  featureGroup: EXP,
  risks: ["read"],
  schema: z.object({ id: z.string().min(1) }),
  async handler(ctx, args) {
    const entity = await ctx.clockify.getExpense(args.id);
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_expenses_get",
        entity: "expense",
        ids: { workspaceId: ctx.workspaceId },
        data: { entity },
      }),
    };
  },
});

const listExpenseCategories = defineAction({
  name: "clockify_expenses_categories_list",
  description: "List expense categories.",
  featureGroup: EXP,
  risks: ["read"],
  schema: z.object({}),
  async handler(ctx) {
    const items = await ctx.clockify.listExpenseCategories();
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_expenses_categories_list",
        entity: "expense_category",
        ids: { workspaceId: ctx.workspaceId },
        data: { count: items.length, items },
      }),
    };
  },
});

const createExpense = defineAction({
  name: "clockify_expenses_create",
  description: "Create an expense. Billing action — previews and requires confirmation.",
  featureGroup: EXP,
  risks: ["billing"],
  schema: z.object({
    amount: z.number().positive(),
    /** `major` (e.g. 125.00) is converted ×100 to the minor units stored in the payload. */
    amountUnit: z.enum(["major", "minor"]).default("major"),
    date: z.string().min(1), // full ISO or YYYY-MM-DD
    categoryId: z.string().min(1),
    notes: z.string().optional(),
    billable: z.boolean().optional(),
    projectId: z.string().optional(),
    taskId: z.string().optional(),
  }),
  async handler(ctx, args) {
    const input: StoredExpense = {
      amountMinor: toMinor(args.amount, args.amountUnit),
      date: args.date,
      categoryId: args.categoryId,
      ...(args.notes !== undefined ? { notes: args.notes } : {}),
      ...(args.billable !== undefined ? { billable: args.billable } : {}),
      ...(args.projectId !== undefined ? { projectId: args.projectId } : {}),
      ...(args.taskId !== undefined ? { taskId: args.taskId } : {}),
    };
    return {
      kind: "preview",
      preview: {
        actionLabel: "Create expense",
        featureGroup: EXP,
        riskLabels: ["billing"],
        targets: [],
        expectedChanges: [
          `Create an expense of ${input.amountMinor} (minor units) in category ${args.categoryId}${args.notes ? ` — "${args.notes}"` : ""}`,
        ],
        reversibility: "You can edit or delete the expense afterward.",
        warnings: ["This creates an expense record."],
      },
      operation: {
        actionName: "clockify_expenses_create",
        featureGroup: EXP,
        risks: ["billing"],
        payload: { input },
      },
    };
  },
  async commit(ctx, operation) {
    const { input } = operation.payload as { input: StoredExpense };
    // The expense owner is the admin making the change — never model-supplied.
    const expense = await ctx.clockify.createExpense({ ...input, userId: ctx.adminUserId });
    return successReceipt({
      action: "clockify_expenses_create",
      entity: "expense",
      ids: { workspaceId: ctx.workspaceId },
      changed: { created: [{ type: "expense", id: expense.id, name: expense.name }] },
    });
  },
});

/** Map a provided update field to its Clockify `changeFields` token. */
const UPDATE_FIELD_TOKEN: Record<string, string> = {
  amount: "AMOUNT",
  date: "DATE",
  categoryId: "CATEGORY",
  notes: "NOTES",
  billable: "BILLABLE",
  projectId: "PROJECT",
  taskId: "TASK",
};

const updateExpense = defineAction({
  name: "clockify_expenses_update",
  description: "Update an expense. Billing action — previews and requires confirmation.",
  featureGroup: EXP,
  risks: ["billing"],
  schema: z
    .object({
      id: z.string().min(1),
      amount: z.number().positive().optional(),
      amountUnit: z.enum(["major", "minor"]).default("major"),
      date: z.string().optional(),
      categoryId: z.string().optional(),
      notes: z.string().optional(),
      billable: z.boolean().optional(),
      projectId: z.string().optional(),
      taskId: z.string().optional(),
    })
    .refine(
      (v) =>
        v.amount !== undefined ||
        v.date !== undefined ||
        v.categoryId !== undefined ||
        v.notes !== undefined ||
        v.billable !== undefined ||
        v.projectId !== undefined ||
        v.taskId !== undefined,
      { message: "Provide at least one field to change." },
    ),
  async handler(ctx, args) {
    const values: Record<string, unknown> = {
      ...(args.amount !== undefined ? { amountMinor: toMinor(args.amount, args.amountUnit) } : {}),
      ...(args.date !== undefined ? { date: args.date } : {}),
      ...(args.categoryId !== undefined ? { categoryId: args.categoryId } : {}),
      ...(args.notes !== undefined ? { notes: args.notes } : {}),
      ...(args.billable !== undefined ? { billable: args.billable } : {}),
      ...(args.projectId !== undefined ? { projectId: args.projectId } : {}),
      ...(args.taskId !== undefined ? { taskId: args.taskId } : {}),
    };
    const changeFields = (
      ["amount", "date", "categoryId", "notes", "billable", "projectId", "taskId"] as const
    )
      .filter((k) => args[k] !== undefined)
      .map((k) => UPDATE_FIELD_TOKEN[k]);
    return {
      kind: "preview",
      preview: {
        actionLabel: "Update expense",
        featureGroup: EXP,
        riskLabels: ["billing"],
        targets: [{ type: "expense", id: args.id }],
        expectedChanges: changeFields.map((t) => `set ${t}`),
        reversibility: "You can update the expense again to revert most fields.",
        warnings: ["Updating an expense changes an expense record."],
      },
      operation: {
        actionName: "clockify_expenses_update",
        featureGroup: EXP,
        risks: ["billing"],
        payload: { id: args.id, changeFields, values },
      },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as {
      id: string;
      changeFields: string[];
      values: Record<string, unknown>;
    };
    const updated = await ctx.clockify.updateExpense(payload.id, {
      changeFields: payload.changeFields,
      ...payload.values,
      userId: ctx.adminUserId, // fallback owner if the existing expense lacks one
    });
    return successReceipt({
      action: "clockify_expenses_update",
      entity: "expense",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "expense", id: updated.id, name: updated.name }] },
    });
  },
});

const deleteExpense = defineAction({
  name: "clockify_expenses_delete",
  description: "Delete an expense. Destructive billing action — previews and requires confirmation.",
  featureGroup: EXP,
  risks: ["destructive", "billing"],
  schema: z.object({ id: z.string().min(1), notes: z.string().optional() }),
  async handler(ctx, args) {
    return {
      kind: "preview",
      preview: {
        actionLabel: "Delete expense",
        featureGroup: EXP,
        riskLabels: ["destructive", "billing"],
        targets: [{ type: "expense", id: args.id, name: args.notes }],
        expectedChanges: [`Delete expense ${args.notes ?? args.id}`],
        reversibility: "This cannot be undone.",
        warnings: ["Deleting an expense is permanent."],
      },
      operation: {
        actionName: "clockify_expenses_delete",
        featureGroup: EXP,
        risks: ["destructive", "billing"],
        payload: { id: args.id, notes: args.notes },
      },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { id: string; notes?: string };
    await ctx.clockify.deleteExpense(payload.id);
    return successReceipt({
      action: "clockify_expenses_delete",
      entity: "expense",
      ids: { workspaceId: ctx.workspaceId },
      changed: { deleted: [{ type: "expense", id: payload.id, name: payload.notes }] },
    });
  },
});

const createExpenseCategory = defineAction({
  name: "clockify_expenses_categories_create",
  description: "Create an expense category. Billing action — previews and requires confirmation.",
  featureGroup: EXP,
  risks: ["billing"],
  schema: z.object({ name: z.string().min(1) }),
  async handler(ctx, args) {
    return {
      kind: "preview",
      preview: {
        actionLabel: "Create expense category",
        featureGroup: EXP,
        riskLabels: ["billing"],
        targets: [],
        expectedChanges: [`Create expense category "${args.name}"`],
        reversibility: "You can rename or delete the category afterward.",
        warnings: ["This adds an expense category to the workspace."],
      },
      operation: {
        actionName: "clockify_expenses_categories_create",
        featureGroup: EXP,
        risks: ["billing"],
        payload: { name: args.name },
      },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { name: string };
    const category = await ctx.clockify.createExpenseCategory({ name: payload.name });
    return successReceipt({
      action: "clockify_expenses_categories_create",
      entity: "expense_category",
      ids: { workspaceId: ctx.workspaceId },
      changed: { created: [{ type: "expense_category", id: category.id, name: category.name }] },
    });
  },
});

const updateExpenseCategory = defineAction({
  name: "clockify_expenses_categories_update",
  description: "Rename an expense category. Billing action — previews and requires confirmation.",
  featureGroup: EXP,
  risks: ["billing"],
  schema: z.object({ id: z.string().min(1), name: z.string().min(1) }),
  async handler(ctx, args) {
    return {
      kind: "preview",
      preview: {
        actionLabel: "Update expense category",
        featureGroup: EXP,
        riskLabels: ["billing"],
        targets: [{ type: "expense_category", id: args.id, name: args.name }],
        expectedChanges: [`Rename expense category to "${args.name}"`],
        reversibility: "You can rename the category again to revert.",
        warnings: ["This changes a workspace expense category."],
      },
      operation: {
        actionName: "clockify_expenses_categories_update",
        featureGroup: EXP,
        risks: ["billing"],
        payload: { id: args.id, name: args.name },
      },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { id: string; name: string };
    const category = await ctx.clockify.updateExpenseCategory(payload.id, { name: payload.name });
    return successReceipt({
      action: "clockify_expenses_categories_update",
      entity: "expense_category",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "expense_category", id: category.id, name: category.name }] },
    });
  },
});

const deleteExpenseCategory = defineAction({
  name: "clockify_expenses_categories_delete",
  description:
    "Delete an expense category. Destructive billing action — previews and requires confirmation.",
  featureGroup: EXP,
  risks: ["destructive", "billing"],
  schema: z.object({ id: z.string().min(1), name: z.string().optional() }),
  async handler(ctx, args) {
    return {
      kind: "preview",
      preview: {
        actionLabel: "Delete expense category",
        featureGroup: EXP,
        riskLabels: ["destructive", "billing"],
        targets: [{ type: "expense_category", id: args.id, name: args.name }],
        expectedChanges: [`Delete expense category ${args.name ?? args.id}`],
        reversibility: "This cannot be undone.",
        warnings: ["Deleting an expense category is permanent."],
      },
      operation: {
        actionName: "clockify_expenses_categories_delete",
        featureGroup: EXP,
        risks: ["destructive", "billing"],
        payload: { id: args.id, name: args.name },
      },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { id: string; name?: string };
    await ctx.clockify.deleteExpenseCategory(payload.id);
    return successReceipt({
      action: "clockify_expenses_categories_delete",
      entity: "expense_category",
      ids: { workspaceId: ctx.workspaceId },
      changed: { deleted: [{ type: "expense_category", id: payload.id, name: payload.name }] },
    });
  },
});

export const EXPENSE_ACTIONS: ActionDefinition[] = [
  listExpenses,
  getExpense,
  listExpenseCategories,
  createExpense,
  updateExpense,
  deleteExpense,
  createExpenseCategory,
  updateExpenseCategory,
  deleteExpenseCategory,
];
