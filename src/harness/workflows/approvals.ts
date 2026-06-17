import { z } from "zod";
import { defineReadAction, defineRiskyAction, type ActionDefinition } from "../action.js";
import { successReceipt } from "../receipts.js";
import { DAY_MS, nowDate } from "../../durations.js";
import { resolveRelativeDay } from "./resolve.js";

/**
 * Typed approval workflows (goclmcp §2.11). Reads (list/get) execute
 * immediately; submit / approve / reject / withdraw / resubmit run preview→commit.
 * Risk classes: submit = high_risk_write; approve/reject/withdraw =
 * external_side_effect (notify the timesheet owner); resubmit = bulk +
 * external_side_effect. All gated by `approvals`. These are real Clockify writes,
 * so they use high_risk_write / external_side_effect / bulk (which keep the policy
 * gate), NEVER `permission_change` (which would bypass it) — a deliberate
 * deviation from the plan's D3, per the permission-change note.
 */

const AP = "approvals" as const;

/** Clockify's approval endpoint wants a full ISO-8601 UTC instant (e.g.
 *  `2026-06-01T00:00:00Z`), NOT a bare date — a bare date 400s with code 501.
 *  Format to seconds + Z (matching Clockify's own example; no millis). */
function toClockifyInstant(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Resolve a submit/resubmit period start to the full ISO UTC instant Clockify
 * requires. `week` keywords compute the Monday server-side; an explicit
 * `periodStart` accepts a full ISO instant, a bare YYYY-MM-DD, or a RELATIVE
 * day ("next monday", "June 1" — resolved via resolveRelativeDay so the year is
 * never fabricated: `new Date("June 1")` parses to 2001). `missing` = ask which
 * period; `bad` = the value couldn't be resolved (clarify, never wire it).
 */
function resolvePeriodStart(
  now: Date,
  args: { week?: "this_week" | "last_week"; periodStart?: string },
): { kind: "ok"; instant: string } | { kind: "missing" } | { kind: "bad"; raw: string } {
  if (args.week) return { kind: "ok", instant: weekStartInstant(now, args.week) };
  const raw = args.periodStart?.trim();
  if (!raw) return { kind: "missing" };
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    // An OFFSET-NAIVE ISO instant ("2026-06-01T00:00:00") is parsed by `new Date`
    // in the SERVER's local timezone, then toClockifyInstant's toISOString()
    // shifts it back to UTC — landing the submitted period hours (or a calendar
    // day) off what the admin confirmed on a non-UTC host. Anchor a missing
    // offset to UTC explicitly; a value already carrying Z or a ±HH:MM offset is
    // left untouched.
    const hasOffset = /([zZ]|[+-]\d{2}:?\d{2})$/.test(raw);
    const parsed = new Date(hasOffset ? raw : `${raw}Z`);
    return Number.isNaN(parsed.getTime()) ? { kind: "bad", raw } : { kind: "ok", instant: toClockifyInstant(parsed) };
  }
  const day = resolveRelativeDay(now, { date: raw });
  return day === undefined ? { kind: "bad", raw } : { kind: "ok", instant: `${day}T00:00:00Z` };
}

const BAD_PERIOD_START = (raw: string): string =>
  `I couldn't make sense of the period start "${raw}" — give me a calendar date (YYYY-MM-DD) or something like this week, last week, or next monday.`;

/** The Monday (00:00:00Z) of this/last week, computed server-side from ctx.now so
 *  the model never has to guess a calendar date (matching the curated-report pattern). */
function weekStartInstant(now: Date, which: "this_week" | "last_week"): string {
  const dow = (now.getUTCDay() + 6) % 7; // 0 = Monday … 6 = Sunday
  const back = which === "last_week" ? dow + 7 : dow;
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - back * DAY_MS);
  return `${monday.toISOString().slice(0, 10)}T00:00:00Z`;
}

