import type { ExternalMutationPlan, ExternalMutationPlanDraft } from "./mutation-contract.js";
import { HOST_CALL_BUDGET_MAXIMUM } from "../clockify/request-governor.js";

/** One persisted/declaration/catalog contract. The capability envelope is capped
 * at 64 KiB, so an individual structured literal is capped at 16 KiB, depth 8,
 * and 256 JSON nodes; at most 128 constraints may be retained for one write. */
export const INTENT_LITERAL_CONSTRAINT_LIMIT = 128;
export const INTENT_LITERAL_MAX_DEPTH = 8;
export const INTENT_LITERAL_MAX_NODES = 256;
export const INTENT_LITERAL_MAX_BYTES = 16 * 1024;
export const INTENT_LITERAL_LIMITS = Object.freeze({
  maxConstraints: INTENT_LITERAL_CONSTRAINT_LIMIT,
  maxDepth: INTENT_LITERAL_MAX_DEPTH,
  maxNodes: INTENT_LITERAL_MAX_NODES,
  maxBytes: INTENT_LITERAL_MAX_BYTES,
});

export const TURN_HOST_CALL_LIMIT = HOST_CALL_BUDGET_MAXIMUM;
export const HOST_CALL_ESTIMATOR_VERSION = 1;
/** A cold confirmed HTTP request spends one bounded role lookup in
 * requireSession, then two forced checks before the mutation plan reservation
 * (confirmation entry and commit choke point). */
export const CONFIRMED_REQUEST_PRE_RESERVATION_HOST_CALLS = 3;
/** A base-only ambiguous invoice create may inspect only this many complete
 * post-list candidates. More candidates are non-authoritative without per-id
 * reads, keeping the physical reconciliation cost deterministic. */
export const INVOICE_CREATE_RECONCILIATION_CANDIDATE_MAX = 8;
/** Generic client/project create reconciliation performs a post-list followed
 * by per-candidate authoritative reads. Four candidates keep that physical
 * path within the generic eight-call single-step reservation:
 * role + baseline + mutation + post-list + four detail reads. */
export const STRUCTURE_CREATE_RECONCILIATION_CANDIDATE_MAX = 4;

function deriveMaximumBatchSize(
  estimateRemainingCalls: (count: number) => number,
  callsAlreadyConsumed = 0,
): number {
  for (let count = 0; count < TURN_HOST_CALL_LIMIT; count += 1) {
    if (callsAlreadyConsumed + estimateRemainingCalls(count + 1) > TURN_HOST_CALL_LIMIT) return count;
  }
  throw new Error("host_call_estimator_did_not_reach_turn_limit");
}

function estimateGroupMemberBatchHostCalls(memberCount: number): number {
  // Two snapshot reads + role + mutation per member, plus one reconciliation
  // read. A reconciled ambiguous step is terminal for the batch.
  return 4 * memberCount + 1;
}

function estimateOnboardGroupBatchHostCalls(groupCount: number): number {
  // The single terminal ambiguity allowance is shared by invite and group
  // steps; any successfully reconciled step stops later dispatch.
  return 4 * groupCount + 4;
}

function estimateInvoiceCreateHostCalls(itemCount: number, hasEnrichment: boolean): number {
  if (itemCount === 0 && !hasEnrichment) {
    // Fresh role check + complete baseline + POST + complete post-list + the
    // bounded per-candidate detail scan used only after an ambiguous POST.
    return 4 + INVOICE_CREATE_RECONCILIATION_CANDIDATE_MAX;
  }
  return 3 + (hasEnrichment ? 3 : 0) + 2 * itemCount;
}

function estimateApprovePendingBatchHostCalls(approvalCount: number): number {
  // Every approval rechecks its exact target, rechecks the admin role, and
  // dispatches one PATCH. Only the terminal step can spend one additional read
  // to reconcile an ambiguous PATCH because a reconciled ambiguity stops later
  // dispatches.
  return 3 * approvalCount + 1;
}

/** Worst case from commit entry through terminal result, including role checks,
 * authoritative snapshot/baseline reads, mutations, and one terminal ambiguous
 * reconciliation. These functions are also used by the model-visible schemas. */
