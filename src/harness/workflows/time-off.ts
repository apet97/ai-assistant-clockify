import { z } from "zod";
import {
  defineReadAction,
  defineRiskyAction,
  type ActionDefinition,
} from "../action.js";
import { successReceipt } from "../receipts.js";
import { resolveRelativeDay } from "./resolve.js";

/**
 * Typed time-off workflows (goclmcp §2.9 — policies, requests, balances). Reads
 * execute immediately; writes run preview→commit. Risk classes: policy
 * create/update + balance update = `high_risk_write`; policy archive + request
 * delete = `destructive`; request create + approve/deny = `external_side_effect`
 * (they notify the requester/approver). All gated by `time_off_approvals` — these
 * are real Clockify writes, so they use high_risk_write / external_side_effect
 * (both keep the policy gate), NEVER `permission_change` (which would bypass it).
 * Approve/deny supersede the generic `clockify_manage_time_off`.
 */

const TOA = "time_off_approvals" as const;

// ── Policies ────────────────────────────────────────────────────────────────

const listPolicies = defineReadAction({
  name: "clockify_time_off_policies_list",
  description: "List time-off policies.",
  group: TOA,
  schema: z.object({}),
  async handler(ctx) {
    const items = await ctx.clockify.listTimeOffPolicies();
    return successReceipt({
      action: "clockify_time_off_policies_list",
      entity: "time_off_policy",
      ids: { workspaceId: ctx.workspaceId },
      data: { count: items.length, items },
    });
  },
});

const getPolicy = defineReadAction({
  name: "clockify_time_off_policies_get",
  description: "Fetch a single time-off policy by id.",
  group: TOA,
  schema: z.object({ id: z.string().min(1) }),
  async handler(ctx, args) {
    const entity = await ctx.clockify.getTimeOffPolicy(args.id);
    return successReceipt({
      action: "clockify_time_off_policies_get",
      entity: "time_off_policy",
      ids: { workspaceId: ctx.workspaceId },
      data: { entity },
    });
  },
});

const createPolicy = defineRiskyAction({
  name: "clockify_time_off_policies_create",
  description:
    "Create a time-off policy (scoped to you). Elevated write — previews and requires confirmation.",
  group: TOA,
  risks: ["high_risk_write"],
  schema: z.object({
    name: z.string().min(1),
    requiresApproval: z.boolean().optional(),
    daysPerYear: z.number().nonnegative().optional(),
    negativeBalance: z.boolean().optional(),
  }),
  async preview(_ctx, args) {
    const input = {
      name: args.name,
      ...(args.requiresApproval !== undefined ? { requiresApproval: args.requiresApproval } : {}),
      ...(args.daysPerYear !== undefined ? { daysPerYear: args.daysPerYear } : {}),
      ...(args.negativeBalance !== undefined ? { negativeBalance: args.negativeBalance } : {}),
    };
    return {
      actionLabel: "Create time-off policy",
      targets: [],
      expectedChanges: [`Create time-off policy "${args.name}"`],
      reversibility: "You can archive the policy afterward.",
      warnings: ["This adds a time-off policy to the workspace."],
      payload: { input },
    };
  },
  async commit(ctx, payload) {
    const { input } = payload as { input: { name: string; requiresApproval?: boolean; daysPerYear?: number; negativeBalance?: boolean } };
    const policy = await ctx.clockify.createTimeOffPolicy({ ...input, userId: ctx.adminUserId });
    return successReceipt({
      action: "clockify_time_off_policies_create",
      entity: "time_off_policy",
      ids: { workspaceId: ctx.workspaceId },
      changed: { created: [{ type: "time_off_policy", id: policy.id, name: policy.name }] },
    });
  },
});

