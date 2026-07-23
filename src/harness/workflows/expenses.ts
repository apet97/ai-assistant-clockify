import { z } from "zod";
import { zNumberLike } from "../arg-shapes.js";
import { defineAction, defineReadAction, defineRiskyAction, type ActionContext, type ActionDefinition, type CommitResult, type ConfirmableOperation, type SemanticLiteralAlias, type TargetSnapshot } from "../action.js";
import { nowDate } from "../../durations.js";
import { errorReceipt, listReceipt, successReceipt } from "../receipts.js";
import { fromMinor, toMinor } from "../money.js";
import { describePatch, resolveDateRange, resolveEntityRef, resolveProjectTaskRefs, resolveRelativeDay } from "./resolve.js";
import { durableMutationContract } from "../durable-mutation-contract.js";
import { commitSingleDurableRiskyStep, executeDurableRiskyStep } from "../durable-risky-write.js";
import { isJournalDegradedStep, withJournalDegradedWarning, type MutationDispatchResult } from "../mutation-workflow.js";
import { captureTargetSnapshot, verifyTargetSnapshots } from "../target-snapshots.js";
import { dispatchWithReconciliation, reconcileCreate, reconcileDelete } from "./structure-durable.js";
import {
  expenseCategoryById as categoryById,
  expenseCategoryTarget as categoryTarget,
  listAllExpenseCategories as listAllCategories,
} from "./expense-action-shared.js";
import type { ExpenseSummary, PreparedExpenseUpdateInput } from "../../clockify/ports/expenses.js";
import { DefinitiveWriteFailure } from "../../clockify/write-outcome.js";
import type {
  ApiAccess,
  ApiActionMetadataCarrier,
  ApiMethod,
  AvailabilityByAuthClass,
  MaterialFieldMetadata,
} from "../api-operation.js";

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

type ExpenseActionName =
  | "clockify_expenses_list"
  | "clockify_expenses_get"
  | "clockify_expenses_categories_list"
  | "clockify_expenses_create"
  | "clockify_expenses_update"
  | "clockify_expenses_delete"
  | "clockify_expenses_categories_create"
  | "clockify_expenses_categories_update"
  | "clockify_expenses_categories_delete";

const EXPENSE_AVAILABILITY: AvailabilityByAuthClass = Object.freeze({
  addon: Object.freeze({ available: true }),
  api_key: Object.freeze({ available: true }),
});

function expenseEndpointKey(
  access: ApiAccess,
  method: ApiMethod,
  path: string,
  sourceModule = "expenses.ts",
): string {
  return [access, "api", method, path, sourceModule].join("\0");
}

function expenseMaterialField(
  path: string,
  label: string,
  formatterId: string,
  requiredInPreview: boolean,
): MaterialFieldMetadata {
  return Object.freeze({
    kind: "value",
    path,
    label,
    formatterId,
    formatterVersion: 1,
    requiredInPreview,
  });
}

function expenseApiMetadata(input: {
  actionName: ExpenseActionName;
  operationId: string;
  method: ApiMethod;
  path: string;
  access: ApiAccess;
  primary: string;
  support: readonly string[];
  materialFields: readonly MaterialFieldMetadata[];
}): ApiActionMetadataCarrier {
  return Object.freeze({
    apiExposure: "api",
    apiOperation: Object.freeze({
      operationId: input.operationId,
      host: "api",
      method: input.method,
      path: input.path,
      access: input.access,
      exposure: "api",
    }),
    adapterEndpoints: Object.freeze({
      primary: Object.freeze([input.primary]),
      support: Object.freeze([...input.support]),
    }),
    availabilityByAuthClass: EXPENSE_AVAILABILITY,
    boundedArgumentDictionaries: Object.freeze([]),
    materialFields: Object.freeze([...input.materialFields]),
    presentation: Object.freeze({ presenterId: input.actionName, version: 1 }),
  });
}

function expenseInternalMetadata(input: {
  reason: string;
  primary: readonly string[];
  support: readonly string[];
}): ApiActionMetadataCarrier {
  return Object.freeze({
    apiExposure: "composite",
    apiExposureReason: input.reason,
    adapterEndpoints: Object.freeze({
      primary: Object.freeze([...input.primary]),
      support: Object.freeze([...input.support]),
    }),
    availabilityByAuthClass: EXPENSE_AVAILABILITY,
    boundedArgumentDictionaries: Object.freeze([]),
  });
}

const expenseEndpoint = Object.freeze({
  list: expenseEndpointKey("read", "GET", "/workspaces/{workspaceId}/expenses"),
  get: expenseEndpointKey("read", "GET", "/workspaces/{workspaceId}/expenses/{id}"),
  create: expenseEndpointKey("write", "POST", "/workspaces/{workspaceId}/expenses"),
  update: expenseEndpointKey("write", "PUT", "/workspaces/{workspaceId}/expenses/{id}"),
  delete: expenseEndpointKey("write", "DELETE", "/workspaces/{workspaceId}/expenses/{id}"),
  categoriesList: expenseEndpointKey("read", "GET", "/workspaces/{workspaceId}/expenses/categories"),
  categoriesCreate: expenseEndpointKey("write", "POST", "/workspaces/{workspaceId}/expenses/categories"),
  categoriesUpdate: expenseEndpointKey("write", "PUT", "/workspaces/{workspaceId}/expenses/categories/{id}"),
  categoriesStatus: expenseEndpointKey("write", "PATCH", "/workspaces/{workspaceId}/expenses/categories/{id}/status"),
  categoriesDelete: expenseEndpointKey("write", "DELETE", "/workspaces/{workspaceId}/expenses/categories/{id}"),
  usersList: expenseEndpointKey("read", "GET", "/workspaces/{workspaceId}/users", "users.ts"),
  projectsList: expenseEndpointKey("read", "GET", "/workspaces/{workspaceId}/projects", "projects.ts"),
  projectsGet: expenseEndpointKey("read", "GET", "/workspaces/{workspaceId}/projects/{id}", "projects.ts"),
  tasksList: expenseEndpointKey("read", "GET", "/workspaces/{workspaceId}/projects/{projectId}/tasks", "tasks.ts"),
  tasksGet: expenseEndpointKey("read", "GET", "/workspaces/{workspaceId}/projects/{projectId}/tasks/{id}", "tasks.ts"),
});

