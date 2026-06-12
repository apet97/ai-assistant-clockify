import { z } from "zod";
import {
  defineAction,
  defineReadAction,
  defineRiskyAction,
  type ActionContext,
  type ActionDefinition,
  type RiskyClarifyResult,
} from "../action.js";
import { successReceipt } from "../receipts.js";
import { toMinor } from "../money.js";
import { describePatch, resolveEntityRef } from "./resolve.js";

/**
 * Typed task workflows (goclmcp §2.3). Tasks live under a project. Reads + create
 * execute immediately; update/delete/rate are risky and preview→commit. Rate is a
 * billing action gated by `invoices`; the rest are `work_structure`.
 */

const WORK = "work_structure" as const;

/**
 * Tasks are project-scoped, so a symbolic reference resolves in two steps:
 * project (by id or name) first, then the task within it. Either step can stop
 * with a clarify — an unresolved reference must never reach a confirmable
 * operation (the live loop confirmed previews whose commits then 400'd).
 */
async function resolveTaskRef(
  ctx: ActionContext,
  refs: { projectId?: string; projectName?: string; id?: string; name?: string },
  verb: string,
): Promise<
  | { ok: true; projectId: string; id: string; name?: string }
  | { ok: false; clarify: RiskyClarifyResult }
> {
  const project = await resolveEntityRef(
    { id: refs.projectId, name: refs.projectName },
    {
      noun: "project",
      verb,
      list: (filter) => ctx.clockify.listProjects(filter),
      // A task delete may target a task inside an ARCHIVED project.
      includeArchived: verb === "delete",
    },
  );
  if (!project.ok) return project;
  const task = await resolveEntityRef(
    { id: refs.id, name: refs.name },
    { noun: "task", verb, list: () => ctx.clockify.listTasks(project.id) },
  );
  if (!task.ok) return task;
  return { ok: true, projectId: project.id, id: task.id, name: task.name ?? refs.name };
}

const listTasks = defineReadAction({
  name: "clockify_tasks_list",
  description: "List tasks under a project (optional name filter).",
  group: WORK,
  schema: z.object({ projectId: z.string().min(1), name: z.string().optional() }),
  async handler(ctx, args) {
    const items = await ctx.clockify.listTasks(args.projectId, { name: args.name });
    return successReceipt({
      action: "clockify_tasks_list",
      entity: "task",
      ids: { workspaceId: ctx.workspaceId, projectId: args.projectId },
      data: { count: items.length, items },
    });
  },
});

const getTask = defineReadAction({
  name: "clockify_tasks_get",
  description: "Fetch a single task by id within a project.",
  group: WORK,
  schema: z.object({ projectId: z.string().min(1), id: z.string().min(1) }),
  async handler(ctx, args) {
    const entity = await ctx.clockify.getTask(args.projectId, args.id);
    return successReceipt({
      action: "clockify_tasks_get",
      entity: "task",
      ids: { workspaceId: ctx.workspaceId, projectId: args.projectId },
      data: { entity },
    });
  },
});

const createTask = defineAction({
  name: "clockify_tasks_create",
  description: "Create a task under a project. Safe write — executes immediately when policy allows.",
  featureGroup: WORK,
  risks: ["safe_write"],
  schema: z.object({ projectId: z.string().min(1), name: z.string().min(1) }),
  async handler(ctx, args) {
    const task = await ctx.clockify.createTask({ projectId: args.projectId, name: args.name });
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_tasks_create",
        entity: "task",
        ids: { workspaceId: ctx.workspaceId, projectId: args.projectId },
        changed: { created: [{ type: "task", id: task.id, name: task.name }] },
      }),
    };
  },
});

const updateTask = defineRiskyAction({
  name: "clockify_tasks_update",
  description:
    "Update a task (rename, reassign, status, estimate). Pass `projectId` (or the exact `projectName`) and the task's `id` (or its exact `currentName`) — the harness resolves names server-side; use `currentName` + the new `name` to RENAME without listing first. Elevated write — previews and requires confirmation.",
  group: WORK,
  risks: ["high_risk_write"],
  schema: z
    .object({
      projectId: z.string().min(1).optional(),
      /** The task's project name, resolved to an id server-side. */
      projectName: z.string().min(1).optional(),
      id: z.string().min(1).optional(),
      /** The task's existing name, resolved to an id server-side (rename-by-name). */
      currentName: z.string().min(1).optional(),
      name: z.string().optional(),
      status: z.string().optional(),
      assigneeIds: z.array(z.string()).optional(),
      fields: z.record(z.string(), z.unknown()).optional(),
    })
    .refine((v) => v.projectId !== undefined || v.projectName !== undefined, {
      message: "Provide the project id or its exact projectName.",
    })
    .refine((v) => v.id !== undefined || v.currentName !== undefined, {
      message: "Provide the task id or its exact currentName.",
    })
    .refine((v) => v.name !== undefined || v.status !== undefined || v.assigneeIds !== undefined || v.fields !== undefined, {
      message: "Provide at least one field to change.",
    }),
  async preview(ctx, args) {
    const resolved = await resolveTaskRef(
      ctx,
      { projectId: args.projectId, projectName: args.projectName, id: args.id, name: args.currentName },
      "update",
    );
    if (!resolved.ok) return resolved.clarify;
    const patch: Record<string, unknown> = {
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.assigneeIds !== undefined ? { assigneeIds: args.assigneeIds } : {}),
      ...(args.fields ?? {}),
    };
    return {
      actionLabel: "Update task",
      targets: [{ type: "task", id: resolved.id, name: resolved.name ?? args.name }],
      expectedChanges: describePatch(patch),
      reversibility: "You can update the task again to revert most fields.",
      warnings: ["Updating a task changes live workspace data."],
      payload: { projectId: resolved.projectId, id: resolved.id, patch },
    };
  },
  async commit(ctx, payload) {
    const { projectId, id, patch } = payload as { projectId: string; id: string; patch: Record<string, unknown> };
    const updated = await ctx.clockify.updateTask(projectId, id, patch);
    return successReceipt({
      action: "clockify_tasks_update",
      entity: "task",
      ids: { workspaceId: ctx.workspaceId, projectId },
      changed: { updated: [{ type: "task", id: updated.id, name: updated.name }] },
    });
  },
});

