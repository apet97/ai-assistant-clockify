import { z } from "zod";
import { zStringList } from "../arg-shapes.js";
import {
  defineAction,
  defineReadAction,
  defineRiskyAction,
  type ActionContext,
  type ActionDefinition,
  type ActionResult,
  type ClarifyOption,
} from "../action.js";
import { successReceipt } from "../receipts.js";
import { resolveEntityRef, resolveGroupRefs, resolveInstant, resolveRelativeDay, resolveUserFilter, resolveUserRefs } from "./resolve.js";

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
 * Resolve a holiday's `startDate`/`endDate` server-side (CLAUDE.md "dates
 * server-side" invariant) — the model must never compute a calendar date. Each
 * provided value resolves to a real YYYY-MM-DD via resolveRelativeDay (absolute
 * dates pass through, relative days like "next monday" resolve, a real-day check
 * rejects 2026-02-30); an unparseable/fabricated value clarifies instead of
 * sending a string the wire would reject (or silently mis-date). Undefined inputs
 * stay undefined (update may change neither).
 */
function resolveHolidayDates(
  ctx: ActionContext,
  startDate: string | undefined,
  endDate: string | undefined,
): { ok: true; startDate?: string; endDate?: string } | { ok: false; clarify: ActionResult } {
  const now = (ctx.now ?? (() => new Date()))();
  const bad: string[] = [];
  const resolvedStart = startDate !== undefined ? resolveRelativeDay(now, { date: startDate }) : undefined;
  if (startDate !== undefined && resolvedStart === undefined) bad.push(`start date "${startDate}"`);
  const resolvedEnd = endDate !== undefined ? resolveRelativeDay(now, { date: endDate }) : undefined;
  if (endDate !== undefined && resolvedEnd === undefined) bad.push(`end date "${endDate}"`);
  if (bad.length) {
    return {
      ok: false,
      clarify: {
        kind: "clarify",
        message: `I couldn't make sense of the ${bad.join(" or ")}. Use a real date like 2026-12-25 or a relative day like "next monday".`,
      },
    };
  }
  return { ok: true, startDate: resolvedStart, endDate: resolvedEnd };
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

const getHoliday = defineAction({
  name: "clockify_holidays_get",
  description: "Fetch a single holiday by id, or by its exact `name` (resolved server-side).",
  featureGroup: TOA,
  risks: ["read"],
  schema: z
    .object({ id: z.string().min(1).optional(), name: z.string().min(1).optional() })
    .refine((v) => v.id !== undefined || v.name !== undefined, {
      message: "Provide the holiday id or its exact name.",
    }),
  async handler(ctx, args) {
    const resolved = await resolveEntityRef(args, {
      noun: "holiday",
      verb: "fetch",
      list: () => ctx.clockify.listHolidays(),
    });
    if (!resolved.ok) {
      return { kind: "clarify", message: resolved.clarify.clarify, options: resolved.clarify.options };
    }
    const entity = await ctx.clockify.getHoliday(resolved.id);
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_holidays_get",
        entity: "holiday",
        ids: { workspaceId: ctx.workspaceId },
        data: { entity },
      }),
    };
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
    // Dates server-side (CLAUDE.md invariant): the model never computes calendar
    // dates. Resolve relative/absolute days to a real YYYY-MM-DD; an unparseable
    // value clarifies rather than fabricating a date the wire would reject.
    const dates = resolveHolidayDates(ctx, args.startDate, args.endDate);
    if (!dates.ok) return dates.clarify;
    if (dates.startDate === undefined) {
      // The schema requires startDate; this also guards a whitespace-only value.
      return { kind: "clarify", message: 'A holiday needs a start date like 2026-12-25 or "next monday".' };
    }
    const holiday = await ctx.clockify.createHoliday({
      name: args.name,
      startDate: dates.startDate,
      ...(dates.endDate !== undefined ? { endDate: dates.endDate } : {}),
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

// Map a clarify-shaped ActionResult from the resolvers into the risky-preview
// clarify shape (the preview callback returns { clarify, options? }, not a receipt).
function toRiskyClarify(result: ActionResult): { clarify: string; options?: ClarifyOption[] } {
  return result.kind === "clarify"
    ? { clarify: result.message, ...(result.options ? { options: result.options } : {}) }
    : { clarify: "Please clarify the holiday details." };
}

const updateHoliday = defineRiskyAction({
  name: "clockify_holidays_update",
  description:
    "Update a workspace holiday (name, dates, recurrence, or who it applies to). `userIds`/`userGroupIds` entries may be ids, exact names, or 'me' — resolved server-side, clarifies on an unknown one. Editing overwrites live workspace data, so it previews and requires confirmation.",
  group: TOA,
  // Editing an existing holiday overwrites live data for everyone assigned and has no
  // undo — same class as every other *_update, so preview→button-confirm (was wrongly
  // shipping as safe_write / immediate; enterprise-audit safety fix).
  risks: ["high_risk_write"],
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
  async preview(ctx, args) {
    const assign = await resolveHolidayAssignment(ctx, args);
    if (!assign.ok) return toRiskyClarify(assign.clarify);
    // Dates server-side: resolve a relative/absolute change to a real day; an
    // unparseable value clarifies (never reaches the wire as-is).
    const dates = resolveHolidayDates(ctx, args.startDate, args.endDate);
    if (!dates.ok) return toRiskyClarify(dates.clarify);
    const { id, userIds: _userIds, userGroupIds: _userGroupIds, startDate: _startDate, endDate: _endDate, ...rest } = args;
    const body: Record<string, unknown> = {
      ...rest,
      ...(dates.startDate !== undefined ? { startDate: dates.startDate } : {}),
      ...(dates.endDate !== undefined ? { endDate: dates.endDate } : {}),
      ...(assign.userIds?.length ? { userIds: assign.userIds } : {}),
      ...(assign.userGroupIds?.length ? { userGroupIds: assign.userGroupIds } : {}),
    };
    const changes: string[] = [];
    if (rest.name !== undefined) changes.push(`Rename to "${rest.name}"`);
    if (dates.startDate !== undefined) changes.push(`Start date → ${dates.startDate}`);
    if (dates.endDate !== undefined) changes.push(`End date → ${dates.endDate}`);
    if (rest.occursAnnually !== undefined) changes.push(`Recurs annually → ${rest.occursAnnually}`);
    if (assign.userIds?.length || assign.userGroupIds?.length) {
      changes.push(`Reassign to ${assign.userIds?.length ?? 0} user(s) + ${assign.userGroupIds?.length ?? 0} group(s)`);
    }
    return {
      actionLabel: "Update holiday",
      targets: [{ type: "holiday", id, name: args.name }],
      expectedChanges: changes.length ? changes : ["Update holiday"],
      reversibility: "Editing overwrites the holiday's current values; there is no undo.",
      warnings: ["This affects everyone assigned to the holiday."],
      payload: { id, body },
    };
  },
  async commit(ctx, payload) {
    const { id, body } = payload as { id: string; body: Record<string, unknown> };
    const holiday = await ctx.clockify.updateHoliday(id, body);
    return successReceipt({
      action: "clockify_holidays_update",
      entity: "holiday",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "holiday", id: holiday.id, name: holiday.name }] },
    });
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
