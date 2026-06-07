import { z } from "zod";
import { defineAction, type ActionDefinition } from "../action.js";
import { successReceipt } from "../receipts.js";

/**
 * Typed task workflows (goclmcp §2.3). Tasks live under a project. Reads + create
 * execute immediately; update/delete/rate are risky and preview→commit. Rate is a
 * billing action gated by `invoices`; the rest are `work_structure`.
 */

const WORK = "work_structure" as const;

const listTasks = defineAction({
  name: "clockify_tasks_list",
  description: "List tasks under a project (optional name filter).",
  featureGroup: WORK,
  risks: ["read"],
  schema: z.object({ projectId: z.string().min(1), name: z.string().optional() }),
  async handler(ctx, args) {
    const items = await ctx.clockify.listTasks(args.projectId, { name: args.name });
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_tasks_list",
        entity: "task",
        ids: { workspaceId: ctx.workspaceId, projectId: args.projectId },
        data: { count: items.length, items },
      }),
    };
  },
});

const getTask = defineAction({
  name: "clockify_tasks_get",
  description: "Fetch a single task by id within a project.",
  featureGroup: WORK,
  risks: ["read"],
  schema: z.object({ projectId: z.string().min(1), id: z.string().min(1) }),
  async handler(ctx, args) {
    const entity = await ctx.clockify.getTask(args.projectId, args.id);
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_tasks_get",
        entity: "task",
        ids: { workspaceId: ctx.workspaceId, projectId: args.projectId },
        data: { entity },
      }),
    };
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

const updateTask = defineAction({
  name: "clockify_tasks_update",
  description:
    "Update a task (rename, reassign, status, estimate). Elevated write — previews and requires confirmation.",
  featureGroup: WORK,
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
  async handler(ctx, args) {
    const patch: Record<string, unknown> = {
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.assigneeIds !== undefined ? { assigneeIds: args.assigneeIds } : {}),
      ...(args.fields ?? {}),
    };
    return {
      kind: "preview",
      preview: {
        actionLabel: "Update task",
        featureGroup: WORK,
        riskLabels: ["high_risk_write"],
        targets: [{ type: "task", id: args.id, name: args.name }],
        expectedChanges: Object.keys(patch).map((k) => `set ${k}`),
        reversibility: "You can update the task again to revert most fields.",
        warnings: ["Updating a task changes live workspace data."],
      },
      operation: {
        actionName: "clockify_tasks_update",
        featureGroup: WORK,
        risks: ["high_risk_write"],
        payload: { projectId: args.projectId, id: args.id, patch },
      },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { projectId: string; id: string; patch: Record<string, unknown> };
    const updated = await ctx.clockify.updateTask(payload.projectId, payload.id, payload.patch);
    return successReceipt({
      action: "clockify_tasks_update",
      entity: "task",
      ids: { workspaceId: ctx.workspaceId, projectId: payload.projectId },
      changed: { updated: [{ type: "task", id: updated.id, name: updated.name }] },
    });
  },
});

const deleteTask = defineAction({
  name: "clockify_tasks_delete",
  description:
    "Delete a task (marks it DONE first, then deletes). Previews and requires confirmation.",
  featureGroup: WORK,
  risks: ["destructive"],
  schema: z.object({ projectId: z.string().min(1), id: z.string().min(1), name: z.string().optional() }),
  async handler(ctx, args) {
    return {
      kind: "preview",
      preview: {
        actionLabel: "Delete task",
        featureGroup: WORK,
        riskLabels: ["destructive"],
        targets: [{ type: "task", id: args.id, name: args.name }],
        expectedChanges: [`Delete task ${args.name ?? args.id}`],
        reversibility: "This cannot be undone.",
        warnings: ["Deleting a task is permanent."],
      },
      operation: {
        actionName: "clockify_tasks_delete",
        featureGroup: WORK,
        risks: ["destructive"],
        payload: { projectId: args.projectId, id: args.id, name: args.name },
      },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { projectId: string; id: string; name?: string };
    await ctx.clockify.deleteTask(payload.projectId, payload.id);
    return successReceipt({
      action: "clockify_tasks_delete",
      entity: "task",
      ids: { workspaceId: ctx.workspaceId, projectId: payload.projectId },
      changed: { deleted: [{ type: "task", id: payload.id, name: payload.name }] },
    });
  },
});

const rateUpdate = defineAction({
  name: "clockify_tasks_rate_update",
  description:
    "Set a task's billable hourly or cost rate. Billing action — previews and requires confirmation.",
  featureGroup: "invoices",
  risks: ["billing"],
  schema: z.object({
    projectId: z.string().min(1),
    taskId: z.string().min(1),
    rateKind: z.enum(["HOURLY", "COST"]),
    amount: z.number().nonnegative(),
    amountUnit: z.enum(["major", "minor"]).default("major"),
    since: z.string().optional(),
  }),
  async handler(ctx, args) {
    const amountMinor = args.amountUnit === "minor" ? Math.round(args.amount) : Math.round(args.amount * 100);
    return {
      kind: "preview",
      preview: {
        actionLabel: `Set task ${args.rateKind === "COST" ? "cost" : "hourly"} rate`,
        featureGroup: "invoices",
        riskLabels: ["billing"],
        targets: [{ type: "task", id: args.taskId }],
        expectedChanges: [`Set ${args.rateKind} rate to ${amountMinor} (minor units)`],
        reversibility: "You can set a new rate at any time; past entries keep their recorded rate.",
        warnings: ["This changes the billable amount of future entries on the task."],
      },
      operation: {
        actionName: "clockify_tasks_rate_update",
        featureGroup: "invoices",
        risks: ["billing"],
        payload: {
          projectId: args.projectId,
          taskId: args.taskId,
          rateKind: args.rateKind,
          amountMinor,
          since: args.since,
        },
      },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as {
      projectId: string;
      taskId: string;
      rateKind: "HOURLY" | "COST";
      amountMinor: number;
      since?: string;
    };
    await ctx.clockify.updateTaskRate(payload);
    return successReceipt({
      action: "clockify_tasks_rate_update",
      entity: "task",
      ids: { workspaceId: ctx.workspaceId, projectId: payload.projectId },
      changed: { updated: [{ type: "task", id: payload.taskId }] },
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
