import type { RestCore } from "./core.js";
import type { EntitySummary } from "../types.js";
import type { SchedulingPort, AssignmentSummary } from "../ports/scheduling.js";

function mapAssignment(raw: any): AssignmentSummary {
  const out: AssignmentSummary = { id: raw.id };
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

  async function listRaw(filter?: { start?: string; end?: string; userId?: string; projectId?: string }): Promise<any[]> {
    const params: Record<string, string> = {
      start: filter?.start || DEFAULT_START,
      end: filter?.end || DEFAULT_END,
    };
    if (filter?.userId) params.userId = filter.userId;
    if (filter?.projectId) params.projectId = filter.projectId;
    const rows = await core.paginate("api", `${ws}/scheduling/assignments/all`, params);
    return rows as any[];
  }

  return {
    async listAssignments(filter) {
      return (await listRaw(filter)).map(mapAssignment);
    },
    async getAssignment(id) {
      const raw = (await listRaw()).find((a) => a.id === id);
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
      const result = (await core.call("api", "POST", `${ws}/scheduling/assignments/recurring`, body)) as any;
      const rows = Array.isArray(result) ? result : [result];
      const first = rows[0] ?? {};
      return { id: first.id ?? "assignment", name: first.id ?? "assignment" };
    },
    async updateAssignment(id, patch): Promise<EntitySummary> {
      // The recurring PATCH is a full replace (rejects a body without start/end),
      // so list-scan the existing assignment and re-send its period + identity.
      const existing = (await listRaw()).find((a) => a.id === id) ?? {};
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
      await core.call("api", "PUT", `${ws}/scheduling/assignments/publish`, {
        start: input.start,
        end: input.end,
        notifyUsers: input.notifyUsers ?? false,
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
        return Array.isArray(one) ? one : one ? [one] : [];
      }
      const out = (await core.call("api", "POST", `${ws}/scheduling/assignments/projects/totals`, {
        start: input.start,
        end: input.end,
      })) as unknown;
      return Array.isArray(out) ? out : out ? [out] : [];
    },
    async getUserScheduleTotals(userId, range) {
      const qs = new URLSearchParams({ start: range.start, end: range.end });
      return core.call("api", "GET", `${ws}/scheduling/assignments/users/${userId}/totals?${qs.toString()}`);
    },
  };
}