const EXPENSE_API_METADATA = Object.freeze({
  clockify_expenses_list: expenseApiMetadata({
    actionName: "clockify_expenses_list",
    operationId: "getExpenses",
    method: "GET",
    path: "/workspaces/{workspaceId}/expenses",
    access: "read",
    primary: expenseEndpoint.list,
    support: [],
    materialFields: [],
  }),
  clockify_expenses_get: expenseApiMetadata({
    actionName: "clockify_expenses_get",
    operationId: "getExpense",
    method: "GET",
    path: "/workspaces/{workspaceId}/expenses/{id}",
    access: "read",
    primary: expenseEndpoint.get,
    support: [],
    materialFields: [],
  }),
  clockify_expenses_categories_list: expenseApiMetadata({
    actionName: "clockify_expenses_categories_list",
    operationId: "getCategories",
    method: "GET",
    path: "/workspaces/{workspaceId}/expenses/categories",
    access: "read",
    primary: expenseEndpoint.categoriesList,
    support: [],
    materialFields: [],
  }),
  clockify_expenses_create: expenseApiMetadata({
    actionName: "clockify_expenses_create",
    operationId: "createExpense",
    method: "POST",
    path: "/workspaces/{workspaceId}/expenses",
    access: "write",
    primary: expenseEndpoint.create,
    support: [
      expenseEndpoint.categoriesList,
      expenseEndpoint.usersList,
      expenseEndpoint.projectsList,
      expenseEndpoint.projectsGet,
      expenseEndpoint.tasksList,
      expenseEndpoint.tasksGet,
      expenseEndpoint.list,
    ],
    materialFields: [
      expenseMaterialField("/input/amountMinor", "Amount", "money-minor", true),
      expenseMaterialField("/input/date", "Date", "text", true),
      expenseMaterialField("/input/categoryId", "Category", "entity", true),
      expenseMaterialField("/input/userId", "User", "entity", true),
      expenseMaterialField("/input/notes", "Notes", "text", false),
      expenseMaterialField("/input/billable", "Billable", "boolean", false),
      expenseMaterialField("/input/projectId", "Project", "entity", false),
      expenseMaterialField("/input/taskId", "Task", "entity", false),
    ],
  }),
  clockify_expenses_update: expenseApiMetadata({
    actionName: "clockify_expenses_update",
    operationId: "updateExpense",
    method: "PUT",
    path: "/workspaces/{workspaceId}/expenses/{id}",
    access: "write",
    primary: expenseEndpoint.update,
    support: [
      expenseEndpoint.get,
      expenseEndpoint.categoriesList,
      expenseEndpoint.usersList,
      expenseEndpoint.projectsList,
      expenseEndpoint.projectsGet,
      expenseEndpoint.tasksList,
      expenseEndpoint.tasksGet,
    ],
    materialFields: [
      expenseMaterialField("/id", "Expense", "entity", true),
      expenseMaterialField("/values/amountMinor", "Amount", "money-minor", false),
      expenseMaterialField("/values/date", "Date", "text", false),
      expenseMaterialField("/values/categoryId", "Category", "entity", false),
      expenseMaterialField("/values/notes", "Notes", "text", false),
      expenseMaterialField("/values/billable", "Billable", "boolean", false),
      expenseMaterialField("/values/projectId", "Project", "entity", false),
      expenseMaterialField("/values/taskId", "Task", "entity", false),
    ],
  }),
  clockify_expenses_delete: expenseApiMetadata({
    actionName: "clockify_expenses_delete",
    operationId: "deleteExpense",
    method: "DELETE",
    path: "/workspaces/{workspaceId}/expenses/{id}",
    access: "write",
    primary: expenseEndpoint.delete,
    support: [expenseEndpoint.get],
    materialFields: [
      expenseMaterialField("/id", "Expense", "entity", true),
      expenseMaterialField("/notes", "Notes", "text", false),
    ],
  }),
  clockify_expenses_categories_create: expenseApiMetadata({
    actionName: "clockify_expenses_categories_create",
    operationId: "createExpenseCategory",
    method: "POST",
    path: "/workspaces/{workspaceId}/expenses/categories",
    access: "write",
    primary: expenseEndpoint.categoriesCreate,
    support: [expenseEndpoint.categoriesList],
    materialFields: [
      expenseMaterialField("/name", "Category name", "text", true),
    ],
  }),
  clockify_expenses_categories_update: expenseInternalMetadata({
    reason: "May dispatch the category-name PUT, the archive-status PATCH, or both primary mutations; use clockify_expenses_categories_rename and clockify_expenses_categories_status_update instead.",
    primary: [expenseEndpoint.categoriesUpdate, expenseEndpoint.categoriesStatus],
    support: [expenseEndpoint.categoriesList],
  }),
  clockify_expenses_categories_delete: expenseInternalMetadata({
    reason: "Archives an active category before deletion, so one invocation can contain two primary mutations; use clockify_expenses_categories_status_update and clockify_expenses_categories_delete_archived instead.",
    primary: [expenseEndpoint.categoriesStatus, expenseEndpoint.categoriesDelete],
    support: [expenseEndpoint.categoriesList],
  }),
} satisfies Readonly<Record<ExpenseActionName, ApiActionMetadataCarrier>>);

