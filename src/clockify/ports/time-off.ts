import type { EntitySummary, ListResult } from "../types.js";

export interface TimeOffPolicySummary extends EntitySummary {
  status?: string;
  timeUnit?: string;
  requiresApproval?: boolean;
  daysPerYear?: number;
  negativeBalance?: boolean;
  /** The users / user groups the policy applies to (from the policy doc). */
  userIds?: string[];
  userGroupIds?: string[];
}

export interface TimeOffRequestSummary {
  id: string;
  policyId?: string;
  userId?: string;
  status?: string;
  note?: string;
  start?: string;
  end?: string;
  days?: number;
  halfDay?: boolean;
  timeUnit?: string;
}

export interface TimeOffBalanceSummary {
  policyId?: string;
  policyName?: string;
  userId?: string;
  balance?: number;
  used?: number;
  total?: number;
}

export interface CreateTimeOffPolicyInput {
  name: string;
  /** Default scope (the admin) when neither userIds nor userGroupIds is given. */
  userId: string;
  requiresApproval?: boolean;
  daysPerYear?: number;
  negativeBalance?: boolean;
  /** Scope the policy to these users / user groups (resolved ids). */
  userIds?: string[];
  userGroupIds?: string[];
}

export interface UpdateTimeOffPolicyInput {
  name?: string;
  requiresApproval?: boolean;
  daysPerYear?: number;
  userIds?: string[];
  userGroupIds?: string[];
}
export interface PreparedTimeOffPolicyUpdateInput extends UpdateTimeOffPolicyInput {
  name: string;
  body: Record<string, unknown>;
  source: Record<string, unknown>;
}

export interface CreateTimeOffRequestInput {
  start: string;
  end: string;
  days?: number;
  halfDay?: boolean;
  note?: string;
  /**
   * Policy time unit. "HOURS" selects the hours wire shape (full ISO datetime
   * start/end, NO `days`/half-day scaffold); default/"DAYS" uses the bare-date form.
   */
  timeUnit?: string;
}

/**
 * Time-off slice of the {@link WorkspaceClient} port (goclmcp §2.9 — policies,
 * requests, balances). Reads are immediate; the writes run only from a handler's
 * `commit`. Gotchas pinned by the unit tests: request LIST is a `POST` search
 * (`POST /time-off/requests` → `{count, requests:[]}`); policy update is
 * GET-then-PUT; archive + approve/deny + balance update are all PATCH; the
 * balance update path is `/time-off/balance/policy/{policyId}`.
 */
export interface TimeOffPort {
  listTimeOffPolicies(): Promise<ListResult<TimeOffPolicySummary>>;
  getTimeOffPolicy(id: string): Promise<TimeOffPolicySummary | null>;
  createTimeOffPolicy(input: CreateTimeOffPolicyInput): Promise<EntitySummary>;
  createTimeOffPolicyAtomic(input: CreateTimeOffPolicyInput): Promise<EntitySummary>;
  updateTimeOffPolicy(id: string, patch: UpdateTimeOffPolicyInput): Promise<EntitySummary>;
  prepareTimeOffPolicyUpdate(id: string, patch: UpdateTimeOffPolicyInput): Promise<PreparedTimeOffPolicyUpdateInput>;
  /** Exact raw policy document used to verify a full replacement immediately before dispatch. */
  getTimeOffPolicyMutationState(id: string): Promise<Record<string, unknown> | null>;
  updateTimeOffPolicyAtomic(id: string, body: PreparedTimeOffPolicyUpdateInput): Promise<EntitySummary>;
  archiveTimeOffPolicy(id: string, archived: boolean): Promise<void>;
  archiveTimeOffPolicyAtomic(id: string, archived: boolean): Promise<void>;
  listTimeOffRequests(filter?: { status?: string; userId?: string }): Promise<ListResult<TimeOffRequestSummary>>;
  getTimeOffRequest(id: string): Promise<TimeOffRequestSummary | null>;
  createTimeOffRequest(policyId: string, input: CreateTimeOffRequestInput): Promise<EntitySummary>;
  createTimeOffRequestAtomic(policyId: string, input: CreateTimeOffRequestInput): Promise<EntitySummary>;
  deleteTimeOffRequest(policyId: string, requestId: string): Promise<void>;
  deleteTimeOffRequestAtomic(policyId: string, requestId: string): Promise<void>;
  setTimeOffRequestStatus(
    policyId: string,
    requestId: string,
    statusType: "APPROVED" | "REJECTED",
    note?: string,
  ): Promise<EntitySummary>;
  setTimeOffRequestStatusAtomic(
    policyId: string,
    requestId: string,
    statusType: "APPROVED" | "REJECTED",
    note?: string,
  ): Promise<EntitySummary>;
  getTimeOffBalance(userId: string): Promise<ListResult<TimeOffBalanceSummary>>;
  updateTimeOffBalance(
    policyId: string,
    input: { userIds: string[]; value: number; note?: string },
  ): Promise<void>;
  updateTimeOffBalanceAtomic(policyId: string, input: { userIds: string[]; value: number; note?: string }): Promise<void>;
}
