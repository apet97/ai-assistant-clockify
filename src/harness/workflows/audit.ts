import { z } from "zod";
import { defineAction, type ActionContext, type ActionDefinition } from "../action.js";
import { successReceipt } from "../receipts.js";
import { SEVEN_DAYS_MS } from "../../durations.js";

/**
 * Typed audit workflows (goclmcp §2.15). Both reads. The audit-log search runs on
 * the AUDIT host; the entity-changes feed on the primary host. Results are
 * byte-capped (no silent truncation). Gated by `audit_log`. NOTE: the production
 * add-on-token clearance for the audit host is unverified (no LIVE_ADDON_TOKEN);
 * the API-key dev path is spike-confirmed.
 */

const AUD = "audit_log" as const;
const AUDIT_MAX_BYTES = 200_000;

/** A representative subset of the audit-log action enum (Clockify accepts the full set). */
const auditAction = z.enum([
  "CREATE_TIME_PERSONAL_MANUAL", "UPDATE_TIME_PERSONAL", "DELETE_TIME_PERSONAL", "CREATE_TIME_FOR_OTHER",
  "CREATE_PROJECT", "UPDATE_PROJECT", "DELETE_PROJECT",
  "CREATE_TASK", "UPDATE_TASK", "DELETE_TASK",
  "CREATE_CLIENT", "UPDATE_CLIENT", "DELETE_CLIENT",
  "CREATE_TAG", "UPDATE_TAG", "DELETE_TAG",
  "CREATE_EXPENSE", "UPDATE_EXPENSE", "DELETE_EXPENSE",
]);

function capRows(rows: unknown[]): { data?: unknown[]; count: number; bytes: number; truncated: boolean } {
  const bytes = Buffer.byteLength(JSON.stringify(rows), "utf8");
  return bytes > AUDIT_MAX_BYTES
    ? { count: rows.length, bytes, truncated: true }
    : { data: rows, count: rows.length, bytes, truncated: false };
}

/** Every audit action in the enum — the default when the planner names none. */
const ALL_AUDIT_ACTIONS = auditAction.options;

const search = defineAction({
  name: "clockify_audit_logs_search",
  description: "Search the workspace audit log for create/update/delete actions in a date range (≤31 days). Defaults to all tracked actions over the last 7 days when not specified.",
  featureGroup: AUD,
  risks: ["read"],
  // actions/start/end are optional: the planner often omits them (it can't see the
  // schema), so default to all actions over the last 7 days rather than dead-ending
  // on `invalid_args`. A provided (but empty) actions list is still rejected.
  schema: z.object({
    actions: z.array(auditAction).min(1).optional(),
    start: z.string().min(1).optional(),
    end: z.string().min(1).optional(),
    page: z.number().int().positive().optional(),
  }),
  async handler(ctx: ActionContext, args) {
    const end = args.end ?? (ctx.now ?? (() => new Date()))().toISOString();
    const start = args.start ?? new Date(Date.parse(end) - SEVEN_DAYS_MS).toISOString();
    const rows = await ctx.clockify.searchAuditLog({
      actions: args.actions ?? ALL_AUDIT_ACTIONS,
      start,
      end,
      page: args.page,
    });
    const capped = capRows(rows);
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_audit_logs_search",
        entity: "audit_log",
        ids: { workspaceId: ctx.workspaceId },
        data: { count: capped.count, bytes: capped.bytes, truncated: capped.truncated, entries: capped.data },
        warnings: capped.truncated ? [{ code: "audit_truncated", message: `Audit result is ${capped.bytes} bytes, over the inline cap; narrow the date range or fewer actions.` }] : undefined,
      }),
    };
  },
});

const entityChanges = defineAction({
  name: "clockify_entity_changes_list",
  description: "List recently created/updated/deleted entities (experimental change-tracking feed).",
  featureGroup: AUD,
  risks: ["read"],
  schema: z.object({ changeType: z.enum(["created", "updated", "deleted"]) }),
  async handler(ctx, args) {
    const rows = await ctx.clockify.listEntityChanges(args.changeType);
    const capped = capRows(rows);
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_entity_changes_list",
        entity: "audit_log",
        ids: { workspaceId: ctx.workspaceId },
        data: { changeType: args.changeType, count: capped.count, bytes: capped.bytes, truncated: capped.truncated, entities: capped.data },
        warnings: capped.truncated ? [{ code: "audit_truncated", message: `Change feed is ${capped.bytes} bytes, over the inline cap.` }] : undefined,
      }),
    };
  },
});

export const AUDIT_ACTIONS: ActionDefinition[] = [search, entityChanges];
