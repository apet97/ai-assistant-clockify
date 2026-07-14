import { z } from "zod";
import { zNumberLike } from "../arg-shapes.js";
import { defineAction, defineReadAction, defineRiskyAction, type ActionContext, type ActionDefinition } from "../action.js";
import { nowDate } from "../../durations.js";
import { successReceipt } from "../receipts.js";
import { fromMinor, toMinor } from "../money.js";
import { describePatch, resolveDateRange, resolveEntityRef, resolveProjectTaskRefs, resolveRelativeDay } from "./resolve.js";

/** The harness owns calendar math — the model sends "today"/"yesterday", never a guessed date.
 *  `undefined` = unparseable; the caller must clarify (never send it to the wire). */
function resolveDate(ctx: ActionContext, date?: string): string | undefined {
  return resolveRelativeDay(nowDate(ctx), { date }, ctx.timeZone);
}

const DATE_CLARIFY = (raw: string) =>
  `I couldn't make sense of the date "${raw}" — give me a calendar date (YYYY-MM-DD) or something like today, yesterday, or next Monday.`;

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

/** Fields stored in the create payload (`userId` = the resolved expense owner). */
interface StoredExpense {
  amountMinor: number;
  date: string;
  categoryId: string;
  userId: string;
  notes?: string;
  billable?: boolean;
  projectId?: string;
  taskId?: string;
}

const listExpenses = defineAction({
  name: "clockify_expenses_list",
  description:
    "List expenses. `start`/`end` accept YYYY-MM-DD, a full ISO instant, or a relative day/period (today, yesterday, last month — resolved server-side; never guess a calendar date).",
  featureGroup: EXP,
  risks: ["read"],
  schema: z.object({ start: z.string().optional(), end: z.string().optional() }),
  async handler(ctx, args) {
    // The wire wants yyyy-MM-ddThh:mm:ssZ instants — a raw date word silently
    // returns an empty list (not a 400). Resolve here (from→start-of-day,
    // to→end-of-day), clarify on garbage. Mirrors clockify_entries_list. The
    // shared resolver owns the per-edge resolveInstant + bad-date clarify; both
    // edges are optional with no default, so an omitted edge stays undefined.
    const dates = resolveDateRange(nowDate(ctx), {
      start: { raw: args.start },
      end: { raw: args.end },
      exampleHint: "today, yesterday, or last month",
      timeZone: ctx.timeZone,
    });
    if (!dates.ok) return { kind: "clarify", message: dates.message };
    const { start, end } = dates;
    const items = await ctx.clockify.listExpenses({ start, end });
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_expenses_list",
        entity: "expense",
        ids: { workspaceId: ctx.workspaceId },
        data: {
          count: items.length,
          items,
          ...(start !== undefined || end !== undefined ? { window: { start, end } } : {}),
        },
      }),
    };
  },
});

const getExpense = defineReadAction({
  name: "clockify_expenses_get",
  description: "Fetch a single expense by id.",
  group: EXP,
  schema: z.object({ id: z.string().min(1) }),
  async handler(ctx, args) {
    const entity = await ctx.clockify.getExpense(args.id);
    return successReceipt({
      action: "clockify_expenses_get",
      entity: "expense",
      ids: { workspaceId: ctx.workspaceId },
      data: { entity },
    });
  },
});

const listExpenseCategories = defineReadAction({
  name: "clockify_expenses_categories_list",
  description: "List expense categories.",
  group: EXP,
  schema: z.object({}),
  async handler(ctx) {
    const items = await ctx.clockify.listExpenseCategories();
    return successReceipt({
      action: "clockify_expenses_categories_list",
      entity: "expense_category",
      ids: { workspaceId: ctx.workspaceId },
      data: { count: items.length, items },
    });
  },
});

