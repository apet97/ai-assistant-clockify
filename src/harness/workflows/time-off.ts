import { z } from "zod";
import { zNumberLike, zStringList } from "../arg-shapes.js";
import {
  clarifyResult,
  defineAction,
  defineReadAction,
  defineRiskyAction,
  type ActionContext,
  type ActionDefinition,
  type SemanticLiteralAlias,
  type TargetSnapshot,
} from "../action.js";
import { nowDate } from "../../durations.js";
import { errorReceipt, listReceipt, successReceipt } from "../receipts.js";
import { describePatch, resolveEntityRef, resolvePeriod, resolveRelativeDay, resolveScopeRefs, resolveUserFilter, resolveUserRefs, zonedDayTimeInstant } from "./resolve.js";
import { durableMutationContract } from "../durable-mutation-contract.js";
import { commitSingleDurableRiskyStep, executeDurableRiskyStep } from "../durable-risky-write.js";
import { isJournalDegradedStep, withJournalDegradedWarning } from "../mutation-workflow.js";
import { captureTargetSnapshot, verifyTargetSnapshots } from "../target-snapshots.js";
import { dispatchWithReconciliation, reconcileCreate, reconcileDelete } from "./structure-durable.js";
import type { CreateTimeOffPolicyInput, CreateTimeOffRequestInput, TimeOffPolicySummary, TimeOffRequestSummary } from "../../clockify/ports/time-off.js";
import { DefinitiveWriteFailure } from "../../clockify/write-outcome.js";
import { TIME_OFF_BALANCE_USER_BATCH_MAX } from "../safety-limits.js";

const REQUIRES_APPROVAL_LITERAL_ALIASES = Object.freeze([
  { path: "requiresApproval", value: false, authoredPhrases: Object.freeze(["does not require approval", "no approval required", "without approval"]) },
  { path: "requiresApproval", value: true, authoredPhrases: Object.freeze(["requires approval", "require approval", "approval required"]) },
] satisfies readonly SemanticLiteralAlias[]);

/** Step a YYYY-MM-DD day forward by n calendar days. */
function addCalendarDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Sat/Sun are not workdays. */
function isWorkday(day: string): boolean {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6;
}

/** The first workday on or after `day`. */
function nextWorkday(day: string): string {
  let d = day;
  while (!isWorkday(d)) d = addCalendarDays(d, 1);
  return d;
}

/** The day reached after `extra` additional workdays beyond `day` (weekends skipped). */
function addWorkdays(day: string, extra: number): string {
  let d = day;
  for (let i = 0; i < extra; i += 1) d = nextWorkday(addCalendarDays(d, 1));
  return d;
}

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
const timeOffCreateContract = durableMutationContract({ source: "confirmed", targeting: { mode: "create_no_target" }, strategies: ["create"] });
const timeOffSnapshotContract = (relations: ["target" | "parent", ...Array<"target" | "parent">], strategy: "create" | "update" | "delete" | "state-command") =>
  durableMutationContract({ source: "confirmed", targeting: { mode: "snapshots", relations }, strategies: [strategy] });

async function policySnapshot(ctx: ActionContext, id: string, relation: "target" | "parent" = "target"): Promise<TargetSnapshot | undefined> {
  const policy = await ctx.clockify.getTimeOffPolicyMutationState(id);
  const policyId = typeof policy?.id === "string" ? policy.id : undefined;
  const name = typeof policy?.name === "string" ? policy.name : undefined;
  return policy && policyId ? captureTargetSnapshot(relation, { type: "time_off_policy", id: policyId, ...(name ? { name } : {}) }, policy) : undefined;
}

async function requestSnapshot(ctx: ActionContext, requestId: string): Promise<TargetSnapshot | undefined> {
  const request = await ctx.clockify.getTimeOffRequest(requestId);
  return request ? captureTargetSnapshot("target", { type: "time_off_request", id: request.id }, request) : undefined;
}

function fetchTimeOffSnapshot(ctx: ActionContext, snapshot: TargetSnapshot) {
  if (snapshot.ref.type === "time_off_policy") {
    return ctx.clockify.getTimeOffPolicyMutationState(snapshot.ref.id).then((row) => row
      ? { ref: { type: "time_off_policy", id: snapshot.ref.id, ...(typeof row.name === "string" ? { name: row.name } : {}) }, projection: row, truncated: false }
      : undefined);
  }
  return ctx.clockify.getTimeOffRequest(snapshot.ref.id).then((row) => row
    ? { ref: { type: "time_off_request", id: row.id }, projection: row, truncated: false }
    : undefined);
}

async function balanceSnapshot(ctx: ActionContext, policyId: string, userIds: string[]): Promise<TargetSnapshot | undefined> {
  const reads = await Promise.all(userIds.map((userId) => ctx.clockify.getTimeOffBalance(userId)));
  if (reads.some((result) => result.truncated)) return undefined;
  const rows = reads.flatMap((result) => result.rows).filter((row) => row.policyId === policyId)
    .sort((a, b) => `${a.userId ?? ""}:${a.policyId ?? ""}`.localeCompare(`${b.userId ?? ""}:${b.policyId ?? ""}`));
  if (new Set(rows.map((row) => row.userId)).size !== new Set(userIds).size) return undefined;
  return captureTargetSnapshot("target", { type: "time_off_balance", id: `${policyId}:${[...userIds].sort().join(",")}` }, rows);
}

