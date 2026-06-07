import type { RestCore } from "./core.js";
import type { EntitySummary } from "../client.js";
import type { HolidayPort, HolidaySummary } from "../ports/holidays.js";

/** Holiday assignment filter (users / user groups). */
function assignment(ids: string[]): Record<string, unknown> {
  return { contains: "CONTAINS", ids, status: "ALL" };
}

/** The in-period endpoint wants full ISO datetimes; normalize a date-only bound. */
function periodStart(d: string): string {
  return d.includes("T") ? d : `${d}T00:00:00Z`;
}
function periodEnd(d: string): string {
  return d.includes("T") ? d : `${d}T23:59:59.999Z`;
}

function mapHoliday(raw: any): HolidaySummary {
  const out: HolidaySummary = { id: raw.id, name: raw.name };
  const dp = raw.datePeriod ?? {};
  if (dp.startDate !== undefined) out.startDate = dp.startDate;
  if (dp.endDate !== undefined) out.endDate = dp.endDate;
  if (typeof raw.occursAnnually === "boolean") out.occursAnnually = raw.occursAnnually;
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

  return {
    async listHolidays() {
      const rows = (await core.call("api", "GET", `${ws}/holidays`)) as any[] | null;
      return (Array.isArray(rows) ? rows : []).map(mapHoliday);
    },
    async getHoliday(id) {
      const rows = (await core.call("api", "GET", `${ws}/holidays`)) as any[] | null;
      const raw = (Array.isArray(rows) ? rows : []).find((h) => h.id === id);
      return raw ? mapHoliday(raw) : null;
    },
    async listHolidaysInPeriod({ assignedTo, start, end }) {
      const qs = new URLSearchParams({ "assigned-to": assignedTo, start: periodStart(start), end: periodEnd(end) });
      const rows = (await core.call("api", "GET", `${ws}/holidays/in-period?${qs.toString()}`)) as any[] | null;
      return (Array.isArray(rows) ? rows : []).map(mapHoliday);
    },
    async createHoliday(input): Promise<EntitySummary> {
      const body: Record<string, unknown> = {
        name: input.name,
        datePeriod: { startDate: input.startDate, endDate: input.endDate ?? input.startDate },
        ...(input.occursAnnually !== undefined ? { occursAnnually: input.occursAnnually } : {}),
        ...(input.userIds?.length ? { users: assignment(input.userIds) } : {}),
        ...(input.userGroupIds?.length ? { userGroups: assignment(input.userGroupIds) } : {}),
      };
      const h = (await core.call("api", "POST", `${ws}/holidays`, body)) as { id: string; name?: string };
      return { id: h.id, name: h.name ?? input.name };
    },
    async updateHoliday(id, patch): Promise<EntitySummary> {
      // The PUT is a full REPLACE — unchanged fields must be carried over or
      // Clockify 400s "must not be null". GET-scan the existing holiday (no
      // single-GET route) and merge the patch into a complete body.
      const rows = (await core.call("api", "GET", `${ws}/holidays`)) as any[] | null;
      const existing = (Array.isArray(rows) ? rows : []).find((h) => h.id === id) ?? {};
      const existingPeriod = existing.datePeriod ?? {};
      const body: Record<string, unknown> = {
        name: patch.name ?? existing.name,
        datePeriod: {
          startDate: patch.startDate ?? existingPeriod.startDate,
          endDate: patch.endDate ?? patch.startDate ?? existingPeriod.endDate,
        },
        ...(patch.occursAnnually ?? existing.occursAnnually) !== undefined
          ? { occursAnnually: patch.occursAnnually ?? existing.occursAnnually }
          : {},
      };
      // The read-back exposes the assignment as flat `userIds`/`userGroupIds`
      // arrays; re-send them in the `{contains,ids,status}` filter form so the
      // full-replace PUT keeps an assignment (else 400 "must not be null").
      const existingUserIds = Array.isArray(existing.userIds) ? existing.userIds : [];
      const existingGroupIds = Array.isArray(existing.userGroupIds) ? existing.userGroupIds : [];
      if (patch.userIds?.length) body.users = assignment(patch.userIds);
      else if (existingUserIds.length) body.users = assignment(existingUserIds);
      if (patch.userGroupIds?.length) body.userGroups = assignment(patch.userGroupIds);
      else if (existingGroupIds.length) body.userGroups = assignment(existingGroupIds);
      // A holiday can also be assigned to "everyone" (no userIds) — preserve that.
      if (existing.everyoneIncludingNew !== undefined) body.everyoneIncludingNew = existing.everyoneIncludingNew;
      if (!body.users && !body.userGroups && body.everyoneIncludingNew !== true) {
        // Clockify rejects a holiday with no assignment; fail clearly instead of
        // letting the full-replace PUT 400 on a dropped assignment.
        throw new Error(`Cannot update holiday ${id}: no resolvable user/group assignment to preserve`);
      }
      const h = (await core.call("api", "PUT", `${ws}/holidays/${id}`, body)) as { id?: string; name?: string };
      return { id: h?.id ?? id, name: h?.name ?? patch.name ?? id };
    },
    async deleteHoliday(id) {
      await core.call("api", "DELETE", `${ws}/holidays/${id}`);
    },
  };
}
