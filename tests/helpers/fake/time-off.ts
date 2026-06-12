import type { WorkspaceClient } from "../../../src/clockify/client.js";
import type {
  TimeOffPolicySummary,
  TimeOffRequestSummary,
} from "../../../src/clockify/ports/time-off.js";
import type { FakeContext } from "./state.js";

export function makeFakeTimeOff({ state, bump, nextId }: FakeContext): Pick<
  WorkspaceClient,
  | "listTimeOffPolicies"
  | "getTimeOffPolicy"
  | "createTimeOffPolicy"
  | "updateTimeOffPolicy"
  | "archiveTimeOffPolicy"
  | "listTimeOffRequests"
  | "getTimeOffRequest"
  | "createTimeOffRequest"
  | "deleteTimeOffRequest"
  | "setTimeOffRequestStatus"
  | "getTimeOffBalance"
  | "updateTimeOffBalance"
> {
  return {
    async listTimeOffPolicies() {
      bump("listTimeOffPolicies");
      return state.timeOffPolicies;
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
    async archiveTimeOffPolicy(id, archived) {
      bump("archiveTimeOffPolicy");
      const policy = state.timeOffPolicies.find((p) => p.id === id);
      if (policy) policy.status = archived ? "ARCHIVED" : "ACTIVE";
    },
    async listTimeOffRequests(filter) {
      bump("listTimeOffRequests");
      let rows = state.timeOffRequests;
      if (filter?.status) rows = rows.filter((r) => r.status === filter.status);
      if (filter?.userId) rows = rows.filter((r) => r.userId === filter.userId);
      return rows;
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
    async deleteTimeOffRequest(policyId, requestId) {
      bump("deleteTimeOffRequest");
      void policyId;
      state.timeOffRequests = state.timeOffRequests.filter((r) => r.id !== requestId);
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
    async getTimeOffBalance(userId) {
      bump("getTimeOffBalance");
      return state.timeOffBalances.map((b) => ({ ...b, userId }));
    },
    async updateTimeOffBalance(policyId, input) {
      bump("updateTimeOffBalance");
      void policyId;
      void input;
    },
  };
}
