import type { EntitySummary } from "../client.js";

export interface TimeOffPolicySummary extends EntitySummary {
  status?: string;
  timeUnit?: string;
}

export interface TimeOffRequestSummary {
  id: string;
  policyId?: string;
  userId?: string;
  status?: string;
  note?: string;
  start?: string;
  end?: string;
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
  /** Policy is scoped to this user (the admin) by default. */
  userId: string;
  requiresApproval?: boolean;
  daysPerYear?: number;
  negativeBalance?: boolean;
}

export interface UpdateTimeOffPolicyInput {
  name?: string;
  requiresApproval?: boolean;
  daysPerYear?: number;
}

export interface CreateTimeOffRequestInput {
  start: string;
  end: string;
  days?: number;
  halfDay?: boolean;
  note?: string;
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
  listTimeOffPolicies(): Promise<TimeOffPolicySummary[]>;
  getTimeOffPolicy(id: string): Promise<TimeOffPolicySummary | null>;
  createTimeOffPolicy(input: CreateTimeOffPolicyInput): Promise<EntitySummary>;
  updateTimeOffPolicy(id: string, patch: UpdateTimeOffPolicyInput): Promise<EntitySummary>;
  archiveTimeOffPolicy(id: string, archived: boolean): Promise<void>;
  listTimeOffRequests(filter?: { status?: string; userId?: string }): Promise<TimeOffRequestSummary[]>;
  getTimeOffRequest(id: string): Promise<TimeOffRequestSummary | null>;
  createTimeOffRequest(policyId: string, input: CreateTimeOffRequestInput): Promise<EntitySummary>;
  deleteTimeOffRequest(policyId: string, requestId: string): Promise<void>;
  setTimeOffRequestStatus(
    policyId: string,
    requestId: string,
    statusType: "APPROVED" | "REJECTED",
    note?: string,
  ): Promise<EntitySummary>;
  getTimeOffBalance(userId: string): Promise<TimeOffBalanceSummary[]>;
  updateTimeOffBalance(
    policyId: string,
    input: { userIds: string[]; value: number; note?: string },
  ): Promise<void>;
}