function samePolicy(row: TimeOffPolicySummary, expected: CreateTimeOffPolicyInput | Record<string, unknown>): boolean {
  const expectedRecord = expected as Record<string, unknown>;
  if (typeof expected.name === "string" && row.name !== expected.name) return false;
  if ((row.status ?? "ACTIVE") !== (typeof expectedRecord.status === "string" ? expectedRecord.status : "ACTIVE")) return false;
  if ((row.timeUnit ?? "DAYS") !== (typeof expectedRecord.timeUnit === "string" ? expectedRecord.timeUnit : "DAYS")) return false;
  if ((row.requiresApproval ?? false) !== (typeof expected.requiresApproval === "boolean" ? expected.requiresApproval : false)) return false;
  if ((row.negativeBalance ?? false) !== (typeof expected.negativeBalance === "boolean" ? expected.negativeBalance : false)) return false;
  if (Object.hasOwn(expected, "daysPerYear") && row.daysPerYear !== expected.daysPerYear) return false;
  const users = Array.isArray(expected.userIds) && expected.userIds.length
    ? expected.userIds
    : typeof expected.userId === "string" ? [expected.userId] : undefined;
  if (JSON.stringify([...(row.userIds ?? [])].sort()) !== JSON.stringify([...(users ?? [])].sort())) return false;
  const groups = Array.isArray(expected.userGroupIds) ? expected.userGroupIds : [];
  if (JSON.stringify([...(row.userGroupIds ?? [])].sort()) !== JSON.stringify([...groups].sort())) return false;
  return true;
}

function sameRequest(row: TimeOffRequestSummary, policyId: string, input: CreateTimeOffRequestInput, requesterId: string): boolean {
  const isHours = input.timeUnit === "HOURS";
  const expectedDays = isHours
    ? undefined
    : input.days ?? Math.round((Date.parse(`${input.end.slice(0, 10)}T00:00:00Z`) - Date.parse(`${input.start.slice(0, 10)}T00:00:00Z`)) / 86_400_000) + 1;
  return row.policyId === policyId && row.userId === requesterId && row.status === "PENDING" &&
    row.start === input.start && row.end === input.end && (row.timeUnit ?? (isHours ? "HOURS" : "DAYS")) === (isHours ? "HOURS" : "DAYS") &&
    row.days === expectedDays && (row.halfDay ?? false) === (input.halfDay ?? false) &&
    (Object.hasOwn(input, "note") ? row.note === input.note : row.note === undefined);
}

// ── Policies ────────────────────────────────────────────────────────────────

const listPolicies = defineReadAction({
  name: "clockify_time_off_policies_list",
  description: "List time-off policies.",
  group: TOA,
  schema: z.object({}),
  async handler(ctx) {
    const { rows, truncated } = await ctx.clockify.listTimeOffPolicies();
    return listReceipt({
      action: "clockify_time_off_policies_list",
      entity: "time_off_policy",
      ids: { workspaceId: ctx.workspaceId },
      rows,
      truncated,
    });
  },
});

