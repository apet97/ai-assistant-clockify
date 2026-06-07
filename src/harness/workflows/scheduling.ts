import { z } from "zod";
import { defineAction, type ActionDefinition } from "../action.js";
import { successReceipt } from "../receipts.js";

/**
 * Typed scheduling workflows (goclmcp §2.10). Reads (list/get/totals) and
 * create (safe_write) execute immediately; update/delete/publish run
 * preview→commit. Risk classes: create = safe_write; update = high_risk_write;
 * delete = destructive; publish = external_side_effect (notifies assignees).
 * All gated by `scheduling`. Publish supersedes the generic clockify_manage_schedule.
 */

const SCHED = "scheduling" as const;
const seriesOption = z.enum(["ONLY_THIS", "ALL", "THIS_AND_FOLLOWING"]);

const listAssignments = defineAction({
  name: "clockify_scheduling_assignments_list",
  description: "List scheduling assignments in a date range (optional user/project filter).",
  featureGroup: SCHED,
  risks: ["read"],
  schema: z.object({ start: z.string().optional(), end: z.string().optional(), userId: z.string().optional(), projectId: z.string().optional() }),
  async handler(ctx, args) {
    const items = await ctx.clockify.listAssignments(args);
    return { kind: "receipt", receipt: successReceipt({ action: "clockify_scheduling_assignments_list", entity: "assignment", ids: { workspaceId: ctx.workspaceId }, data: { count: items.length, items } }) };
  },
});

const getAssignment = defineAction({
  name: "clockify_scheduling_assignments_get",
  description: "Fetch a single scheduling assignment by id.",
  featureGroup: SCHED,
  risks: ["read"],
  schema: z.object({ id: z.string().min(1) }),
  async handler(ctx, args) {
    const entity = await ctx.clockify.getAssignment(args.id);
    return { kind: "receipt", receipt: successReceipt({ action: "clockify_scheduling_assignments_get", entity: "assignment", ids: { workspaceId: ctx.workspaceId }, data: { entity } }) };
  },
});

const createAssignment = defineAction({
  name: "clockify_scheduling_assignments_create",
  description: "Create a scheduling assignment (draft). Safe write — executes immediately when policy allows.",
  featureGroup: SCHED,
  risks: ["safe_write"],
  schema: z.object({
    userId: z.string().min(1),
    projectId: z.string().min(1),
    start: z.string().min(1),
    end: z.string().min(1),
    hoursPerDay: z.number().min(0.5).max(24),
    note: z.string().optional(),
  }),
  async handler(ctx, args) {
    const assignment = await ctx.clockify.createAssignment(args);
    return { kind: "receipt", receipt: successReceipt({ action: "clockify_scheduling_assignments_create", entity: "assignment", ids: { workspaceId: ctx.workspaceId }, changed: { created: [{ type: "assignment", id: assignment.id }] } }) };
  },
});

const updateAssignment = defineAction({
  name: "clockify_scheduling_assignments_update",
  description: "Update a scheduling assignment. Elevated write — previews and requires confirmation.",
  featureGroup: SCHED,
  risks: ["high_risk_write"],
  schema: z
    .object({ id: z.string().min(1), hoursPerDay: z.number().min(0.5).max(24).optional(), note: z.string().optional(), seriesUpdateOption: seriesOption.optional() })
    .refine((v) => v.hoursPerDay !== undefined || v.note !== undefined, { message: "Provide hoursPerDay or note to change." }),
  async handler(ctx, args) {
    const patch = {
      ...(args.hoursPerDay !== undefined ? { hoursPerDay: args.hoursPerDay } : {}),
      ...(args.note !== undefined ? { note: args.note } : {}),
      ...(args.seriesUpdateOption !== undefined ? { seriesUpdateOption: args.seriesUpdateOption } : {}),
    };
    return {
      kind: "preview",
      preview: {
        actionLabel: "Update scheduling assignment",
        featureGroup: SCHED,
        riskLabels: ["high_risk_write"],
        targets: [{ type: "assignment", id: args.id }],
        expectedChanges: Object.keys(patch).map((k) => `set ${k}`),
        reversibility: "You can update the assignment again.",
        warnings: ["This changes a user's scheduled work."],
      },
      operation: { actionName: "clockify_scheduling_assignments_update", featureGroup: SCHED, risks: ["high_risk_write"], payload: { id: args.id, patch } },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { id: string; patch: Parameters<typeof ctx.clockify.updateAssignment>[1] };
    const updated = await ctx.clockify.updateAssignment(payload.id, payload.patch);
    return successReceipt({ action: "clockify_scheduling_assignments_update", entity: "assignment", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "assignment", id: updated.id }] } });
  },
});

