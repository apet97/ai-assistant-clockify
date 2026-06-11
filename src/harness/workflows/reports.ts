import { z } from "zod";
import { defineAction, type ActionContext, type ActionDefinition } from "../action.js";
import { successReceipt } from "../receipts.js";
import { resolveInstant } from "./resolve.js";
import { SEVEN_DAYS_MS } from "../../durations.js";

/**
 * Typed report workflows (goclmcp §2.14). All reads on the REPORTS host. Reports
 * can be large, so the result is byte-capped: if the serialized JSON exceeds the
 * inline cap, it is omitted with an explicit `truncated` warning (no silent cap).
 * Gated by `reports`. The reports host authenticates with the production
 * X-Addon-Token (same routing + auth header as the api host); the dev API key
 * also works.
 */

const REP = "reports" as const;

/** Largest report carried inline in a receipt (serialized JSON bytes). */
const REPORT_MAX_BYTES = 200_000;

// The date range is optional: the planner often omits it (it can't see the
// schema), so default to the last 7 days through now rather than dead-ending on
// `invalid_args`. An explicit range still wins. Relative values (today /
// yesterday / last monday / YYYY-MM-DD) are resolved server-side — the live
// loop sent the words straight through and the reports host 400'd "Invalid
// date!"; an unresolvable value clarifies, it never reaches the wire.
const rangeSchema = z.object({
  dateRangeStart: z.string().min(1).optional(),
  dateRangeEnd: z.string().min(1).optional(),
});

type ResolvedRange =
  | { ok: true; range: { dateRangeStart: string; dateRangeEnd: string } }
  | { ok: false; message: string };

function resolveRange(
  ctx: ActionContext,
  args: { dateRangeStart?: string; dateRangeEnd?: string },
): ResolvedRange {
  const now = (ctx.now ?? (() => new Date()))();
  const end = args.dateRangeEnd !== undefined ? resolveInstant(now, args.dateRangeEnd, "end") : now.toISOString();
  const start =
    args.dateRangeStart !== undefined
      ? resolveInstant(now, args.dateRangeStart, "start")
      : end !== undefined
        ? new Date(Date.parse(end) - SEVEN_DAYS_MS).toISOString()
        : undefined;
  const bad = [
    args.dateRangeStart !== undefined && start === undefined ? args.dateRangeStart : undefined,
    args.dateRangeEnd !== undefined && end === undefined ? args.dateRangeEnd : undefined,
  ].filter((value): value is string => value !== undefined);
  if (bad.length || start === undefined || end === undefined) {
    return {
      ok: false,
      message: `I couldn't make sense of the date${bad.length > 1 ? "s" : ""} ${bad.map((b) => `"${b}"`).join(" and ")} — give me a calendar date (YYYY-MM-DD) or something like today, yesterday, or last monday.`,
    };
  }
  return { ok: true, range: { dateRangeStart: start, dateRangeEnd: end } };
}

/** Cap a report payload; returns {data} or {bytes, truncated} + a warning flag. */
function capReport(data: unknown): { data?: unknown; bytes: number; truncated: boolean } {
  const bytes = Buffer.byteLength(JSON.stringify(data ?? null), "utf8");
  return bytes > REPORT_MAX_BYTES ? { bytes, truncated: true } : { data, bytes, truncated: false };
}

function reportReceipt(action: string, workspaceId: string, data: unknown) {
  const capped = capReport(data);
  return successReceipt({
    action,
    entity: "report",
    ids: { workspaceId },
    data: { bytes: capped.bytes, truncated: capped.truncated, report: capped.data },
    warnings: capped.truncated
      ? [{ code: "report_truncated", message: `Report is ${capped.bytes} bytes, over the inline cap; narrow the date range or use the Clockify UI export.` }]
      : undefined,
  });
}

const summary = defineAction({
  name: "clockify_reports_summary",
  description: "Run a summary report for a date range (grouped, defaults to PROJECT).",
  featureGroup: REP,
  risks: ["read"],
  schema: rangeSchema.extend({ groups: z.array(z.enum(["PROJECT", "CLIENT", "TASK", "TAG", "USER", "DATE"])).optional() }),
  async handler(ctx, args) {
    const resolved = resolveRange(ctx, args);
    if (!resolved.ok) return { kind: "clarify", message: resolved.message };
    const data = await ctx.clockify.summaryReport(resolved.range, args.groups);
    return { kind: "receipt", receipt: reportReceipt("clockify_reports_summary", ctx.workspaceId, data) };
  },
});

const detailed = defineAction({
  name: "clockify_reports_detailed",
  description: "Run a detailed (entry-level) report for a date range.",
  featureGroup: REP,
  risks: ["read"],
  schema: rangeSchema,
  async handler(ctx, args) {
    const resolved = resolveRange(ctx, args);
    if (!resolved.ok) return { kind: "clarify", message: resolved.message };
    const data = await ctx.clockify.detailedReport(resolved.range);
    return { kind: "receipt", receipt: reportReceipt("clockify_reports_detailed", ctx.workspaceId, data) };
  },
});

const weekly = defineAction({
  name: "clockify_reports_weekly",
  description: "Run a weekly report for a date range.",
  featureGroup: REP,
  risks: ["read"],
  schema: rangeSchema,
  async handler(ctx, args) {
    const resolved = resolveRange(ctx, args);
    if (!resolved.ok) return { kind: "clarify", message: resolved.message };
    const data = await ctx.clockify.weeklyReport(resolved.range);
    return { kind: "receipt", receipt: reportReceipt("clockify_reports_weekly", ctx.workspaceId, data) };
  },
});

export const REPORT_ACTIONS: ActionDefinition[] = [summary, detailed, weekly];