const createExpense = defineRiskyAction({
  name: "clockify_expenses_create",
  description:
    "Create an expense. `date` accepts YYYY-MM-DD or a relative 'today'/'yesterday' (resolved server-side; defaults to today — never guess a calendar date). Pass `categoryId`, or the exact `categoryName` and the harness resolves it. Link a project/task by id or exact name (`projectId`/`projectName`, `taskId`/`taskName`) — also resolved server-side. Defaults to YOUR expense; to log it for another user pass their `userId` or exact `userName` (or 'me' for yourself). Billing action — previews and requires confirmation.",
  group: EXP,
  risks: ["billing"],
  schema: z
    .object({
      amount: zNumberLike(z.number().positive()),
      /** `major` (e.g. 125.00) is converted ×100 to the minor units stored in the payload. */
      amountUnit: z.enum(["major", "minor"]).default("major"),
      /** YYYY-MM-DD, full ISO, or relative today/yesterday/tomorrow; defaults to today. */
      date: z.string().min(1).optional(),
      categoryId: z.string().min(1).optional(),
      /** The category's exact name, resolved to an id server-side. */
      categoryName: z.string().min(1).optional(),
      /** The expense owner — defaults to the admin; a user id or 'me'. */
      userId: z.string().min(1).optional(),
      /** The owner's exact name, resolved to an id server-side. */
      userName: z.string().min(1).optional(),
      notes: z.string().optional(),
      billable: z.boolean().optional(),
      projectId: z.string().optional(),
      /** The linked project's exact name, resolved to an id server-side. */
      projectName: z.string().optional(),
      taskId: z.string().optional(),
      /** The linked task's exact name (needs the project), resolved server-side. */
      taskName: z.string().optional(),
    })
    .refine((v) => v.categoryId !== undefined || v.categoryName !== undefined, {
      message: "Provide the expense category id or its exact categoryName.",
    }),
  async preview(ctx, args) {
    // Resolve the category by name (or a name in the categoryId slot) — a bogus
    // category must clarify with the REAL list, never preview a doomed commit.
    const category = await resolveEntityRef(
      { id: args.categoryId, name: args.categoryName },
      { noun: "expense category", verb: "use", list: () => ctx.clockify.listExpenseCategories() },
    );
    if (!category.ok) return category.clarify;
    // Resolve the OWNER: default to the admin; allow another user by id/exact name
    // ("me" = the admin). Clockify needs a real userId — a bad one must clarify at
    // PREVIEW, never confirm-then-fail.
    let ownerId = ctx.adminUserId;
    let ownerLabel = "you";
    if (args.userId || args.userName) {
      if ((args.userId ?? args.userName ?? "").trim().toLowerCase() === "me") {
        ownerId = ctx.adminUserId;
      } else {
        const owner = await resolveEntityRef(
          { id: args.userId, name: args.userName },
          { noun: "user", verb: "create the expense for", list: () => ctx.clockify.listUsers() },
        );
        if (!owner.ok) return owner.clarify;
        ownerId = owner.id;
        ownerLabel = owner.name ?? owner.id;
      }
    }
    // A linked project/task resolves by name in either slot — a bogus ref
    // clarifies at preview, never a confirmed-then-failed commit.
    const refs = await resolveProjectTaskRefs(args, {
      verb: "attach the expense to",
      listProjects: (f) => ctx.clockify.listProjects(f),
      listTasks: (projectId) => ctx.clockify.listTasks(projectId),
    });
    if (!refs.ok) return refs.clarify;
    // Live: the model sent the literal string "today" to the wire (400) —
    // the harness resolves relative dates and defaults to today.
    const date = resolveDate(ctx, args.date);
    if (date === undefined) return { clarify: DATE_CLARIFY(args.date as string) };
    const input: StoredExpense = {
      amountMinor: toMinor(args.amount, args.amountUnit),
      date,
      categoryId: category.id,
      userId: ownerId,
      ...(args.notes !== undefined ? { notes: args.notes } : {}),
      ...(args.billable !== undefined ? { billable: args.billable } : {}),
      ...(refs.projectId !== undefined ? { projectId: refs.projectId } : {}),
      ...(refs.taskId !== undefined ? { taskId: refs.taskId } : {}),
    };
    const onProject = refs.projectId
      ? ` on project "${refs.projectName ?? refs.projectId}"${refs.taskId ? ` (task "${refs.taskName ?? refs.taskId}")` : ""}`
      : "";
    return {
      actionLabel: "Create expense",
      targets: [],
      expectedChanges: [
        `Create an expense of ${fromMinor(input.amountMinor)} for ${ownerLabel} in category ${category.name ?? category.id}${onProject}${args.notes ? ` — "${args.notes}"` : ""}`,
      ],
      reversibility: "You can edit or delete the expense afterward.",
      warnings: ["This creates an expense record."],
      payload: { input },
    };
  },
  async commit(ctx, payload) {
    const { input } = payload as { input: StoredExpense };
    // The owner was resolved at preview (defaults to the admin); the model never
    // sets it directly on the wire.
    const expense = await ctx.clockify.createExpense(input);
    return successReceipt({
      action: "clockify_expenses_create",
      entity: "expense",
      ids: { workspaceId: ctx.workspaceId },
      changed: { created: [{ type: "expense", id: expense.id, name: expense.name }] },
    });
  },
});

