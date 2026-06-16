import type { RestCore } from "./core.js";
import { toBareDate, inclusiveDays } from "./wire-dates.js";
import type { EntitySummary } from "../types.js";
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

function mapPolicy(raw: Record<string, unknown>): TimeOffPolicySummary {
  const out: TimeOffPolicySummary = { id: raw.id as string, name: raw.name as string };
  if (raw.status !== undefined) out.status = raw.status as string;
  if (raw.timeUnit !== undefined) out.timeUnit = raw.timeUnit as string;
  return out;
}

function mapRequest(raw: Record<string, unknown>): TimeOffRequestSummary {
  const out: TimeOffRequestSummary = { id: raw.id as string };
  if (raw.policyId !== undefined) out.policyId = raw.policyId as string;
  if (raw.userId !== undefined) out.userId = raw.userId as string;
  const rawStatus = raw.status as { statusType?: string } | string | undefined;
  const status = rawStatus && typeof rawStatus === "object" ? rawStatus.statusType : rawStatus;
  if (status !== undefined) out.status = status;
  if (raw.note !== undefined) out.note = raw.note as string;
  const period = (raw.timeOffPeriod as { period?: { start?: string; end?: string } } | undefined)?.period;
  if (period?.start !== undefined) out.start = period.start;
  if (period?.end !== undefined) out.end = period.end;
  return out;
}

function mapBalance(raw: Record<string, unknown>, userId: string): TimeOffBalanceSummary {
  const out: TimeOffBalanceSummary = { userId };
  if (raw.policyId !== undefined) out.policyId = raw.policyId as string;
  if (raw.policyName !== undefined) out.policyName = raw.policyName as string;
  if (typeof raw.balance === "number") out.balance = raw.balance;
  if (typeof raw.used === "number") out.used = raw.used;
  if (typeof raw.total === "number") out.total = raw.total;
  return out;
}

/**
 * Typed time-off REST module (goclmcp §2.9 — policies, requests, balances). I/O
 * only. Shapes pinned by the unit tests + the 2026-06-10 live probe: request
 * LIST and the single get are the POST search (`{count, requests:[]}` — the
 * single-GET route does not exist; it 404s "No static resource" even for a real
 * id); request create wants bare `YYYY-MM-DD` dates and REQUIRES `days` (400
 * "Value for number of days is not allowed" without it); approve/deny PATCH
 * carries `{status, note?}` (NOT `statusType`); policy update is GET-then-PUT
 * (merge into the existing policy); archive + balance update are PATCH; the
 * balance update path is `/time-off/balance/policy/{policyId}`.
 */
export function makeTimeOffRest(core: RestCore, workspaceId: string): TimeOffPort {
  const ws = `/workspaces/${workspaceId}`;
  const TIME_UNIT = "DAYS";

  return {
    async listTimeOffPolicies() {
      const rows = (await core.paginate("api", `${ws}/time-off/policies`)) as any[];
      return rows.map(mapPolicy);
    },
    async getTimeOffPolicy(id) {
      const raw = await core.call("api", "GET", `${ws}/time-off/policies/${id}`, undefined, true);
      return raw ? mapPolicy(raw as Record<string, unknown>) : null;
    },
    async createTimeOffPolicy(input): Promise<EntitySummary> {
      const body: Record<string, unknown> = {
        name: input.name,
        approve: { requiresApproval: input.requiresApproval ?? false },
        timeUnit: TIME_UNIT,
        userGroups: filter(input.userGroupIds ?? []),
        // Scope to the given users, else the admin (a policy with no scope is rejected).
        users: filter(input.userIds?.length ? input.userIds : [input.userId]),
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
      // The PUT requires users/userGroups as {contains,ids} FILTERS, but the GET
      // returns them FLAT as userIds/userGroupIds — re-sending the GET doc leaves
      // the filters null and the PUT 400s "must not be null" (live-verified). Always
      // reconstruct BOTH from the existing flat ids, overlaying the patch when given.
      const existingUserIds = Array.isArray(existing.userIds) ? (existing.userIds as string[]) : [];
      const existingGroupIds = Array.isArray(existing.userGroupIds) ? (existing.userGroupIds as string[]) : [];
      existing.users = filter(patch.userIds?.length ? patch.userIds : existingUserIds);
      existing.userGroups = filter(patch.userGroupIds?.length ? patch.userGroupIds : existingGroupIds);
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
      // There is no real single-GET route (live: 404 "No static resource" even
      // for an existing id) — find the request through the POST search instead.
      const env = (await core.call("api", "POST", `${ws}/time-off/requests`, { page: 1, pageSize: 200 })) as
        | { requests?: any[] }
        | any[]
        | null;
      const rows = Array.isArray(env) ? env : (env?.requests ?? []);
      const raw = rows.find((r: any) => r.id === id);
      return raw ? mapRequest(raw) : null;
    },
    async createTimeOffRequest(policyId, input): Promise<EntitySummary> {
      const start = toBareDate(input.start);
      const end = toBareDate(input.end);
      // `days` is REQUIRED on the wire (live: 400 without it); default the
      // inclusive span and let Clockify apply its own working-day validation.
      const days = input.days ?? inclusiveDays(start, end);
      const body: Record<string, unknown> = {
        timeOffPeriod: {
          period: {
            start,
            end,
            ...(days !== undefined ? { days } : {}),
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
      // The wire field is `status` (spec + goclmcp); `statusType` only appears in responses.
      const r = (await core.call("api", "PATCH", `${ws}/time-off/policies/${policyId}/requests/${requestId}`, {
        status: statusType,
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
