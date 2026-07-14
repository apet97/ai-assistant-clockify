import type { WorkspaceClient } from "../../../src/clockify/client.js";
import type {
  TimeOffPolicySummary,
  TimeOffRequestSummary,
} from "../../../src/clockify/ports/time-off.js";
import { fakeListResult, type FakeContext } from "./state.js";

export function makeFakeTimeOff({ state, seed, bump, nextId }: FakeContext): Pick<
  WorkspaceClient,
  | "listTimeOffPolicies"
  | "getTimeOffPolicy"
  | "createTimeOffPolicy"
  | "createTimeOffPolicyAtomic"
  | "updateTimeOffPolicy"
  | "prepareTimeOffPolicyUpdate"
  | "getTimeOffPolicyMutationState"
  | "updateTimeOffPolicyAtomic"
  | "archiveTimeOffPolicy"
  | "archiveTimeOffPolicyAtomic"
  | "listTimeOffRequests"
  | "getTimeOffRequest"
  | "createTimeOffRequest"
  | "createTimeOffRequestAtomic"
  | "deleteTimeOffRequest"
  | "deleteTimeOffRequestAtomic"
  | "setTimeOffRequestStatus"
  | "setTimeOffRequestStatusAtomic"
  | "getTimeOffBalance"
  | "updateTimeOffBalance"
  | "updateTimeOffBalanceAtomic"