const updatePolicy = defineRiskyAction({
  name: "clockify_time_off_policies_update",
  description:
    "Update a time-off policy (name / approval / days per year). Elevated write — previews and requires confirmation.",
  group: TOA,
  risks: ["high_risk_write"],
  schema: z
    .object({
      id: z.string().min(1),
      name: z.string().optional(),
      requiresApproval: z.boolean().optional(),
      daysPerYear: z.number().nonnegative().optional(),
    })
    .refine((v) => v.name !== undefined || v.requiresApproval !== undefined || v.daysPerYear !== undefined, {
      message: "Provide at least one field to change.",
    }),
  async preview(_ctx, args) {
    const patch = {
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.requiresApproval !== undefined ? { requiresApproval: args.requiresApproval } : {}),
      ...(args.daysPerYear !== undefined ? { daysPerYear: args.daysPerYear } : {}),
    };
    return {
      actionLabel: "Update time-off policy",
      targets: [{ type: "time_off_policy", id: args.id, ...(args.name !== undefined ? { name: args.name } : {}) }],
      expectedChanges: Object.keys(patch).map((k) => `set ${k}`),
      reversibility: "You can update the policy again to revert most fields.",
      warnings: ["This changes a workspace time-off policy."],
      payload: { id: args.id, patch },
    };
  },
  async commit(ctx, payload) {
    const { id, patch } = payload as { id: string; patch: { name?: string; requiresApproval?: boolean; daysPerYear?: number } };
    const updated = await ctx.clockify.updateTimeOffPolicy(id, patch);
    return successReceipt({
      action: "clockify_time_off_policies_update",
      entity: "time_off_policy",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "time_off_policy", id: updated.id, name: updated.name }] },
    });
  },
});

const archivePolicy = defineRiskyAction({
  name: "clockify_time_off_policies_archive",
  description:
    "Archive (or unarchive) a time-off policy. Destructive — previews and requires confirmation.",
  group: TOA,
  risks: ["destructive"],
  schema: z.object({ id: z.string().min(1), name: z.string().optional(), archived: z.boolean().default(true) }),
  async preview(_ctx, args) {
    return {
      actionLabel: args.archived ? "Archive time-off policy" : "Unarchive time-off policy",
      targets: [{ type: "time_off_policy", id: args.id, ...(args.name !== undefined ? { name: args.name } : {}) }],
      expectedChanges: [`${args.archived ? "Archive" : "Unarchive"} policy ${args.name ?? args.id}`],
      reversibility: "You can unarchive the policy to restore it.",
      warnings: ["Archiving a policy stops new requests against it."],
      payload: { id: args.id, name: args.name, archived: args.archived },
    };
  },
  async commit(ctx, payload) {
    const { id, name, archived } = payload as { id: string; name?: string; archived: boolean };
    await ctx.clockify.archiveTimeOffPolicy(id, archived);
    return successReceipt({
      action: "clockify_time_off_policies_archive",
      entity: "time_off_policy",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "time_off_policy", id, name }] },
    });
  },
});

// ── Requests ────────────────────────────────────────────────────────────────

const listRequests = defineReadAction({
  name: "clockify_time_off_requests_list",
  description: "List time-off requests (optional status / user filter).",
  group: TOA,
  schema: z.object({ status: z.string().optional(), userId: z.string().optional() }),
  async handler(ctx, args) {
    const items = await ctx.clockify.listTimeOffRequests(args);
    return successReceipt({
      action: "clockify_time_off_requests_list",
      entity: "time_off_request",
      ids: { workspaceId: ctx.workspaceId },
      data: { count: items.length, items },
    });
  },
});

const getRequest = defineReadAction({
  name: "clockify_time_off_requests_get",
  description: "Fetch a single time-off request by id.",
  group: TOA,
  schema: z.object({ id: z.string().min(1) }),
  async handler(ctx, args) {
    const entity = await ctx.clockify.getTimeOffRequest(args.id);
    return successReceipt({
      action: "clockify_time_off_requests_get",
      entity: "time_off_request",
      ids: { workspaceId: ctx.workspaceId },
      data: { entity },
    });
  },
});

