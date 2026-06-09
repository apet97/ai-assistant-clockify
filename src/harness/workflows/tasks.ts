import { z } from "zod";
import {
  defineAction,
  defineReadAction,
  defineRiskyAction,
  type ActionDefinition,
} from "../action.js";
import { successReceipt } from "../receipts.js";

/**
 * Typed task workflows (goclmcp §2.3). Tasks live under a project. Reads + create
 * execute immediately; update/delete/rate are risky and preview→commit. Rate is a
 * billing action gated by `invoices`; the rest are `work_structure`.
 */

const WORK = "work_structure" as const;

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
    "Update a task (rename, reassign, status, estimate). Elevated write — previews and requires confirmation.",
  group: WORK,
  risks: ["high_risk_write"],
  schema: z
    .object({
      projectId: z.string().min(1),
      id: z.string().min(1),
      name: z.string().optional(),
      status: z.string().optional(),
      assigneeIds: z.array(z.string()).optional(),
      fields: z.record(z.string(), z.unknown()).optional(),
    })
    .refine((v) => v.name !== undefined || v.status !== undefined || v.assigneeIds !== undefined || v.fields !== undefined, {
      message: "Provide at least one field to change.",
    }),
  async preview(_ctx, args) {
    const patch: Record<string, unknown> = {
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.assigneeIds !== undefined ? { assigneeIds: args.assigneeIds } : {}),
      ...(args.fields ?? {}),
    };
    return {
      actionLabel: "Update task",
      targets: [{ type: "task", id: args.id, name: args.name }],
      expectedChanges: Object.keys(patch).map((k) => `set ${k}`),
      reversibility: "You can update the task again to revert most fields.",
      warnings: ["Updating a task changes live workspace data."],
      payload: { projectId: args.projectId, id: args.id, patch },
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
    "Delete a task (marks it DONE first, then deletes). Previews and requires confirmation.",
  group: WORK,
  risks: ["destructive"],
  schema: z.object({ projectId: z.string().min(1), id: z.string().min(1), name: z.string().optional() }),
  async preview(_ctx, args) {
    return {
      actionLabel: "Delete task",
      targets: [{ type: "task", id: args.id, name: args.name }],
      expectedChanges: [`Delete task ${args.name ?? args.id}`],
      reversibility: "This cannot be undone.",
      warnings: ["Deleting a task is permanent."],
      payload: { projectId: args.projectId, id: args.id, name: args.name },
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
    "Set a task's billable hourly or cost rate. Billing action — previews and requires confirmation.",
  group: "invoices",
  risks: ["billing"],
  schema: z.object({
    projectId: z.string().min(1),
    taskId: z.string().min(1),
    rateKind: z.enum(["HOURLY", "COST"]),
    amount: z.number().nonnegative(),
    amountUnit: z.enum(["major", "minor"]).default("major"),
    since: z.string().optional(),
  }),
  async preview(_ctx, args) {
    const amountMinor = args.amountUnit === "minor" ? Math.round(args.amount) : Math.round(args.amount * 100);
    return {
      actionLabel: `Set task ${args.rateKind === "COST" ? "cost" : "hourly"} rate`,
      targets: [{ type: "task", id: args.taskId }],
      expectedChanges: [`Set ${args.rateKind} rate to ${amountMinor} (minor units)`],
      reversibility: "You can set a new rate at any time; past entries keep their recorded rate.",
      warnings: ["This changes the billable amount of future entries on the task."],
      payload: {
        projectId: args.projectId,
        taskId: args.taskId,
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
