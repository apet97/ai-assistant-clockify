import { z } from "zod";
import { defineAction, type ActionDefinition } from "../action.js";
import { successReceipt } from "../receipts.js";

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

const listPolicies = defineAction({
  name: "clockify_time_off_policies_list",
  description: "List time-off policies.",
  featureGroup: TOA,
  risks: ["read"],
  schema: z.object({}),
  async handler(ctx) {
    const items = await ctx.clockify.listTimeOffPolicies();
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_time_off_policies_list",
        entity: "time_off_policy",
        ids: { workspaceId: ctx.workspaceId },
        data: { count: items.length, items },
      }),
    };
  },
});

const getPolicy = defineAction({
  name: "clockify_time_off_policies_get",
  description: "Fetch a single time-off policy by id.",
  featureGroup: TOA,
  risks: ["read"],
  schema: z.object({ id: z.string().min(1) }),
  async handler(ctx, args) {
    const entity = await ctx.clockify.getTimeOffPolicy(args.id);
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_time_off_policies_get",
        entity: "time_off_policy",
        ids: { workspaceId: ctx.workspaceId },
        data: { entity },
      }),
    };
  },
});

const createPolicy = defineAction({
  name: "clockify_time_off_policies_create",
  description:
    "Create a time-off policy (scoped to you). Elevated write — previews and requires confirmation.",
  featureGroup: TOA,
  risks: ["high_risk_write"],
  schema: z.object({
    name: z.string().min(1),
    requiresApproval: z.boolean().optional(),
    daysPerYear: z.number().nonnegative().optional(),
    negativeBalance: z.boolean().optional(),
  }),
  async handler(ctx, args) {
    const input = {
      name: args.name,
      ...(args.requiresApproval !== undefined ? { requiresApproval: args.requiresApproval } : {}),
      ...(args.daysPerYear !== undefined ? { daysPerYear: args.daysPerYear } : {}),
      ...(args.negativeBalance !== undefined ? { negativeBalance: args.negativeBalance } : {}),
    };
    return {
      kind: "preview",
      preview: {
        actionLabel: "Create time-off policy",
        featureGroup: TOA,
        riskLabels: ["high_risk_write"],
        targets: [],
        expectedChanges: [`Create time-off policy "${args.name}"`],
        reversibility: "You can archive the policy afterward.",
        warnings: ["This adds a time-off policy to the workspace."],
      },
      operation: {
        actionName: "clockify_time_off_policies_create",
        featureGroup: TOA,
        risks: ["high_risk_write"],
        payload: { input },
      },
    };
  },
  async commit(ctx, operation) {
    const { input } = operation.payload as { input: { name: string; requiresApproval?: boolean; daysPerYear?: number; negativeBalance?: boolean } };
    const policy = await ctx.clockify.createTimeOffPolicy({ ...input, userId: ctx.adminUserId });
    return successReceipt({
      action: "clockify_time_off_policies_create",
      entity: "time_off_policy",
      ids: { workspaceId: ctx.workspaceId },
      changed: { created: [{ type: "time_off_policy", id: policy.id, name: policy.name }] },
    });
  },
});

const updatePolicy = defineAction({
  name: "clockify_time_off_policies_update",
  description:
    "Update a time-off policy (name / approval / days per year). Elevated write — previews and requires confirmation.",
  featureGroup: TOA,
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
  async handler(ctx, args) {
    const patch = {
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.requiresApproval !== undefined ? { requiresApproval: args.requiresApproval } : {}),
      ...(args.daysPerYear !== undefined ? { daysPerYear: args.daysPerYear } : {}),
    };
    return {
      kind: "preview",
      preview: {
        actionLabel: "Update time-off policy",
        featureGroup: TOA,
        riskLabels: ["high_risk_write"],
        targets: [{ type: "time_off_policy", id: args.id, ...(args.name !== undefined ? { name: args.name } : {}) }],
        expectedChanges: Object.keys(patch).map((k) => `set ${k}`),
        reversibility: "You can update the policy again to revert most fields.",
        warnings: ["This changes a workspace time-off policy."],
      },
      operation: {
        actionName: "clockify_time_off_policies_update",
        featureGroup: TOA,
        risks: ["high_risk_write"],
        payload: { id: args.id, patch },
      },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { id: string; patch: { name?: string; requiresApproval?: boolean; daysPerYear?: number } };
    const updated = await ctx.clockify.updateTimeOffPolicy(payload.id, payload.patch);
    return successReceipt({
      action: "clockify_time_off_policies_update",
      entity: "time_off_policy",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "time_off_policy", id: updated.id, name: updated.name }] },
    });
  },
});

