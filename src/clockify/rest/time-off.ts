import { PAGE_SIZE, type RestCore } from "./core.js";
import { toBareDate, inclusiveDays } from "./wire-dates.js";
import { assertCompleteAbsence, collectPages } from "./list-pages.js";
import type { EntitySummary } from "../types.js";
import type {
  TimeOffPort,
  TimeOffPolicySummary,
  TimeOffRequestSummary,
  TimeOffBalanceSummary,
  CreateTimeOffPolicyInput,
  UpdateTimeOffPolicyInput,
  PreparedTimeOffPolicyUpdateInput,
  CreateTimeOffRequestInput,
} from "../ports/time-off.js";
import { AmbiguousWriteOutcome } from "../write-outcome.js";

/** Clockify scope filter shared by policy users/userGroups. */
function filter(ids: string[]): Record<string, unknown> {
  return { contains: "CONTAINS", ids, status: "ACTIVE" };
}

/** Policy row fields read by {@link mapPolicy}. */
type PolicyRow = {
  id?: string;
  name?: string;
  status?: string;
  timeUnit?: string;
};

/** Request row fields read by {@link mapRequest}. */
type RequestRow = {
  id?: string;
  policyId?: string;
  userId?: string;
  status?: { statusType?: string } | string;
  note?: string;
  timeUnit?: string;
  timeOffPeriod?: { period?: { start?: string; end?: string; days?: number }; isHalfDay?: boolean };
};

/** Balance row fields read by {@link mapBalance}. */
type BalanceRow = {
  policyId?: string;
  policyName?: string;
  balance?: number;
  used?: number;
  total?: number;
};

