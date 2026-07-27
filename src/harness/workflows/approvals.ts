import { z } from "zod";
import { defineReadAction, defineRiskyAction, type ActionContext, type ActionDefinition, type CommitResult, type TargetSnapshot } from "../action.js";
import { durableMutationContract } from "../durable-mutation-contract.js";
import { commitSingleDurableRiskyStep, executeDurableRiskyStep } from "../durable-risky-write.js";
import { errorReceipt, listReceipt, successReceipt } from "../receipts.js";
import { captureTargetSnapshot, verifyTargetSnapshots } from "../target-snapshots.js";
import { sanitizedFingerprint } from "../safe-json.js";
import { nowDate } from "../../durations.js";
import { resolveInstant, resolvePeriod } from "./resolve.js";
import { dispatchWithReconciliation, reconcileCreate } from "./structure-durable.js";
import { DefinitiveWriteFailure } from "../../clockify/write-outcome.js";
import { APPROVAL_PENDING_BATCH_MAX } from "../safety-limits.js";
import { isJournalDegradedStep } from "../mutation-workflow.js";
import type {
  ApiAccess,
  ApiActionMetadataCarrier,
  ApiExposure,
  ApiMethod,
  AvailabilityByAuthClass,
  MaterialFieldMetadata,
} from "../api-operation.js";

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

type ApprovalActionName =
  | "clockify_approvals_list"
  | "clockify_approvals_get"
  | "clockify_approvals_submit"
  | "clockify_approvals_approve"
  | "clockify_approvals_approve_pending"
  | "clockify_approvals_reject"
  | "clockify_approvals_withdraw"
  | "clockify_approvals_resubmit";

const APPROVAL_AVAILABILITY: AvailabilityByAuthClass = Object.freeze({
  addon: Object.freeze({ available: true }),
  api_key: Object.freeze({ available: true }),
});

function approvalEndpointKey(access: ApiAccess, method: ApiMethod, path: string): string {
  return [access, "api", method, path, "approvals.ts"].join("\0");
}

function approvalMaterialField(
  path: string,
  label: string,
  formatterId: string,
  requiredInPreview: boolean,
): MaterialFieldMetadata {
  return Object.freeze({
    kind: "value",
    path,
    label,
    formatterId,
    formatterVersion: 1,
    requiredInPreview,
  });
}

function approvalApiMetadata(input: {
  actionName: ApprovalActionName;
  operationId: string;
  method: ApiMethod;
  path: string;
  access: ApiAccess;
  primary: string;
  support: readonly string[];
  materialFields: readonly MaterialFieldMetadata[];
}): ApiActionMetadataCarrier {
  return Object.freeze({
    apiExposure: "api",
    apiOperation: Object.freeze({
      operationId: input.operationId,
      host: "api",
      method: input.method,
      path: input.path,
      access: input.access,
      exposure: "api",
    }),
    adapterEndpoints: Object.freeze({
      primary: Object.freeze([input.primary]),
      support: Object.freeze([...input.support]),
    }),
    availabilityByAuthClass: APPROVAL_AVAILABILITY,
    boundedArgumentDictionaries: Object.freeze([]),
    materialFields: Object.freeze([...input.materialFields]),
    presentation: Object.freeze({ presenterId: input.actionName, version: 1 }),
  });
}

function approvalInternalMetadata(input: {
  exposure: Exclude<ApiExposure, "api" | "local">;
  reason: string;
  primary: readonly string[];
  support: readonly string[];
}): ApiActionMetadataCarrier {
  return Object.freeze({
    apiExposure: input.exposure,
    apiExposureReason: input.reason,
    adapterEndpoints: Object.freeze({
      primary: Object.freeze([...input.primary]),
      support: Object.freeze([...input.support]),
    }),
    availabilityByAuthClass: APPROVAL_AVAILABILITY,
    boundedArgumentDictionaries: Object.freeze([]),
  });
}

const approvalEndpoint = Object.freeze({
  list: approvalEndpointKey("read", "GET", "/workspaces/{workspaceId}/approval-requests"),
  submit: approvalEndpointKey("write", "POST", "/workspaces/{workspaceId}/approval-requests"),
  status: approvalEndpointKey("write", "PATCH", "/workspaces/{workspaceId}/approval-requests/{id}"),
  resubmit: approvalEndpointKey("write", "POST", "/workspaces/{workspaceId}/approval-requests/resubmit-entries-for-approval"),
});