export function estimateSetupProjectHostCalls(input: {
  memberCount: number;
  rateCount: number;
  hasClient: boolean;
}): number {
  const snapshotCount = input.memberCount + (input.hasClient ? 1 : 0);
  // Normal create cost is snapshots + baseline + dispatch role + POST. A
  // terminal ambiguous create adds both the post-list and exact state read.
  // Only one step can end ambiguously because later dispatch stops, so this
  // two-call terminal allowance covers the entire operation.
  const createAndInitialEvidence = snapshotCount + 5;
  // Normal later steps use baseline + snapshots + role + mutation. The create
  // allowance above covers the one possible reconciliation because a
  // successfully reconciled ambiguous step is terminal for the composition.
  const membership = input.memberCount > 0 ? snapshotCount + 3 : 0;
  const rates = input.rateCount * (snapshotCount + 3);
  return createAndInitialEvidence + membership + rates;
}

/** Model-visible batch ceilings are calculated from the same worst-case cost
 * functions used to bind durable plans. Prior-call offsets cover resolution
 * already charged to the turn before the operation reservation begins. */
export const GROUP_MEMBER_BATCH_MAX = deriveMaximumBatchSize(
  estimateGroupMemberBatchHostCalls,
  CONFIRMED_REQUEST_PRE_RESERVATION_HOST_CALLS,
);
/** Tag ids on bounded time-entry create/start/update actions must fit the 22-fact material presentation ceiling alongside other preview fields. */
export const TIME_ENTRY_TAG_BATCH_MAX = 14;
/** Holiday scope arrays share one POST/PUT body; keep scalar preview fields plus both arrays within 22 facts. */
export const HOLIDAY_SCOPE_USER_BATCH_MAX = 8;
export const HOLIDAY_SCOPE_GROUP_BATCH_MAX = 8;
export const ONBOARD_GROUP_BATCH_MAX = deriveMaximumBatchSize(
  estimateOnboardGroupBatchHostCalls,
  CONFIRMED_REQUEST_PRE_RESERVATION_HOST_CALLS,
);
export const INVOICE_ITEM_BATCH_MAX = deriveMaximumBatchSize(
  (count) => estimateInvoiceCreateHostCalls(count, true),
  CONFIRMED_REQUEST_PRE_RESERVATION_HOST_CALLS,
);
export const SETUP_PROJECT_MEMBER_BATCH_MAX = deriveMaximumBatchSize(
  (count) => estimateSetupProjectHostCalls({ memberCount: count, rateCount: 0, hasClient: true }),
  CONFIRMED_REQUEST_PRE_RESERVATION_HOST_CALLS,
);
export const SETUP_PROJECT_RATE_BATCH_MAX = deriveMaximumBatchSize(
  (count) => estimateSetupProjectHostCalls({ memberCount: count, rateCount: count, hasClient: true }),
  CONFIRMED_REQUEST_PRE_RESERVATION_HOST_CALLS,
);
/** Keep public schemas and authority metadata on the same cold-request bound. */
export const MARK_INVOICED_ENTRY_BATCH_MAX = Math.min(
  21,
  deriveMaximumBatchSize(
    (count) => 2 * count + 2,
    CONFIRMED_REQUEST_PRE_RESERVATION_HOST_CALLS,
  ),
);
export const INVOICE_IMPORT_PROJECT_BATCH_MAX = deriveMaximumBatchSize(
  (count) => count + 3,
  CONFIRMED_REQUEST_PRE_RESERVATION_HOST_CALLS,
);
export const SETUP_TASK_ASSIGNEE_BATCH_MAX = deriveMaximumBatchSize(
  (count) => 3 * count + 11,
  CONFIRMED_REQUEST_PRE_RESERVATION_HOST_CALLS,
);
export const TIME_OFF_BALANCE_USER_BATCH_MAX = deriveMaximumBatchSize(
  (count) => 2 * count + 3,
  CONFIRMED_REQUEST_PRE_RESERVATION_HOST_CALLS,
);
export const APPROVAL_PENDING_BATCH_MAX = deriveMaximumBatchSize(
  estimateApprovePendingBatchHostCalls,
  CONFIRMED_REQUEST_PRE_RESERVATION_HOST_CALLS,
);

/** Plan-step maxima are distinct from raw argument item maxima. */
export const INVOICE_CREATE_MUTATION_STEP_MAX = INVOICE_ITEM_BATCH_MAX + 2;
export const ONBOARD_USER_MUTATION_STEP_MAX = ONBOARD_GROUP_BATCH_MAX + 1;
export const SETUP_PROJECT_MUTATION_STEP_MAX = SETUP_PROJECT_RATE_BATCH_MAX + 2;

function countSteps(plan: ExternalMutationPlanDraft, prefix: string): number {
  return plan.steps.filter((step) => step.id.startsWith(prefix)).length;
}

