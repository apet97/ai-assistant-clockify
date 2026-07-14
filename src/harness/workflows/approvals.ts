import { z } from "zod";
import { defineReadAction, defineRiskyAction, type ActionContext, type ActionDefinition } from "../action.js";
import { durableMutationContract } from "../durable-mutation-contract.js";
import { commitSingleDurableRiskyStep } from "../durable-risky-write.js";
import { listReceipt, successReceipt } from "../receipts.js";
import { captureTargetSnapshot } from "../target-snapshots.js";
import { sanitizedFingerprint } from "../safe-json.js";
import { nowDate } from "../../durations.js";
import { resolveInstant, resolvePeriod } from "./resolve.js";
import { dispatchWithReconciliation, reconcileCreate } from "./structure-durable.js";
import { DefinitiveWriteFailure } from "../../clockify/write-outcome.js";

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
const approvalCreateContract = durableMutationContract({ source: "confirmed", targeting: { mode: "create_no_target" }, strategies: ["create"] });
const approvalStateContract = durableMutationContract({ source: "confirmed", targeting: { mode: "snapshots", relations: ["target"] }, strategies: ["state-command"] });

function approvalProjection(approval: Awaited<ReturnType<ActionContext["clockify"]["getApproval"]>>) {
  if (!approval) return undefined;
  return {
    id: approval.id, userId: approval.userId, userName: approval.userName,
    state: approval.state, periodStart: approval.periodStart, periodEnd: approval.periodEnd,
  };
}

function approvalCreateProjection(approval: { state?: string; periodStart?: string }) {
  return { state: approval.state, periodStart: approval.periodStart };
}

async function requireFreshApprovalBaseline(ctx: ActionContext, baselineIds: readonly string[]) {
  const current = await ctx.clockify.listApprovals();
  const ids = current.rows.map((row) => row.id).sort();
  if (current.truncated || sanitizedFingerprint(ids) !== sanitizedFingerprint([...baselineIds].sort())) {
    throw new DefinitiveWriteFailure("VERIFY", "approval_baseline", "The approval list changed after preview. Create a fresh preview.");
  }
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
  timeZone: string,
  weekStartsOn: number,
): { kind: "ok"; instant: string } | { kind: "missing" } | { kind: "bad"; raw: string } {
  if (args.week) {
    const range = resolvePeriod(now, args.week, timeZone, weekStartsOn);
    return { kind: "ok", instant: range.dateRangeStart.replace(".000Z", "Z") };
  }
  const raw = args.periodStart?.trim();
  if (!raw) return { kind: "missing" };
  const instant = resolveInstant(now, raw, "start", timeZone);
  return instant === undefined
    ? { kind: "bad", raw }
    : { kind: "ok", instant: instant.replace(".000Z", "Z") };
}

const BAD_PERIOD_START = (raw: string): string =>
  `I couldn't make sense of the period start "${raw}" — give me a calendar date (YYYY-MM-DD) or something like this week, last week, or next monday.`;

