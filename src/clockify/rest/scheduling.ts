import type { RestCore } from "./core.js";
import type { EntitySummary, ListResult } from "../types.js";
import type { SchedulingPort, AssignmentSummary } from "../ports/scheduling.js";
import { assertCompleteAbsence, collectPages } from "./list-pages.js";
import { PAGE_SIZE } from "./core.js";

/**
 * Assignment row read from `…/assignments/all` (and the recurring POST/PATCH
 * responses). Fields are those {@link mapAssignment} and the update GET-scan read;
 * the period is exposed nested as `period:{start,end}` while create accepts
 * top-level `start`/`end`.
 */
type AssignmentRow = {
  id?: string;
  userId?: string;
  projectId?: string;
  start?: string;
  end?: string;
  period?: { start?: string; end?: string };
  hoursPerDay?: number;
  startTime?: string;
  note?: string;
  published?: boolean;
};

function mapAssignment(raw: AssignmentRow): AssignmentSummary {
  const out: AssignmentSummary = { id: raw.id as string };
  if (raw.userId !== undefined) out.userId = raw.userId;
  if (raw.projectId !== undefined) out.projectId = raw.projectId;
  // The period is exposed as a nested `period:{start,end}` (create accepts top-level).
  const start = raw.start ?? raw.period?.start;
  const end = raw.end ?? raw.period?.end;
  if (start !== undefined) out.start = start;
  if (end !== undefined) out.end = end;
  if (typeof raw.hoursPerDay === "number") out.hoursPerDay = raw.hoursPerDay;
  if (raw.note !== undefined) out.note = raw.note;
  if (typeof raw.published === "boolean") out.published = raw.published;
  return out;
}

/**
 * Typed scheduling REST module (goclmcp §2.10). I/O only. Shapes pinned by the
 * unit tests: assignments live under `/scheduling/assignments/recurring`; list is
 * a bare array under `…/all`; the single GET is a list-scan; delete carries a
 * `seriesUpdateOption` query; PUBLISH is a PUT to `…/publish`; project totals is
 * a POST search.
 */