/** Deterministic bound bound into the persisted plan and confirmation hash. */
export function estimateMutationPlanHostCalls(
  actionName: string,
  operation: unknown,
  plan: ExternalMutationPlanDraft,
): number {
  if (actionName === "clockify_approvals_approve_pending") {
    return estimateApprovePendingBatchHostCalls(plan.steps.length);
  }
  if (actionName === "clockify_groups_add_user") return estimateGroupMemberBatchHostCalls(plan.steps.length);
  if (actionName === "clockify_onboard_user") {
    return estimateOnboardGroupBatchHostCalls(countSteps(plan, "add-user-to-group-"));
  }
  if (actionName === "clockify_invoices_create") {
    const items = countSteps(plan, "add-invoice-item-");
    return estimateInvoiceCreateHostCalls(
      items,
      plan.steps.some((step) => step.id === "enrich-invoice"),
    );
  }
  if (actionName === "clockify_setup_project") {
    const payload = operation && typeof operation === "object" && !Array.isArray(operation)
      ? operation as { addUserIds?: unknown; memberRates?: unknown; clientId?: unknown }
      : {};
    const memberCount = Array.isArray(payload.addUserIds) ? payload.addUserIds.length : 0;
    const rateCount = Array.isArray(payload.memberRates) ? payload.memberRates.length : 0;
    return estimateSetupProjectHostCalls({ memberCount, rateCount, hasClient: typeof payload.clientId === "string" });
  }
  const payload = operation && typeof operation === "object" && !Array.isArray(operation)
    ? operation as Record<string, unknown>
    : {};
  if (actionName === "clockify_projects_create") {
    const body = payload.body && typeof payload.body === "object" && !Array.isArray(payload.body)
      ? payload.body as Record<string, unknown>
      : {};
    // A parent client adds one authoritative pre-dispatch snapshot read to the
    // generic create path (role + baseline + POST + bounded reconciliation).
    return typeof payload.clientId === "string" || typeof body.clientId === "string" ? 9 : 8;
  }
  if (actionName === "clockify_invoices_import_time") {
    const range = payload.range && typeof payload.range === "object" && !Array.isArray(payload.range)
      ? payload.range as Record<string, unknown>
      : {};
    const projects = Array.isArray(range.projectIds)
      ? new Set(range.projectIds.filter((value): value is string => typeof value === "string")).size
      : 0;
    // Invoice snapshot + one snapshot per project + role + mutation.
    return projects + 3;
  }
  if (actionName === "clockify_entries_mark_invoiced") {
    const entries = Array.isArray(payload.ids) ? payload.ids.length : 0;
    // Snapshot each entry before dispatch and again only after an ambiguous
    // state command, plus one role read and the mutation itself.
    return 2 * entries + 2;
  }
  if (actionName === "clockify_setup_task") {
    const assignees = Array.isArray(payload.assigneeIds) ? payload.assigneeIds.length : 0;
    // Parent evidence is checked three times around create. A rate adds the
    // exact task read, role, mutation, and terminal reconciliation allowance.
    return 3 * assignees + (payload.rate === undefined ? 7 : 11);
  }
  if (actionName === "clockify_time_off_balance_update") {
    const users = Array.isArray(payload.userIds) ? payload.userIds.length : 0;
    // Balance evidence and ambiguous reconciliation each read every user;
    // policy evidence, role verification, and the mutation are one call each.
    return 2 * users + 3;
  }
  if (actionName === "undo") {
    return plan.steps.reduce((total, step) => {
      if (step.id.endsWith("-transition")) return total + 3; // prepare + role + mutation
      if (step.id.endsWith("-delete")) return total + 2; // role + mutation
      return total + 8;
    }, 0);
  }
  // Conservative generic bound: each exact host step may need a role read,
  // several authoritative target/parent reads, a preflight read, the mutation,
  // and one terminal reconciliation read. The mutation scope disables retries
  // and caps scans to one page, so eight is a physical upper bound rather than
  // a logical-call guess. Do not clamp: an over-budget plan is rejected before
  // persistence/confirmation and before any dispatch.
  return Math.max(1, plan.steps.length * 8);
}

export function bindMutationPlanHostCalls(
  actionName: string,
  operation: unknown,
  plan: ExternalMutationPlanDraft,
): ExternalMutationPlan {
  return {
    ...plan,
    maxHostCalls: estimateMutationPlanHostCalls(actionName, operation, plan),
  };
}