> {
  return {
    async listTimeOffPolicies() {
      bump("listTimeOffPolicies");
      return fakeListResult(seed, "listTimeOffPolicies", state.timeOffPolicies);
    },
    async getTimeOffPolicy(id) {
      bump("getTimeOffPolicy");
      return state.timeOffPolicies.find((p) => p.id === id) ?? null;
    },
    async createTimeOffPolicy(input) {
      bump("createTimeOffPolicy");
      const policy: TimeOffPolicySummary = {
        id: nextId("pol"),
        name: input.name,
        status: "ACTIVE",
        timeUnit: "DAYS",
        ...(input.userIds?.length ? { userIds: input.userIds } : {}),
        ...(input.userGroupIds?.length ? { userGroupIds: input.userGroupIds } : {}),
      };
      state.timeOffPolicies.push(policy);
      return { id: policy.id, name: policy.name };
    },
    async createTimeOffPolicyAtomic(input) {
      bump("createTimeOffPolicyAtomic");
      const policy: TimeOffPolicySummary = {
        id: nextId("pol"), name: input.name, status: "ACTIVE", timeUnit: "DAYS",
        requiresApproval: input.requiresApproval ?? false,
        ...(input.daysPerYear !== undefined ? { daysPerYear: input.daysPerYear } : {}),
        ...(input.negativeBalance !== undefined ? { negativeBalance: input.negativeBalance } : {}),
        userIds: input.userIds?.length ? input.userIds : [input.userId],
        ...(input.userGroupIds?.length ? { userGroupIds: input.userGroupIds } : {}),
      };
      state.timeOffPolicies.push(policy);
      return policy;
    },
    async updateTimeOffPolicy(id, patch) {
      bump("updateTimeOffPolicy");
      const index = state.timeOffPolicies.findIndex((p) => p.id === id);
      const base: TimeOffPolicySummary = index >= 0 ? state.timeOffPolicies[index] : { id, name: id };
      const updated: TimeOffPolicySummary = {
        ...base,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.userIds?.length ? { userIds: patch.userIds } : {}),
        ...(patch.userGroupIds?.length ? { userGroupIds: patch.userGroupIds } : {}),
      };
      if (index >= 0) state.timeOffPolicies[index] = updated;
      else state.timeOffPolicies.push(updated);
      return { id, name: updated.name };
    },
    async prepareTimeOffPolicyUpdate(id, patch) {
      bump("prepareTimeOffPolicyUpdate");
      const policy = state.timeOffPolicies.find((row) => row.id === id);
      if (!policy) throw new Error("time_off_policy_not_found");
      const source = structuredClone(policy as unknown as Record<string, unknown>);
      const body = { ...source, ...patch, name: patch.name ?? policy.name };
      return { ...body, name: body.name, body, source };
    },
    async getTimeOffPolicyMutationState(id) {
      bump("getTimeOffPolicyMutationState");
      const policy = state.timeOffPolicies.find((row) => row.id === id);
      return policy ? structuredClone(policy as unknown as Record<string, unknown>) : null;
    },
    async updateTimeOffPolicyAtomic(id, body) {
      bump("updateTimeOffPolicyAtomic");
      const index = state.timeOffPolicies.findIndex((row) => row.id === id);
      if (index < 0) throw new Error("time_off_policy_not_found");
      state.timeOffPolicies[index] = { ...state.timeOffPolicies[index]!, ...body.body, id };
      return { id, name: state.timeOffPolicies[index]!.name };
    },
    async archiveTimeOffPolicy(id, archived) {
      bump("archiveTimeOffPolicy");
      const policy = state.timeOffPolicies.find((p) => p.id === id);
      if (policy) policy.status = archived ? "ARCHIVED" : "ACTIVE";
    },
    async archiveTimeOffPolicyAtomic(id, archived) {
      bump("archiveTimeOffPolicyAtomic");
      const policy = state.timeOffPolicies.find((row) => row.id === id);
      if (!policy) throw new Error("time_off_policy_not_found");
      policy.status = archived ? "ARCHIVED" : "ACTIVE";
    },
    async listTimeOffRequests(filter) {
      bump("listTimeOffRequests");
      let rows = state.timeOffRequests;
      if (filter?.status) rows = rows.filter((r) => r.status === filter.status);
      if (filter?.userId) rows = rows.filter((r) => r.userId === filter.userId);
      return fakeListResult(seed, "listTimeOffRequests", rows);
    },
    async getTimeOffRequest(id) {
      bump("getTimeOffRequest");
      return state.timeOffRequests.find((r) => r.id === id) ?? null;
    },
    async createTimeOffRequest(policyId, input) {
      bump("createTimeOffRequest");
      const req: TimeOffRequestSummary = {
        id: nextId("tor"),
        policyId,
        status: "PENDING",
        note: input.note,
        start: input.start,
        end: input.end,
      };
      state.timeOffRequests.push(req);
      return { id: req.id, name: req.id };
    },
    async createTimeOffRequestAtomic(policyId, input) {
      bump("createTimeOffRequestAtomic");
      const request: TimeOffRequestSummary = {
        id: nextId("tor"), policyId, userId: "admin-1", status: "PENDING",
        ...(input.note !== undefined ? { note: input.note } : {}),
        start: input.start, end: input.end, timeUnit: input.timeUnit === "HOURS" ? "HOURS" : "DAYS",
        ...(input.timeUnit === "HOURS" ? {} : {
          days: input.days ?? Math.round((Date.parse(`${input.end.slice(0, 10)}T00:00:00Z`) - Date.parse(`${input.start.slice(0, 10)}T00:00:00Z`)) / 86_400_000) + 1,
          halfDay: input.halfDay ?? false,
        }),
      };
      state.timeOffRequests.push(request);
      return { id: request.id, name: request.id };
    },
    async deleteTimeOffRequest(policyId, requestId) {
      bump("deleteTimeOffRequest");
      void policyId;
      state.timeOffRequests = state.timeOffRequests.filter((r) => r.id !== requestId);
      state.deleted.push({ entityType: "time_off_request", id: requestId });
    },
    async deleteTimeOffRequestAtomic(policyId, requestId) {
      bump("deleteTimeOffRequestAtomic");
      void policyId;
      state.timeOffRequests = state.timeOffRequests.filter((request) => request.id !== requestId);
      state.deleted.push({ entityType: "time_off_request", id: requestId });
    },
    async setTimeOffRequestStatus(policyId, requestId, statusType, note) {
      bump("setTimeOffRequestStatus");
      void policyId;
      void note;
      const req = state.timeOffRequests.find((r) => r.id === requestId);
      if (req) req.status = statusType;
      return { id: requestId, name: statusType };
    },
    async setTimeOffRequestStatusAtomic(policyId, requestId, statusType, note) {
      bump("setTimeOffRequestStatusAtomic");
      void policyId; void note;
      const request = state.timeOffRequests.find((row) => row.id === requestId);
      if (!request) throw new Error("time_off_request_not_found");
      request.status = statusType;
      return { id: requestId, name: statusType };
    },
    async getTimeOffBalance(userId) {
      bump("getTimeOffBalance");
      return fakeListResult(seed, "getTimeOffBalance", state.timeOffBalances.map((b) => ({ ...b, userId })));
    },
    async updateTimeOffBalance(policyId, input) {
      bump("updateTimeOffBalance");
      void policyId;
      void input;
    },
    async updateTimeOffBalanceAtomic(policyId, input) {
      bump("updateTimeOffBalanceAtomic");
      for (const userId of input.userIds) {
        const row = state.timeOffBalances.find((balance) => balance.policyId === policyId &&
          (balance.userId === undefined || balance.userId === userId));
        if (row) {
          row.userId = userId;
          row.balance = (row.balance ?? 0) + input.value;
        }
      }
    },
  };
}