const listApprovals = defineReadAction({
  name: "clockify_approvals_list",
  description: "List approval requests (status filter: PENDING / APPROVED / WITHDRAWN_APPROVAL).",
  group: AP,
  schema: z.object({ status: z.enum(["PENDING", "APPROVED", "WITHDRAWN_APPROVAL"]).optional() }),
  async handler(ctx, args) {
    const items = await ctx.clockify.listApprovals(args);
    return successReceipt({ action: "clockify_approvals_list", entity: "approval", ids: { workspaceId: ctx.workspaceId }, data: { count: items.length, items } });
  },
});

const getApproval = defineReadAction({
  name: "clockify_approvals_get",
  description: "Fetch a single approval request by id.",
  group: AP,
  schema: z.object({ id: z.string().min(1) }),
  async handler(ctx, args) {
    const entity = await ctx.clockify.getApproval(args.id);
    return successReceipt({ action: "clockify_approvals_get", entity: "approval", ids: { workspaceId: ctx.workspaceId }, data: { entity } });
  },
});

const submitApproval = defineRiskyAction({
  name: "clockify_approvals_submit",
  description:
    "Submit ONE timesheet period for approval. Pass `week` ('this_week' or 'last_week') and the harness computes the period start, OR an explicit `periodStart` — YYYY-MM-DD or a relative day (next monday, June 1), resolved server-side; do NOT guess a calendar date. Elevated write: previews and requires confirmation. Submit one period per call.",
  group: AP,
  risks: ["high_risk_write"],
  schema: z.object({
    period: z.string().default("WEEKLY"),
    /** Relative week — the harness resolves the period start server-side from `now`. */
    week: z.enum(["this_week", "last_week"]).optional(),
    /** Explicit period start (date or instant); normalized to the ISO UTC instant Clockify requires. */
    periodStart: z.string().min(1).optional(),
  }),
  async preview(ctx, args) {
    const now = nowDate(ctx);
    const resolved = resolvePeriodStart(now, args);
    if (resolved.kind === "bad") return { clarify: BAD_PERIOD_START(resolved.raw) };
    if (resolved.kind === "missing") {
      return {
        clarify:
          'Which period should I submit? Tell me a week ("this week" or "last week") or a start date like 2026-06-01. I submit one period per request.',
      };
    }
    const periodStart = resolved.instant;
    return {
      actionLabel: "Submit timesheet for approval",
      targets: [],
      expectedChanges: [`Submit ${args.period} timesheet starting ${periodStart} for approval`],
      reversibility: "You can withdraw the submission afterward.",
      warnings: ["This submits a timesheet for approval."],
      payload: { period: args.period, periodStart },
    };
  },
  async commit(ctx, payload) {
    const { period, periodStart } = payload as { period: string; periodStart: string };
    const approval = await ctx.clockify.submitApproval({ period, periodStart });
    return successReceipt({ action: "clockify_approvals_submit", entity: "approval", ids: { workspaceId: ctx.workspaceId }, changed: { created: [{ type: "approval", id: approval.id }] } });
  },
});

/** Build an approve/reject/withdraw action — all PATCH the request state (external side effect). */
function stateAction(name: string, label: string, state: string): ActionDefinition {
  return defineRiskyAction({
    name,
    description: `${label} an approval request. External side effect (notifies the owner) — previews and requires confirmation.`,
    group: AP,
    risks: ["external_side_effect"],
    schema: z.object({ id: z.string().min(1), note: z.string().optional() }),
    async preview(_ctx, args) {
      return {
        actionLabel: `${label} approval request`,
        targets: [{ type: "approval", id: args.id }],
        expectedChanges: [`${label} approval request ${args.id} → ${state}`],
        reversibility: "Approval decisions notify the owner and may be hard to reverse.",
        warnings: ["This changes a timesheet approval and notifies the owner."],
        payload: { id: args.id, state, note: args.note },
      };
    },
    async commit(ctx, payload) {
      const { id, state: payloadState, note } = payload as { id: string; state: string; note?: string };
      const result = await ctx.clockify.setApprovalState(id, payloadState, note);
      return successReceipt({ action: name, entity: "approval", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "approval", id: result.id, name: result.name }] } });
    },
  });
}