const EXPENSE_BILLABLE_LITERAL_ALIASES = Object.freeze([
  { path: "billable", value: false, authoredPhrases: Object.freeze(["non-billable", "nonbillable", "non billable", "not billable"]) },
  { path: "billable", value: true, authoredPhrases: Object.freeze(["billable"]) },
] satisfies readonly SemanticLiteralAlias[]);
const createContract = durableMutationContract({ source: "confirmed", targeting: { mode: "create_no_target" }, strategies: ["create"] });
const expenseCreateContract = durableMutationContract({ source: "confirmed", targeting: { mode: "snapshots", relations: ["parent"] }, strategies: ["create"] });
const targetContract = (strategies: ["update" | "delete" | "state-command" | "composed", ...Array<"update" | "delete" | "state-command" | "composed">]) =>
  durableMutationContract({ source: "confirmed", targeting: { mode: "snapshots", relations: ["target"] }, strategies });

async function expenseTarget(ctx: ActionContext, id: string): Promise<TargetSnapshot | undefined> {
  const expense = await ctx.clockify.getExpense(id);
  return expense ? captureTargetSnapshot("target", { type: "expense", id: expense.id, name: expense.name }, expense) : undefined;
}

function staleExpenseFetch(ctx: ActionContext, snapshot: TargetSnapshot) {
  return ctx.clockify.getExpense(snapshot.ref.id).then((row) => row
    ? { ref: { type: "expense", id: row.id, name: row.name }, projection: row, truncated: false }
    : undefined);
}

function staleCategoryFetch(ctx: ActionContext, snapshot: TargetSnapshot) {
  return categoryById(ctx, snapshot.ref.id).then((row) => row
    ? { ref: { type: "expense_category", id: row.id, name: row.name }, projection: row, truncated: false }
    : undefined);
}

async function expenseParentSnapshots(ctx: ActionContext, input: {
  categoryId?: string;
  userId?: string;
  projectId?: string;
  taskId?: string;
}): Promise<TargetSnapshot[] | undefined> {
  if (!input.categoryId || !input.userId) return undefined;
  const category = await categoryById(ctx, input.categoryId);
  const users = await ctx.clockify.listUsers();
  if (!category || users.truncated) return undefined;
  const ownerMatches = users.rows.filter((row) => row.id === input.userId);
  let ownerProjection: { id: string; name?: string; role?: string } | undefined = ownerMatches.length === 1 ? ownerMatches[0] : undefined;
  if (!ownerProjection && input.userId === ctx.adminUserId) {
    const role = await ctx.clockify.getWorkspaceMemberRole(input.userId);
    if (role) ownerProjection = { id: input.userId, role };
  }
  if (!ownerProjection) return undefined;
  const snapshots: TargetSnapshot[] = [
    captureTargetSnapshot("parent", { type: "expense_category", id: category.id, name: category.name }, category),
    captureTargetSnapshot("parent", { type: "user", id: ownerProjection.id, ...(ownerProjection.name ? { name: ownerProjection.name } : {}) }, ownerProjection),
  ];
  if (input.projectId) {
    const project = await ctx.clockify.getProject(input.projectId);
    if (!project) return undefined;
    snapshots.push(captureTargetSnapshot("parent", { type: "project", id: project.id, name: project.name }, project));
    if (input.taskId) {
      const task = await ctx.clockify.getTask(input.projectId, input.taskId);
      if (!task) return undefined;
      snapshots.push(captureTargetSnapshot("parent", { type: "task", id: task.id, name: task.name, projectId: input.projectId }, task));
    }
  } else if (input.taskId) {
    return undefined;
  }
  return snapshots;
}

async function fetchExpenseSnapshot(ctx: ActionContext, snapshot: TargetSnapshot) {
  if (snapshot.ref.type === "expense") return staleExpenseFetch(ctx, snapshot);
  if (snapshot.ref.type === "expense_category") return staleCategoryFetch(ctx, snapshot);
  if (snapshot.ref.type === "user") {
    const users = await ctx.clockify.listUsers();
    if (users.truncated) return { ref: snapshot.ref, truncated: true };
    const matches = users.rows.filter((row) => row.id === snapshot.ref.id);
    const row = matches.length === 1 ? matches[0] : undefined;
    if (row) return { ref: { type: "user", id: row.id, name: row.name }, projection: row, truncated: false };
    const projection = snapshot.projection as { role?: unknown };
    if (typeof projection.role === "string" && snapshot.ref.id === ctx.adminUserId) {
      const role = await ctx.clockify.getWorkspaceMemberRole(snapshot.ref.id);
      return role ? { ref: { type: "user", id: snapshot.ref.id }, projection: { id: snapshot.ref.id, role }, truncated: false } : undefined;
    }
    return undefined;
  }
  if (snapshot.ref.type === "project") {
    const row = await ctx.clockify.getProject(snapshot.ref.id);
    return row ? { ref: { type: "project", id: row.id, name: row.name }, projection: row, truncated: false } : undefined;
  }
  if (snapshot.ref.type === "task" && snapshot.ref.projectId) {
    const row = await ctx.clockify.getTask(snapshot.ref.projectId, snapshot.ref.id);
    return row ? { ref: { type: "task", id: row.id, name: row.name, projectId: snapshot.ref.projectId }, projection: row, truncated: false } : undefined;
  }
  return undefined;
}