const listApprovals = defineReadAction({
  name: "clockify_approvals_list",
  description: "List approval requests (status filter: PENDING / APPROVED / WITHDRAWN_APPROVAL).",
  group: AP,
  schema: z.object({ status: z.enum(["PENDING", "APPROVED", "WITHDRAWN_APPROVAL"]).optional() }),
  async handler(ctx, args) {
    const { rows, truncated } = await ctx.clockify.listApprovals(args);
    return listReceipt({ action: "clockify_approvals_list", entity: "approval", ids: { workspaceId: ctx.workspaceId }, rows, truncated });
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
  mutationWorkflow: "durable",
  mutationContract: approvalCreateContract,
  schema: z.object({
    period: z.string().default("WEEKLY"),
    /** Relative week — the harness resolves the period start server-side from `now`. */
    week: z.enum(["this_week", "last_week"]).optional(),
    /** Explicit period start (date or instant); normalized to the ISO UTC instant Clockify requires. */
    periodStart: z.string().min(1).optional(),
  }),
  async preview(ctx, args) {
    const now = nowDate(ctx);
    const resolved = resolvePeriodStart(now, args, ctx.timeZone ?? "UTC", ctx.weekStartsOn ?? 1);
    if (resolved.kind === "bad") return { clarify: BAD_PERIOD_START(resolved.raw) };
    if (resolved.kind === "missing") {
      return {
        clarify:
          'Which period should I submit? Tell me a week ("this week" or "last week") or a start date like 2026-06-01. I submit one period per request.',
      };
    }
    const periodStart = resolved.instant;
    const baseline = await ctx.clockify.listApprovals();
    if (baseline.truncated) return { clarify: "Clockify returned an incomplete approval list, so I can't safely submit or reconcile this period." };
    if (baseline.rows.some((row) => row.periodStart?.slice(0, 10) === periodStart.slice(0, 10) && row.state === "PENDING")) {
      return { clarify: "That period already has a pending approval request." };
    }
    return {
      actionLabel: "Submit timesheet for approval",
      targets: [],
      expectedChanges: [`Submit ${args.period} timesheet starting ${periodStart} for approval`],
      reversibility: "You can withdraw the submission afterward.",
      warnings: ["This submits a timesheet for approval."],
      payload: {
        period: args.period, periodStart, baselineIds: baseline.rows.map((row) => row.id).sort(),
        finalFingerprint: sanitizedFingerprint({ state: "PENDING", periodStart }),
      },
      mutationPlan: { mode: "single", steps: [{ id: "submit-approval", kind: "primary", reconciliationStrategy: "create" }] },
    };
  },
  async commit(ctx, payload, operation) {
    const { period, periodStart, baselineIds, finalFingerprint } = payload as { period: string; periodStart: string; baselineIds: string[]; finalFingerprint: string };
    return commitSingleDurableRiskyStep({
      ctx, operation, planStepId: "submit-approval", name: "Submit approval",
      async dispatch() {
        await requireFreshApprovalBaseline(ctx, baselineIds);
        const dispatched = await dispatchWithReconciliation({
          dispatch: () => ctx.clockify.submitApprovalAtomic({ period, periodStart }),
          reconcile: async () => {
            const row = await reconcileCreate({
              beforeIds: baselineIds,
              list: () => ctx.clockify.listApprovals(),
              matches: (candidate) => sanitizedFingerprint(approvalCreateProjection(candidate)) === finalFingerprint,
            });
            return row ? { id: row.id, name: row.id } : undefined;
          },
        });
        const approval = dispatched.value;
        return { externalId: approval.id, effect: { created: { type: "approval", id: approval.id } }, detail: { reconciled: dispatched.reconciled } };
      },
      success: (step) => successReceipt({ action: "clockify_approvals_submit", entity: "approval", ids: { workspaceId: ctx.workspaceId }, changed: { created: [{ type: "approval", id: step.externalId ?? "approval" }] } }),
    });
  },
});

/** Build an approve/reject/withdraw action — all PATCH the request state (external side effect). */
function stateAction(name: string, label: string, state: string): ActionDefinition {
  return defineRiskyAction({
    name,
    description: `${label} an approval request. External side effect (notifies the owner) — previews and requires confirmation.`,
    group: AP,
    risks: ["external_side_effect"],
    mutationWorkflow: "durable",
    mutationContract: approvalStateContract,
    schema: z.object({ id: z.string().min(1), note: z.string().optional() }),
    async preview(ctx, args) {
      const current = await ctx.clockify.getApproval(args.id);
      if (!current) return { clarify: `I couldn't verify approval request ${args.id}. Give me a current approval id.` };
      const targetSnapshot = captureTargetSnapshot("target", { type: "approval", id: current.id }, approvalProjection(current));
      return {
        actionLabel: `${label} approval request`,
        targets: [{ type: "approval", id: args.id }],
        expectedChanges: [`${label} approval request ${args.id} → ${state}`],
        reversibility: "Approval decisions notify the owner and may be hard to reverse.",
        warnings: ["This changes a timesheet approval and notifies the owner."],
        payload: {
          id: current.id, state,
          ...(args.note !== undefined ? { note: args.note } : {}),
          ...(current.state !== undefined ? { previousState: current.state } : {}),
        },
        targetSnapshots: [targetSnapshot],
        mutationPlan: { mode: "single", steps: [{ id: "set-approval-state", kind: "primary", targetFingerprint: targetSnapshot.fingerprint, reconciliationStrategy: "state-command" }] },
      };
    },
    async commit(ctx, payload, operation) {
      const { id, state: payloadState, note } = payload as { id: string; state: string; note?: string };
      return commitSingleDurableRiskyStep({
        ctx, operation, planStepId: "set-approval-state", name: `${label} approval request`,
        verification: {
          snapshots: operation.targetSnapshots ?? [],
          async fetchSnapshot() {
            const current = await ctx.clockify.getApproval(id);
            return current ? { ref: { type: "approval", id }, projection: approvalProjection(current) } : undefined;
          },
        },
        async dispatch() {
          const dispatched = await dispatchWithReconciliation({
            dispatch: () => ctx.clockify.setApprovalStateAtomic(id, payloadState, note),
            reconcile: async () => {
              const current = await ctx.clockify.getApproval(id);
              return current?.state === payloadState ? { id: current.id, name: payloadState } : undefined;
            },
          });
          return { externalId: dispatched.value.id, effect: { previousState: (payload as { previousState?: string }).previousState, state: payloadState }, detail: { reconciled: dispatched.reconciled } };
        },
        success: (step) => successReceipt({ action: name, entity: "approval", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "approval", id: step.externalId ?? id, name: payloadState }] } }),
      });
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
  mutationWorkflow: "durable",
  mutationContract: approvalStateContract,
  schema: z.object({ id: z.string().min(1), state: z.enum(["WITHDRAWN_SUBMISSION", "WITHDRAWN_APPROVAL"]).default("WITHDRAWN_SUBMISSION"), note: z.string().optional() }),
  async preview(ctx, args) {
    const current = await ctx.clockify.getApproval(args.id);
    if (!current) return { clarify: `I couldn't verify approval request ${args.id}. Give me a current approval id.` };
    const targetSnapshot = captureTargetSnapshot("target", { type: "approval", id: current.id }, approvalProjection(current));
    return {
      actionLabel: "Withdraw approval request",
      targets: [{ type: "approval", id: args.id }],
      expectedChanges: [`Withdraw approval request ${args.id} → ${args.state}`],
      reversibility: "You can resubmit afterward.",
      warnings: ["This withdraws a timesheet approval and notifies the owner."],
      payload: {
        id: current.id, state: args.state,
        ...(args.note !== undefined ? { note: args.note } : {}),
        ...(current.state !== undefined ? { previousState: current.state } : {}),
      },
      targetSnapshots: [targetSnapshot],
      mutationPlan: { mode: "single", steps: [{ id: "withdraw-approval", kind: "primary", targetFingerprint: targetSnapshot.fingerprint, reconciliationStrategy: "state-command" }] },
    };
  },
  async commit(ctx, payload, operation) {
    const { id, state, note } = payload as { id: string; state: string; note?: string };
    return commitSingleDurableRiskyStep({
      ctx, operation, planStepId: "withdraw-approval", name: "Withdraw approval request",
      verification: { snapshots: operation.targetSnapshots ?? [], async fetchSnapshot() {
        const current = await ctx.clockify.getApproval(id);
        return current ? { ref: { type: "approval", id }, projection: approvalProjection(current) } : undefined;
      } },
      async dispatch() {
        const dispatched = await dispatchWithReconciliation({
          dispatch: () => ctx.clockify.setApprovalStateAtomic(id, state, note),
          reconcile: async () => {
            const current = await ctx.clockify.getApproval(id);
            return current?.state === state ? { id: current.id, name: state } : undefined;
          },
        });
        return { externalId: dispatched.value.id, effect: { state }, detail: { reconciled: dispatched.reconciled } };
      },
      success: (step) => successReceipt({ action: "clockify_approvals_withdraw", entity: "approval", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "approval", id: step.externalId ?? id, name: state }] } }),
    });
  },
});