const deleteTask = defineRiskyAction({
  name: "clockify_tasks_delete",
  description:
    "Delete a task (marks it DONE first, then deletes). Pass `projectId` (or the exact `projectName`) and the task's `id` (or its exact `name`) — the harness resolves names server-side. Previews and requires confirmation.",
  group: WORK,
  risks: ["destructive"],
  schema: z
    .object({
      projectId: z.string().min(1).optional(),
      projectName: z.string().min(1).optional(),
      id: z.string().min(1).optional(),
      name: z.string().min(1).optional(),
    })
    .refine((v) => v.projectId !== undefined || v.projectName !== undefined, {
      message: "Provide the project id or its exact projectName.",
    })
    .refine((v) => v.id !== undefined || v.name !== undefined, {
      message: "Provide the task id or its exact name.",
    }),
  async preview(ctx, args) {
    const resolved = await resolveTaskRef(
      ctx,
      { projectId: args.projectId, projectName: args.projectName, id: args.id, name: args.name },
      "delete",
    );
    if (!resolved.ok) return resolved.clarify;
    const name = resolved.name ?? args.name;
    return {
      actionLabel: "Delete task",
      targets: [{ type: "task", id: resolved.id, name }],
      expectedChanges: [`Delete task ${name ?? resolved.id}`],
      reversibility: "This cannot be undone.",
      warnings: ["Deleting a task is permanent."],
      payload: { projectId: resolved.projectId, id: resolved.id, name },
    };
  },
  async commit(ctx, payload) {
    const { projectId, id, name } = payload as { projectId: string; id: string; name?: string };
    await ctx.clockify.deleteTask(projectId, id);
    return successReceipt({
      action: "clockify_tasks_delete",
      entity: "task",
      ids: { workspaceId: ctx.workspaceId, projectId },
      changed: { deleted: [{ type: "task", id, name }] },
    });
  },
});

const rateUpdate = defineRiskyAction({
  name: "clockify_tasks_rate_update",
  description:
    "Set a task's billable hourly or cost rate. Pass the project by `projectId` or exact `projectName`, and the task by `taskId` or exact `taskName` — the harness resolves names and verifies the task exists server-side. `amount` is major units (e.g. 75 = 75.00) unless `amountUnit` is 'minor'. Billing action — previews and requires confirmation.",
  group: "invoices",
  risks: ["billing"],
  schema: z
    .object({
      projectId: z.string().min(1).optional(),
      projectName: z.string().min(1).optional(),
      taskId: z.string().min(1).optional(),
      taskName: z.string().min(1).optional(),
      rateKind: z.enum(["HOURLY", "COST"]),
      amount: z.number().nonnegative(),
      /** `major` (e.g. 75.00) is converted ×100 to the minor units Clockify wants. */
      amountUnit: z.enum(["major", "minor"]).default("major"),
      since: z.string().optional(),
    })
    .refine((v) => v.projectId !== undefined || v.projectName !== undefined, { message: "Provide the project id or its exact projectName." })
    .refine((v) => v.taskId !== undefined || v.taskName !== undefined, { message: "Provide the task id or its exact taskName." }),
  async preview(ctx, args) {
    // Resolve + VERIFY the task exists before previewing — an unresolved task id
    // sails past the trust-the-id path and 404s at commit; clarify here instead.
    const resolved = await resolveTaskRef(
      ctx,
      { projectId: args.projectId, projectName: args.projectName, id: args.taskId, name: args.taskName },
      "set a rate on",
    );
    if (!resolved.ok) return resolved.clarify;
    const amountMinor = toMinor(args.amount, args.amountUnit);
    const taskLabel = resolved.name ?? resolved.id;
    return {
      actionLabel: `Set task ${args.rateKind === "COST" ? "cost" : "hourly"} rate`,
      targets: [{ type: "task", id: resolved.id, name: resolved.name }],
      expectedChanges: [`Set ${args.rateKind} rate for "${taskLabel}" to ${(amountMinor / 100).toFixed(2)}`],
      reversibility: "You can set a new rate at any time; past entries keep their recorded rate.",
      warnings: ["This changes the billable amount of future entries on the task."],
      payload: {
        projectId: resolved.projectId,
        taskId: resolved.id,
        rateKind: args.rateKind,
        amountMinor,
        since: args.since,
      },
    };
  },
  async commit(ctx, payload) {
    const typed = payload as {
      projectId: string;
      taskId: string;
      rateKind: "HOURLY" | "COST";
      amountMinor: number;
      since?: string;
    };
    await ctx.clockify.updateTaskRate(typed);
    return successReceipt({
      action: "clockify_tasks_rate_update",
      entity: "task",
      ids: { workspaceId: ctx.workspaceId, projectId: typed.projectId },
      changed: { updated: [{ type: "task", id: typed.taskId }] },
    });
  },
});

export const TASK_ACTIONS: ActionDefinition[] = [
  listTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
  rateUpdate,
];