const getPolicy = defineAction({
  name: "clockify_time_off_policies_get",
  description: "Fetch a single time-off policy by id, or by its exact `name` (resolved server-side).",
  featureGroup: TOA,
  risks: ["read"],
  schema: z
    .object({ id: z.string().min(1).optional(), name: z.string().min(1).optional() })
    .refine((v) => v.id !== undefined || v.name !== undefined, {
      message: "Provide the policy id or its exact name.",
    }),
  async handler(ctx, args) {
    const resolved = await resolveEntityRef(args, {
      noun: "time-off policy",
      verb: "fetch",
      list: () => ctx.clockify.listTimeOffPolicies(),
    });
    if (!resolved.ok) return clarifyResult(resolved.clarify);
    const entity = await ctx.clockify.getTimeOffPolicy(resolved.id);
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

const createPolicy = defineRiskyAction({
  name: "clockify_time_off_policies_create",
  description:
    "Create a time-off policy. Scope it with `userIds` and/or `userGroupIds` — each entry an id, exact name, or 'me' (groups by id/exact name), resolved server-side, clarifies on an unknown one; defaults to just you when neither is given. Elevated write — previews and requires confirmation.",
  group: TOA,
  risks: ["high_risk_write"],
  mutationWorkflow: "durable",
  mutationContract: timeOffCreateContract,
  semanticLiteralAliases: Object.freeze([
    { path: "negativeBalance", value: false, authoredPhrases: Object.freeze(["do not allow negative balance", "no negative balance", "negative balance not allowed"]) },
    { path: "negativeBalance", value: true, authoredPhrases: Object.freeze(["allow negative balance", "negative balance allowed"]) },
    ...REQUIRES_APPROVAL_LITERAL_ALIASES,
  ] satisfies readonly SemanticLiteralAlias[]),
  schema: z.object({
    name: z.string().min(1),
    requiresApproval: z.boolean().optional(),
    daysPerYear: zNumberLike(z.number().nonnegative()).optional(),
    negativeBalance: z.boolean().optional(),
    userIds: zStringList().optional(),
    userGroupIds: zStringList().optional(),
  }),
  async preview(ctx, args) {
    const scope = await resolveScopeRefs(ctx, args, { verb: "scope the policy to" });
    if (!scope.ok) return scope.clarify;
    const input: CreateTimeOffPolicyInput = {
      name: args.name,
      userId: ctx.adminUserId,
      ...(args.requiresApproval !== undefined ? { requiresApproval: args.requiresApproval } : {}),
      ...(args.daysPerYear !== undefined ? { daysPerYear: args.daysPerYear } : {}),
      ...(args.negativeBalance !== undefined ? { negativeBalance: args.negativeBalance } : {}),
      ...(scope.userIds?.length ? { userIds: scope.userIds } : {}),
      ...(scope.userGroupIds?.length ? { userGroupIds: scope.userGroupIds } : {}),
    };
    const baseline = await ctx.clockify.listTimeOffPolicies();
    if (baseline.truncated) return { clarify: "Clockify returned an incomplete policy baseline. Retry after it can be read completely." };
    return {
      actionLabel: "Create time-off policy",
      targets: [],
      expectedChanges: [`Create time-off policy "${args.name}" (scoped to ${scope.labels.length ? scope.labels.join(", ") : "you"})`],
      reversibility: "You can archive the policy afterward.",
      warnings: ["This adds a time-off policy to the workspace."],
      payload: { input },
      mutationPlan: { mode: "single", steps: [{ id: "create-time-off-policy", kind: "primary", reconciliationStrategy: "create" }] },
    };
  },
  async commit(ctx, payload, operation) {
    const { input } = payload as { input: CreateTimeOffPolicyInput };
    let baselineIds: string[];
    try {
      const baseline = await ctx.clockify.listTimeOffPolicies();
      if (baseline.truncated) {
        return errorReceipt({
          action: operation.actionName,
          code: "create_baseline_unavailable",
          message: "Clockify returned an incomplete time-off policy list immediately before dispatch. No policy was created.",
          recovery: { hint: "Refresh and preview the policy again when the complete list is available.", retryable: true },
        });
      }
      baselineIds = baseline.rows.map((row) => row.id);
    } catch {
      return errorReceipt({
        action: operation.actionName,
        code: "create_baseline_unavailable",
        message: "The time-off policy list could not be read immediately before dispatch. No policy was created.",
        recovery: { hint: "Refresh and preview the policy again after Clockify reads recover.", retryable: true },
      });
    }
    const step = await executeDurableRiskyStep({
      ctx, operation, planStepId: "create-time-off-policy", index: 0, name: "Create time-off policy",
      preparedDetail: { preDispatch: { strategy: "time_off_policy_create_baseline", ids: baselineIds, truncated: false } },
      dispatch: async () => {
        const result = await dispatchWithReconciliation({ dispatch: () => ctx.clockify.createTimeOffPolicyAtomic(input), reconcile: () => reconcileCreate({ beforeIds: baselineIds, list: () => ctx.clockify.listTimeOffPolicies(), matches: (row) => samePolicy(row, input) }) });
        const policy = result.value;
        return { externalId: policy.id, effect: { created: { type: "time_off_policy", id: policy.id, name: policy.name } }, detail: { reconciled: result.reconciled } };
      },
    });
    if (step.status === "succeeded") {
      const receipt = successReceipt({ action: "clockify_time_off_policies_create", entity: "time_off_policy", ids: { workspaceId: ctx.workspaceId }, changed: { created: [{ type: "time_off_policy", id: step.externalId ?? "unknown", name: input.name }] } });
      return isJournalDegradedStep(step) ? withJournalDegradedWarning(receipt) : receipt;
    }
    return errorReceipt({
      action: operation.actionName,
      code: step.status === "outcome_unknown" ? "commit_outcome_unknown" : "write_failed",
      message: step.status === "outcome_unknown"
        ? "Clockify did not provide a definitive response, so the policy may or may not have been created."
        : "Clockify definitively rejected time-off policy creation.",
      recovery: step.status === "outcome_unknown"
        ? { hint: "Verify the exact policy in Clockify before deciding whether to try again.", retryable: false }
        : { hint: "Correct the policy details and preview again.", retryable: true },
    });
  },
});

const updatePolicy = defineRiskyAction({
  name: "clockify_time_off_policies_update",
  description:
    "Update a time-off policy (name / approval / days per year) or re-scope it with `userIds`/`userGroupIds` (ids, exact names, or 'me'; resolved server-side, clarifies on an unknown one). Elevated write — previews and requires confirmation.",
  group: TOA,
  risks: ["high_risk_write"],
  mutationWorkflow: "durable",
  mutationContract: timeOffSnapshotContract(["target"], "update"),
  semanticLiteralAliases: REQUIRES_APPROVAL_LITERAL_ALIASES,
  schema: z
    .object({
      id: z.string().min(1),
      name: z.string().optional(),
      requiresApproval: z.boolean().optional(),
      daysPerYear: zNumberLike(z.number().nonnegative()).optional(),
      userIds: zStringList().optional(),
      userGroupIds: zStringList().optional(),
    })
    .refine(
      (v) =>
        v.name !== undefined ||
        v.requiresApproval !== undefined ||
        v.daysPerYear !== undefined ||
        v.userIds !== undefined ||
        v.userGroupIds !== undefined,
      { message: "Provide at least one field to change." },
    ),
  async preview(ctx, args) {
    const scope = await resolveScopeRefs(ctx, args, { verb: "scope the policy to" });
    if (!scope.ok) return scope.clarify;
    const patch = {
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.requiresApproval !== undefined ? { requiresApproval: args.requiresApproval } : {}),
      ...(args.daysPerYear !== undefined ? { daysPerYear: args.daysPerYear } : {}),
      ...(scope.userIds?.length ? { userIds: scope.userIds } : {}),
      ...(scope.userGroupIds?.length ? { userGroupIds: scope.userGroupIds } : {}),
    };
    const changes = describePatch({
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.requiresApproval !== undefined ? { requiresApproval: args.requiresApproval } : {}),
      ...(args.daysPerYear !== undefined ? { daysPerYear: args.daysPerYear } : {}),
    });
    if (scope.labels.length) changes.push(`scope policy to ${scope.labels.join(", ")}`);
    let updateBody: Awaited<ReturnType<typeof ctx.clockify.prepareTimeOffPolicyUpdate>>;
    try { updateBody = await ctx.clockify.prepareTimeOffPolicyUpdate(args.id, patch); }
    catch { return { clarify: "The current policy could not be prepared safely. Refresh it and preview again." }; }
    const target = captureTargetSnapshot(
      "target",
      { type: "time_off_policy", id: args.id, ...(typeof updateBody.source.name === "string" ? { name: updateBody.source.name } : {}) },
      updateBody.source,
    );
    return {
      actionLabel: "Update time-off policy",
      targets: [{ type: "time_off_policy", id: args.id, ...(args.name !== undefined ? { name: args.name } : {}) }],
      expectedChanges: changes,
      reversibility: "You can update the policy again to revert most fields.",
      warnings: ["This changes a workspace time-off policy."],
      payload: { id: args.id, patch, updateBody },
      targetSnapshots: [target],
      mutationPlan: { mode: "single", steps: [{ id: "update-time-off-policy", kind: "primary", targetFingerprint: target.fingerprint, reconciliationStrategy: "update" }] },
    };
  },
  async commit(ctx, payload, operation) {
    const { id, patch, updateBody } = payload as { id: string; patch: Record<string, unknown>; updateBody: Awaited<ReturnType<typeof ctx.clockify.prepareTimeOffPolicyUpdate>> };
    return commitSingleDurableRiskyStep({
      ctx, operation, planStepId: "update-time-off-policy", name: "Update time-off policy",
      verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (snapshot) => fetchTimeOffSnapshot(ctx, snapshot) },
      dispatch: async () => {
        const result = await dispatchWithReconciliation({ dispatch: () => ctx.clockify.updateTimeOffPolicyAtomic(id, updateBody), reconcile: async () => { const row = await ctx.clockify.getTimeOffPolicy(id); return row && samePolicy(row, patch) ? row : undefined; } });
        const updated = result.value;
        return { externalId: updated.id, effect: { updated: { type: "time_off_policy", id: updated.id, name: updated.name } }, detail: { reconciled: result.reconciled } };
      },
      success: (step) => successReceipt({ action: "clockify_time_off_policies_update", entity: "time_off_policy", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "time_off_policy", id: step.externalId ?? id, name: updateBody.name }] } }),
    });
  },
});