const APPROVAL_API_METADATA = Object.freeze({
  clockify_approvals_list: approvalApiMetadata({
    actionName: "clockify_approvals_list",
    operationId: "getApprovalRequests",
    method: "GET",
    path: "/workspaces/{workspaceId}/approval-requests",
    access: "read",
    primary: approvalEndpoint.list,
    support: [],
    materialFields: [],
  }),
  clockify_approvals_get: approvalInternalMetadata({
    exposure: "composite",
    reason: "Finds one approval request by scanning the approval-request list because Clockify exposes no GET approval-by-id operation; it is not a fabricated get-one operation.",
    primary: [approvalEndpoint.list],
    support: [],
  }),
  clockify_approvals_submit: approvalApiMetadata({
    actionName: "clockify_approvals_submit",
    operationId: "createApprrovalRequest",
    method: "POST",
    path: "/workspaces/{workspaceId}/approval-requests",
    access: "write",
    primary: approvalEndpoint.submit,
    support: [approvalEndpoint.list],
    materialFields: [
      approvalMaterialField("/period", "Period", "text", true),
      approvalMaterialField("/periodStart", "Period start", "text", true),
    ],
  }),
  clockify_approvals_approve: approvalApiMetadata({
    actionName: "clockify_approvals_approve",
    operationId: "updateApprovalStatus",
    method: "PATCH",
    path: "/workspaces/{workspaceId}/approval-requests/{id}",
    access: "write",
    primary: approvalEndpoint.status,
    support: [approvalEndpoint.list],
    materialFields: [
      approvalMaterialField("/id", "Approval", "entity", true),
      approvalMaterialField("/state", "State", "text", true),
      approvalMaterialField("/note", "Note", "text", false),
    ],
  }),
  clockify_approvals_approve_pending: approvalInternalMetadata({
    exposure: "composite",
    reason: "May approve up to 18 requests through independent status PATCHes, so the current approve-all loop is not one atomic API operation; use the single-request approval operation.",
    primary: [approvalEndpoint.status],
    support: [approvalEndpoint.list],
  }),
  clockify_approvals_reject: approvalApiMetadata({
    actionName: "clockify_approvals_reject",
    operationId: "updateApprovalStatus",
    method: "PATCH",
    path: "/workspaces/{workspaceId}/approval-requests/{id}",
    access: "write",
    primary: approvalEndpoint.status,
    support: [approvalEndpoint.list],
    materialFields: [
      approvalMaterialField("/id", "Approval", "entity", true),
      approvalMaterialField("/state", "State", "text", true),
      approvalMaterialField("/note", "Note", "text", false),
    ],
  }),
  clockify_approvals_withdraw: approvalApiMetadata({
    actionName: "clockify_approvals_withdraw",
    operationId: "updateApprovalStatus",
    method: "PATCH",
    path: "/workspaces/{workspaceId}/approval-requests/{id}",
    access: "write",
    primary: approvalEndpoint.status,
    support: [approvalEndpoint.list],
    materialFields: [
      approvalMaterialField("/id", "Approval", "entity", true),
      approvalMaterialField("/state", "State", "text", true),
      approvalMaterialField("/note", "Note", "text", false),
    ],
  }),
  clockify_approvals_resubmit: approvalApiMetadata({
    actionName: "clockify_approvals_resubmit",
    operationId: "resubmitApprovalRequest",
    method: "POST",
    path: "/workspaces/{workspaceId}/approval-requests/resubmit-entries-for-approval",
    access: "write",
    primary: approvalEndpoint.resubmit,
    support: [approvalEndpoint.list],
    materialFields: [
      approvalMaterialField("/approvalId", "Approval", "entity", true),
      approvalMaterialField("/period", "Period", "text", true),
      approvalMaterialField("/periodStart", "Period start", "text", true),
    ],
  }),
} satisfies Readonly<Record<ApprovalActionName, ApiActionMetadataCarrier>>);

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
  ...APPROVAL_API_METADATA.clockify_approvals_list,
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
  ...APPROVAL_API_METADATA.clockify_approvals_get,
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
  ...APPROVAL_API_METADATA.clockify_approvals_submit,
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
function stateAction(
  name: "clockify_approvals_approve" | "clockify_approvals_reject",
  label: string,
  state: string,
): ActionDefinition {
  return defineRiskyAction({
    ...APPROVAL_API_METADATA[name],
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

interface PendingApprovalOperation {
  approvals: Array<{ id: string; previousState: string }>;
}

function approvePendingPartial(
  ctx: ActionContext,
  completedIds: readonly string[],
  total: number,
  message: string,
  outcomeUnknown = false,
): Extract<CommitResult, { kind: "partial" }> {
  return {
    kind: "partial",
    receipt: successReceipt({
      action: "clockify_approvals_approve_pending",
      entity: "approval",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: completedIds.map((id) => ({ type: "approval", id, name: "APPROVED" })) },
      warnings: outcomeUnknown
        ? [{ code: "outcome_unknown", message: "A later approval result is unknown." }]
        : undefined,
    }),
    message: `${completedIds.length} of ${total} pending timesheets are known to be approved. ${message}`,
    recovery: {
      hint: "Refresh pending approvals before creating a preview for anything still unfinished.",
      retryable: false,
    },
  };
}

function approvePendingPreDispatchStopped(detail: unknown): boolean {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return false;
  const record = detail as Record<string, unknown>;
  if (typeof record.code === "string" && [
    "mutation_dispatch_denied",
    "mutation_plan_violation",
    "host_call_budget_exceeded",
    "host_request_cancelled",
  ].includes(record.code)) return true;
  return approvePendingPreDispatchStopped(record.dispatch);
}

const approvePending = defineRiskyAction({
  ...APPROVAL_API_METADATA.clockify_approvals_approve_pending,
  name: "clockify_approvals_approve_pending",
  description:
    "Approve ALL currently pending timesheets. Takes no ids: the harness lists the complete pending set server-side, binds every exact approval to one preview, and only the preview button can execute it. Never ask for typed confirmation and never call the single-id approval action for an approve-all request.",
  group: AP,
  risks: ["bulk", "external_side_effect"],
  mutationWorkflow: "durable",
  mutationContract: approvalStateContract,
  schema: z.object({}).strict(),
  async preview(ctx) {
    const listed = await ctx.clockify.listApprovals({ status: "PENDING" });
    if (listed.truncated) {
      return { clarify: "Clockify returned an incomplete pending-timesheet list, so I cannot bind a truthful approve-all preview." };
    }
    const pending = listed.rows
      .filter((approval) => approval.state === "PENDING")
      .sort((left, right) => left.id.localeCompare(right.id));
    if (pending.length === 0) return { clarify: "There are no pending timesheets to approve." };
    if (pending.length > APPROVAL_PENDING_BATCH_MAX) {
      return {
        clarify:
          `There are ${pending.length} pending timesheets, above the safe one-operation limit of ${APPROVAL_PENDING_BATCH_MAX}. Narrow the request before approving.`,
      };
    }

    const targetSnapshots = pending.map((approval) =>
      captureTargetSnapshot(
        "target",
        { type: "approval", id: approval.id, ...(approval.userName ? { name: approval.userName } : {}) },
        approvalProjection(approval),
      ));
    return {
      actionLabel: `Approve ${pending.length} pending timesheet${pending.length === 1 ? "" : "s"}`,
      targets: pending.map((approval) => ({
        type: "approval",
        id: approval.id,
        ...(approval.userName ? { name: approval.userName } : {}),
      })),
      expectedChanges: pending.map((approval) =>
        `Approve ${approval.userName ?? approval.id}${approval.periodStart ? ` (${approval.periodStart.slice(0, 10)})` : ""}`),
      reversibility: "Approval decisions notify each timesheet owner and may be hard to reverse.",
      warnings: ["This approves every timesheet shown in this exact preview and notifies its owner."],
      payload: {
        approvals: pending.map((approval) => ({ id: approval.id, previousState: "PENDING" })),
      },
      targetSnapshots,
      mutationPlan: {
        mode: "batch",
        steps: targetSnapshots.map((snapshot, index) => ({
          id: `approve-pending-${index}`,
          kind: "primary" as const,
          targetFingerprint: snapshot.fingerprint,
          reconciliationStrategy: "state-command" as const,
        })),
      },
    };
  },
  async commit(ctx, payload, operation) {
    const { approvals } = payload as unknown as PendingApprovalOperation;
    const snapshots = operation.targetSnapshots ?? [];
    if (approvals.length === 0 || approvals.length !== snapshots.length ||
      approvals.length !== operation.mutationPlan?.steps.length || approvals.length > APPROVAL_PENDING_BATCH_MAX) {
      return errorReceipt({
        action: operation.actionName,
        code: "invalid_mutation_plan",
        message: "The stored approve-all batch is incomplete or exceeds its safe bound.",
        recovery: { hint: "Create a fresh preview from the current pending-timesheet list.", retryable: false },
      });
    }

    const completedIds: string[] = [];
    for (const [index, approval] of approvals.entries()) {
      const snapshot = snapshots[index] as TargetSnapshot | undefined;
      const planStepId = `approve-pending-${index}`;
      if (!snapshot || snapshot.ref.id !== approval.id || operation.mutationPlan.steps[index]?.id !== planStepId) {
        return completedIds.length > 0
          ? approvePendingPartial(ctx, completedIds, approvals.length, "The stored next target was invalid, so no later approval was sent.")
          : errorReceipt({
              action: operation.actionName,
              code: "invalid_mutation_plan",
              message: "The stored approve-all target does not match its exact plan.",
              recovery: { hint: "Create a fresh preview.", retryable: false },
            });
      }

      let verificationFailure: "stale_target" | "stale_parent" | undefined;
      let reconciled = false;
      const step = await executeDurableRiskyStep({
        ctx,
        operation,
        planStepId,
        index,
        name: `Approve pending timesheet ${approval.id}`,
        preparedDetail: { targetSnapshots: [snapshot] },
        async dispatch() {
          const verified = await verifyTargetSnapshots([snapshot], async () => {
            const current = await ctx.clockify.getApproval(approval.id);
            return current
              ? { ref: { type: "approval", id: approval.id }, projection: approvalProjection(current) }
              : undefined;
          });
          if (!verified.ok) {
            verificationFailure = verified.code;
            throw new DefinitiveWriteFailure("VERIFY", planStepId, verified.code);
          }
          const dispatched = await dispatchWithReconciliation({
            dispatch: () => ctx.clockify.setApprovalStateAtomic(approval.id, "APPROVED"),
            reconcile: async () => {
              const current = await ctx.clockify.getApproval(approval.id);
              return current?.state === "APPROVED" ? { id: current.id, name: "APPROVED" } : undefined;
            },
          });
          reconciled = dispatched.reconciled;
          return {
            externalId: dispatched.value.id,
            effect: { previousState: approval.previousState, state: "APPROVED" },
            detail: { reconciled: dispatched.reconciled },
          };
        },
      });

      if (step.status === "succeeded") {
        completedIds.push(step.externalId ?? approval.id);
        if (isJournalDegradedStep(step)) {
          return approvePendingPartial(
            ctx,
            completedIds,
            approvals.length,
            "The latest approval succeeded, but its full local journal settlement degraded; no later approval was sent.",
          );
        }
        if (reconciled && index < approvals.length - 1) {
          return approvePendingPartial(
            ctx,
            completedIds,
            approvals.length,
            "The latest approval was proven successful after an ambiguous response, so no later approval was sent.",
          );
        }
        continue;
      }

      if (completedIds.length > 0) {
        const preDispatchStopped = approvePendingPreDispatchStopped(step.detail);
        return approvePendingPartial(
          ctx,
          completedIds,
          approvals.length,
          verificationFailure
            ? "The next timesheet changed after preview, so it and all later approvals were not sent."
            : preDispatchStopped
              ? "A fresh authorization or execution gate stopped the next approval before dispatch; it and all later approvals were not sent."
            : step.status === "outcome_unknown"
              ? "The next approval may or may not have applied; no later approval was sent."
              : "Clockify definitively rejected the next approval; no later approval was sent.",
          step.status === "outcome_unknown",
        );
      }
      if (verificationFailure) {
        return errorReceipt({
          action: operation.actionName,
          code: verificationFailure,
          message: "A pending timesheet changed after preview. No approval mutation was sent.",
          recovery: { hint: "Refresh pending approvals and create a fresh preview.", retryable: true },
        });
      }
      if (approvePendingPreDispatchStopped(step.detail)) {
        return errorReceipt({
          action: operation.actionName,
          code: "write_blocked_before_dispatch",
          message: "A fresh authorization or execution gate stopped the first approval before dispatch. No approval mutation was sent.",
          recovery: { hint: "Restore authorization and create a fresh preview.", retryable: true },
        });
      }
      return errorReceipt({
        action: operation.actionName,
        code: step.status === "outcome_unknown" ? "commit_outcome_unknown" : "write_failed",
        message: step.status === "outcome_unknown"
          ? "Clockify did not provide a definitive result for the first approval. No later approval was sent."
          : "Clockify definitively rejected the first approval. No later approval was sent.",
        recovery: {
          hint: step.status === "outcome_unknown"
            ? "Verify that exact timesheet in Clockify before deciding what remains."
            : "Refresh pending approvals before retrying.",
          retryable: step.status !== "outcome_unknown",
        },
      });
    }

    return successReceipt({
      action: operation.actionName,
      entity: "approval",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: completedIds.map((id) => ({ type: "approval", id, name: "APPROVED" })) },
    });
  },
});

const withdraw = defineRiskyAction({
  ...APPROVAL_API_METADATA.clockify_approvals_withdraw,
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
  ...APPROVAL_API_METADATA.clockify_approvals_resubmit,
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

export const APPROVAL_ACTIONS: ActionDefinition[] = [listApprovals, getApproval, submitApproval, approve, approvePending, reject, withdraw, resubmit];

/** Read-only startup dispatcher metadata; it grants no mutation capability. */
export const APPROVAL_STARTUP_RECONCILIATION = Object.freeze({
  clockify_approvals_submit: { "submit-approval": "create" },
  clockify_approvals_approve: { "set-approval-state": "state-command" },
  clockify_approvals_approve_pending: { "approve-pending-*": "state-command" },
  clockify_approvals_reject: { "set-approval-state": "state-command" },
  clockify_approvals_withdraw: { "withdraw-approval": "state-command" },
  clockify_approvals_resubmit: { "resubmit-approval": "state-command" },
} as const);