const deleteAssignment = defineAction({
  name: "clockify_scheduling_assignments_delete",
  description: "Delete a scheduling assignment. Destructive — previews and requires confirmation.",
  featureGroup: SCHED,
  risks: ["destructive"],
  schema: z.object({ id: z.string().min(1), seriesUpdateOption: seriesOption.optional() }),
  async handler(ctx, args) {
    return {
      kind: "preview",
      preview: {
        actionLabel: "Delete scheduling assignment",
        featureGroup: SCHED,
        riskLabels: ["destructive"],
        targets: [{ type: "assignment", id: args.id }],
        expectedChanges: [`Delete scheduling assignment ${args.id}`],
        reversibility: "This cannot be undone.",
        warnings: ["Deleting an assignment removes scheduled work."],
      },
      operation: { actionName: "clockify_scheduling_assignments_delete", featureGroup: SCHED, risks: ["destructive"], payload: { id: args.id, seriesUpdateOption: args.seriesUpdateOption } },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { id: string; seriesUpdateOption?: string };
    await ctx.clockify.deleteAssignment(payload.id, payload.seriesUpdateOption);
    return successReceipt({ action: "clockify_scheduling_assignments_delete", entity: "assignment", ids: { workspaceId: ctx.workspaceId }, changed: { deleted: [{ type: "assignment", id: payload.id }] } });
  },
});

const publish = defineAction({
  name: "clockify_scheduling_publish",
  description: "Publish draft scheduling assignments in a date range. External side effect (notifies assignees) — previews and requires confirmation.",
  featureGroup: SCHED,
  risks: ["external_side_effect"],
  schema: z.object({ start: z.string().min(1), end: z.string().min(1), notifyUsers: z.boolean().optional() }),
  async handler(ctx, args) {
    return {
      kind: "preview",
      preview: {
        actionLabel: "Publish schedule",
        featureGroup: SCHED,
        riskLabels: ["external_side_effect"],
        targets: [],
        expectedChanges: [`Publish scheduled assignments ${args.start} → ${args.end}${args.notifyUsers ? " (notify users)" : ""}`],
        reversibility: "Publishing notifies assignees and is hard to reverse.",
        warnings: ["This publishes the schedule and may email affected users."],
      },
      operation: { actionName: "clockify_scheduling_publish", featureGroup: SCHED, risks: ["external_side_effect"], payload: { start: args.start, end: args.end, notifyUsers: args.notifyUsers } },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { start: string; end: string; notifyUsers?: boolean };
    await ctx.clockify.publishSchedule(payload);
    return successReceipt({ action: "clockify_scheduling_publish", entity: "schedule", ids: { workspaceId: ctx.workspaceId }, data: { published: true, start: payload.start, end: payload.end } });
  },
});

const projectTotals = defineAction({
  name: "clockify_scheduling_project_totals",
  description: "Get scheduled-hours totals per project in a date range.",
  featureGroup: SCHED,
  risks: ["read"],
  schema: z.object({ start: z.string().min(1), end: z.string().min(1), projectId: z.string().optional() }),
  async handler(ctx, args) {
    const items = await ctx.clockify.getProjectScheduleTotals(args);
    return { kind: "receipt", receipt: successReceipt({ action: "clockify_scheduling_project_totals", entity: "schedule", ids: { workspaceId: ctx.workspaceId }, data: { count: items.length, items } }) };
  },
});

const userTotals = defineAction({
  name: "clockify_scheduling_user_totals",
  description: "Get a user's scheduled-hours totals in a date range (defaults to you).",
  featureGroup: SCHED,
  risks: ["read"],
  schema: z.object({ userId: z.string().optional(), start: z.string().min(1), end: z.string().min(1) }),
  async handler(ctx, args) {
    const data = await ctx.clockify.getUserScheduleTotals(args.userId ?? ctx.adminUserId, { start: args.start, end: args.end });
    return { kind: "receipt", receipt: successReceipt({ action: "clockify_scheduling_user_totals", entity: "schedule", ids: { workspaceId: ctx.workspaceId }, data: { totals: data } }) };
  },
});

export const SCHEDULING_ACTIONS: ActionDefinition[] = [
  listAssignments,
  getAssignment,
  createAssignment,
  updateAssignment,
  deleteAssignment,
  publish,
  projectTotals,
  userTotals,
];