const updateExpense = defineRiskyAction({
  name: "clockify_expenses_update",
  description:
    "Update an expense. Category/project/task accept an id or the exact name (`categoryName`/`projectName`/`taskName`) — resolved server-side. Billing action — previews and requires confirmation.",
  group: EXP,
  risks: ["billing"],
  schema: z
    .object({
      id: z.string().min(1),
      amount: zNumberLike(z.number().positive()).optional(),
      amountUnit: z.enum(["major", "minor"]).default("major"),
      date: z.string().optional(),
      categoryId: z.string().optional(),
      /** The category's exact name, resolved to an id server-side. */
      categoryName: z.string().optional(),
      notes: z.string().optional(),
      billable: z.boolean().optional(),
      projectId: z.string().optional(),
      /** The linked project's exact name, resolved server-side. */
      projectName: z.string().optional(),
      taskId: z.string().optional(),
      /** The linked task's exact name (needs the project), resolved server-side. */
      taskName: z.string().optional(),
    })
    .refine(
      (v) =>
        v.amount !== undefined ||
        v.date !== undefined ||
        v.categoryId !== undefined ||
        v.categoryName !== undefined ||
        v.notes !== undefined ||
        v.billable !== undefined ||
        v.projectId !== undefined ||
        v.projectName !== undefined ||
        v.taskId !== undefined ||
        v.taskName !== undefined,
      { message: "Provide at least one field to change." },
    ),
  async preview(ctx, args) {
    const date = args.date !== undefined ? resolveDate(ctx, args.date) : undefined;
    if (args.date !== undefined && date === undefined) return { clarify: DATE_CLARIFY(args.date) };
    // Resolve symbolic refs (a name in either slot) to verified ids — an
    // identity mistake clarifies at preview, never a confirmed-then-failed PUT.
    let category: { id: string; name?: string } | undefined;
    if (args.categoryId !== undefined || args.categoryName !== undefined) {
      const resolved = await resolveEntityRef(
        { id: args.categoryId, name: args.categoryName },
        { noun: "expense category", verb: "use", list: () => ctx.clockify.listExpenseCategories() },
      );
      if (!resolved.ok) return resolved.clarify;
      category = resolved;
    }
    const refs = await resolveProjectTaskRefs(args, {
      verb: "move the expense to",
      listProjects: (f) => ctx.clockify.listProjects(f),
      listTasks: (projectId) => ctx.clockify.listTasks(projectId),
    });
    if (!refs.ok) return refs.clarify;
    const values: Record<string, unknown> = {
      ...(args.amount !== undefined ? { amountMinor: toMinor(args.amount, args.amountUnit) } : {}),
      ...(date !== undefined ? { date } : {}),
      ...(category !== undefined ? { categoryId: category.id } : {}),
      ...(args.notes !== undefined ? { notes: args.notes } : {}),
      ...(args.billable !== undefined ? { billable: args.billable } : {}),
      ...(refs.projectId !== undefined ? { projectId: refs.projectId } : {}),
      ...(refs.taskId !== undefined ? { taskId: refs.taskId } : {}),
    };
    // Preview VALUES are the user-facing ones (major amount, resolved NAMES) so
    // a model-garbled value is catchable at preview time; the payload `values`
    // carry the wire ids the commit writes.
    const display: Array<[token: string, value: unknown]> = [];
    if (args.amount !== undefined) display.push(["AMOUNT", args.amount]);
    if (date !== undefined) display.push(["DATE", date]);
    if (category !== undefined) display.push(["CATEGORY", category.name ?? category.id]);
    if (args.notes !== undefined) display.push(["NOTES", args.notes]);
    if (args.billable !== undefined) display.push(["BILLABLE", args.billable]);
    if (refs.projectId !== undefined) display.push(["PROJECT", refs.projectName ?? refs.projectId]);
    if (refs.taskId !== undefined) display.push(["TASK", refs.taskName ?? refs.taskId]);
    const changeFields = display.map(([token]) => token);
    const changeValues: Record<string, unknown> = Object.fromEntries(display);
    return {
      actionLabel: "Update expense",
      targets: [{ type: "expense", id: args.id }],
      expectedChanges: describePatch(changeValues),
      reversibility: "You can update the expense again to revert most fields.",
      warnings: ["Updating an expense changes an expense record."],
      payload: { id: args.id, changeFields, values },
    };
  },
  async commit(ctx, payload) {
    const { id, changeFields, values } = payload as {
      id: string;
      changeFields: string[];
      values: Record<string, unknown>;
    };
    const updated = await ctx.clockify.updateExpense(id, {
      changeFields,
      ...values,
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

const deleteExpense = defineRiskyAction({
  name: "clockify_expenses_delete",
  description: "Delete an expense. Destructive billing action — previews and requires confirmation.",
  group: EXP,
  risks: ["destructive", "billing"],
  schema: z.object({ id: z.string().min(1), notes: z.string().optional() }),
  async preview(_ctx, args) {
    return {
      actionLabel: "Delete expense",
      targets: [{ type: "expense", id: args.id, name: args.notes }],
      expectedChanges: [`Delete expense ${args.notes ?? args.id}`],
      reversibility: "This cannot be undone.",
      warnings: ["Deleting an expense is permanent."],
      payload: { id: args.id, notes: args.notes },
    };
  },
  async commit(ctx, payload) {
    const { id, notes } = payload as { id: string; notes?: string };
    await ctx.clockify.deleteExpense(id);
    return successReceipt({
      action: "clockify_expenses_delete",
      entity: "expense",
      ids: { workspaceId: ctx.workspaceId },
      changed: { deleted: [{ type: "expense", id, name: notes }] },
    });
  },
});

const createExpenseCategory = defineRiskyAction({
  name: "clockify_expenses_categories_create",
  description: "Create an expense category. Billing action — previews and requires confirmation.",
  group: EXP,
  risks: ["billing"],
  schema: z.object({ name: z.string().min(1) }),
  async preview(_ctx, args) {
    return {
      actionLabel: "Create expense category",
      targets: [],
      expectedChanges: [`Create expense category "${args.name}"`],
      reversibility: "You can rename or delete the category afterward.",
      warnings: ["This adds an expense category to the workspace."],
      payload: { name: args.name },
    };
  },
  async commit(ctx, payload) {
    const { name } = payload as { name: string };
    const category = await ctx.clockify.createExpenseCategory({ name });
    return successReceipt({
      action: "clockify_expenses_categories_create",
      entity: "expense_category",
      ids: { workspaceId: ctx.workspaceId },
      changed: { created: [{ type: "expense_category", id: category.id, name: category.name }] },
    });
  },
});

const updateExpenseCategory = defineRiskyAction({
  name: "clockify_expenses_categories_update",
  description:
    "Rename and/or archive/unarchive an expense category. Pass the category `id` or its exact `currentName` (the harness resolves it); `name` sets a new name, `archived` archives (true) or restores (false). Billing action — previews and requires confirmation.",
  group: EXP,
  risks: ["billing"],
  schema: z
    .object({
      id: z.string().min(1).optional(),
      /** The category's existing name, resolved to an id server-side. */
      currentName: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
      archived: z.boolean().optional(),
    })
    .refine((v) => v.id !== undefined || v.currentName !== undefined, {
      message: "Provide the category id or its exact currentName.",
    })
    .refine((v) => v.name !== undefined || v.archived !== undefined, {
      message: "Provide a new name and/or archived.",
    }),
  async preview(ctx, args) {
    // "archive category X" used to render a RENAME preview (live item 176) —
    // there IS a real archive route (the status PATCH the delete already uses).
    const resolved = await resolveEntityRef(
      { id: args.id, name: args.currentName },
      {
        noun: "expense category",
        verb: "update",
        list: () => ctx.clockify.listExpenseCategories(),
        // Unarchiving targets an entity that is archived by definition.
        includeArchived: args.archived === false,
      },
    );
    if (!resolved.ok) return resolved.clarify;
    const changes = [
      ...(args.name !== undefined ? [`Rename expense category to "${args.name}"`] : []),
      ...(args.archived !== undefined
        ? [`${args.archived ? "Archive" : "Unarchive"} expense category ${resolved.name ?? resolved.id}`]
        : []),
    ];
    return {
      actionLabel: "Update expense category",
      targets: [{ type: "expense_category", id: resolved.id, name: resolved.name ?? args.name }],
      expectedChanges: changes,
      reversibility: "You can update the category again to revert.",
      warnings: ["This changes a workspace expense category."],
      payload: { id: resolved.id, name: args.name, archived: args.archived },
    };
  },
  async commit(ctx, payload) {
    const { id, name, archived } = payload as { id: string; name?: string; archived?: boolean };
    let summary: { id: string; name?: string } = { id };
    if (name !== undefined) summary = await ctx.clockify.updateExpenseCategory(id, { name });
    if (archived !== undefined) await ctx.clockify.setExpenseCategoryArchived(id, archived);
    return successReceipt({
      action: "clockify_expenses_categories_update",
      entity: "expense_category",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "expense_category", id: summary.id, name: summary.name ?? name }] },
    });
  },
});

const deleteExpenseCategory = defineRiskyAction({
  name: "clockify_expenses_categories_delete",
  description:
    "Delete an expense category. Pass the category id, or its exact `name` and the harness resolves it. Destructive billing action — previews and requires confirmation.",
  group: EXP,
  risks: ["destructive", "billing"],
  schema: z
    .object({ id: z.string().min(1).optional(), name: z.string().min(1).optional() })
    .refine((v) => v.id !== undefined || v.name !== undefined, {
      message: "Provide the category id or its exact name.",
    }),
  async preview(ctx, args) {
    // Resolve a name (or a name in the id slot) — live, "delete category X"
    // sent the NAME to the status PATCH and 400'd after the admin confirmed.
    // Deleting an ARCHIVED category is valid (delete archives first anyway).
    const resolved = await resolveEntityRef(args, {
      noun: "expense category",
      verb: "delete",
      list: (filter) => ctx.clockify.listExpenseCategories(filter),
      includeArchived: true,
    });
    if (!resolved.ok) return resolved.clarify;
    const name = resolved.name ?? args.name;
    return {
      actionLabel: "Delete expense category",
      targets: [{ type: "expense_category", id: resolved.id, name }],
      expectedChanges: [`Delete expense category ${name ?? resolved.id}`],
      reversibility: "This cannot be undone.",
      warnings: ["Deleting an expense category is permanent."],
      payload: { id: resolved.id, name },
    };
  },
  async commit(ctx, payload) {
    const { id, name } = payload as { id: string; name?: string };
    await ctx.clockify.deleteExpenseCategory(id);
    return successReceipt({
      action: "clockify_expenses_categories_delete",
      entity: "expense_category",
      ids: { workspaceId: ctx.workspaceId },
      changed: { deleted: [{ type: "expense_category", id, name }] },
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