function mapPolicy(raw: Record<string, unknown>): TimeOffPolicySummary {
  const out: TimeOffPolicySummary = { id: raw.id as string, name: raw.name as string };
  if (raw.status !== undefined) out.status = raw.status as string;
  if (raw.timeUnit !== undefined) out.timeUnit = raw.timeUnit as string;
  const approve = raw.approve as { requiresApproval?: unknown } | undefined;
  if (typeof approve?.requiresApproval === "boolean") out.requiresApproval = approve.requiresApproval;
  const accrual = raw.automaticAccrual as { amount?: unknown } | undefined;
  if (typeof accrual?.amount === "number") out.daysPerYear = accrual.amount;
  if (typeof raw.allowNegativeBalance === "boolean") out.negativeBalance = raw.allowNegativeBalance;
  const users = raw.users as { ids?: unknown } | undefined;
  const groups = raw.userGroups as { ids?: unknown } | undefined;
  if (Array.isArray(raw.userIds)) out.userIds = raw.userIds as string[];
  else if (Array.isArray(users?.ids)) out.userIds = users.ids as string[];
  if (Array.isArray(raw.userGroupIds)) out.userGroupIds = raw.userGroupIds as string[];
  else if (Array.isArray(groups?.ids)) out.userGroupIds = groups.ids as string[];
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
  const timeOffPeriod = raw.timeOffPeriod as { period?: { start?: string; end?: string; days?: number }; isHalfDay?: boolean } | undefined;
  const period = timeOffPeriod?.period;
  if (period?.start !== undefined) out.start = period.start;
  if (period?.end !== undefined) out.end = period.end;
  if (typeof period?.days === "number") out.days = period.days;
  if (typeof timeOffPeriod?.isHalfDay === "boolean") out.halfDay = timeOffPeriod.isHalfDay;
  if (typeof raw.timeUnit === "string") out.timeUnit = raw.timeUnit;
  else if (typeof period?.start === "string") out.timeUnit = period.start.includes("T") ? "HOURS" : "DAYS";
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

  async function searchRequests(filterArg?: { status?: string; userId?: string }) {
    return collectPages<RequestRow>({
      label: `${ws}/time-off/requests`,
      pageSize: PAGE_SIZE,
      async load(page, pageSize) {
        const body: Record<string, unknown> = { page, pageSize };
        if (filterArg?.status) body.statuses = [filterArg.status];
        if (filterArg?.userId) body.users = [filterArg.userId];
        const env = (await core.postQuery("api", `${ws}/time-off/requests`, body)) as
          | { count?: number; requests?: RequestRow[] }
          | RequestRow[]
          | null;
        const rows = Array.isArray(env) ? env : (env?.requests ?? []);
        return { rows, ...(!Array.isArray(env) && typeof env?.count === "number" ? { total: env.count } : {}) };
      },
    });
  }

  const createPolicyAtomic = async (input: CreateTimeOffPolicyInput): Promise<EntitySummary> => {
    const body: Record<string, unknown> = { name: input.name, approve: { requiresApproval: input.requiresApproval ?? false }, timeUnit: TIME_UNIT, userGroups: filter(input.userGroupIds ?? []), users: filter(input.userIds?.length ? input.userIds : [input.userId]), ...(input.daysPerYear !== undefined ? { automaticAccrual: { amount: input.daysPerYear, period: "YEAR", timeUnit: TIME_UNIT } } : {}) };
    if (input.negativeBalance !== undefined) { body.allowNegativeBalance = input.negativeBalance; if (input.negativeBalance) body.negativeBalance = { amount: 10, amountValidForTimeUnit: true, period: "YEAR", shouldReset: false, timeUnit: TIME_UNIT }; }
    const row = (await core.mutate("api", "POST", `${ws}/time-off/policies`, body)) as { id?: unknown; name?: string } | null;
    if (typeof row?.id !== "string" || row.id.length === 0) {
      throw new AmbiguousWriteOutcome("POST", `${ws}/time-off/policies`, "Clockify returned a successful time-off policy response without a usable id.");
    }
    return { id: row.id, name: row.name ?? input.name };
  };
  const getPolicyMutationState = async (id: string): Promise<Record<string, unknown> | null> => {
    const raw = await core.call("api", "GET", `${ws}/time-off/policies/${id}`, undefined, true);
    return raw && typeof raw === "object" ? structuredClone(raw as Record<string, unknown>) : null;
  };
  const preparePolicyUpdate = async (id: string, patch: UpdateTimeOffPolicyInput): Promise<PreparedTimeOffPolicyUpdateInput> => {
    const existing = (await getPolicyMutationState(id)) ?? {};
    const source = structuredClone(existing);
    const body = structuredClone(existing);
    const timeUnit = (existing.timeUnit as string | undefined) ?? TIME_UNIT;
    const name = patch.name ?? existing.name as string | undefined;
    if (!name) throw new Error("time_off_policy_name_unavailable");
    if (patch.daysPerYear !== undefined) body.automaticAccrual = { ...((body.automaticAccrual ?? {}) as Record<string, unknown>), amount: patch.daysPerYear, period: "YEAR", timeUnit };
    if (patch.requiresApproval !== undefined) body.approve = { ...((body.approve ?? {}) as Record<string, unknown>), requiresApproval: patch.requiresApproval };
    const rawUsers = existing.users as { ids?: unknown } | undefined;
    const rawGroups = existing.userGroups as { ids?: unknown } | undefined;
    const users = Array.isArray(existing.userIds) ? existing.userIds as string[] : Array.isArray(rawUsers?.ids) ? rawUsers.ids as string[] : [];
    const groups = Array.isArray(existing.userGroupIds) ? existing.userGroupIds as string[] : Array.isArray(rawGroups?.ids) ? rawGroups.ids as string[] : [];
    Object.assign(body, { name, users: filter(patch.userIds?.length ? patch.userIds : users), userGroups: filter(patch.userGroupIds?.length ? patch.userGroupIds : groups) });
    return { ...body, name, body, source } as PreparedTimeOffPolicyUpdateInput;
  };
  const updatePolicyAtomic = async (id: string, body: PreparedTimeOffPolicyUpdateInput): Promise<EntitySummary> => {
    const row = (await core.mutate("api", "PUT", `${ws}/time-off/policies/${id}`, body.body)) as { id?: string; name?: string };
    return { id: row?.id ?? id, name: row?.name ?? body.name };
  };
  const archivePolicyAtomic = async (id: string, archived: boolean): Promise<void> => { await core.mutate("api", "PATCH", `${ws}/time-off/policies/${id}`, { status: archived ? "ARCHIVED" : "ACTIVE" }); };
  const createRequestAtomic = async (policyId: string, input: CreateTimeOffRequestInput): Promise<EntitySummary> => {
    let body: Record<string, unknown>;
    if (input.timeUnit === "HOURS") body = { timeOffPeriod: { period: { start: input.start, end: input.end } }, ...(input.note !== undefined ? { note: input.note } : {}) };
    else { const start = toBareDate(input.start); const end = toBareDate(input.end); const days = input.days ?? inclusiveDays(start, end); body = { timeOffPeriod: { period: { start, end, ...(days !== undefined ? { days } : {}) }, isHalfDay: input.halfDay ?? false, halfDayPeriod: "NOT_DEFINED", timeOffHalfDayPeriod: "NOT_DEFINED" }, ...(input.note !== undefined ? { note: input.note } : {}) }; }
    const row = (await core.mutate("api", "POST", `${ws}/time-off/policies/${policyId}/requests`, body)) as { id?: unknown } | null;
    if (typeof row?.id !== "string" || row.id.length === 0) {
      throw new AmbiguousWriteOutcome("POST", `${ws}/time-off/policies/${policyId}/requests`, "Clockify returned a successful time-off request response without a usable id.");
    }
    return { id: row.id, name: row.id };
  };
  const deleteRequestAtomic = async (policyId: string, requestId: string): Promise<void> => { await core.mutate("api", "DELETE", `${ws}/time-off/policies/${policyId}/requests/${requestId}`); };
  const setRequestStatusAtomic = async (policyId: string, requestId: string, statusType: "APPROVED" | "REJECTED", note?: string): Promise<EntitySummary> => {
    const row = (await core.mutate("api", "PATCH", `${ws}/time-off/policies/${policyId}/requests/${requestId}`, { status: statusType, ...(note !== undefined ? { note } : {}) })) as { id?: string } | null;
    return { id: row?.id ?? requestId, name: statusType };
  };
  const updateBalanceAtomic = async (policyId: string, input: { userIds: string[]; value: number; note?: string }): Promise<void> => { await core.mutate("api", "PATCH", `${ws}/time-off/balance/policy/${policyId}`, { userIds: input.userIds, value: input.value, ...(input.note !== undefined ? { note: input.note } : {}) }); };

  return {
    async listTimeOffPolicies() {
      const result = await core.paginate("api", `${ws}/time-off/policies`);
      return { ...result, rows: (result.rows as PolicyRow[]).map(mapPolicy) };
    },
    async getTimeOffPolicy(id) {
      const raw = await core.call("api", "GET", `${ws}/time-off/policies/${id}`, undefined, true);
      return raw ? mapPolicy(raw as Record<string, unknown>) : null;
    },
    async createTimeOffPolicy(input): Promise<EntitySummary> {
      return createPolicyAtomic(input);
    },
    createTimeOffPolicyAtomic: createPolicyAtomic,
    async updateTimeOffPolicy(id, patch): Promise<EntitySummary> {
      return updatePolicyAtomic(id, await preparePolicyUpdate(id, patch));
    },
    prepareTimeOffPolicyUpdate: preparePolicyUpdate,
    getTimeOffPolicyMutationState: getPolicyMutationState,
    updateTimeOffPolicyAtomic: updatePolicyAtomic,
    async archiveTimeOffPolicy(id, archived) {
      await archivePolicyAtomic(id, archived);
    },
    archiveTimeOffPolicyAtomic: archivePolicyAtomic,
    async listTimeOffRequests(filterArg) {
      const result = await searchRequests(filterArg);
      return { ...result, rows: result.rows.map(mapRequest) };
    },
    async getTimeOffRequest(id) {
      // There is no real single-GET route (live: 404 "No static resource" even
      // for an existing id) — find the request through the POST search instead.
      const result = await searchRequests();
      const raw = result.rows.find((r) => r.id === id);
      if (!raw) assertCompleteAbsence(result.truncated, "time-off request", id);
      return raw ? mapRequest(raw) : null;
    },
    async createTimeOffRequest(policyId, input): Promise<EntitySummary> {
      return createRequestAtomic(policyId, input);
    },
    createTimeOffRequestAtomic: createRequestAtomic,
    async deleteTimeOffRequest(policyId, requestId) {
      await deleteRequestAtomic(policyId, requestId);
    },
    deleteTimeOffRequestAtomic: deleteRequestAtomic,
    async setTimeOffRequestStatus(policyId, requestId, statusType, note): Promise<EntitySummary> {
      // The wire field is `status` (spec + goclmcp); `statusType` only appears in responses.
      return setRequestStatusAtomic(policyId, requestId, statusType, note);
    },
    setTimeOffRequestStatusAtomic: setRequestStatusAtomic,
    async getTimeOffBalance(userId) {
      const result = await core.paginateEnvelope("api", `${ws}/time-off/balance/user/${userId}`, "balances");
      return { ...result, rows: (result.rows as BalanceRow[]).map((r) => mapBalance(r, userId)) };
    },
    async updateTimeOffBalance(policyId, input) {
      await updateBalanceAtomic(policyId, input);
    },
    updateTimeOffBalanceAtomic: updateBalanceAtomic,
  };
}