async function executeVerifiedCategoryStep(input: {
  ctx: ActionContext;
  operation: ConfirmableOperation;
  planStepId: string;
  index: number;
  name: string;
  snapshot: TargetSnapshot;
  dispatch(): Promise<MutationDispatchResult>;
}) {
  let verificationFailure: "stale_target" | "stale_parent" | undefined;
  const step = await executeDurableRiskyStep({
    ctx: input.ctx,
    operation: input.operation,
    planStepId: input.planStepId,
    index: input.index,
    name: input.name,
    preparedDetail: { targetSnapshots: [input.snapshot] },
    dispatch: async () => {
      const verified = await verifyTargetSnapshots([input.snapshot], (snapshot) => staleCategoryFetch(input.ctx, snapshot));
      if (!verified.ok) {
        verificationFailure = verified.code;
        throw new DefinitiveWriteFailure("VERIFY", input.planStepId, verified.code);
      }
      return input.dispatch();
    },
  });
  return { step, verificationFailure };
}

function expectedCategorySnapshot(snapshot: TargetSnapshot, patch: { name?: string; archived?: boolean }): TargetSnapshot {
  const projection = { ...(snapshot.projection as Record<string, unknown>), ...patch };
  const currentName = typeof projection.name === "string" ? projection.name : snapshot.ref.name;
  return captureTargetSnapshot("target", { ...snapshot.ref, ...(currentName ? { name: currentName } : {}) }, projection);
}

function partialReceipt(ctx: ActionContext, action: string, id: string, message: string): Extract<CommitResult, { kind: "partial" }> {
  return {
    kind: "partial",
    receipt: successReceipt({ action, entity: "expense_category", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "expense_category", id }] } }),
    message,
    recovery: { hint: "Refresh the category and preview only the remaining change.", retryable: false },
  };
}

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

function sameExpense(row: ExpenseSummary, input: StoredExpense | PreparedExpenseUpdateInput | Record<string, unknown>): boolean {
  const expected = input as StoredExpense & { amount?: string; quantity?: number };
  const expectedTotal = expected.amount !== undefined
    ? Number(expected.amount) * 100 * (expected.quantity ?? 1)
    : expected.amountMinor;
  if (expectedTotal !== undefined && row.total !== expectedTotal) return false;
  if (expected.date !== undefined && row.date?.slice(0, 10) !== expected.date.slice(0, 10)) return false;
  if (expected.categoryId !== undefined && row.categoryId !== expected.categoryId) return false;
  if (expected.userId !== undefined && row.userId !== expected.userId) return false;
  for (const key of ["notes", "billable", "projectId", "taskId"] as const) {
    if (Object.hasOwn(expected, key) && row[key] !== expected[key]) return false;
  }
  return true;
}

const listExpenses = defineAction({
  name: "clockify_expenses_list",
  ...EXPENSE_API_METADATA.clockify_expenses_list,
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
    const { rows, truncated } = await ctx.clockify.listExpenses({ start, end });
    return {
      kind: "receipt",
      receipt: listReceipt({
        action: "clockify_expenses_list",
        entity: "expense",
        ids: { workspaceId: ctx.workspaceId },
        rows,
        truncated,
        data: {
          ...(start !== undefined || end !== undefined ? { window: { start, end } } : {}),
        },
      }),
    };
  },
});

const getExpense = defineReadAction({
  name: "clockify_expenses_get",
  ...EXPENSE_API_METADATA.clockify_expenses_get,
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
  ...EXPENSE_API_METADATA.clockify_expenses_categories_list,
  description: "List expense categories.",
  group: EXP,
  schema: z.object({}),
  async handler(ctx) {
    const { rows, truncated } = await ctx.clockify.listExpenseCategories();
    return listReceipt({
      action: "clockify_expenses_categories_list",
      entity: "expense_category",
      ids: { workspaceId: ctx.workspaceId },
      rows,
      truncated,
    });
  },
});

