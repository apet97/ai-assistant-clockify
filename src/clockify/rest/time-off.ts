import type { RestCore } from "./core.js";
import type { EntitySummary } from "../client.js";
import type {
  TimeOffPort,
  TimeOffPolicySummary,
  TimeOffRequestSummary,
  TimeOffBalanceSummary,
} from "../ports/time-off.js";

/** Clockify scope filter shared by policy users/userGroups. */
function filter(ids: string[]): Record<string, unknown> {
  return { contains: "CONTAINS", ids, status: "ACTIVE" };
}

function mapPolicy(raw: any): TimeOffPolicySummary {
  const out: TimeOffPolicySummary = { id: raw.id, name: raw.name };
  if (raw.status !== undefined) out.status = raw.status;
  if (raw.timeUnit !== undefined) out.timeUnit = raw.timeUnit;
  return out;
}

function mapRequest(raw: any): TimeOffRequestSummary {
  const out: TimeOffRequestSummary = { id: raw.id };
  if (raw.policyId !== undefined) out.policyId = raw.policyId;
  if (raw.userId !== undefined) out.userId = raw.userId;
  const status = raw.status && typeof raw.status === "object" ? raw.status.statusType : raw.status;
  if (status !== undefined) out.status = status;
  if (raw.note !== undefined) out.note = raw.note;
  const period = raw.timeOffPeriod?.period;
  if (period?.start !== undefined) out.start = period.start;
  if (period?.end !== undefined) out.end = period.end;
  return out;
}

function mapBalance(raw: any, userId: string): TimeOffBalanceSummary {
  const out: TimeOffBalanceSummary = { userId };
  if (raw.policyId !== undefined) out.policyId = raw.policyId;
  if (raw.policyName !== undefined) out.policyName = raw.policyName;
  if (typeof raw.balance === "number") out.balance = raw.balance;
  if (typeof raw.used === "number") out.used = raw.used;
  if (typeof raw.total === "number") out.total = raw.total;
  return out;
}

/**
 * Typed time-off REST module (goclmcp §2.9 — policies, requests, balances). I/O
 * only. Shapes pinned by the unit tests: request LIST is a POST search
 * (`{count, requests:[]}`); policy update is GET-then-PUT (merge into the
 * existing policy); archive + approve/deny + balance update are PATCH; the
 * balance update path is `/time-off/balance/policy/{policyId}`.
 */
