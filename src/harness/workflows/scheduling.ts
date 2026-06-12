import { z } from "zod";
import {
  defineAction,
  defineReadAction,
  defineRiskyAction,
  type ActionContext,
  type ActionDefinition,
} from "../action.js";
import { successReceipt } from "../receipts.js";
import { describePatch, resolveEntityRef, resolveInstant, resolveUserRef } from "./resolve.js";

/**
 * Typed scheduling workflows (goclmcp §2.10). Reads (list/get/totals) and
 * create (safe_write) execute immediately; update/delete/publish run
 * preview→commit. Risk classes: create = safe_write; update = high_risk_write;
 * delete = destructive; publish = external_side_effect (notifies assignees).
 * All gated by `scheduling`. Publish supersedes the generic clockify_manage_schedule.
 */

const SCHED = "scheduling" as const;
const seriesOption = z.enum(["ONLY_THIS", "ALL", "THIS_AND_FOLLOWING"]);

/**
 * Every scheduling start/end is a `yyyy-MM-ddThh:mm:ssZ` instant on the wire
 * (OpenAPI: AssignmentCreateRequestV1 / PublishAssignmentsRequestV1 / the
 * assignments query params). The live loop sent relative words straight
 * through; resolve them server-side and STOP on anything unparseable.
 */
function resolveSchedulingWindow(
  ctx: ActionContext,
  args: { start?: string; end?: string },
): { ok: true; start?: string; end?: string } | { ok: false; message: string } {
  const now = (ctx.now ?? (() => new Date()))();
  const start = args.start !== undefined ? resolveInstant(now, args.start, "start") : undefined;
  const end = args.end !== undefined ? resolveInstant(now, args.end, "end") : undefined;
  const bad = [
    args.start !== undefined && start === undefined ? args.start : undefined,
    args.end !== undefined && end === undefined ? args.end : undefined,
  ].filter((value): value is string => value !== undefined);
  if (bad.length) {
    return {
      ok: false,
      message: `I couldn't make sense of the date${bad.length > 1 ? "s" : ""} ${bad.map((b) => `"${b}"`).join(" and ")} — give me a calendar date (YYYY-MM-DD) or something like today, tomorrow, or next monday.`,
    };
  }
  return { ok: true, start, end };
}

const listAssignments = defineAction({
  name: "clockify_scheduling_assignments_list",
  description:
    "List scheduling assignments in a date range (optional user/project filter). `start`/`end` accept YYYY-MM-DD, a full ISO instant, or a relative day (today/next monday…), resolved server-side.",
  featureGroup: SCHED,
  risks: ["read"],
  schema: z.object({ start: z.string().optional(), end: z.string().optional(), userId: z.string().optional(), projectId: z.string().optional() }),
  async handler(ctx, args) {
    const window = resolveSchedulingWindow(ctx, args);
    if (!window.ok) return { kind: "clarify", message: window.message };
    const items = await ctx.clockify.listAssignments({ ...args, start: window.start, end: window.end });
    return {
      kind: "receipt",
      receipt: successReceipt({ action: "clockify_scheduling_assignments_list", entity: "assignment", ids: { workspaceId: ctx.workspaceId }, data: { count: items.length, items } }),
    };
  },
});

const getAssignment = defineReadAction({
  name: "clockify_scheduling_assignments_get",
  description: "Fetch a single scheduling assignment by id.",
  group: SCHED,
  schema: z.object({ id: z.string().min(1) }),
  async handler(ctx, args) {
    const entity = await ctx.clockify.getAssignment(args.id);
    return successReceipt({ action: "clockify_scheduling_assignments_get", entity: "assignment", ids: { workspaceId: ctx.workspaceId }, data: { entity } });
  },
});