const resubmit = defineRiskyAction({
  name: "clockify_approvals_resubmit",
  description:
    "Resubmit the caller's rejected/withdrawn entries for ONE approval period. Pass `week` ('this_week' or 'last_week') and the harness computes the period start, OR an explicit `periodStart` — YYYY-MM-DD or a relative day (next monday, June 1), resolved server-side; do NOT guess a calendar date. Bulk external side effect — previews and requires confirmation.",
  group: AP,
  risks: ["bulk", "external_side_effect"],
  mutationWorkflow: "durable",
  mutationContract: approvalStateContract,
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
    const resolved = resolvePeriodStart(now, args, ctx.timeZone ?? "UTC", ctx.weekStartsOn ?? 1);
    if (resolved.kind === "bad") return { clarify: BAD_PERIOD_START(resolved.raw) };
    if (resolved.kind === "missing") {
      return {
        clarify:
          'Which period should I resubmit? Tell me a week ("this week" or "last week") or a start date like 2026-06-01. I resubmit one period per request.',
      };
    }
    const periodStart = resolved.instant;
    const candidates = await ctx.clockify.listApprovals();
    if (candidates.truncated) return { clarify: "Clockify returned an incomplete approval list. Narrow the period before resubmitting." };
    const matching = candidates.rows.filter((row) => row.periodStart?.slice(0, 10) === periodStart.slice(0, 10));
    if (matching.length !== 1) return { clarify: "I need exactly one approval request for that period before resubmitting. Give me a narrower period." };
    const current = matching[0]!;
    const targetSnapshot = captureTargetSnapshot("target", { type: "approval", id: current.id }, approvalProjection(current));
    return {
      actionLabel: "Resubmit entries for approval",
      targets: [],
      expectedChanges: [`Resubmit ${args.period} entries starting ${periodStart} for approval`],
      reversibility: "You can withdraw afterward.",
      warnings: ["This resubmits entries and notifies approvers."],
      payload: {
        period: args.period, periodStart, approvalId: current.id,
        ...(current.state !== undefined ? { previousState: current.state } : {}),
      },
      targetSnapshots: [targetSnapshot],
      mutationPlan: { mode: "single", steps: [{ id: "resubmit-approval", kind: "primary", targetFingerprint: targetSnapshot.fingerprint, reconciliationStrategy: "state-command" }] },
    };
  },
  async commit(ctx, payload, operation) {
    const typed = payload as { period: string; periodStart: string; approvalId: string };
    return commitSingleDurableRiskyStep({
      ctx, operation, planStepId: "resubmit-approval", name: "Resubmit approval",
      verification: { snapshots: operation.targetSnapshots ?? [], async fetchSnapshot() {
        const current = await ctx.clockify.getApproval(typed.approvalId);
        return current ? { ref: { type: "approval", id: typed.approvalId }, projection: approvalProjection(current) } : undefined;
      } },
      async dispatch() {
        const dispatched = await dispatchWithReconciliation({
          dispatch: () => ctx.clockify.resubmitApprovalAtomic({ period: typed.period, periodStart: typed.periodStart }),
          reconcile: async () => {
            const current = await ctx.clockify.getApproval(typed.approvalId);
            return current?.state === "PENDING" ? { id: current.id, name: "PENDING" } : undefined;
          },
        });
        return { externalId: dispatched.value.id, effect: { state: "PENDING" }, detail: { reconciled: dispatched.reconciled } };
      },
      success: (step) => successReceipt({ action: "clockify_approvals_resubmit", entity: "approval", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "approval", id: step.externalId ?? typed.approvalId }] } }),
    });
  },
});

export const APPROVAL_ACTIONS: ActionDefinition[] = [listApprovals, getApproval, submitApproval, approve, reject, withdraw, resubmit];

/** Read-only startup dispatcher metadata; it grants no mutation capability. */
export const APPROVAL_STARTUP_RECONCILIATION = Object.freeze({
  clockify_approvals_submit: { "submit-approval": "create" },
  clockify_approvals_approve: { "set-approval-state": "state-command" },
  clockify_approvals_reject: { "set-approval-state": "state-command" },
  clockify_approvals_withdraw: { "withdraw-approval": "state-command" },
  clockify_approvals_resubmit: { "resubmit-approval": "state-command" },
} as const);
