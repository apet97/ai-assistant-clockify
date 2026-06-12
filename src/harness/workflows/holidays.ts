import { z } from "zod";
import { zStringList } from "../arg-shapes.js";
import {
  defineAction,
  defineReadAction,
  defineRiskyAction,
  type ActionContext,
  type ActionDefinition,
  type ActionResult,
} from "../action.js";
import { successReceipt } from "../receipts.js";
import { resolveGroupRefs, resolveInstant, resolveUserFilter, resolveUserRefs } from "./resolve.js";

/**
 * Resolve a holiday's `userIds` (names/'me'/ids) and `userGroupIds` (names/ids) to
 * real ids at the handler entry, so a name never reaches the wire (it would 400 /
 * silently mis-assign). Returns the resolved ids, or a `clarify` ActionResult to
 * return directly. Both lists are verified against the real users/groups.
 */
async function resolveHolidayAssignment(
  ctx: ActionContext,
  args: { userIds?: string[]; userGroupIds?: string[] },
): Promise<{ ok: true; userIds?: string[]; userGroupIds?: string[] } | { ok: false; clarify: ActionResult }> {
  let userIds: string[] | undefined;
  let userGroupIds: string[] | undefined;
  if (args.userIds?.length) {
    const r = await resolveUserRefs(args.userIds, { verb: "assign the holiday to", adminUserId: ctx.adminUserId, listUsers: () => ctx.clockify.listUsers(), verifyIds: true });
    if (!r.ok) return { ok: false, clarify: { kind: "clarify", message: r.clarify.clarify, options: r.clarify.options } };
    userIds = r.userIds;
  }
  if (args.userGroupIds?.length) {
    const r = await resolveGroupRefs(args.userGroupIds, { verb: "assign the holiday to", listGroups: () => ctx.clockify.listGroups() });
    if (!r.ok) return { ok: false, clarify: { kind: "clarify", message: r.clarify.clarify, options: r.clarify.options } };
    userGroupIds = r.groupIds;
  }
  return { ok: true, userIds, userGroupIds };
}

/**
 * Typed holiday workflows (goclmcp §2.9 — holidays). Reads (list/get/in-period)
 * and create/update execute immediately (safe_write, matching how named
 * work-structure resources are created); delete is destructive (preview→commit).
 * All gated by `time_off_approvals`. Clockify rejects a holiday with no
 * assignment, so create requires at least one user or user group.
 */

const TOA = "time_off_approvals" as const;

const listHolidays = defineReadAction({
  name: "clockify_holidays_list",
  description: "List the workspace holidays.",
  group: TOA,
  schema: z.object({}),
  async handler(ctx) {
    const items = await ctx.clockify.listHolidays();
    return successReceipt({
      action: "clockify_holidays_list",
      entity: "holiday",
      ids: { workspaceId: ctx.workspaceId },
      data: { count: items.length, items },
    });
  },
});

const getHoliday = defineReadAction({
  name: "clockify_holidays_get",
  description: "Fetch a single holiday by id.",
  group: TOA,
  schema: z.object({ id: z.string().min(1) }),
  async handler(ctx, args) {
    const entity = await ctx.clockify.getHoliday(args.id);
    return successReceipt({
      action: "clockify_holidays_get",
      entity: "holiday",
      ids: { workspaceId: ctx.workspaceId },
      data: { entity },
    });
  },
});

const listInPeriod = defineAction({
  name: "clockify_holidays_in_period",
  description:
    "List holidays assigned to a user across a date period (defaults to you; `assignedTo` accepts a user id, exact name, or 'me'). `start`/`end` accept YYYY-MM-DD or a relative day/period (today, next month…), resolved server-side.",
  featureGroup: TOA,
  risks: ["read"],
  schema: z.object({ assignedTo: z.string().optional(), start: z.string().min(1), end: z.string().min(1) }),
  async handler(ctx, args) {
    // The user slot resolves id/name/'me' (the user-sweep missed this one);
    // the dates resolve server-side — a relative word must never reach the wire.
    const user = await resolveUserFilter(args.assignedTo, {
      verb: "list holidays for",
      adminUserId: ctx.adminUserId,
      listUsers: () => ctx.clockify.listUsers(),
      defaultTo: ctx.adminUserId,
    });
    if (!user.ok) return { kind: "clarify", message: user.clarify.clarify, options: user.clarify.options };
    const now = (ctx.now ?? (() => new Date()))();
    const start = resolveInstant(now, args.start, "start");
    const end = resolveInstant(now, args.end, "end");
    const bad = [
      start === undefined ? args.start : undefined,
      end === undefined ? args.end : undefined,
    ].filter((value): value is string => value !== undefined);
    if (bad.length || start === undefined || end === undefined) {
      return {
        kind: "clarify",
        message: `I couldn't make sense of the date${bad.length > 1 ? "s" : ""} ${bad.map((b) => `"${b}"`).join(" and ")} — give me a calendar date (YYYY-MM-DD) or something like today, next monday, or next month.`,
      };
    }
    const items = await ctx.clockify.listHolidaysInPeriod({ assignedTo: user.userId as string, start, end });
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_holidays_in_period",
        entity: "holiday",
        ids: { workspaceId: ctx.workspaceId },
        data: { count: items.length, items },
      }),
    };
  },
});

