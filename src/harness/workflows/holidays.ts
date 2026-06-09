import { z } from "zod";
import {
  defineAction,
  defineReadAction,
  defineRiskyAction,
  type ActionDefinition,
} from "../action.js";
import { successReceipt } from "../receipts.js";

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

const listInPeriod = defineReadAction({
  name: "clockify_holidays_in_period",
  description: "List holidays assigned to a user across a date period.",
  group: TOA,
  schema: z.object({ assignedTo: z.string().min(1), start: z.string().min(1), end: z.string().min(1) }),
  async handler(ctx, args) {
    const items = await ctx.clockify.listHolidaysInPeriod(args);
    return successReceipt({
      action: "clockify_holidays_in_period",
      entity: "holiday",
      ids: { workspaceId: ctx.workspaceId },
      data: { count: items.length, items },
    });
  },
});

const createHoliday = defineAction({
  name: "clockify_holidays_create",
  description:
    "Create a workspace holiday. Safe write — executes immediately when policy allows. Requires at least one user or user group assignment.",
  featureGroup: TOA,
  risks: ["safe_write"],
  schema: z
    .object({
      name: z.string().min(1),
      startDate: z.string().min(1), // YYYY-MM-DD
      endDate: z.string().optional(),
      occursAnnually: z.boolean().optional(),
      userIds: z.array(z.string().min(1)).optional(),
      userGroupIds: z.array(z.string().min(1)).optional(),
    })
    .refine((v) => (v.userIds?.length ?? 0) > 0 || (v.userGroupIds?.length ?? 0) > 0, {
      message: "A holiday needs at least one userIds or userGroupIds assignment.",
    }),
  async handler(ctx, args) {
    const holiday = await ctx.clockify.createHoliday(args);
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
  description: "Update a workspace holiday. Safe write — executes immediately when policy allows.",
  featureGroup: TOA,
  risks: ["safe_write"],
  schema: z
    .object({
      id: z.string().min(1),
      name: z.string().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      occursAnnually: z.boolean().optional(),
      userIds: z.array(z.string().min(1)).optional(),
      userGroupIds: z.array(z.string().min(1)).optional(),
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
    const { id, ...patch } = args;
    const holiday = await ctx.clockify.updateHoliday(id, patch);
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