const createRequest = defineRiskyAction({
  name: "clockify_time_off_requests_create",
  description:
    "Submit a time-off request under a policy. `start`/`end` accept YYYY-MM-DD or a relative day (tomorrow/next monday…), resolved server-side. External side effect (notifies approvers) — previews and requires confirmation.",
  group: TOA,
  risks: ["external_side_effect"],
  schema: z.object({
    policyId: z.string().min(1),
    start: z.string().min(1),
    end: z.string().min(1),
    days: z.number().positive().optional(),
    halfDay: z.boolean().optional(),
    note: z.string().optional(),
  }),
  async preview(ctx, args) {
    // The wire wants bare YYYY-MM-DD days; the live loop sent the literal
    // string "next Monday". Resolve here, clarify on anything unparseable.
    const now = (ctx.now ?? (() => new Date()))();
    const start = resolveRelativeDay(now, { date: args.start });
    const end = resolveRelativeDay(now, { date: args.end });
    const bad = [start === undefined ? args.start : undefined, end === undefined ? args.end : undefined].filter(
      (value): value is string => value !== undefined,
    );
    if (bad.length || start === undefined || end === undefined) {
      return {
        clarify: `I couldn't make sense of the date${bad.length > 1 ? "s" : ""} ${bad.map((b) => `"${b}"`).join(" and ")} — give me a calendar date (YYYY-MM-DD) or something like tomorrow or next monday.`,
      };
    }
    const input = {
      start,
      end,
      ...(args.days !== undefined ? { days: args.days } : {}),
      ...(args.halfDay !== undefined ? { halfDay: args.halfDay } : {}),
      ...(args.note !== undefined ? { note: args.note } : {}),
    };
    // Surface a short balance before confirm: Clockify rejects an over-balance
    // request with the misleading "Value for number of days is not allowed", so
    // the constraint must be visible in the PREVIEW (Phase 4 discipline). The
    // balance read is best-effort — a failure never blocks the request.
    const requestedDays =
      args.days ??
      (args.halfDay ? 0.5 : Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1);
    const warnings = ["This submits a request that notifies approvers."];
    try {
      const balances = await ctx.clockify.getTimeOffBalance(ctx.adminUserId);
      const policyBalance = balances.find((b) => b.policyId === args.policyId)?.balance;
      if (policyBalance !== undefined && requestedDays > policyBalance) {
        warnings.push(
          `This requests ${requestedDays} day(s) but the policy balance is ${policyBalance} — Clockify will likely reject it (its error reads "Value for number of days is not allowed"). Top up the balance or shorten the request.`,
        );
      }
    } catch {
      // Balance unavailable — submit as before; Clockify itself remains the gate.
    }
    return {
      actionLabel: "Submit time-off request",
      targets: [{ type: "time_off_policy", id: args.policyId }],
      expectedChanges: [`Request time off ${start} → ${end} under policy ${args.policyId}`],
      reversibility: "You can delete the request afterward.",
      warnings,
      payload: { policyId: args.policyId, input },
    };
  },
  async commit(ctx, payload) {
    const { policyId, input } = payload as { policyId: string; input: Parameters<typeof ctx.clockify.createTimeOffRequest>[1] };
    const req = await ctx.clockify.createTimeOffRequest(policyId, input);
    return successReceipt({
      action: "clockify_time_off_requests_create",
      entity: "time_off_request",
      ids: { workspaceId: ctx.workspaceId },
      changed: { created: [{ type: "time_off_request", id: req.id }] },
    });
  },
});

const deleteRequest = defineRiskyAction({
  name: "clockify_time_off_requests_delete",
  description: "Delete a time-off request. Destructive — previews and requires confirmation.",
  group: TOA,
  risks: ["destructive"],
  schema: z.object({ policyId: z.string().min(1), requestId: z.string().min(1) }),
  async preview(_ctx, args) {
    return {
      actionLabel: "Delete time-off request",
      targets: [{ type: "time_off_request", id: args.requestId }],
      expectedChanges: [`Delete time-off request ${args.requestId}`],
      reversibility: "This cannot be undone.",
      warnings: ["Deleting a time-off request is permanent."],
      payload: { policyId: args.policyId, requestId: args.requestId },
    };
  },
  async commit(ctx, payload) {
    const { policyId, requestId } = payload as { policyId: string; requestId: string };
    await ctx.clockify.deleteTimeOffRequest(policyId, requestId);
    return successReceipt({
      action: "clockify_time_off_requests_delete",
      entity: "time_off_request",
      ids: { workspaceId: ctx.workspaceId },
      changed: { deleted: [{ type: "time_off_request", id: requestId }] },
    });
  },
});

