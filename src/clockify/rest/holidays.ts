import type { RestCore } from "./core.js";
import { periodStart, periodEnd } from "./wire-dates.js";
import type { EntitySummary } from "../types.js";
import type { HolidayPort, HolidaySummary, CreateHolidayInput, UpdateHolidayInput, PreparedHolidayUpdateInput } from "../ports/holidays.js";
import { AmbiguousWriteOutcome } from "../write-outcome.js";

/** Holiday assignment filter (users / user groups). */
function assignment(ids: string[]): Record<string, unknown> {
  return { contains: "CONTAINS", ids, status: "ALL" };
}

/**
 * Holiday row read from `GET /holidays` (and `…/in-period`). Fields are those
 * {@link mapHoliday} and the update GET-scan read; the read-back exposes the
 * assignment FLAT as `userIds`/`userGroupIds` (re-sent as `{contains,ids,status}`
 * filters on the full-replace PUT).
 */
type HolidayRow = {
  id?: string;
  name?: string;
  datePeriod?: { startDate?: string; endDate?: string };
  occursAnnually?: boolean;
  userIds?: string[];
  userGroupIds?: string[];
  everyoneIncludingNew?: boolean;
};

function mapHoliday(raw: Record<string, unknown>): HolidaySummary {
  const out: HolidaySummary = { id: raw.id as string, name: raw.name as string };
  const dp = (raw.datePeriod ?? {}) as Record<string, unknown>;
  if (dp.startDate !== undefined) out.startDate = dp.startDate as string;
  if (dp.endDate !== undefined) out.endDate = dp.endDate as string;
  if (typeof raw.occursAnnually === "boolean") out.occursAnnually = raw.occursAnnually;
  if (Array.isArray(raw.userIds)) out.userIds = raw.userIds as string[];
  if (Array.isArray(raw.userGroupIds)) out.userGroupIds = raw.userGroupIds as string[];
  if (typeof raw.everyoneIncludingNew === "boolean") out.everyoneIncludingNew = raw.everyoneIncludingNew;
  return out;
}

/**
 * Typed holiday REST module (goclmcp §2.9 — holidays). I/O only. Shapes pinned
 * by the unit tests: list is a bare array; the single GET is a list-scan (no
 * `/holidays/{id}` route); create/update use `datePeriod:{startDate,endDate}`
 * and a `users`/`userGroups` `{contains,ids,status}` assignment; update is a PUT.
 */
