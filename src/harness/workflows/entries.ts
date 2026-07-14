import { z } from "zod";
import {
  clarifyResult,
  defineAction,
  defineRiskyAction,
  defineReadAction,
  type ActionDefinition,
} from "../action.js";
import { successReceipt, errorReceipt } from "../receipts.js";
import { resolveDateRange, resolveProjectTaskRefs, resolveUserFilter } from "./resolve.js";
import { nowDate } from "../../durations.js";

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
    "List time entries for a user (defaults to the caller; `userId` accepts a user id, exact name, or 'me'). `start`/`end` accept YYYY-MM-DD, a full ISO instant, or a relative day (today/yesterday/last monday…) resolved server-side. Optional project/task filters — pass an id or the exact name (`projectId`/`projectName`, `taskId`/`taskName`), resolved server-side.",
  featureGroup: "time_tracking",
  risks: ["read"],
  schema: z.object({
    userId: z.string().optional(),
    start: z.string().optional(),
    end: z.string().optional(),
    projectId: z.string().optional(),
    projectName: z.string().optional(),
    taskId: z.string().optional(),
    taskName: z.string().optional(),
  }),
  async handler(ctx, args) {
    // The user filter resolves id/name/'me' (clarifies on unknown), defaulting
    // to the caller.
    const user = await resolveUserFilter(args.userId, {
      verb: "list entries for",
      adminUserId: ctx.adminUserId,
      listUsers: () => ctx.clockify.listUsers(),
      defaultTo: ctx.adminUserId,
    });
    if (!user.ok) return clarifyResult(user.clarify);
    const userId = user.userId;
    // The wire wants yyyy-MM-ddThh:mm:ssZ instants; the live loop sent
    // `?start=today` 12× (400 every time). Both edges are optional with no
    // default; the shared resolver owns the per-edge resolveInstant, the
    // bad-date collection, and the clarify copy — only the hint tail is ours.
    const range = resolveDateRange(nowDate(ctx), {
      start: { raw: args.start },
      end: { raw: args.end },
      exampleHint: "today, yesterday, or last monday",
      timeZone: ctx.timeZone,
    });
    if (!range.ok) return { kind: "clarify", message: range.message };
    const { start, end } = range;
    // A name in either filter slot resolves to a verified id — an unknown
    // filter clarifies instead of a doomed (or silently-empty) wire call.
    const refs = await resolveProjectTaskRefs(args, {
      verb: "filter by",
      listProjects: (f) => ctx.clockify.listProjects(f),
      listTasks: (projectId) => ctx.clockify.listTasks(projectId),
    });
    if (!refs.ok) {
      return clarifyResult(refs.clarify);
    }
    const { entries: items, truncated } = await ctx.clockify.getEntries({
      userId,
      start,
      end,
      projectId: refs.projectId,
      taskId: refs.taskId,
    });
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_entries_list",
        entity: "time_entry",
        ids: { workspaceId: ctx.workspaceId },
        data: {
          userId,
          count: items.length,
          items,
          ...(truncated ? { truncated: true } : {}),
          ...(start !== undefined || end !== undefined ? { window: { start, end } } : {}),
        },
        // Mirror the exportInvoice precedent: a truncated list gets both a
        // data flag and an honest, actionable caveat for the model + admin.
        warnings: truncated
          ? [
              {
                code: "list_truncated",
                message: `Showing the first ${items.length} time entries (the maximum fetched at once); there may be more. Narrow the date window or add a project filter to see the rest.`,
              },
            ]
          : undefined,
      }),
    };
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