const createHoliday = defineAction({
  name: "clockify_holidays_create",
  description:
    "Create a workspace holiday. Assign it with `userIds` and/or `userGroupIds` — each entry is an id, an exact name, or 'me' (groups by id or exact name); the harness resolves names server-side and clarifies on an unknown one. Safe write — executes immediately when policy allows. Requires at least one user or user group assignment.",
  featureGroup: TOA,
  risks: ["safe_write"],
  schema: z
    .object({
      name: z.string().min(1),
      startDate: z.string().min(1), // YYYY-MM-DD
      endDate: z.string().optional(),
      occursAnnually: z.boolean().optional(),
      userIds: zStringList().optional(),
      userGroupIds: zStringList().optional(),
    })
    .refine((v) => (v.userIds?.length ?? 0) > 0 || (v.userGroupIds?.length ?? 0) > 0, {
      message: "A holiday needs at least one userIds or userGroupIds assignment.",
    }),
  async handler(ctx, args) {
    const assign = await resolveHolidayAssignment(ctx, args);
    if (!assign.ok) return assign.clarify;
    const holiday = await ctx.clockify.createHoliday({
      name: args.name,
      startDate: args.startDate,
      ...(args.endDate !== undefined ? { endDate: args.endDate } : {}),
      ...(args.occursAnnually !== undefined ? { occursAnnually: args.occursAnnually } : {}),
      ...(assign.userIds?.length ? { userIds: assign.userIds } : {}),
      ...(assign.userGroupIds?.length ? { userGroupIds: assign.userGroupIds } : {}),
    });
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_holidays_create",
        entity: "holiday",
        ids: { workspaceId: ctx.workspaceId },
        changed: { created: [{ type: "holiday", id: holiday.id, name: holiday.name }] },
      }),
    };
  },
});

const updateHoliday = defineAction({
  name: "clockify_holidays_update",
  description:
    "Update a workspace holiday. `userIds`/`userGroupIds` entries may be ids, exact names, or 'me' — resolved server-side, clarifies on an unknown one. Safe write — executes immediately when policy allows.",
  featureGroup: TOA,
  risks: ["safe_write"],
  schema: z
    .object({
      id: z.string().min(1),
      name: z.string().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      occursAnnually: z.boolean().optional(),
      userIds: zStringList().optional(),
      userGroupIds: zStringList().optional(),
    })
    .refine(
      (v) =>
        v.name !== undefined ||
        v.startDate !== undefined ||
        v.endDate !== undefined ||
        v.occursAnnually !== undefined ||
        v.userIds !== undefined ||
        v.userGroupIds !== undefined,
      { message: "Provide at least one field to change." },
    ),
  async handler(ctx, args) {
    const assign = await resolveHolidayAssignment(ctx, args);
    if (!assign.ok) return assign.clarify;
    const { id, userIds: _userIds, userGroupIds: _userGroupIds, ...rest } = args;
    const holiday = await ctx.clockify.updateHoliday(id, {
      ...rest,
      ...(assign.userIds?.length ? { userIds: assign.userIds } : {}),
      ...(assign.userGroupIds?.length ? { userGroupIds: assign.userGroupIds } : {}),
    });
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_holidays_update",
        entity: "holiday",
        ids: { workspaceId: ctx.workspaceId },
        changed: { updated: [{ type: "holiday", id: holiday.id, name: holiday.name }] },
      }),
    };
  },
});

const deleteHoliday = defineRiskyAction({
  name: "clockify_holidays_delete",
  description: "Delete a workspace holiday. Destructive — previews and requires confirmation.",
  group: TOA,
  risks: ["destructive"],
  schema: z.object({ id: z.string().min(1), name: z.string().optional() }),
  async preview(_ctx, args) {
    return {
      actionLabel: "Delete holiday",
      targets: [{ type: "holiday", id: args.id, name: args.name }],
      expectedChanges: [`Delete holiday ${args.name ?? args.id}`],
      reversibility: "This cannot be undone.",
      warnings: ["Deleting a holiday affects everyone assigned to it."],
      payload: { id: args.id, name: args.name },
    };
  },
  async commit(ctx, payload) {
    const { id, name } = payload as { id: string; name?: string };
    await ctx.clockify.deleteHoliday(id);
    return successReceipt({
      action: "clockify_holidays_delete",
      entity: "holiday",
      ids: { workspaceId: ctx.workspaceId },
      changed: { deleted: [{ type: "holiday", id, name }] },
    });
  },
});

export const HOLIDAY_ACTIONS: ActionDefinition[] = [
  listHolidays,
  getHoliday,
  listInPeriod,
  createHoliday,
  updateHoliday,
  deleteHoliday,
];