export function makeHolidayRest(core: RestCore, workspaceId: string): HolidayPort {
  const ws = `/workspaces/${workspaceId}`;
  const createAtomic = async (input: CreateHolidayInput): Promise<EntitySummary> => {
    const body = { name: input.name, datePeriod: { startDate: input.startDate, endDate: input.endDate ?? input.startDate }, ...(input.occursAnnually !== undefined ? { occursAnnually: input.occursAnnually } : {}), ...(input.userIds?.length ? { users: assignment(input.userIds) } : {}), ...(input.userGroupIds?.length ? { userGroups: assignment(input.userGroupIds) } : {}) };
    const row = (await core.mutate("api", "POST", `${ws}/holidays`, body)) as { id?: unknown; name?: string } | null;
    if (typeof row?.id !== "string" || row.id.length === 0) {
      throw new AmbiguousWriteOutcome("POST", `${ws}/holidays`, "Clockify returned a successful holiday response without a usable id.");
    }
    return { id: row.id, name: row.name ?? input.name };
  };
  const prepareUpdate = async (id: string, patch: UpdateHolidayInput): Promise<PreparedHolidayUpdateInput> => {
    const rows = (await core.call("api", "GET", `${ws}/holidays`)) as HolidayRow[] | null;
    const existing = (Array.isArray(rows) ? rows : []).find((holiday) => holiday.id === id);
    if (!existing?.name || !existing.datePeriod?.startDate) throw new Error("holiday_not_found_or_incomplete");
    const userIds = patch.userIds?.length ? patch.userIds : existing.userIds ?? [];
    const userGroupIds = patch.userGroupIds?.length ? patch.userGroupIds : existing.userGroupIds ?? [];
    if (!userIds.length && !userGroupIds.length && existing.everyoneIncludingNew !== true) throw new Error(`Cannot update holiday ${id}: no resolvable assignment`);
    return { name: patch.name ?? existing.name, startDate: patch.startDate ?? existing.datePeriod.startDate, endDate: patch.endDate ?? patch.startDate ?? existing.datePeriod.endDate ?? existing.datePeriod.startDate, ...(patch.occursAnnually ?? existing.occursAnnually) !== undefined ? { occursAnnually: patch.occursAnnually ?? existing.occursAnnually } : {}, ...(userIds.length ? { userIds } : {}), ...(userGroupIds.length ? { userGroupIds } : {}), ...(existing.everyoneIncludingNew !== undefined ? { everyoneIncludingNew: existing.everyoneIncludingNew } : {}), source: mapHoliday(existing as Record<string, unknown>) };
  };
  const updateAtomic = async (id: string, input: PreparedHolidayUpdateInput): Promise<EntitySummary> => {
    const body = { name: input.name, datePeriod: { startDate: input.startDate, endDate: input.endDate ?? input.startDate }, ...(input.occursAnnually !== undefined ? { occursAnnually: input.occursAnnually } : {}), ...(input.userIds?.length ? { users: assignment(input.userIds) } : {}), ...(input.userGroupIds?.length ? { userGroups: assignment(input.userGroupIds) } : {}), ...(input.everyoneIncludingNew !== undefined ? { everyoneIncludingNew: input.everyoneIncludingNew } : {}) };
    const row = (await core.mutate("api", "PUT", `${ws}/holidays/${id}`, body)) as { id?: string; name?: string };
    return { id: row?.id ?? id, name: row?.name ?? input.name };
  };
  const deleteAtomic = async (id: string): Promise<void> => { await core.mutate("api", "DELETE", `${ws}/holidays/${id}`); };

  return {
    async listHolidays() {
      const rows = (await core.call("api", "GET", `${ws}/holidays`)) as HolidayRow[] | null;
      return { rows: (Array.isArray(rows) ? rows : []).map(mapHoliday), truncated: false };
    },
    async getHoliday(id) {
      const rows = (await core.call("api", "GET", `${ws}/holidays`)) as HolidayRow[] | null;
      const raw = (Array.isArray(rows) ? rows : []).find((h) => h.id === id);
      return raw ? mapHoliday(raw) : null;
    },
    async getHolidayMutationState(id) {
      const rows = (await core.call("api", "GET", `${ws}/holidays`)) as HolidayRow[] | null;
      const raw = (Array.isArray(rows) ? rows : []).find((holiday) => holiday.id === id);
      return raw ? mapHoliday(raw as Record<string, unknown>) : null;
    },
    async listHolidaysInPeriod({ assignedTo, start, end }) {
      const qs = new URLSearchParams({ "assigned-to": assignedTo, start: periodStart(start), end: periodEnd(end) });
      const rows = (await core.call("api", "GET", `${ws}/holidays/in-period?${qs.toString()}`)) as HolidayRow[] | null;
      return { rows: (Array.isArray(rows) ? rows : []).map(mapHoliday), truncated: false };
    },
    async createHoliday(input): Promise<EntitySummary> {
      return createAtomic(input);
    },
    createHolidayAtomic: createAtomic,
    async updateHoliday(id, patch): Promise<EntitySummary> {
      return updateAtomic(id, await prepareUpdate(id, patch));
    },
    prepareHolidayUpdate: prepareUpdate,
    updateHolidayAtomic: updateAtomic,
    async deleteHoliday(id) {
      await deleteAtomic(id);
    },
    deleteHolidayAtomic: deleteAtomic,
  };
}
