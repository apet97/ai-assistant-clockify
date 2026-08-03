import type { RestCore } from "./core.js";
import type { EntitySummary, ListResult } from "../types.js";
import type { SchedulingPort, AssignmentSummary, CreateAssignmentInput, PreparedAssignmentUpdateInput, UpdateAssignmentInput } from "../ports/scheduling.js";
import { assertCompleteAbsence, collectPages } from "./list-pages.js";
import { PAGE_SIZE } from "./core.js";
import { AmbiguousWriteOutcome } from "../write-outcome.js";

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
  if (typeof raw.userId === "string") out.userId = raw.userId;
  if (typeof raw.projectId === "string") out.projectId = raw.projectId;
  // The period is exposed as a nested `period:{start,end}` (create accepts top-level).
  const start = raw.start ?? raw.period?.start;
  const end = raw.end ?? raw.period?.end;
  if (typeof start === "string") out.start = start;
  if (typeof end === "string") out.end = end;
  if (typeof raw.hoursPerDay === "number") out.hoursPerDay = raw.hoursPerDay;
  if (typeof raw.startTime === "string") out.startTime = raw.startTime;
  if (typeof raw.note === "string") out.note = raw.note;
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

  async function prepareAssignmentUpdate(id: string, patch: UpdateAssignmentInput): Promise<PreparedAssignmentUpdateInput> {
    const result = await listRaw();
    const found = result.rows.find((a) => a.id === id);
    if (!found) assertCompleteAbsence(result.truncated, "assignment", id);
    const existing = found ?? {};
    const start = existing.start ?? existing.period?.start;
    const end = existing.end ?? existing.period?.end;
    if (!existing.userId || !existing.projectId || !start || !end || typeof existing.hoursPerDay !== "number") {
      throw new Error(`Assignment ${id} is missing fields required for a complete replacement.`);
    }
    return {
      userId: existing.userId,
      projectId: existing.projectId,
      start,
      end,
      hoursPerDay: patch.hoursPerDay ?? existing.hoursPerDay,
      ...(typeof existing.startTime === "string" ? { startTime: existing.startTime } : {}),
      ...(typeof patch.note === "string" ? { note: patch.note } : typeof existing.note === "string" ? { note: existing.note } : {}),
      ...(patch.seriesUpdateOption !== undefined ? { seriesUpdateOption: patch.seriesUpdateOption } : {}),
    };
  }

  async function createAssignmentAtomic(input: CreateAssignmentInput): Promise<EntitySummary> {
    const result = (await core.mutate("api", "POST", `${ws}/scheduling/assignments/recurring`, input)) as
      | AssignmentRow | AssignmentRow[] | null;
    const first = (Array.isArray(result) ? result[0] : result) ?? {};
    if (typeof first.id !== "string" || first.id.length === 0) {
      throw new AmbiguousWriteOutcome("POST", `${ws}/scheduling/assignments/recurring`, "Clockify accepted the assignment create without a usable id.");
    }
    return { id: first.id, name: first.id };
  }

  async function updateAssignmentAtomic(id: string, input: PreparedAssignmentUpdateInput): Promise<EntitySummary> {
    const result = (await core.mutate("api", "PATCH", `${ws}/scheduling/assignments/recurring/${id}`, input)) as unknown;
    const first = ((Array.isArray(result) ? result[0] : result) ?? {}) as { id?: unknown };
    if (first.id !== undefined && typeof first.id !== "string") {
      throw new AmbiguousWriteOutcome("PATCH", `${ws}/scheduling/assignments/recurring/${id}`, "Clockify returned a malformed assignment id.");
    }
    const updatedId = typeof first.id === "string" && first.id.length > 0 ? first.id : id;
    return { id: updatedId, name: updatedId };
  }

  async function deleteAssignmentAtomic(id: string, seriesUpdateOption?: string): Promise<void> {
    const qs = seriesUpdateOption ? `?${new URLSearchParams({ seriesUpdateOption }).toString()}` : "";
    await core.mutate("api", "DELETE", `${ws}/scheduling/assignments/recurring/${id}${qs}`);
  }

  async function publishScheduleAtomic(input: { start: string; end: string; notifyUsers?: boolean; userId?: string }): Promise<void> {
    await core.mutate("api", "PUT", `${ws}/scheduling/assignments/publish`, {
      start: input.start,
      end: input.end,
      notifyUsers: input.notifyUsers ?? false,
      ...(input.userId ? { userFilter: { contains: "CONTAINS", ids: [input.userId] } } : {}),
    });
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
    prepareAssignmentUpdate,
    createAssignmentAtomic,
    updateAssignmentAtomic,
    deleteAssignmentAtomic,
    publishScheduleAtomic,
    createAssignment: createAssignmentAtomic,
    async updateAssignment(id, patch) { return updateAssignmentAtomic(id, await prepareAssignmentUpdate(id, patch)); },
    deleteAssignment: deleteAssignmentAtomic,
    publishSchedule: publishScheduleAtomic,
    async getAllProjectScheduleTotals(input) {
      return collectPages({
        label: `${ws}/scheduling/assignments/projects/totals`,
        pageSize: PAGE_SIZE,
        async load(page, pageSize) {
          const out = (await core.postQuery("api", `${ws}/scheduling/assignments/projects/totals`, {
            start: input.start,
            end: input.end,
            page,
            pageSize,
          })) as unknown;
          return { rows: Array.isArray(out) ? out : out ? [out] : [] };
        },
      });
    },
    async getOneProjectScheduleTotals(input) {
      const qs = new URLSearchParams({ start: input.start, end: input.end });
      const one = (await core.call(
        "api",
        "GET",
        `${ws}/scheduling/assignments/projects/totals/${input.projectId}?${qs.toString()}`,
      )) as unknown;
      return { rows: Array.isArray(one) ? one : one ? [one] : [], truncated: false };
    },
    async getProjectScheduleTotals(input) {
      if (input.projectId !== undefined) {
        return this.getOneProjectScheduleTotals({
          start: input.start,
          end: input.end,
          projectId: input.projectId,
        });
      }
      return this.getAllProjectScheduleTotals({ start: input.start, end: input.end });
    },
    async getUserScheduleTotals(userId, range) {
      const qs = new URLSearchParams({ start: range.start, end: range.end });
      return core.call("api", "GET", `${ws}/scheduling/assignments/users/${userId}/totals?${qs.toString()}`);
    },
  };
}