const approve = stateAction("clockify_approvals_approve", "Approve", "APPROVED");
const reject = stateAction("clockify_approvals_reject", "Reject", "REJECTED");

const withdraw = defineRiskyAction({
  name: "clockify_approvals_withdraw",
  description: "Withdraw a submitted or approved approval request. External side effect — previews and requires confirmation.",
  group: AP,
  risks: ["external_side_effect"],
  schema: z.object({ id: z.string().min(1), state: z.enum(["WITHDRAWN_SUBMISSION", "WITHDRAWN_APPROVAL"]).default("WITHDRAWN_SUBMISSION"), note: z.string().optional() }),
  async preview(_ctx, args) {
    return {
      actionLabel: "Withdraw approval request",
      targets: [{ type: "approval", id: args.id }],
      expectedChanges: [`Withdraw approval request ${args.id} → ${args.state}`],
      reversibility: "You can resubmit afterward.",
      warnings: ["This withdraws a timesheet approval and notifies the owner."],
      payload: { id: args.id, state: args.state, note: args.note },
    };
  },
  async commit(ctx, payload) {
    const { id, state, note } = payload as { id: string; state: string; note?: string };
    const result = await ctx.clockify.setApprovalState(id, state, note);
    return successReceipt({ action: "clockify_approvals_withdraw", entity: "approval", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "approval", id: result.id, name: result.name }] } });
  },
});

const resubmit = defineRiskyAction({
  name: "clockify_approvals_resubmit",
  description:
    "Resubmit the caller's rejected/withdrawn entries for ONE approval period. Pass `week` ('this_week' or 'last_week') and the harness computes the period start, OR an explicit `periodStart` — YYYY-MM-DD or a relative day (next monday, June 1), resolved server-side; do NOT guess a calendar date. Bulk external side effect — previews and requires confirmation.",
  group: AP,
  risks: ["bulk", "external_side_effect"],
  // The real endpoint takes the same {period, periodStart} body as submit (the
  // old {id, entryIds} shape never existed upstream — spec + goclmcp).
  schema: z.object({
    period: z.string().default("WEEKLY"),
    /** Relative week — the harness resolves the period start server-side from `now`. */
    week: z.enum(["this_week", "last_week"]).optional(),
    /** Explicit period start (date or instant); normalized to the ISO UTC instant Clockify requires. */
    periodStart: z.string().min(1).optional(),
  }),
  async preview(ctx, args) {
    const now = nowDate(ctx);
    const resolved = resolvePeriodStart(now, args);
    if (resolved.kind === "bad") return { clarify: BAD_PERIOD_START(resolved.raw) };
    if (resolved.kind === "missing") {
      return {
        clarify:
          'Which period should I resubmit? Tell me a week ("this week" or "last week") or a start date like 2026-06-01. I resubmit one period per request.',
      };
    }
    const periodStart = resolved.instant;
    return {
      actionLabel: "Resubmit entries for approval",
      targets: [],
      expectedChanges: [`Resubmit ${args.period} entries starting ${periodStart} for approval`],
      reversibility: "You can withdraw afterward.",
      warnings: ["This resubmits entries and notifies approvers."],
      payload: { period: args.period, periodStart },
    };
  },
  async commit(ctx, payload) {
    const typed = payload as { period: string; periodStart: string };
    const result = await ctx.clockify.resubmitApproval(typed);
    return successReceipt({ action: "clockify_approvals_resubmit", entity: "approval", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "approval", id: result.id }] } });
  },
});

export const APPROVAL_ACTIONS: ActionDefinition[] = [listApprovals, getApproval, submitApproval, approve, reject, withdraw, resubmit];
