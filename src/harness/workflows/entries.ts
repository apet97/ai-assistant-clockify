import { z } from "zod";
import {
  defineReadAction,
  defineRiskyAction,
  type ActionDefinition,
} from "../action.js";
import { successReceipt, errorReceipt } from "../receipts.js";

/**
 * Typed time-entry workflows (goclmcp §2.1) that complement the existing
 * time-tracking actions (status/start/stop/log/review/fix). Reads (list/get)
 * execute immediately; delete and mark-invoiced are risky and preview→commit.
 * `mark_invoiced` is a billing state change, so it is gated by the `invoices`
 * feature group even though it operates on time entries.
 */

const listEntries = defineReadAction({
  name: "clockify_entries_list",
  description:
    "List time entries for a user (defaults to the caller). Optional date window and project/task filters.",
  group: "time_tracking",
  schema: z.object({
    userId: z.string().optional(),
    start: z.string().optional(),
    end: z.string().optional(),
    projectId: z.string().optional(),
    taskId: z.string().optional(),
  }),
  async handler(ctx, args) {
    const userId = args.userId ?? ctx.adminUserId;
    const items = await ctx.clockify.getEntries({
      userId,
      start: args.start,
      end: args.end,
      projectId: args.projectId,
      taskId: args.taskId,
    });
    return successReceipt({
      action: "clockify_entries_list",
      entity: "time_entry",
      ids: { workspaceId: ctx.workspaceId },
      data: { userId, count: items.length, items },
    });
  },
});

const getEntry = defineReadAction({
  name: "clockify_entries_get",
  description: "Fetch a single time entry by id.",
  group: "time_tracking",
  schema: z.object({ id: z.string().min(1) }),
  async handler(ctx, args) {
    const entry = await ctx.clockify.getEntry(args.id);
    return successReceipt({
      action: "clockify_entries_get",
      entity: "time_entry",
      ids: { workspaceId: ctx.workspaceId },
      data: { entry },
    });
  },
});

const deleteEntry = defineRiskyAction({
  name: "clockify_entries_delete",
  description: "Delete a time entry. Previews first and requires confirmation.",
  group: "time_tracking",
  risks: ["destructive"],
  schema: z.object({ id: z.string().min(1), description: z.string().optional() }),
  async preview(_ctx, args) {
    return {
      actionLabel: "Delete time entry",
      targets: [{ type: "time_entry", id: args.id, name: args.description }],
      expectedChanges: [`Delete time entry ${args.description ?? args.id}`],
      reversibility: "This cannot be undone.",
      warnings: ["Deleting a time entry is permanent."],
      payload: { id: args.id, description: args.description },
    };
  },
  async commit(ctx, payload) {
    const { id, description } = payload as { id: string; description?: string };
    if (!ctx.clockify.deleteEntity) {
      return errorReceipt({
        action: "clockify_entries_delete",
        code: "unsupported",
        message: "Delete is not supported by the configured Clockify client.",
      });
    }
    await ctx.clockify.deleteEntity({ entityType: "time_entry", id });
    return successReceipt({
      action: "clockify_entries_delete",
      entity: "time_entry",
      ids: { workspaceId: ctx.workspaceId },
      changed: { deleted: [{ type: "time_entry", id, name: description }] },
    });
  },
});

const markInvoiced = defineRiskyAction({
  name: "clockify_entries_mark_invoiced",
  description:
    "Mark (or unmark) a set of time entries as invoiced. Bulk billing change — previews first and requires confirmation.",
  group: "invoices",
  risks: ["bulk", "billing"],
  schema: z.object({
    ids: z.array(z.string().min(1)).min(1),
    invoiced: z.boolean(),
  }),
  async preview(_ctx, args) {
    return {
      actionLabel: `${args.invoiced ? "Mark" : "Unmark"} ${args.ids.length} entr${args.ids.length === 1 ? "y" : "ies"} invoiced`,
      targets: args.ids.map((id) => ({ type: "time_entry", id })),
      expectedChanges: [
        `Set invoiced=${args.invoiced} on ${args.ids.length} time entr${args.ids.length === 1 ? "y" : "ies"}`,
      ],
      reversibility: "You can re-run this action to flip the invoiced flag back.",
      warnings: ["This changes the billing/invoiced state of multiple entries at once."],
      payload: { ids: args.ids, invoiced: args.invoiced },
    };
  },
  async commit(ctx, payload) {
    const { ids, invoiced } = payload as { ids: string[]; invoiced: boolean };
    await ctx.clockify.markEntriesInvoiced({ ids, invoiced });
    return successReceipt({
      action: "clockify_entries_mark_invoiced",
      entity: "time_entry",
      ids: { workspaceId: ctx.workspaceId },
      changed: {
        updated: ids.map((id) => ({ type: "time_entry", id })),
      },
    });
  },
});

export const ENTRY_ACTIONS: ActionDefinition[] = [listEntries, getEntry, deleteEntry, markInvoiced];
