import { z } from "zod";
import { defineAction, type ActionContext, type ActionDefinition } from "../action.js";
import { successReceipt } from "../receipts.js";
import { resolveDateRange } from "./resolve.js";
import { nowDate, SEVEN_DAYS_MS } from "../../durations.js";
import type {
  ApiActionMetadataCarrier,
  AvailabilityByAuthClass,
} from "../api-operation.js";

/**
 * Typed report workflows (goclmcp §2.14). All reads on the REPORTS host. Reports
 * can be large, so the result is byte-capped: if the serialized JSON exceeds the
 * inline cap, it is omitted with an explicit `truncated` warning (no silent cap).
 * Gated by `reports`. The reports host authenticates with the production
 * X-Addon-Token (same routing + auth header as the api host); the dev API key
 * also works.
 */

const REP = "reports" as const;

type ReportActionName =
  | "clockify_reports_summary"
  | "clockify_reports_detailed"
  | "clockify_reports_weekly";

const REPORT_AVAILABILITY: AvailabilityByAuthClass = Object.freeze({
  addon: Object.freeze({ available: true }),
  api_key: Object.freeze({ available: true }),
});

function reportApiMetadata(
  actionName: ReportActionName,
  operationId: string,
  path: string,
): ApiActionMetadataCarrier {
  return Object.freeze({
    apiExposure: "api",
    apiOperation: Object.freeze({
      operationId,
      host: "reports",
      method: "POST",
      path,
      access: "read",
      exposure: "api",
    }),
    adapterEndpoints: Object.freeze({
      primary: Object.freeze([
        ["read", "reports", "POST", path, "reports.ts"].join("\0"),
      ]),
      support: Object.freeze([]),
    }),
    availabilityByAuthClass: REPORT_AVAILABILITY,
    boundedArgumentDictionaries: Object.freeze([]),
    materialFields: Object.freeze([]),
    presentation: Object.freeze({ presenterId: actionName, version: 1 }),
  });
}

const REPORT_API_METADATA = Object.freeze({
  clockify_reports_summary: reportApiMetadata(
    "clockify_reports_summary",
    "generateSummaryReport",
    "/workspaces/{workspaceId}/reports/summary",
  ),
  clockify_reports_detailed: reportApiMetadata(
    "clockify_reports_detailed",
    "generateDetailedReport",
    "/workspaces/{workspaceId}/reports/detailed",
  ),
  clockify_reports_weekly: reportApiMetadata(
    "clockify_reports_weekly",
    "generateWeeklyReport",
    "/workspaces/{workspaceId}/reports/weekly",
  ),
} satisfies Readonly<Record<ReportActionName, ApiActionMetadataCarrier>>);

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
  const now = nowDate(ctx);
  // Default end → now and start → end-minus-7-days when omitted; an explicit
  // range still wins. The shared resolver owns the per-edge resolveInstant, the
  // bad-date collection, and the clarify copy (only the example-hint tail is
  // ours). Reports REQUIRE both edges, so the start/end-undefined guard stays.
  const resolved = resolveDateRange(now, {
    start: { raw: args.dateRangeStart, defaultTo: (end) => (end !== undefined ? new Date(Date.parse(end) - SEVEN_DAYS_MS).toISOString() : undefined) },
    end: { raw: args.dateRangeEnd, defaultTo: now.toISOString() },
    exampleHint: "today, yesterday, or last monday",
    timeZone: ctx.timeZone,
  });
  if (!resolved.ok) return resolved;
  if (resolved.start === undefined || resolved.end === undefined) {
    return {
      ok: false,
      message:
        "I couldn't make sense of the date — give me a calendar date (YYYY-MM-DD) or something like today, yesterday, or last monday.",
    };
  }
  return { ok: true, range: { dateRangeStart: resolved.start, dateRangeEnd: resolved.end } };
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
  ...REPORT_API_METADATA.clockify_reports_summary,
  description: "Run a summary report (grouped, defaults to PROJECT). The date range is OPTIONAL — omitted = the last 7 days; call directly, never ask for dates.",
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
  ...REPORT_API_METADATA.clockify_reports_detailed,
  description: "Run a detailed (entry-level) report. The date range is OPTIONAL — omitted = the last 7 days; call directly, never ask for dates.",
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
  ...REPORT_API_METADATA.clockify_reports_weekly,
  description: "Run a weekly report. The date range is OPTIONAL — omitted = the last 7 days; call directly, never ask for dates.",
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
