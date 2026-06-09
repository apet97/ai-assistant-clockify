import { z } from "zod";
import { defineReadAction, defineRiskyAction, type ActionDefinition } from "../action.js";
import { successReceipt } from "../receipts.js";

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
const DAY_MS = 24 * 60 * 60 * 1000;

/** Clockify's approval endpoint wants a full ISO-8601 UTC instant (e.g.
 *  `2026-06-01T00:00:00Z`), NOT a bare date — a bare date 400s with code 501.
 *  Format to seconds + Z (matching Clockify's own example; no millis). */
function toClockifyInstant(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Normalize a model-supplied periodStart to the full ISO UTC instant Clockify
 *  requires: a bare `YYYY-MM-DD` becomes midnight UTC; a fuller value is parsed. */
function normalizeInstant(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00Z`;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : toClockifyInstant(parsed);
}

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
    "Submit ONE timesheet period for approval. Pass `week` ('this_week' or 'last_week') and the harness computes the period start, OR an explicit `periodStart` date (YYYY-MM-DD) — do NOT guess a calendar date. Elevated write: previews and requires confirmation. Submit one period per call.",
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
    const now = (ctx.now ?? (() => new Date()))();
    const periodStart = args.week
      ? weekStartInstant(now, args.week)
      : args.periodStart
        ? normalizeInstant(args.periodStart)
        : undefined;
    if (!periodStart) {
      return {
        clarify:
          'Which period should I submit? Tell me a week ("this week" or "last week") or a start date like 2026-06-01. I submit one period per request.',
      };
    }
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
  description: "Resubmit time entries for an active approval period. Bulk external side effect — previews and requires confirmation.",
  group: AP,
  risks: ["bulk", "external_side_effect"],
  schema: z.object({ id: z.string().min(1), entryIds: z.array(z.string().min(1)).min(1), note: z.string().optional() }),
  async preview(_ctx, args) {
    return {
      actionLabel: "Resubmit entries for approval",
      targets: [{ type: "approval", id: args.id }],
      expectedChanges: [`Resubmit ${args.entryIds.length} entries for approval ${args.id}`],
      reversibility: "You can withdraw afterward.",
      warnings: ["This resubmits entries and notifies approvers."],
      payload: { id: args.id, entryIds: args.entryIds, note: args.note },
    };
  },
  async commit(ctx, payload) {
    const { id, entryIds, note } = payload as { id: string; entryIds: string[]; note?: string };
    const result = await ctx.clockify.resubmitApproval(id, entryIds, note);
    return successReceipt({ action: "clockify_approvals_resubmit", entity: "approval", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "approval", id: result.id }] } });
  },
});

export const APPROVAL_ACTIONS: ActionDefinition[] = [listApprovals, getApproval, submitApproval, approve, reject, withdraw, resubmit];