const createAssignment = defineAction({
  name: "clockify_scheduling_assignments_create",
  description:
    "Create a scheduling assignment (draft) for ONE user (Clockify scheduling is per-user — there is no group assignment). Pass `userId` and `projectId` as ids or exact names (or 'me' for the user) — resolved server-side, clarifies on an unknown one. `start`/`end` accept YYYY-MM-DD or a relative day (today/next monday…). Safe write — executes immediately when policy allows.",
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
    const window = resolveSchedulingWindow(ctx, args);
    if (!window.ok) return { kind: "clarify", message: window.message };
    const user = await resolveUserRef({ id: args.userId }, { verb: "schedule", adminUserId: ctx.adminUserId, listUsers: () => ctx.clockify.listUsers() });
    if (!user.ok) return { kind: "clarify", message: user.clarify.clarify, options: user.clarify.options };
    const project = await resolveEntityRef({ id: args.projectId }, { noun: "project", verb: "schedule on", list: (f) => ctx.clockify.listProjects(f) });
    if (!project.ok) return { kind: "clarify", message: project.clarify.clarify, options: project.clarify.options };
    const assignment = await ctx.clockify.createAssignment({
      ...args,
      userId: user.userId,
      projectId: project.id,
      start: window.start as string,
      end: window.end as string,
    });
    return { kind: "receipt", receipt: successReceipt({ action: "clockify_scheduling_assignments_create", entity: "assignment", ids: { workspaceId: ctx.workspaceId }, changed: { created: [{ type: "assignment", id: assignment.id }] } }) };
  },
});

const updateAssignment = defineRiskyAction({
  name: "clockify_scheduling_assignments_update",
  description: "Update a scheduling assignment. Elevated write — previews and requires confirmation.",
  group: SCHED,
  risks: ["high_risk_write"],
  schema: z
    .object({ id: z.string().min(1), hoursPerDay: z.number().min(0.5).max(24).optional(), note: z.string().optional(), seriesUpdateOption: seriesOption.optional() })
    .refine((v) => v.hoursPerDay !== undefined || v.note !== undefined, { message: "Provide hoursPerDay or note to change." }),
  async preview(_ctx, args) {
    const patch = {
      ...(args.hoursPerDay !== undefined ? { hoursPerDay: args.hoursPerDay } : {}),
      ...(args.note !== undefined ? { note: args.note } : {}),
      ...(args.seriesUpdateOption !== undefined ? { seriesUpdateOption: args.seriesUpdateOption } : {}),
    };
    return {
      actionLabel: "Update scheduling assignment",
      targets: [{ type: "assignment", id: args.id }],
      expectedChanges: describePatch(patch),
      reversibility: "You can update the assignment again.",
      warnings: ["This changes a user's scheduled work."],
      payload: { id: args.id, patch },
    };
  },
  async commit(ctx, payload) {
    const { id, patch } = payload as { id: string; patch: Parameters<typeof ctx.clockify.updateAssignment>[1] };
    const updated = await ctx.clockify.updateAssignment(id, patch);
    return successReceipt({ action: "clockify_scheduling_assignments_update", entity: "assignment", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "assignment", id: updated.id }] } });
  },
});

const deleteAssignment = defineRiskyAction({
  name: "clockify_scheduling_assignments_delete",
  description: "Delete a scheduling assignment. Destructive — previews and requires confirmation.",
  group: SCHED,
  risks: ["destructive"],
  schema: z.object({ id: z.string().min(1), seriesUpdateOption: seriesOption.optional() }),
  async preview(_ctx, args) {
    return {
      actionLabel: "Delete scheduling assignment",
      targets: [{ type: "assignment", id: args.id }],
      expectedChanges: [`Delete scheduling assignment ${args.id}`],
      reversibility: "This cannot be undone.",
      warnings: ["Deleting an assignment removes scheduled work."],
      payload: { id: args.id, seriesUpdateOption: args.seriesUpdateOption },
    };
  },
  async commit(ctx, payload) {
    const { id, seriesUpdateOption } = payload as { id: string; seriesUpdateOption?: string };
    await ctx.clockify.deleteAssignment(id, seriesUpdateOption);
    return successReceipt({ action: "clockify_scheduling_assignments_delete", entity: "assignment", ids: { workspaceId: ctx.workspaceId }, changed: { deleted: [{ type: "assignment", id }] } });
  },
});