const archivePolicy = defineRiskyAction({
  name: "clockify_time_off_policies_archive",
  description:
    "Archive (or unarchive) a time-off policy. Destructive — previews and requires confirmation.",
  group: TOA,
  risks: ["destructive"],
  mutationWorkflow: "durable",
  mutationContract: timeOffSnapshotContract(["target"], "state-command"),
  semanticLiteralAliases: Object.freeze([
    { path: "archived", value: false, authoredPhrases: Object.freeze(["active", "restore", "unarchive", "unarchived"]) },
    { path: "archived", value: true, authoredPhrases: Object.freeze(["archive", "archived"]) },
  ] satisfies readonly SemanticLiteralAlias[]),
  schema: z.object({ id: z.string().min(1), name: z.string().optional(), archived: z.boolean().default(true) }),
  async preview(ctx, args) {
    const target = await policySnapshot(ctx, args.id);
    if (!target) return { clarify: `Time-off policy ${args.id} could not be verified.` };
    return {
      actionLabel: args.archived ? "Archive time-off policy" : "Unarchive time-off policy",
      targets: [{ type: "time_off_policy", id: args.id, ...(args.name !== undefined ? { name: args.name } : {}) }],
      expectedChanges: [`${args.archived ? "Archive" : "Unarchive"} policy ${args.name ?? args.id}`],
      reversibility: "You can unarchive the policy to restore it.",
      warnings: [
        args.archived
          ? "Archiving a policy stops new requests against it."
          : "Unarchiving re-enables new requests against this policy.",
      ],
      payload: { id: args.id, ...(args.name !== undefined ? { name: args.name } : {}), archived: args.archived },
      targetSnapshots: [target],
      mutationPlan: { mode: "single", steps: [{ id: "archive-time-off-policy", kind: "primary", targetFingerprint: target.fingerprint, reconciliationStrategy: "state-command" }] },
    };
  },
  async commit(ctx, payload, operation) {
    const { id, name, archived } = payload as { id: string; name?: string; archived: boolean };
    return commitSingleDurableRiskyStep({
      ctx, operation, planStepId: "archive-time-off-policy", name: "Archive time-off policy",
      verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (snapshot) => fetchTimeOffSnapshot(ctx, snapshot) },
      dispatch: async () => {
        const result = await dispatchWithReconciliation({ dispatch: async () => { await ctx.clockify.archiveTimeOffPolicyAtomic(id, archived); return true as const; }, reconcile: async () => (await ctx.clockify.getTimeOffPolicy(id))?.status === (archived ? "ARCHIVED" : "ACTIVE") ? true as const : undefined });
        return { effect: { archived }, detail: { reconciled: result.reconciled } };
      },
      success: () => successReceipt({ action: "clockify_time_off_policies_archive", entity: "time_off_policy", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "time_off_policy", id, name }] } }),
    });
  },
});

// ── Requests ────────────────────────────────────────────────────────────────