const archivePolicy = defineAction({
  name: "clockify_time_off_policies_archive",
  description:
    "Archive (or unarchive) a time-off policy. Destructive — previews and requires confirmation.",
  featureGroup: TOA,
  risks: ["destructive"],
  schema: z.object({ id: z.string().min(1), name: z.string().optional(), archived: z.boolean().default(true) }),
  async handler(ctx, args) {
    return {
      kind: "preview",
      preview: {
        actionLabel: args.archived ? "Archive time-off policy" : "Unarchive time-off policy",
        featureGroup: TOA,
        riskLabels: ["destructive"],
        targets: [{ type: "time_off_policy", id: args.id, ...(args.name !== undefined ? { name: args.name } : {}) }],
        expectedChanges: [`${args.archived ? "Archive" : "Unarchive"} policy ${args.name ?? args.id}`],
        reversibility: "You can unarchive the policy to restore it.",
        warnings: ["Archiving a policy stops new requests against it."],
      },
      operation: {
        actionName: "clockify_time_off_policies_archive",
        featureGroup: TOA,
        risks: ["destructive"],
        payload: { id: args.id, name: args.name, archived: args.archived },
      },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { id: string; name?: string; archived: boolean };
    await ctx.clockify.archiveTimeOffPolicy(payload.id, payload.archived);
    return successReceipt({
      action: "clockify_time_off_policies_archive",
      entity: "time_off_policy",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "time_off_policy", id: payload.id, name: payload.name }] },
    });
  },
});

// ── Requests ────────────────────────────────────────────────────────────────

const listRequests = defineAction({
  name: "clockify_time_off_requests_list",
  description: "List time-off requests (optional status / user filter).",
  featureGroup: TOA,
  risks: ["read"],
  schema: z.object({ status: z.string().optional(), userId: z.string().optional() }),
  async handler(ctx, args) {
    const items = await ctx.clockify.listTimeOffRequests(args);
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_time_off_requests_list",
        entity: "time_off_request",
        ids: { workspaceId: ctx.workspaceId },
        data: { count: items.length, items },
      }),
    };
  },
});

const getRequest = defineAction({
  name: "clockify_time_off_requests_get",
  description: "Fetch a single time-off request by id.",
  featureGroup: TOA,
  risks: ["read"],
  schema: z.object({ id: z.string().min(1) }),
  async handler(ctx, args) {
    const entity = await ctx.clockify.getTimeOffRequest(args.id);
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_time_off_requests_get",
        entity: "time_off_request",
        ids: { workspaceId: ctx.workspaceId },
        data: { entity },
      }),
    };
  },
});