const createExpense = defineRiskyAction({
  name: "clockify_expenses_create",
  ...EXPENSE_API_METADATA.clockify_expenses_create,
  description:
    "Create an expense. `date` accepts YYYY-MM-DD or a relative 'today'/'yesterday' (resolved server-side; defaults to today — never guess a calendar date). Pass `categoryId`, or the exact `categoryName` and the harness resolves it. Link a project/task by id or exact name (`projectId`/`projectName`, `taskId`/`taskName`) — also resolved server-side. Defaults to YOUR expense; to log it for another user pass their `userId` or exact `userName` (or 'me' for yourself). Billing action — previews and requires confirmation.",
  group: EXP,
  risks: ["billing"],
  mutationWorkflow: "durable",
  mutationContract: expenseCreateContract,
  semanticLiteralAliases: EXPENSE_BILLABLE_LITERAL_ALIASES,
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
    const parentSnapshots = await expenseParentSnapshots(ctx, input);
    if (!parentSnapshots) return { clarify: "The expense category, owner, project, or task could not be verified completely." };
    const baseline = await ctx.clockify.listExpenses();
    if (baseline.truncated) return { clarify: "Clockify returned an incomplete expense baseline. Narrow the workspace data before creating this expense." };
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
      targetSnapshots: parentSnapshots,
      mutationPlan: { mode: "single", steps: [{ id: "create-expense", kind: "primary", targetFingerprint: parentSnapshots[0]!.fingerprint, reconciliationStrategy: "create" }] },
    };
  },
  async commit(ctx, payload, operation) {
    const { input } = payload as { input: StoredExpense };
    let baselineIds: string[];
    try {
      const baseline = await ctx.clockify.listExpenses();
      if (baseline.truncated) {
        return errorReceipt({
          action: operation.actionName,
          code: "create_baseline_unavailable",
          message: "Clockify returned an incomplete expense list immediately before dispatch. No expense was created.",
          recovery: { hint: "Refresh and preview the expense again when the complete list is available.", retryable: true },
        });
      }
      baselineIds = baseline.rows.map((row) => row.id);
    } catch {
      return errorReceipt({
        action: operation.actionName,
        code: "create_baseline_unavailable",
        message: "The expense list could not be read immediately before dispatch. No expense was created.",
        recovery: { hint: "Refresh and preview the expense again after Clockify reads recover.", retryable: true },
      });
    }
    // The owner was resolved at preview (defaults to the admin); the model never
    // sets it directly on the wire.
    let verificationFailure: "stale_target" | "stale_parent" | undefined;
    const snapshots = operation.targetSnapshots ?? [];
    const step = await executeDurableRiskyStep({
      ctx, operation, planStepId: "create-expense", index: 0, name: "Create expense",
      preparedDetail: { preDispatch: { strategy: "expense_create_baseline", ids: baselineIds, truncated: false } },
      dispatch: async () => {
        const verified = await verifyTargetSnapshots(snapshots, (snapshot) => fetchExpenseSnapshot(ctx, snapshot));
        if (!verified.ok) {
          verificationFailure = verified.code;
          throw new DefinitiveWriteFailure("VERIFY", "create-expense", verified.code);
        }
        const result = await dispatchWithReconciliation({
          dispatch: () => ctx.clockify.createExpenseAtomic(input),
          reconcile: () => reconcileCreate({ beforeIds: baselineIds, list: () => ctx.clockify.listExpenses(), matches: (row) => sameExpense(row, input) }),
        });
        const expense = result.value;
        return { externalId: expense.id, effect: { created: { type: "expense", id: expense.id, name: expense.name } }, detail: { reconciled: result.reconciled } };
      },
    });
    if (verificationFailure) {
      return errorReceipt({
        action: operation.actionName,
        code: verificationFailure,
        message: "An expense parent changed or could not be verified. No Clockify mutation was sent.",
        recovery: { hint: "Refresh the expense parents and create a fresh preview.", retryable: true },
      });
    }
    if (step.status === "succeeded") {
      const receipt = successReceipt({ action: "clockify_expenses_create", entity: "expense", ids: { workspaceId: ctx.workspaceId }, changed: { created: [{ type: "expense", id: step.externalId ?? "unknown", name: input.notes }] } });
      return isJournalDegradedStep(step) ? withJournalDegradedWarning(receipt) : receipt;
    }
    return errorReceipt({
      action: operation.actionName,
      code: step.status === "outcome_unknown" ? "commit_outcome_unknown" : "write_failed",
      message: step.status === "outcome_unknown"
        ? "Clockify did not provide a definitive response, so the expense may or may not have been created."
        : "Clockify definitively rejected expense creation.",
      recovery: step.status === "outcome_unknown"
        ? { hint: "Verify the exact expense in Clockify before deciding whether to try again.", retryable: false }
        : { hint: "Correct the expense details and preview again.", retryable: true },
    });
  },
});

const updateExpense = defineRiskyAction({
  name: "clockify_expenses_update",
  ...EXPENSE_API_METADATA.clockify_expenses_update,
  description:
    "Update an expense. Category/project/task accept an id or the exact name (`categoryName`/`projectName`/`taskName`) — resolved server-side. Billing action — previews and requires confirmation.",
  group: EXP,
  risks: ["billing"],
  mutationWorkflow: "durable",
  mutationContract: durableMutationContract({ source: "confirmed", targeting: { mode: "snapshots", relations: ["target", "parent"] }, strategies: ["update"] }),
  semanticLiteralAliases: EXPENSE_BILLABLE_LITERAL_ALIASES,
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
    const target = await expenseTarget(ctx, args.id);
    if (!target) return { clarify: `Expense ${args.id} could not be verified.` };
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
    let updateBody: Awaited<ReturnType<typeof ctx.clockify.prepareExpenseUpdate>>;
    try {
      updateBody = await ctx.clockify.prepareExpenseUpdate(args.id, { changeFields, ...values, userId: ctx.adminUserId });
    } catch {
      return { clarify: "The current expense could not be prepared safely. Refresh it and preview again." };
    }
    const parentSnapshots = await expenseParentSnapshots(ctx, updateBody);
    if (!parentSnapshots) return { clarify: "The expense category, owner, project, or task could not be verified completely." };
    return {
      actionLabel: "Update expense",
      targets: [{ type: "expense", id: args.id }],
      expectedChanges: describePatch(changeValues),
      reversibility: "You can update the expense again to revert most fields.",
      warnings: ["Updating an expense changes an expense record."],
      payload: { id: args.id, changeFields, values, updateBody },
      targetSnapshots: [target, ...parentSnapshots],
      mutationPlan: { mode: "single", steps: [{ id: "update-expense", kind: "primary", targetFingerprint: target.fingerprint, reconciliationStrategy: "update" }] },
    };
  },
  async commit(ctx, payload, operation) {
    const { id, updateBody } = payload as {
      id: string;
      updateBody: Awaited<ReturnType<typeof ctx.clockify.prepareExpenseUpdate>>;
    };
    return commitSingleDurableRiskyStep({
      ctx, operation, planStepId: "update-expense", name: "Update expense",
      verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (snapshot) => fetchExpenseSnapshot(ctx, snapshot) },
      dispatch: async () => {
        const result = await dispatchWithReconciliation({
          dispatch: () => ctx.clockify.updateExpenseAtomic(id, updateBody),
          reconcile: async () => { const row = await ctx.clockify.getExpense(id); return row && sameExpense(row, updateBody) ? row : undefined; },
        });
        const updated = result.value;
        return { externalId: updated.id, effect: { updated: { type: "expense", id: updated.id, name: updated.name } }, detail: { reconciled: result.reconciled } };
      },
      success: (step) => successReceipt({ action: "clockify_expenses_update", entity: "expense", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "expense", id: step.externalId ?? id }] } }),
    });
  },
});

