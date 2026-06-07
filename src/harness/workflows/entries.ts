import { z } from "zod";
import { defineAction, type ActionDefinition } from "../action.js";
import { successReceipt, errorReceipt } from "../receipts.js";

/**
 * Typed time-entry workflows (goclmcp §2.1) that complement the existing
 * time-tracking actions (status/start/stop/log/review/fix). Reads (list/get)
 * execute immediately; delete and mark-invoiced are risky and preview→commit.
 * `mark_invoiced` is a billing state change, so it is gated by the `invoices`
 * feature group even though it operates on time entries.
 */

const listEntries = defineAction({
  name: "clockify_entries_list",
  description:
    "List time entries for a user (defaults to the caller). Optional date window and project/task filters.",
  featureGroup: "time_tracking",
  risks: ["read"],
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
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_entries_list",
        entity: "time_entry",
        ids: { workspaceId: ctx.workspaceId },
        data: { userId, count: items.length, items },
      }),
    };
  },
});

const getEntry = defineAction({
  name: "clockify_entries_get",
  description: "Fetch a single time entry by id.",
  featureGroup: "time_tracking",
  risks: ["read"],
  schema: z.object({ id: z.string().min(1) }),
  async handler(ctx, args) {
    const entry = await ctx.clockify.getEntry(args.id);
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_entries_get",
        entity: "time_entry",
        ids: { workspaceId: ctx.workspaceId },
        data: { entry },
      }),
    };
  },
});

const deleteEntry = defineAction({
  name: "clockify_entries_delete",
  description: "Delete a time entry. Previews first and requires confirmation.",
  featureGroup: "time_tracking",
  risks: ["destructive"],
  schema: z.object({ id: z.string().min(1), description: z.string().optional() }),
  async handler(ctx, args) {
    return {
      kind: "preview",
      preview: {
        actionLabel: "Delete time entry",
        featureGroup: "time_tracking",
        riskLabels: ["destructive"],
        targets: [{ type: "time_entry", id: args.id, name: args.description }],
        expectedChanges: [`Delete time entry ${args.description ?? args.id}`],
        reversibility: "This cannot be undone.",
        warnings: ["Deleting a time entry is permanent."],
      },
      operation: {
        actionName: "clockify_entries_delete",
        featureGroup: "time_tracking",
        risks: ["destructive"],
        payload: { id: args.id, description: args.description },
      },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { id: string; description?: string };
    if (!ctx.clockify.deleteEntity) {
      return errorReceipt({
        action: "clockify_entries_delete",
        code: "unsupported",
        message: "Delete is not supported by the configured Clockify client.",
      });
    }
    await ctx.clockify.deleteEntity({ entityType: "time_entry", id: payload.id });
    return successReceipt({
      action: "clockify_entries_delete",
      entity: "time_entry",
      ids: { workspaceId: ctx.workspaceId },
      changed: { deleted: [{ type: "time_entry", id: payload.id, name: payload.description }] },
    });
  },
});

const markInvoiced = defineAction({
  name: "clockify_entries_mark_invoiced",
  description:
    "Mark (or unmark) a set of time entries as invoiced. Bulk billing change — previews first and requires confirmation.",
  featureGroup: "invoices",
  risks: ["bulk", "billing"],
  schema: z.object({
    ids: z.array(z.string().min(1)).min(1),
    invoiced: z.boolean(),
  }),
  async handler(ctx, args) {
    return {
      kind: "preview",
      preview: {
        actionLabel: `${args.invoiced ? "Mark" : "Unmark"} ${args.ids.length} entr${args.ids.length === 1 ? "y" : "ies"} invoiced`,
        featureGroup: "invoices",
        riskLabels: ["bulk", "billing"],
        targets: args.ids.map((id) => ({ type: "time_entry", id })),
        expectedChanges: [
          `Set invoiced=${args.invoiced} on ${args.ids.length} time entr${args.ids.length === 1 ? "y" : "ies"}`,
        ],
        reversibility: "You can re-run this action to flip the invoiced flag back.",
        warnings: ["This changes the billing/invoiced state of multiple entries at once."],
      },
      operation: {
        actionName: "clockify_entries_mark_invoiced",
        featureGroup: "invoices",
        risks: ["bulk", "billing"],
        payload: { ids: args.ids, invoiced: args.invoiced },
      },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { ids: string[]; invoiced: boolean };
    await ctx.clockify.markEntriesInvoiced({ ids: payload.ids, invoiced: payload.invoiced });
    return successReceipt({
      action: "clockify_entries_mark_invoiced",
      entity: "time_entry",
      ids: { workspaceId: ctx.workspaceId },
      changed: {
        updated: payload.ids.map((id) => ({ type: "time_entry", id })),
      },
    });
  },
});

export const ENTRY_ACTIONS: ActionDefinition[] = [listEntries, getEntry, deleteEntry, markInvoiced];