const createRequest = defineAction({
  name: "clockify_time_off_requests_create",
  description:
    "Submit a time-off request under a policy. External side effect (notifies approvers) — previews and requires confirmation.",
  featureGroup: TOA,
  risks: ["external_side_effect"],
  schema: z.object({
    policyId: z.string().min(1),
    start: z.string().min(1),
    end: z.string().min(1),
    days: z.number().positive().optional(),
    halfDay: z.boolean().optional(),
    note: z.string().optional(),
  }),
  async handler(ctx, args) {
    const input = {
      start: args.start,
      end: args.end,
      ...(args.days !== undefined ? { days: args.days } : {}),
      ...(args.halfDay !== undefined ? { halfDay: args.halfDay } : {}),
      ...(args.note !== undefined ? { note: args.note } : {}),
    };
    return {
      kind: "preview",
      preview: {
        actionLabel: "Submit time-off request",
        featureGroup: TOA,
        riskLabels: ["external_side_effect"],
        targets: [{ type: "time_off_policy", id: args.policyId }],
        expectedChanges: [`Request time off ${args.start} → ${args.end} under policy ${args.policyId}`],
        reversibility: "You can delete the request afterward.",
        warnings: ["This submits a request that notifies approvers."],
      },
      operation: {
        actionName: "clockify_time_off_requests_create",
        featureGroup: TOA,
        risks: ["external_side_effect"],
        payload: { policyId: args.policyId, input },
      },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { policyId: string; input: Parameters<typeof ctx.clockify.createTimeOffRequest>[1] };
    const req = await ctx.clockify.createTimeOffRequest(payload.policyId, payload.input);
    return successReceipt({
      action: "clockify_time_off_requests_create",
      entity: "time_off_request",
      ids: { workspaceId: ctx.workspaceId },
      changed: { created: [{ type: "time_off_request", id: req.id }] },
    });
  },
});

const deleteRequest = defineAction({
  name: "clockify_time_off_requests_delete",
  description: "Delete a time-off request. Destructive — previews and requires confirmation.",
  featureGroup: TOA,
  risks: ["destructive"],
  schema: z.object({ policyId: z.string().min(1), requestId: z.string().min(1) }),
  async handler(ctx, args) {
    return {
      kind: "preview",
      preview: {
        actionLabel: "Delete time-off request",
        featureGroup: TOA,
        riskLabels: ["destructive"],
        targets: [{ type: "time_off_request", id: args.requestId }],
        expectedChanges: [`Delete time-off request ${args.requestId}`],
        reversibility: "This cannot be undone.",
        warnings: ["Deleting a time-off request is permanent."],
      },
      operation: {
        actionName: "clockify_time_off_requests_delete",
        featureGroup: TOA,
        risks: ["destructive"],
        payload: { policyId: args.policyId, requestId: args.requestId },
      },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { policyId: string; requestId: string };
    await ctx.clockify.deleteTimeOffRequest(payload.policyId, payload.requestId);
    return successReceipt({
      action: "clockify_time_off_requests_delete",
      entity: "time_off_request",
      ids: { workspaceId: ctx.workspaceId },
      changed: { deleted: [{ type: "time_off_request", id: payload.requestId }] },
    });
  },
});

/** Build an approve/deny action (both PATCH the request status; supersede manage_time_off). */
function decisionAction(decision: "approve" | "deny"): ActionDefinition {
  const statusType = decision === "approve" ? "APPROVED" : "REJECTED";
  return defineAction({
    name: `clockify_time_off_${decision}`,
    description: `${decision === "approve" ? "Approve" : "Deny"} a time-off request. External side effect (notifies the requester) — previews and requires confirmation.`,
    featureGroup: TOA,
    risks: ["external_side_effect"],
    schema: z.object({ policyId: z.string().min(1), requestId: z.string().min(1), note: z.string().optional() }),
    async handler(ctx, args) {
      return {
        kind: "preview",
        preview: {
          actionLabel: `${decision} time-off request`,
          featureGroup: TOA,
          riskLabels: ["external_side_effect"],
          targets: [{ type: "time_off_request", id: args.requestId }],
          expectedChanges: [`${decision} time-off request ${args.requestId} (policy ${args.policyId})`],
          reversibility: "Approval decisions notify the requester and may be hard to reverse.",
          warnings: ["This notifies the requester and changes their balance/schedule."],
        },
        operation: {
          actionName: `clockify_time_off_${decision}`,
          featureGroup: TOA,
          risks: ["external_side_effect"],
          payload: { policyId: args.policyId, requestId: args.requestId, note: args.note },
        },
      };
    },
    async commit(ctx, operation) {
      const payload = operation.payload as { policyId: string; requestId: string; note?: string };
      const result = await ctx.clockify.setTimeOffRequestStatus(payload.policyId, payload.requestId, statusType, payload.note);
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

const getBalance = defineAction({
  name: "clockify_time_off_balance_get",
  description: "Get a user's time-off balances (defaults to you).",
  featureGroup: TOA,
  risks: ["read"],
  schema: z.object({ userId: z.string().optional() }),
  async handler(ctx, args) {
    const items = await ctx.clockify.getTimeOffBalance(args.userId ?? ctx.adminUserId);
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_time_off_balance_get",
        entity: "time_off_balance",
        ids: { workspaceId: ctx.workspaceId },
        data: { count: items.length, items },
      }),
    };
  },
});

const updateBalance = defineAction({
  name: "clockify_time_off_balance_update",
  description:
    "Adjust users' time-off balance for a policy. Elevated write — previews and requires confirmation.",
  featureGroup: TOA,
  risks: ["high_risk_write"],
  schema: z.object({
    policyId: z.string().min(1),
    userIds: z.array(z.string().min(1)).min(1),
    value: z.number(),
    note: z.string().optional(),
  }),
  async handler(ctx, args) {
    return {
      kind: "preview",
      preview: {
        actionLabel: "Adjust time-off balance",
        featureGroup: TOA,
        riskLabels: ["high_risk_write"],
        targets: [{ type: "time_off_policy", id: args.policyId }],
        expectedChanges: [`Adjust balance by ${args.value} for ${args.userIds.length} user(s) on policy ${args.policyId}`],
        reversibility: "You can adjust the balance again to revert.",
        warnings: ["This changes users' accrued time-off balance."],
      },
      operation: {
        actionName: "clockify_time_off_balance_update",
        featureGroup: TOA,
        risks: ["high_risk_write"],
        payload: { policyId: args.policyId, userIds: args.userIds, value: args.value, note: args.note },
      },
    };
  },
  async commit(ctx, operation) {
    const payload = operation.payload as { policyId: string; userIds: string[]; value: number; note?: string };
    await ctx.clockify.updateTimeOffBalance(payload.policyId, {
      userIds: payload.userIds,
      value: payload.value,
      ...(payload.note !== undefined ? { note: payload.note } : {}),
    });
    return successReceipt({
      action: "clockify_time_off_balance_update",
      entity: "time_off_balance",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "time_off_policy", id: payload.policyId }] },
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
