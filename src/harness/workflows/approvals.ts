import { z } from "zod";
import { defineAction, type ActionDefinition } from "../action.js";
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

const listApprovals = defineAction({
  name: "clockify_approvals_list",
  description: "List approval requests (status filter: PENDING / APPROVED / WITHDRAWN_APPROVAL).",
  featureGroup: AP,
  risks: ["read"],
  schema: z.object({ status: z.enum(["PENDING", "APPROVED", "WITHDRAWN_APPROVAL"]).optional() }),
  async handler(ctx, args) {
    const items = await ctx.clockify.listApprovals(args);
    return { kind: "receipt", receipt: successReceipt({ action: "clockify_approvals_list", entity: "approval", ids: { workspaceId: ctx.workspaceId }, data: { count: items.length, items } }) };
  },
});

const getApproval = defineAction({
  name: "clockify_approvals_get",
  description: "Fetch a single approval request by id.",
  featureGroup: AP,
  risks: ["read"],
  schema: z.object({ id: z.string().min(1) }),
  async handler(ctx, args) {
    const entity = await ctx.clockify.getApproval(args.id);
    return { kind: "receipt", receipt: successReceipt({ action: "clockify_approvals_get", entity: "approval", ids: { workspaceId: ctx.workspaceId }, data: { entity } }) };
  },
});

const submitApproval = defineAction({
  name: "clockify_approvals_submit",
  description: "Submit a timesheet period for approval. Elevated write — previews and requires confirmation.",
  featureGroup: AP,
  risks: ["high_risk_write"],
  schema: z.object({ period: z.string().default("WEEKLY"), periodStart: z.string().min(1) }),
  async handler(ctx, args) {
    return {
      kind: "preview",
      preview: {
        actionLabel: "Submit timesheet for approval",
        featureGroup: AP,
        riskLabels: ["high_risk_write"],
        targets: [],
        expectedChanges: [`Submit ${args.period} timesheet starting ${args.periodStart} for approval`],
        reversibility: "You can withdraw the submission afterward.",
        warnings: ["This submits a timesheet for approval."],
      },
      operation: { actionName: "clockify_approvals_submit", featureGroup: AP, risks: ["high_risk_write"], payload: { period: args.period, periodStart: args.periodStart } },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { period: string; periodStart: string };
    const approval = await ctx.clockify.submitApproval(payload);
    return successReceipt({ action: "clockify_approvals_submit", entity: "approval", ids: { workspaceId: ctx.workspaceId }, changed: { created: [{ type: "approval", id: approval.id }] } });
  },
});

/** Build an approve/reject/withdraw action — all PATCH the request state (external side effect). */
function stateAction(name: string, label: string, state: string): ActionDefinition {
  return defineAction({
    name,
    description: `${label} an approval request. External side effect (notifies the owner) — previews and requires confirmation.`,
    featureGroup: AP,
    risks: ["external_side_effect"],
    schema: z.object({ id: z.string().min(1), note: z.string().optional() }),
    async handler(ctx, args) {
      return {
        kind: "preview",
        preview: {
          actionLabel: `${label} approval request`,
          featureGroup: AP,
          riskLabels: ["external_side_effect"],
          targets: [{ type: "approval", id: args.id }],
          expectedChanges: [`${label} approval request ${args.id} → ${state}`],
          reversibility: "Approval decisions notify the owner and may be hard to reverse.",
          warnings: ["This changes a timesheet approval and notifies the owner."],
        },
        operation: { actionName: name, featureGroup: AP, risks: ["external_side_effect"], payload: { id: args.id, state, note: args.note } },
      };
    },
    async commit(ctx, operation) {
      const payload = operation.payload as { id: string; state: string; note?: string };
      const result = await ctx.clockify.setApprovalState(payload.id, payload.state, payload.note);
      return successReceipt({ action: name, entity: "approval", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "approval", id: result.id, name: result.name }] } });
    },
  });
}

const approve = stateAction("clockify_approvals_approve", "Approve", "APPROVED");
const reject = stateAction("clockify_approvals_reject", "Reject", "REJECTED");

const withdraw = defineAction({
  name: "clockify_approvals_withdraw",
  description: "Withdraw a submitted or approved approval request. External side effect — previews and requires confirmation.",
  featureGroup: AP,
  risks: ["external_side_effect"],
  schema: z.object({ id: z.string().min(1), state: z.enum(["WITHDRAWN_SUBMISSION", "WITHDRAWN_APPROVAL"]).default("WITHDRAWN_SUBMISSION"), note: z.string().optional() }),
  async handler(ctx, args) {
    return {
      kind: "preview",
      preview: {
        actionLabel: "Withdraw approval request",
        featureGroup: AP,
        riskLabels: ["external_side_effect"],
        targets: [{ type: "approval", id: args.id }],
        expectedChanges: [`Withdraw approval request ${args.id} → ${args.state}`],
        reversibility: "You can resubmit afterward.",
        warnings: ["This withdraws a timesheet approval and notifies the owner."],
      },
      operation: { actionName: "clockify_approvals_withdraw", featureGroup: AP, risks: ["external_side_effect"], payload: { id: args.id, state: args.state, note: args.note } },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { id: string; state: string; note?: string };
    const result = await ctx.clockify.setApprovalState(payload.id, payload.state, payload.note);
    return successReceipt({ action: "clockify_approvals_withdraw", entity: "approval", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "approval", id: result.id, name: result.name }] } });
  },
});

const resubmit = defineAction({
  name: "clockify_approvals_resubmit",
  description: "Resubmit time entries for an active approval period. Bulk external side effect — previews and requires confirmation.",
  featureGroup: AP,
  risks: ["bulk", "external_side_effect"],
  schema: z.object({ id: z.string().min(1), entryIds: z.array(z.string().min(1)).min(1), note: z.string().optional() }),
  async handler(ctx, args) {
    return {
      kind: "preview",
      preview: {
        actionLabel: "Resubmit entries for approval",
        featureGroup: AP,
        riskLabels: ["bulk", "external_side_effect"],
        targets: [{ type: "approval", id: args.id }],
        expectedChanges: [`Resubmit ${args.entryIds.length} entries for approval ${args.id}`],
        reversibility: "You can withdraw afterward.",
        warnings: ["This resubmits entries and notifies approvers."],
      },
      operation: { actionName: "clockify_approvals_resubmit", featureGroup: AP, risks: ["bulk", "external_side_effect"], payload: { id: args.id, entryIds: args.entryIds, note: args.note } },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { id: string; entryIds: string[]; note?: string };
    const result = await ctx.clockify.resubmitApproval(payload.id, payload.entryIds, payload.note);
    return successReceipt({ action: "clockify_approvals_resubmit", entity: "approval", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "approval", id: result.id }] } });
  },
});

export const APPROVAL_ACTIONS: ActionDefinition[] = [listApprovals, getApproval, submitApproval, approve, reject, withdraw, resubmit];