const publish = defineRiskyAction({
  name: "clockify_scheduling_publish",
  description: "Publish draft scheduling assignments in a date range. External side effect (notifies assignees) — previews and requires confirmation.",
  group: SCHED,
  risks: ["external_side_effect"],
  schema: z.object({ start: z.string().min(1), end: z.string().min(1), notifyUsers: z.boolean().optional() }),
  async preview(ctx, args) {
    const window = resolveSchedulingWindow(ctx, args);
    if (!window.ok) return { clarify: window.message };
    const { start, end } = window as { start: string; end: string };
    return {
      actionLabel: "Publish schedule",
      targets: [],
      expectedChanges: [`Publish scheduled assignments ${start} → ${end}${args.notifyUsers ? " (notify users)" : ""}`],
      reversibility: "Publishing notifies assignees and is hard to reverse.",
      warnings: ["This publishes the schedule and may email affected users."],
      payload: { start, end, notifyUsers: args.notifyUsers },
    };
  },
  async commit(ctx, payload) {
    const { start, end, notifyUsers } = payload as { start: string; end: string; notifyUsers?: boolean };
    await ctx.clockify.publishSchedule({ start, end, notifyUsers });
    return successReceipt({ action: "clockify_scheduling_publish", entity: "schedule", ids: { workspaceId: ctx.workspaceId }, data: { published: true, start, end } });
  },
});

const projectTotals = defineAction({
  name: "clockify_scheduling_project_totals",
  description:
    "Get scheduled-hours totals per project in a date range (`start`/`end` accept relative days, resolved server-side). Filter to one project by `projectId` or its exact `projectName` (resolved server-side).",
  featureGroup: SCHED,
  risks: ["read"],
  schema: z.object({
    start: z.string().min(1),
    end: z.string().min(1),
    projectId: z.string().optional(),
    projectName: z.string().optional(),
  }),
  async handler(ctx, args) {
    const window = resolveSchedulingWindow(ctx, args);
    if (!window.ok) return { kind: "clarify", message: window.message };
    // A name in either filter slot resolves to a verified id; unknown clarifies.
    let projectId: string | undefined;
    if (args.projectId?.trim() || args.projectName?.trim()) {
      const project = await resolveEntityRef(
        { id: args.projectId, name: args.projectName },
        { noun: "project", verb: "total", list: (f) => ctx.clockify.listProjects(f) },
      );
      if (!project.ok) {
        return { kind: "clarify", message: project.clarify.clarify, options: project.clarify.options };
      }
      projectId = project.id;
    }
    const items = await ctx.clockify.getProjectScheduleTotals({
      projectId,
      start: window.start as string,
      end: window.end as string,
    });
    return {
      kind: "receipt",
      receipt: successReceipt({ action: "clockify_scheduling_project_totals", entity: "schedule", ids: { workspaceId: ctx.workspaceId }, data: { count: items.length, items } }),
    };
  },
});

const userTotals = defineAction({
  name: "clockify_scheduling_user_totals",
  description:
    "Get a user's scheduled-hours totals in a date range (defaults to you; `start`/`end` accept relative days, resolved server-side).",
  featureGroup: SCHED,
  risks: ["read"],
  schema: z.object({ userId: z.string().optional(), start: z.string().min(1), end: z.string().min(1) }),
  async handler(ctx, args) {
    const window = resolveSchedulingWindow(ctx, args);
    if (!window.ok) return { kind: "clarify", message: window.message };
    const data = await ctx.clockify.getUserScheduleTotals(args.userId ?? ctx.adminUserId, {
      start: window.start as string,
      end: window.end as string,
    });
    return {
      kind: "receipt",
      receipt: successReceipt({ action: "clockify_scheduling_user_totals", entity: "schedule", ids: { workspaceId: ctx.workspaceId }, data: { totals: data } }),
    };
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