export function makeTimeOffRest(core: RestCore, workspaceId: string): TimeOffPort {
  const ws = `/workspaces/${workspaceId}`;
  const TIME_UNIT = "DAYS";

  return {
    async listTimeOffPolicies() {
      const rows = (await core.call("api", "GET", `${ws}/time-off/policies`)) as any[] | null;
      return (Array.isArray(rows) ? rows : []).map(mapPolicy);
    },
    async getTimeOffPolicy(id) {
      const raw = await core.call("api", "GET", `${ws}/time-off/policies/${id}`, undefined, true);
      return raw ? mapPolicy(raw) : null;
    },
    async createTimeOffPolicy(input): Promise<EntitySummary> {
      const body: Record<string, unknown> = {
        name: input.name,
        approve: { requiresApproval: input.requiresApproval ?? false },
        timeUnit: TIME_UNIT,
        userGroups: filter([]),
        users: filter([input.userId]),
        ...(input.daysPerYear !== undefined
          ? { automaticAccrual: { amount: input.daysPerYear, period: "YEAR", timeUnit: TIME_UNIT } }
          : {}),
      };
      if (input.negativeBalance !== undefined) {
        body.allowNegativeBalance = input.negativeBalance;
        if (input.negativeBalance) {
          body.negativeBalance = {
            amount: 10,
            amountValidForTimeUnit: true,
            period: "YEAR",
            shouldReset: false,
            timeUnit: TIME_UNIT,
          };
        }
      }
      const p = (await core.call("api", "POST", `${ws}/time-off/policies`, body)) as { id: string; name?: string };
      return { id: p.id, name: p.name ?? input.name };
    },
    async updateTimeOffPolicy(id, patch): Promise<EntitySummary> {
      // GET-then-merge-PUT: Clockify replaces on PUT, so merge into the existing policy.
      const existing = ((await core.call("api", "GET", `${ws}/time-off/policies/${id}`)) ?? {}) as Record<string, any>;
      const timeUnit = (existing.timeUnit as string | undefined) ?? TIME_UNIT;
      if (patch.name !== undefined) existing.name = patch.name;
      if (patch.daysPerYear !== undefined) {
        existing.automaticAccrual = { amount: patch.daysPerYear, period: "YEAR", timeUnit };
      }
      if (patch.requiresApproval !== undefined) {
        existing.approve = { ...(existing.approve ?? {}), requiresApproval: patch.requiresApproval };
      }
      const result = (await core.call("api", "PUT", `${ws}/time-off/policies/${id}`, existing)) as { id?: string; name?: string };
      return { id: result?.id ?? id, name: result?.name ?? patch.name ?? id };
    },
    async archiveTimeOffPolicy(id, archived) {
      await core.call("api", "PATCH", `${ws}/time-off/policies/${id}`, {
        status: archived ? "ARCHIVED" : "ACTIVE",
      });
    },
    async listTimeOffRequests(filterArg) {
      const body: Record<string, unknown> = { page: 1, pageSize: 200 };
      if (filterArg?.status) body.statuses = [filterArg.status];
      if (filterArg?.userId) body.users = [filterArg.userId];
      const env = (await core.call("api", "POST", `${ws}/time-off/requests`, body)) as
        | { requests?: any[] }
        | any[]
        | null;
      const rows = Array.isArray(env) ? env : (env?.requests ?? []);
      return rows.map(mapRequest);
    },
    async getTimeOffRequest(id) {
      const raw = await core.call("api", "GET", `${ws}/time-off/requests/${id}`, undefined, true);
      return raw ? mapRequest(raw) : null;
    },
    async createTimeOffRequest(policyId, input): Promise<EntitySummary> {
      const body: Record<string, unknown> = {
        timeOffPeriod: {
          period: {
            start: input.start,
            end: input.end,
            ...(input.days !== undefined ? { days: input.days } : {}),
          },
          isHalfDay: input.halfDay ?? false,
          halfDayPeriod: "NOT_DEFINED",
          timeOffHalfDayPeriod: "NOT_DEFINED",
        },
        ...(input.note !== undefined ? { note: input.note } : {}),
      };
      const r = (await core.call("api", "POST", `${ws}/time-off/policies/${policyId}/requests`, body)) as { id: string };
      return { id: r.id, name: r.id };
    },
    async deleteTimeOffRequest(policyId, requestId) {
      await core.call("api", "DELETE", `${ws}/time-off/policies/${policyId}/requests/${requestId}`);
    },
    async setTimeOffRequestStatus(policyId, requestId, statusType, note): Promise<EntitySummary> {
      const r = (await core.call("api", "PATCH", `${ws}/time-off/policies/${policyId}/requests/${requestId}`, {
        statusType,
        ...(note !== undefined ? { note } : {}),
      })) as { id?: string } | null;
      return { id: r?.id ?? requestId, name: statusType };
    },
    async getTimeOffBalance(userId) {
      const qs = new URLSearchParams({ page: "1", "page-size": "200" });
      const env = (await core.call("api", "GET", `${ws}/time-off/balance/user/${userId}?${qs.toString()}`)) as
        | { balances?: any[] }
        | any[]
        | null;
      const rows = Array.isArray(env) ? env : (env?.balances ?? []);
      return rows.map((r: any) => mapBalance(r, userId));
    },
    async updateTimeOffBalance(policyId, input) {
      await core.call("api", "PATCH", `${ws}/time-off/balance/policy/${policyId}`, {
        userIds: input.userIds,
        value: input.value,
        ...(input.note !== undefined ? { note: input.note } : {}),
      });
    },
  };
}