const deleteExpense = defineRiskyAction({
  name: "clockify_expenses_delete",
  ...EXPENSE_API_METADATA.clockify_expenses_delete,
  description: "Delete an expense. Destructive billing action — previews and requires confirmation.",
  group: EXP,
  risks: ["destructive", "billing"],
  mutationWorkflow: "durable",
  mutationContract: targetContract(["delete"]),
  schema: z.object({ id: z.string().min(1), notes: z.string().optional() }),
  async preview(ctx, args) {
    const target = await expenseTarget(ctx, args.id);
    if (!target) return { clarify: `Expense ${args.id} could not be verified.` };
    return {
      actionLabel: "Delete expense",
      targets: [{ type: "expense", id: args.id, ...(args.notes !== undefined ? { name: args.notes } : {}) }],
      expectedChanges: [`Delete expense ${args.notes ?? args.id}`],
      reversibility: "This cannot be undone.",
      warnings: ["Deleting an expense is permanent."],
      payload: { id: args.id, ...(args.notes !== undefined ? { notes: args.notes } : {}) },
      targetSnapshots: [target],
      mutationPlan: { mode: "single", steps: [{ id: "delete-expense", kind: "primary", targetFingerprint: target.fingerprint, reconciliationStrategy: "delete" }] },
    };
  },
  async commit(ctx, payload, operation) {
    const { id, notes } = payload as { id: string; notes?: string };
    return commitSingleDurableRiskyStep({
      ctx, operation, planStepId: "delete-expense", name: "Delete expense",
      verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (snapshot) => staleExpenseFetch(ctx, snapshot) },
      dispatch: async () => {
        const result = await dispatchWithReconciliation({ dispatch: async () => { await ctx.clockify.deleteExpenseAtomic(id); return true as const; }, reconcile: () => reconcileDelete(() => ctx.clockify.getExpense(id)) });
        return { effect: { deleted: { type: "expense", id, name: notes } }, detail: { reconciled: result.reconciled } };
      },
      success: () => successReceipt({ action: "clockify_expenses_delete", entity: "expense", ids: { workspaceId: ctx.workspaceId }, changed: { deleted: [{ type: "expense", id, name: notes }] } }),
    });
  },
});

const createExpenseCategory = defineRiskyAction({
  name: "clockify_expenses_categories_create",
  ...EXPENSE_API_METADATA.clockify_expenses_categories_create,
  description: "Create an expense category. Billing action — previews and requires confirmation.",
  group: EXP,
  risks: ["billing"],
  mutationWorkflow: "durable",
  mutationContract: createContract,
  schema: z.object({ name: z.string().min(1) }),
  async preview(ctx, args) {
    const baseline = await listAllCategories(ctx);
    if (!baseline) return { clarify: "Clockify returned an incomplete expense-category baseline. Retry after it can be read completely." };
    return {
      actionLabel: "Create expense category",
      targets: [],
      expectedChanges: [`Create expense category "${args.name}"`],
      reversibility: "You can rename or delete the category afterward.",
      warnings: ["This adds an expense category to the workspace."],
      payload: { name: args.name },
      mutationPlan: { mode: "single", steps: [{ id: "create-expense-category", kind: "primary", reconciliationStrategy: "create" }] },
    };
  },
  async commit(ctx, payload, operation) {
    const { name } = payload as { name: string };
    let baselineIds: string[];
    try {
      const baseline = await listAllCategories(ctx);
      if (!baseline) throw new Error("incomplete_category_baseline");
      baselineIds = baseline.map((row) => row.id);
    } catch {
      return errorReceipt({
        action: operation.actionName,
        code: "create_baseline_unavailable",
        message: "The complete expense-category list could not be read immediately before dispatch. No category was created.",
        recovery: { hint: "Refresh and preview the category again after Clockify reads recover.", retryable: true },
      });
    }
    const step = await executeDurableRiskyStep({
      ctx, operation, planStepId: "create-expense-category", index: 0, name: "Create expense category",
      preparedDetail: { preDispatch: { strategy: "expense_category_create_baseline", ids: baselineIds, truncated: false } },
      dispatch: async () => {
        const result = await dispatchWithReconciliation({
          dispatch: () => ctx.clockify.createExpenseCategoryAtomic({ name }),
          reconcile: async () => {
            const rows = await listAllCategories(ctx);
            if (!rows) return undefined;
            return reconcileCreate({ beforeIds: baselineIds, list: async () => ({ rows, truncated: false }), matches: (row) => row.name === name });
          },
        });
        const category = result.value;
        return { externalId: category.id, effect: { created: { type: "expense_category", id: category.id, name: category.name } }, detail: { reconciled: result.reconciled } };
      },
    });
    if (step.status === "succeeded") {
      const receipt = successReceipt({ action: "clockify_expenses_categories_create", entity: "expense_category", ids: { workspaceId: ctx.workspaceId }, changed: { created: [{ type: "expense_category", id: step.externalId ?? "unknown", name }] } });
      return isJournalDegradedStep(step) ? withJournalDegradedWarning(receipt) : receipt;
    }
    return errorReceipt({
      action: operation.actionName,
      code: step.status === "outcome_unknown" ? "commit_outcome_unknown" : "write_failed",
      message: step.status === "outcome_unknown"
        ? "Clockify did not provide a definitive response, so the category may or may not have been created."
        : "Clockify definitively rejected expense-category creation.",
      recovery: step.status === "outcome_unknown"
        ? { hint: "Verify the exact category in Clockify before deciding whether to try again.", retryable: false }
        : { hint: "Correct the category details and preview again.", retryable: true },
    });
  },
});