const listRequests = defineAction({
  name: "clockify_time_off_requests_list",
  description:
    "List time-off requests (optional status / user filter; `userId` accepts a user id, exact name, or 'me').",
  featureGroup: TOA,
  risks: ["read"],
  schema: z.object({ status: z.string().optional(), userId: z.string().optional() }),
  async handler(ctx, args) {
    // The user filter resolves id/name/'me'; absent = all users (no default).
    const user = await resolveUserFilter(args.userId, {
      verb: "list time-off requests for",
      adminUserId: ctx.adminUserId,
      listUsers: () => ctx.clockify.listUsers(),
    });
    if (!user.ok) return clarifyResult(user.clarify);
    const { rows, truncated } = await ctx.clockify.listTimeOffRequests({ status: args.status, userId: user.userId });
    return {
      kind: "receipt",
      receipt: listReceipt({
        action: "clockify_time_off_requests_list",
        entity: "time_off_request",
        ids: { workspaceId: ctx.workspaceId },
        rows,
        truncated,
      }),
    };
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
    "Submit a time-off request under a policy — pass `policyId` or the exact `policyName` (resolved server-side; do NOT list policies first — an unknown name clarifies with the real options). `start`/`end` accept YYYY-MM-DD or a relative day (tomorrow/next monday…). For 'N days off next/this week' you do NOT need exact dates — pass `days` + `week` and the harness picks the first N workdays (shown in the preview). Never ask which days when a week was given. For an HOUR-based policy, pass the day in `start` plus `hours` (the harness builds the hour window). External side effect (notifies approvers) — previews and requires confirmation.",
  group: TOA,
  risks: ["external_side_effect"],
  mutationWorkflow: "durable",
  mutationContract: timeOffSnapshotContract(["parent"], "create"),
  semanticLiteralAliases: Object.freeze([
    { path: "halfDay", value: false, authoredPhrases: Object.freeze(["full day", "full-day"]) },
    { path: "halfDay", value: true, authoredPhrases: Object.freeze(["half day", "half-day"]) },
  ] satisfies readonly SemanticLiteralAlias[]),
  schema: z
    .object({
      policyId: z.string().min(1).optional(),
      /** The policy's exact name, resolved to an id server-side. */
      policyName: z.string().min(1).optional(),
      start: z.string().min(1).optional(),
      end: z.string().min(1).optional(),
      /** 'N days off next week' — the harness anchors to the first N workdays. */
      week: z.enum(["this_week", "next_week"]).optional(),
      days: zNumberLike(z.number().positive()).optional(),
      /** For HOUR-based policies: the number of hours off on `start` (the day). */
      hours: zNumberLike(z.number().positive()).optional(),
      halfDay: z.boolean().optional(),
      note: z.string().optional(),
    })
    .refine((v) => v.policyId !== undefined || v.policyName !== undefined, {
      message: "Provide the time-off policy id or its exact name.",
    })
    .refine(
      (v) =>
        (v.start !== undefined && v.end !== undefined) ||
        v.week !== undefined ||
        (v.start !== undefined && v.hours !== undefined),
      {
        message:
          "Provide start+end dates, a week ('this_week'/'next_week') with days, or — for an hour-based policy — a start day + hours.",
      },
    ),
  async preview(ctx, args) {
    // List ONCE; reuse the list for resolution AND the timeUnit read so a time-off
    // request preview makes a single policies round-trip (PERF-01). The policy ref
    // resolves by name in either slot (balance_update precedent) — a bogus policy
    // clarifies with the real list, never a doomed commit.
    const policies = await ctx.clockify.listTimeOffPolicies();
    const policy = await resolveEntityRef(
      { id: args.policyId, name: args.policyName },
      {
        noun: "time-off policy",
        verb: "request time off under",
        list: () => Promise.resolve(policies),
        // The request body depends on the policy's DAYS/HOURS unit, so even a
        // syntactically valid id must be present in the list used below.
        verifyId: true,
      },
    );
    if (!policy.ok) return policy.clarify;
    const policyRow = policies.rows.find((p) => p.id === policy.id);
    if (!policyRow || policies.truncated) return { clarify: "The time-off policy could not be verified completely." };
    const parentSnapshot = await policySnapshot(ctx, policyRow.id, "parent");
    if (!parentSnapshot) return { clarify: "The time-off policy could not be verified completely." };
    const now = nowDate(ctx);
    // Time-off request bodies are policy-unit-specific: the DAYS path below builds
    // `period.days` from bare dates; an HOURS policy wants ISO datetime instants
    // (live-verified). Read the unit from the already-fetched list — an unknown
    // unit falls through to the DAYS path, exactly as before.
    const policyUnit = policies.rows.find((p) => p.id === policy.id)?.timeUnit;
    if (policyUnit === "HOURS") {
      // HOURS request = a server-resolved DAY + a number of hours (the model never
      // computes calendar dates). Build 09:00 → 09:00+N ISO instants for the wire.
      const day = resolveRelativeDay(now, { date: args.start }, ctx.timeZone);
      if (day === undefined) {
        return {
          clarify: `For the hour-based policy "${policy.name ?? policy.id}", tell me the day (e.g. "next monday" or 2026-07-06) and how many hours.`,
        };
      }
      const hours = args.hours;
      if (hours === undefined || hours <= 0) {
        return { clarify: `How many hours of time off on ${day} under "${policy.name ?? policy.id}"?` };
      }
      const startInstant = zonedDayTimeInstant(day, 9, 0, ctx.timeZone ?? "UTC");
      if (startInstant === undefined) {
        return { clarify: `I couldn't resolve 09:00 on ${day} in the workspace time zone.` };
      }
      const startMs = Date.parse(startInstant);
      const isoNoMillis = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
      const startIso = isoNoMillis(startMs);
      const endIso = isoNoMillis(startMs + hours * 3_600_000);
      const warnings = ["This submits a request that notifies approvers."];
      try {
        const balances = await ctx.clockify.getTimeOffBalance(ctx.adminUserId);
        const bal = balances.rows.find((b) => b.policyId === policy.id)?.balance;
        if (bal !== undefined && hours > bal) {
          warnings.push(`This requests ${hours}h but the policy balance is ${bal}h — Clockify will likely reject it.`);
        }
      } catch {
        // Balance unavailable — submit anyway; Clockify itself remains the gate.
      }
      return {
        actionLabel: "Request time off",
        targets: [],
        expectedChanges: [`Request ${hours}h off on ${day} under "${policy.name ?? policy.id}"`],
        reversibility: "Cancel or have the request denied in Clockify.",
        warnings,
        payload: {
          policyId: policy.id,
          input: { start: startIso, end: endIso, timeUnit: "HOURS", ...(args.note !== undefined ? { note: args.note } : {}) },
        },
        targetSnapshots: [parentSnapshot],
        mutationPlan: { mode: "single", steps: [{ id: "create-time-off-request", kind: "primary", targetFingerprint: parentSnapshot.fingerprint, reconciliationStrategy: "create" }] },
      };
    }
    if (policyUnit !== undefined && policyUnit !== "DAYS") {
      const unit = policyUnit.toLowerCase();
      return {
        clarify: `The policy "${policy.name ?? policy.id}" is measured in ${unit}, which isn't supported here yet — please submit it directly in Clockify.`,
      };
    }
    // 'N days next week' anchors deterministically to the first N WORKDAYS of
    // that week (the resolveLogTimes pattern: the harness defaults, the preview
    // shows the chosen dates, the admin confirms). Explicit start/end wins.
    let startRef = args.start;
    let endRef = args.end;
    if ((startRef === undefined || endRef === undefined) && args.week) {
      const dayCount = Math.max(1, Math.round(args.days ?? 1));
      const monday = resolvePeriod(now, args.week, ctx.timeZone, ctx.weekStartsOn).dateRangeStart.slice(0, 10);
      const today = resolveRelativeDay(now, { date: "today" }, ctx.timeZone) ?? now.toISOString().slice(0, 10);
      const anchor = nextWorkday(args.week === "this_week" && today > monday ? today : monday);
      if (args.week === "this_week" && anchor > addCalendarDays(monday, 6)) {
        return {
          clarify: "There are no workdays left this week — should I request the days for next week instead?",
        };
      }
      startRef = anchor;
      endRef = addWorkdays(anchor, dayCount - 1);
    }
    // The wire wants bare YYYY-MM-DD days; the live loop sent the literal
    // string "next Monday". Resolve here, clarify on anything unparseable.
    const start = resolveRelativeDay(now, { date: startRef }, ctx.timeZone);
    const end = resolveRelativeDay(now, { date: endRef }, ctx.timeZone);
    const bad = [start === undefined ? startRef : undefined, end === undefined ? endRef : undefined].filter(
      (value): value is string => value !== undefined,
    );
    if (bad.length || start === undefined || end === undefined) {
      return {
        clarify: `I couldn't make sense of the date${bad.length > 1 ? "s" : ""} ${bad.map((b) => `"${b}"`).join(" and ")} — give me a calendar date (YYYY-MM-DD) or something like tomorrow or next monday.`,
      };
    }
    if (start > end) {
      return { clarify: "The time-off start date must be on or before the end date." };
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
      const policyBalance = balances.rows.find((b) => b.policyId === policy.id)?.balance;
      if (policyBalance !== undefined && requestedDays > policyBalance) {
        warnings.push(
          `This requests ${requestedDays} day(s) but the policy balance is ${policyBalance} — Clockify will likely reject it (its error reads "Value for number of days is not allowed"). Top up the balance or shorten the request.`,
        );
      }
    } catch {
      // Balance unavailable — submit as before; Clockify itself remains the gate.
    }
    // Truthful preview: state how many days will be DEDUCTED (the wire `days`),
    // not just the calendar range — they can differ (an explicit days override, or
    // a half day). What the admin confirms must equal what Clockify charges.
    const dayCountLabel = args.halfDay
      ? "a half day"
      : `${requestedDays} day${requestedDays === 1 ? "" : "s"}`;
    return {
      actionLabel: "Submit time-off request",
      targets: [{ type: "time_off_policy", id: policy.id, name: policy.name }],
      expectedChanges: [`Request ${dayCountLabel} off ${start} → ${end} under policy ${policy.name ?? policy.id}`],
      reversibility: "You can delete the request afterward.",
      warnings,
      payload: { policyId: policy.id, input },
      targetSnapshots: [parentSnapshot],
      mutationPlan: { mode: "single", steps: [{ id: "create-time-off-request", kind: "primary", targetFingerprint: parentSnapshot.fingerprint, reconciliationStrategy: "create" }] },
    };
  },
  async commit(ctx, payload, operation) {
    const { policyId, input } = payload as { policyId: string; input: CreateTimeOffRequestInput };
    let baselineIds: string[];
    try {
      const baseline = await ctx.clockify.listTimeOffRequests();
      if (baseline.truncated) {
        return errorReceipt({
          action: operation.actionName,
          code: "create_baseline_unavailable",
          message: "Clockify returned an incomplete time-off request list immediately before dispatch. No request was created.",
          recovery: { hint: "Refresh and preview the request again when the complete list is available.", retryable: true },
        });
      }
      baselineIds = baseline.rows.map((row) => row.id);
    } catch {
      return errorReceipt({
        action: operation.actionName,
        code: "create_baseline_unavailable",
        message: "The time-off request list could not be read immediately before dispatch. No request was created.",
        recovery: { hint: "Refresh and preview the request again after Clockify reads recover.", retryable: true },
      });
    }
    const snapshots = operation.targetSnapshots ?? [];
    let verificationFailure: "stale_target" | "stale_parent" | undefined;
    const step = await executeDurableRiskyStep({
      ctx, operation, planStepId: "create-time-off-request", index: 0, name: "Create time-off request",
      preparedDetail: { preDispatch: { strategy: "time_off_request_create_baseline", ids: baselineIds, truncated: false }, targetSnapshots: snapshots },
      dispatch: async () => {
        const verified = await verifyTargetSnapshots(snapshots, (snapshot) => fetchTimeOffSnapshot(ctx, snapshot));
        if (!verified.ok) {
          verificationFailure = verified.code;
          throw new DefinitiveWriteFailure("VERIFY", "create-time-off-request", verified.code);
        }
        const result = await dispatchWithReconciliation({ dispatch: () => ctx.clockify.createTimeOffRequestAtomic(policyId, input), reconcile: async () => { const row = await reconcileCreate({ beforeIds: baselineIds, list: () => ctx.clockify.listTimeOffRequests(), matches: (candidate) => sameRequest(candidate, policyId, input, ctx.adminUserId) }); return row ? { id: row.id, name: row.id } : undefined; } });
        const req = result.value;
        return { externalId: req.id, effect: { created: { type: "time_off_request", id: req.id } }, detail: { reconciled: result.reconciled } };
      },
    });
    if (verificationFailure) {
      return errorReceipt({
        action: operation.actionName,
        code: verificationFailure,
        message: "The time-off policy changed or could not be verified. No Clockify mutation was sent.",
        recovery: { hint: "Refresh the policy and create a fresh preview.", retryable: true },
      });
    }
    if (step.status === "succeeded") {
      const receipt = successReceipt({ action: "clockify_time_off_requests_create", entity: "time_off_request", ids: { workspaceId: ctx.workspaceId }, changed: { created: [{ type: "time_off_request", id: step.externalId ?? "unknown" }] } });
      return isJournalDegradedStep(step) ? withJournalDegradedWarning(receipt) : receipt;
    }
    return errorReceipt({
      action: operation.actionName,
      code: step.status === "outcome_unknown" ? "commit_outcome_unknown" : "write_failed",
      message: step.status === "outcome_unknown"
        ? "Clockify did not provide a definitive response, so the request may or may not have been created."
        : "Clockify definitively rejected time-off request creation.",
      recovery: step.status === "outcome_unknown"
        ? { hint: "Verify the exact request in Clockify before deciding whether to try again.", retryable: false }
        : { hint: "Correct the request details and preview again.", retryable: true },
    });
  },
});

const deleteRequest = defineRiskyAction({
  name: "clockify_time_off_requests_delete",
  description: "Delete a time-off request. Destructive — previews and requires confirmation.",
  group: TOA,
  risks: ["destructive"],
  mutationWorkflow: "durable",
  mutationContract: timeOffSnapshotContract(["target", "parent"], "delete"),
  schema: z.object({ policyId: z.string().min(1), requestId: z.string().min(1) }),
  async preview(ctx, args) {
    const [target, parent] = await Promise.all([requestSnapshot(ctx, args.requestId), policySnapshot(ctx, args.policyId, "parent")]);
    if (!target || !parent) return { clarify: "The time-off request or its policy could not be verified." };
    const request = target.projection as { policyId?: string };
    if (request.policyId !== undefined && request.policyId !== args.policyId) return { clarify: "The request does not belong to the supplied policy." };
    return {
      actionLabel: "Delete time-off request",
      targets: [{ type: "time_off_request", id: args.requestId }],
      expectedChanges: [`Delete time-off request ${args.requestId}`],
      reversibility: "This cannot be undone.",
      warnings: ["Deleting a time-off request is permanent."],
      payload: { policyId: args.policyId, requestId: args.requestId },
      targetSnapshots: [target, parent],
      mutationPlan: { mode: "single", steps: [{ id: "delete-time-off-request", kind: "primary", targetFingerprint: target.fingerprint, reconciliationStrategy: "delete" }] },
    };
  },
  async commit(ctx, payload, operation) {
    const { policyId, requestId } = payload as { policyId: string; requestId: string };
    return commitSingleDurableRiskyStep({
      ctx, operation, planStepId: "delete-time-off-request", name: "Delete time-off request",
      verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (snapshot) => fetchTimeOffSnapshot(ctx, snapshot) },
      dispatch: async () => {
        const result = await dispatchWithReconciliation({ dispatch: async () => { await ctx.clockify.deleteTimeOffRequestAtomic(policyId, requestId); return true as const; }, reconcile: () => reconcileDelete(() => ctx.clockify.getTimeOffRequest(requestId)) });
        return { effect: { deleted: { type: "time_off_request", id: requestId } }, detail: { reconciled: result.reconciled } };
      },
      success: () => successReceipt({ action: "clockify_time_off_requests_delete", entity: "time_off_request", ids: { workspaceId: ctx.workspaceId }, changed: { deleted: [{ type: "time_off_request", id: requestId }] } }),
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
    mutationWorkflow: "durable",
    mutationContract: timeOffSnapshotContract(["target", "parent"], "state-command"),
    schema: z.object({ policyId: z.string().min(1), requestId: z.string().min(1), note: z.string().optional() }),
    async preview(ctx, args) {
      const [target, parent] = await Promise.all([requestSnapshot(ctx, args.requestId), policySnapshot(ctx, args.policyId, "parent")]);
      if (!target || !parent) return { clarify: "The time-off request or its policy could not be verified." };
      const request = target.projection as { policyId?: string };
      if (request.policyId !== undefined && request.policyId !== args.policyId) return { clarify: "The request does not belong to the supplied policy." };
      return {
        actionLabel: `${decision} time-off request`,
        targets: [{ type: "time_off_request", id: args.requestId }],
        expectedChanges: [`${decision} time-off request ${args.requestId} (policy ${args.policyId})`],
        reversibility: "Approval decisions notify the requester and may be hard to reverse.",
        warnings: ["This notifies the requester and changes their balance/schedule."],
        payload: {
          policyId: args.policyId,
          requestId: args.requestId,
          ...(args.note !== undefined ? { note: args.note } : {}),
        },
        targetSnapshots: [target, parent],
        mutationPlan: { mode: "single", steps: [{ id: `${decision}-time-off-request`, kind: "primary", targetFingerprint: target.fingerprint, reconciliationStrategy: "state-command" }] },
      };
    },
    async commit(ctx, payload, operation) {
      const { policyId, requestId, note } = payload as { policyId: string; requestId: string; note?: string };
      return commitSingleDurableRiskyStep({
        ctx, operation, planStepId: `${decision}-time-off-request`, name: `${decision} time-off request`,
        verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (snapshot) => fetchTimeOffSnapshot(ctx, snapshot) },
        dispatch: async () => {
          const result = await dispatchWithReconciliation({ dispatch: () => ctx.clockify.setTimeOffRequestStatusAtomic(policyId, requestId, statusType, note), reconcile: async () => { const row = await ctx.clockify.getTimeOffRequest(requestId); return row?.status === statusType && (!Object.hasOwn(payload, "note") || row.note === note) ? { id: row.id, name: statusType } : undefined; } });
          return { externalId: result.value.id, effect: { status: statusType }, detail: { reconciled: result.reconciled } };
        },
        success: (step) => successReceipt({ action: `clockify_time_off_${decision}`, entity: "time_off_request", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "time_off_request", id: step.externalId ?? requestId }] } }),
      });
    },
  });
}