export function makeSchedulingRest(core: RestCore, workspaceId: string): SchedulingPort {
  const ws = `/workspaces/${workspaceId}`;

  // The /all endpoint REQUIRES start+end (400s otherwise), so default a wide,
  // API-valid window (Clockify rejects dates past 9999-12-31) when none is given.
  const DEFAULT_START = "2000-01-01T00:00:00Z";
  const DEFAULT_END = "2099-12-31T00:00:00Z";

  async function listRaw(filter?: { start?: string; end?: string; userId?: string; projectId?: string }): Promise<ListResult<AssignmentRow>> {
    const params: Record<string, string> = {
      start: filter?.start || DEFAULT_START,
      end: filter?.end || DEFAULT_END,
    };
    if (filter?.userId) params.userId = filter.userId;
    if (filter?.projectId) params.projectId = filter.projectId;
    const result = await core.paginate("api", `${ws}/scheduling/assignments/all`, params);
    return { ...result, rows: result.rows as AssignmentRow[] };
  }

  return {
    async listAssignments(filter) {
      const result = await listRaw(filter);
      return { ...result, rows: result.rows.map(mapAssignment) };
    },
    async getAssignment(id) {
      const result = await listRaw();
      const raw = result.rows.find((a) => a.id === id);
      if (!raw) assertCompleteAbsence(result.truncated, "assignment", id);
      return raw ? mapAssignment(raw) : null;
    },
    async createAssignment(input): Promise<EntitySummary> {
      const body: Record<string, unknown> = {
        userId: input.userId,
        projectId: input.projectId,
        start: input.start,
        end: input.end,
        hoursPerDay: input.hoursPerDay,
        ...(input.note !== undefined ? { note: input.note } : {}),
      };
      const result = (await core.call("api", "POST", `${ws}/scheduling/assignments/recurring`, body)) as
        | AssignmentRow
        | AssignmentRow[]
        | null;
      const rows = Array.isArray(result) ? result : [result];
      const first: AssignmentRow = rows[0] ?? {};
      return { id: first.id ?? "assignment", name: first.id ?? "assignment" };
    },
    async updateAssignment(id, patch): Promise<EntitySummary> {
      // The recurring PATCH is a full replace (rejects a body without start/end),
      // so list-scan the existing assignment and re-send its period + identity.
      const result = await listRaw();
      const found = result.rows.find((a) => a.id === id);
      if (!found) assertCompleteAbsence(result.truncated, "assignment", id);
      const existing: AssignmentRow = found ?? {};
      const period = existing.period ?? {};
      const start = existing.start ?? period.start;
      const end = existing.end ?? period.end;
      const body: Record<string, unknown> = {
        ...(existing.userId !== undefined ? { userId: existing.userId } : {}),
        ...(existing.projectId !== undefined ? { projectId: existing.projectId } : {}),
        ...(start !== undefined ? { start } : {}),
        ...(end !== undefined ? { end } : {}),
        hoursPerDay: patch.hoursPerDay ?? existing.hoursPerDay,
        ...(existing.startTime !== undefined ? { startTime: existing.startTime } : {}),
        ...(patch.note !== undefined ? { note: patch.note } : existing.note !== undefined ? { note: existing.note } : {}),
        ...(patch.seriesUpdateOption !== undefined ? { seriesUpdateOption: patch.seriesUpdateOption } : {}),
      };
      // The PATCH responds with an ARRAY of AssignmentDtoV1 (the updated
      // occurrence(s)), same as the recurring POST.
      const r = (await core.call("api", "PATCH", `${ws}/scheduling/assignments/recurring/${id}`, body)) as unknown;
      const first = ((Array.isArray(r) ? r[0] : r) ?? {}) as { id?: string };
      return { id: first.id ?? id, name: first.id ?? id };
    },
    async deleteAssignment(id, seriesUpdateOption) {
      const qs = seriesUpdateOption ? `?${new URLSearchParams({ seriesUpdateOption }).toString()}` : "";
      await core.call("api", "DELETE", `${ws}/scheduling/assignments/recurring/${id}${qs}`);
    },
    async publishSchedule(input) {
      // Publish is range-scoped (publishes ALL drafts overlapping [start,end]). An
      // optional userFilter narrows the blast radius to a single user (live-verified
      // the endpoint accepts {contains,ids}).
      await core.call("api", "PUT", `${ws}/scheduling/assignments/publish`, {
        start: input.start,
        end: input.end,
        notifyUsers: input.notifyUsers ?? false,
        ...(input.userId ? { userFilter: { contains: "CONTAINS", ids: [input.userId] } } : {}),
      });
    },
    async getProjectScheduleTotals(input) {
      // A single project's totals live at GET …/projects/totals/{projectId}?start&end.
      // The POST search body (ProjectTotalsRequestV1) has NO projectId field — sending
      // it was silently dropped, returning ALL projects instead of the one requested.
      if (input.projectId !== undefined) {
        const qs = new URLSearchParams({ start: input.start, end: input.end });
        const one = (await core.call(
          "api",
          "GET",
          `${ws}/scheduling/assignments/projects/totals/${input.projectId}?${qs.toString()}`,
        )) as unknown;
        return { rows: Array.isArray(one) ? one : one ? [one] : [], truncated: false };
      }
      return collectPages({
        label: `${ws}/scheduling/assignments/projects/totals`,
        pageSize: PAGE_SIZE,
        async load(page, pageSize) {
          const out = (await core.call("api", "POST", `${ws}/scheduling/assignments/projects/totals`, {
            start: input.start,
            end: input.end,
            page,
            pageSize,
          })) as unknown;
          return { rows: Array.isArray(out) ? out : out ? [out] : [] };
        },
      });
    },
    async getUserScheduleTotals(userId, range) {
      const qs = new URLSearchParams({ start: range.start, end: range.end });
      return core.call("api", "GET", `${ws}/scheduling/assignments/users/${userId}/totals?${qs.toString()}`);
    },
  };
}