const updateExpenseCategory = defineRiskyAction({
  name: "clockify_expenses_categories_update",
  ...EXPENSE_API_METADATA.clockify_expenses_categories_update,
  description:
    "Rename and/or archive/unarchive an expense category. Pass the category `id` or its exact `currentName` (the harness resolves it); `name` sets a new name, `archived` archives (true) or restores (false). Billing action — previews and requires confirmation.",
  group: EXP,
  risks: ["billing"],
  mutationWorkflow: "durable",
  mutationContract: targetContract(["update", "state-command"]),
  semanticLiteralAliases: Object.freeze([
    { path: "archived", value: false, authoredPhrases: Object.freeze(["active", "restore", "unarchive", "unarchived"]) },
    { path: "archived", value: true, authoredPhrases: Object.freeze(["archive", "archived"]) },
  ] satisfies readonly SemanticLiteralAlias[]),
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
    const target = await categoryTarget(ctx, resolved.id);
    if (!target) return { clarify: `Expense category ${resolved.id} could not be verified completely.` };
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
      payload: {
        id: resolved.id,
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.archived !== undefined ? { archived: args.archived } : {}),
      },
      targetSnapshots: [target],
      mutationPlan: {
        mode: args.name !== undefined && args.archived !== undefined ? "curated" : "single",
        steps: [
          ...(args.name !== undefined ? [{ id: "rename-expense-category", kind: "primary" as const, targetFingerprint: target.fingerprint, reconciliationStrategy: "update" as const }] : []),
          ...(args.archived !== undefined ? [{ id: "set-expense-category-status", kind: "primary" as const, reconciliationStrategy: "state-command" as const }] : []),
        ],
      },
    };
  },
  async commit(ctx, payload, operation) {
    const { id, name, archived } = payload as { id: string; name?: string; archived?: boolean };
    const initial = operation.targetSnapshots?.[0];
    if (!initial) return errorReceipt({ action: operation.actionName, code: "stale_target", message: "The category target is missing. Create a fresh preview." });
    let completed = 0;
    if (name !== undefined) {
      const executed = await executeVerifiedCategoryStep({ ctx, operation, planStepId: "rename-expense-category", index: 0, name: "Rename expense category", snapshot: initial, dispatch: async () => {
        const result = await dispatchWithReconciliation({ dispatch: () => ctx.clockify.updateExpenseCategoryAtomic(id, { name }), reconcile: async () => { const row = await categoryById(ctx, id); return row?.name === name ? row : undefined; } });
        return { externalId: result.value.id, effect: { renamed: { id, name } }, detail: { reconciled: result.reconciled } };
      } });
      if (executed.verificationFailure) return errorReceipt({ action: operation.actionName, code: executed.verificationFailure, message: "The category changed before the rename step.", recovery: { hint: "Preview the category update again." } });
      const step = executed.step;
      if (step.status === "outcome_unknown") return errorReceipt({ action: operation.actionName, code: "commit_outcome_unknown", message: "The category rename may or may not have applied.", recovery: { hint: "Verify the category in Clockify before retrying.", retryable: false } });
      if (step.status === "definitive_failed") return errorReceipt({ action: operation.actionName, code: "write_failed", message: "Clockify rejected the category rename." });
      completed += 1;
    }
    if (archived !== undefined) {
      const expected = expectedCategorySnapshot(initial, { ...(name !== undefined ? { name } : {}) });
      const executed = await executeVerifiedCategoryStep({ ctx, operation, planStepId: "set-expense-category-status", index: completed, name: "Set expense category status", snapshot: expected, dispatch: async () => {
        const result = await dispatchWithReconciliation({ dispatch: async () => { await ctx.clockify.setExpenseCategoryArchivedAtomic(id, archived); return true as const; }, reconcile: async () => (await categoryById(ctx, id))?.archived === archived ? true as const : undefined });
        return { effect: { archived }, detail: { reconciled: result.reconciled } };
      } });
      if (executed.verificationFailure) return completed ? partialReceipt(ctx, operation.actionName, id, "The category was renamed, but changed again before the status step.") : errorReceipt({ action: operation.actionName, code: executed.verificationFailure, message: "The category changed before dispatch." });
      const step = executed.step;
      if (step.status !== "succeeded") return completed ? partialReceipt(ctx, operation.actionName, id, "The category rename applied, but the status change did not complete.") : errorReceipt({ action: operation.actionName, code: step.status === "outcome_unknown" ? "commit_outcome_unknown" : "write_failed", message: "The category status change did not complete.", recovery: { hint: "Refresh the category before retrying.", retryable: step.status !== "outcome_unknown" } });
    }
    return successReceipt({
      action: "clockify_expenses_categories_update",
      entity: "expense_category",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "expense_category", id, name }] },
    });
  },
});