const approveRequest = decisionAction("approve");
const denyRequest = decisionAction("deny");

// ── Balances ────────────────────────────────────────────────────────────────

const getBalance = defineAction({
  name: "clockify_time_off_balance_get",
  description: "Get a user's time-off balances (defaults to you; `userId` accepts a user id, exact name, or 'me').",
  featureGroup: TOA,
  risks: ["read"],
  schema: z.object({ userId: z.string().optional() }),
  async handler(ctx, args) {
    const user = await resolveUserFilter(args.userId, {
      verb: "get the time-off balance for",
      adminUserId: ctx.adminUserId,
      listUsers: () => ctx.clockify.listUsers(),
      defaultTo: ctx.adminUserId,
    });
    if (!user.ok) return clarifyResult(user.clarify);
    const { rows, truncated } = await ctx.clockify.getTimeOffBalance(user.userId);
    return {
      kind: "receipt",
      receipt: listReceipt({
        action: "clockify_time_off_balance_get",
        entity: "time_off_balance",
        ids: { workspaceId: ctx.workspaceId },
        rows,
        truncated,
      }),
    };
  },
});

const updateBalance = defineRiskyAction({
  name: "clockify_time_off_balance_update",
  description:
    "Adjust users' time-off balance for a policy. Pass the policy by id or exact name, and `userIds` as ids/exact names/'me' — resolved server-side, clarifies on an unknown one. Elevated write — previews and requires confirmation.",
  group: TOA,
  risks: ["high_risk_write"],
  mutationWorkflow: "durable",
  mutationContract: timeOffSnapshotContract(["target", "parent"], "state-command"),
  schema: z.object({
    policyId: z.string().min(1),
    userIds: zStringList(z.array(z.string().min(1)).min(1).max(TIME_OFF_BALANCE_USER_BATCH_MAX)),
    value: zNumberLike(z.number()),
    note: z.string().optional(),
  }),
  async preview(ctx, args) {
    const policy = await resolveEntityRef(
      { id: args.policyId },
      { noun: "time-off policy", verb: "adjust the balance on", list: () => ctx.clockify.listTimeOffPolicies() },
    );
    if (!policy.ok) return policy.clarify;
    const members = await resolveUserRefs(args.userIds, {
      verb: "adjust the balance for",
      adminUserId: ctx.adminUserId,
      listUsers: () => ctx.clockify.listUsers(),
      verifyIds: true,
    });
    if (!members.ok) return members.clarify;
    const [target, parent] = await Promise.all([
      balanceSnapshot(ctx, policy.id, members.userIds),
      policySnapshot(ctx, policy.id, "parent"),
    ]);
    if (!target || !parent) return { clarify: "The policy or current balances could not be verified completely." };
    const expectedBalances = (target.projection as Array<{ userId?: string; balance?: number }>).map((row) => ({
      userId: row.userId,
      balance: (row.balance ?? 0) + args.value,
    }));
    return {
      actionLabel: "Adjust time-off balance",
      targets: [{ type: "time_off_policy", id: policy.id, name: policy.name }],
      expectedChanges: [`Adjust balance by ${args.value} for ${members.labels.join(", ")} on policy "${policy.name ?? policy.id}"`],
      reversibility: "You can adjust the balance again to revert.",
      warnings: ["This changes users' accrued time-off balance."],
      payload: {
        policyId: policy.id,
        userIds: members.userIds,
        value: args.value,
        expectedBalances,
        ...(args.note !== undefined ? { note: args.note } : {}),
      },
      targetSnapshots: [target, parent],
      mutationPlan: { mode: "single", steps: [{ id: "update-time-off-balance", kind: "primary", targetFingerprint: target.fingerprint, reconciliationStrategy: "state-command" }] },
    };
  },
  async commit(ctx, payload, operation) {
    const { policyId, userIds, value, note, expectedBalances } = payload as { policyId: string; userIds: string[]; value: number; note?: string; expectedBalances: Array<{ userId?: string; balance: number }> };
    return commitSingleDurableRiskyStep({
      ctx, operation, planStepId: "update-time-off-balance", name: "Update time-off balance",
      verification: {
        snapshots: operation.targetSnapshots ?? [],
        fetchSnapshot: async (snapshot) => {
          if (snapshot.ref.type === "time_off_policy") return fetchTimeOffSnapshot(ctx, snapshot);
          const current = await balanceSnapshot(ctx, policyId, userIds);
          return current ? { ref: current.ref, projection: current.projection, truncated: false } : undefined;
        },
      },
      dispatch: async () => {
        const result = await dispatchWithReconciliation({
          dispatch: async () => { await ctx.clockify.updateTimeOffBalanceAtomic(policyId, { userIds, value, ...(note !== undefined ? { note } : {}) }); return true as const; },
          reconcile: async () => {
            const current = await balanceSnapshot(ctx, policyId, userIds);
            if (!current) return undefined;
            const rows = current.projection as Array<{ userId?: string; balance?: number }>;
            return expectedBalances.every((expected) => rows.some((row) => row.userId === expected.userId && row.balance === expected.balance)) ? true as const : undefined;
          },
        });
        return { effect: { balanceDelta: { policyId, userIds, value } }, detail: { reconciled: result.reconciled } };
      },
      success: () => successReceipt({ action: "clockify_time_off_balance_update", entity: "time_off_balance", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "time_off_policy", id: policyId }] } }),
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