/** Build an approve/deny action (both PATCH the request status; supersede manage_time_off). */
function decisionAction(decision: "approve" | "deny"): ActionDefinition {
  const statusType = decision === "approve" ? "APPROVED" : "REJECTED";
  return defineRiskyAction({
    name: `clockify_time_off_${decision}`,
    description: `${decision === "approve" ? "Approve" : "Deny"} a time-off request. External side effect (notifies the requester) — previews and requires confirmation.`,
    group: TOA,
    risks: ["external_side_effect"],
    schema: z.object({ policyId: z.string().min(1), requestId: z.string().min(1), note: z.string().optional() }),
    async preview(_ctx, args) {
      return {
        actionLabel: `${decision} time-off request`,
        targets: [{ type: "time_off_request", id: args.requestId }],
        expectedChanges: [`${decision} time-off request ${args.requestId} (policy ${args.policyId})`],
        reversibility: "Approval decisions notify the requester and may be hard to reverse.",
        warnings: ["This notifies the requester and changes their balance/schedule."],
        payload: { policyId: args.policyId, requestId: args.requestId, note: args.note },
      };
    },
    async commit(ctx, payload) {
      const { policyId, requestId, note } = payload as { policyId: string; requestId: string; note?: string };
      const result = await ctx.clockify.setTimeOffRequestStatus(policyId, requestId, statusType, note);
      return successReceipt({
        action: `clockify_time_off_${decision}`,
        entity: "time_off_request",
        ids: { workspaceId: ctx.workspaceId },
        changed: { updated: [{ type: "time_off_request", id: result.id, name: result.name }] },
      });
    },
  });
}

const approveRequest = decisionAction("approve");
const denyRequest = decisionAction("deny");

// ── Balances ────────────────────────────────────────────────────────────────

const getBalance = defineReadAction({
  name: "clockify_time_off_balance_get",
  description: "Get a user's time-off balances (defaults to you).",
  group: TOA,
  schema: z.object({ userId: z.string().optional() }),
  async handler(ctx, args) {
    const items = await ctx.clockify.getTimeOffBalance(args.userId ?? ctx.adminUserId);
    return successReceipt({
      action: "clockify_time_off_balance_get",
      entity: "time_off_balance",
      ids: { workspaceId: ctx.workspaceId },
      data: { count: items.length, items },
    });
  },
});

const updateBalance = defineRiskyAction({
  name: "clockify_time_off_balance_update",
  description:
    "Adjust users' time-off balance for a policy. Elevated write — previews and requires confirmation.",
  group: TOA,
  risks: ["high_risk_write"],
  schema: z.object({
    policyId: z.string().min(1),
    userIds: z.array(z.string().min(1)).min(1),
    value: z.number(),
    note: z.string().optional(),
  }),
  async preview(_ctx, args) {
    return {
      actionLabel: "Adjust time-off balance",
      targets: [{ type: "time_off_policy", id: args.policyId }],
      expectedChanges: [`Adjust balance by ${args.value} for ${args.userIds.length} user(s) on policy ${args.policyId}`],
      reversibility: "You can adjust the balance again to revert.",
      warnings: ["This changes users' accrued time-off balance."],
      payload: { policyId: args.policyId, userIds: args.userIds, value: args.value, note: args.note },
    };
  },
  async commit(ctx, payload) {
    const { policyId, userIds, value, note } = payload as { policyId: string; userIds: string[]; value: number; note?: string };
    await ctx.clockify.updateTimeOffBalance(policyId, {
      userIds,
      value,
      ...(note !== undefined ? { note } : {}),
    });
    return successReceipt({
      action: "clockify_time_off_balance_update",
      entity: "time_off_balance",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "time_off_policy", id: policyId }] },
    });
  },
});

export const TIME_OFF_ACTIONS: ActionDefinition[] = [
  listPolicies,
  getPolicy,
  createPolicy,
  updatePolicy,
  archivePolicy,
  listRequests,
  getRequest,
  createRequest,
  deleteRequest,
  approveRequest,
  denyRequest,
  getBalance,
  updateBalance,
];