const deleteExpenseCategory = defineRiskyAction({
  name: "clockify_expenses_categories_delete",
  ...EXPENSE_API_METADATA.clockify_expenses_categories_delete,
  description:
    "Delete an expense category. Pass the category id, or its exact `name` and the harness resolves it. Destructive billing action — previews and requires confirmation.",
  group: EXP,
  risks: ["destructive", "billing"],
  mutationWorkflow: "durable",
  mutationContract: targetContract(["state-command", "delete"]),
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
    const target = await categoryTarget(ctx, resolved.id);
    if (!target) return { clarify: `Expense category ${resolved.id} could not be verified completely.` };
    const current = target.projection as { archived?: boolean };
    const name = resolved.name ?? args.name;
    return {
      actionLabel: "Delete expense category",
      targets: [{ type: "expense_category", id: resolved.id, ...(name !== undefined ? { name } : {}) }],
      expectedChanges: [`Delete expense category ${name ?? resolved.id}`],
      reversibility: "This cannot be undone.",
      warnings: ["Deleting an expense category is permanent."],
      targetSnapshots: [target],
      mutationPlan: {
        mode: current.archived ? "single" : "curated",
        steps: [
          ...(!current.archived ? [{ id: "archive-expense-category", kind: "primary" as const, targetFingerprint: target.fingerprint, reconciliationStrategy: "state-command" as const }] : []),
          { id: "delete-expense-category", kind: "primary" as const, reconciliationStrategy: "delete" as const },
        ],
      },
      payload: { id: resolved.id, ...(name !== undefined ? { name } : {}), wasArchived: current.archived === true },
    };
  },
  async commit(ctx, payload, operation) {
    const { id, name, wasArchived } = payload as { id: string; name?: string; wasArchived: boolean };
    const initial = operation.targetSnapshots?.[0];
    if (!initial) return errorReceipt({ action: operation.actionName, code: "stale_target", message: "The category target is missing. Create a fresh preview." });
    let index = 0;
    if (!wasArchived) {
      const executed = await executeVerifiedCategoryStep({ ctx, operation, planStepId: "archive-expense-category", index: index++, name: "Archive expense category", snapshot: initial, dispatch: async () => {
        const result = await dispatchWithReconciliation({ dispatch: async () => { await ctx.clockify.setExpenseCategoryArchivedAtomic(id, true); return true as const; }, reconcile: async () => (await categoryById(ctx, id))?.archived === true ? true as const : undefined });
        return { effect: { archived: true }, detail: { reconciled: result.reconciled } };
      } });
      if (executed.verificationFailure) return errorReceipt({ action: operation.actionName, code: executed.verificationFailure, message: "The category changed before the archive step." });
      const archive = executed.step;
      if (archive.status !== "succeeded") return errorReceipt({ action: operation.actionName, code: archive.status === "outcome_unknown" ? "commit_outcome_unknown" : "write_failed", message: "The category archive did not complete.", recovery: { hint: "Refresh the category before retrying.", retryable: archive.status !== "outcome_unknown" } });
    }
    const expected = wasArchived ? initial : expectedCategorySnapshot(initial, { archived: true });
    const executedDelete = await executeVerifiedCategoryStep({ ctx, operation, planStepId: "delete-expense-category", index, name: "Delete expense category", snapshot: expected, dispatch: async () => {
      const result = await dispatchWithReconciliation({ dispatch: async () => { await ctx.clockify.deleteExpenseCategoryAtomic(id); return true as const; }, reconcile: async () => { const rows = await listAllCategories(ctx); return rows && !rows.some((row) => row.id === id) ? true as const : undefined; } });
      return { effect: { deleted: { type: "expense_category", id } }, detail: { reconciled: result.reconciled } };
    } });
    if (executedDelete.verificationFailure) return !wasArchived ? partialReceipt(ctx, operation.actionName, id, "The category was archived, but could not be verified before deletion.") : errorReceipt({ action: operation.actionName, code: executedDelete.verificationFailure, message: "The archived category could not be verified." });
    const del = executedDelete.step;
    if (del.status !== "succeeded") return !wasArchived ? partialReceipt(ctx, operation.actionName, id, "The category was archived, but deletion did not complete.") : errorReceipt({ action: operation.actionName, code: del.status === "outcome_unknown" ? "commit_outcome_unknown" : "write_failed", message: "The category deletion did not complete.", recovery: { hint: "Verify whether the category still exists before retrying.", retryable: del.status !== "outcome_unknown" } });
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
