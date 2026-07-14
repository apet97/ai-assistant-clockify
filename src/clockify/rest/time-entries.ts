import type { RestCore } from "./core.js";
import type { TimeEntryPort } from "../ports/time-entries.js";
import type { TimeEntrySummary } from "../types.js";

/**
 * Typed time-entry REST module (goclmcp §2.1). I/O only. Entries are user-scoped
 * (`/user/{userId}/time-entries`); a single entry / update / mark-invoiced act on
 * the workspace path. `updateTimeEntry` is GET-then-PUT because Clockify's PUT
 * replaces the entry and requires `start`; mark-invoiced is a PATCH carrying
 * `timeEntryIds` + `invoiced` (matches the Go reference, not the plan's PUT).
 */
interface ClockifyTimeEntry {
  id: string;
  description?: string;
  projectId?: string;
  taskId?: string;
  tagIds?: string[];
  billable?: boolean;
  timeInterval?: { start: string; end?: string | null };
}

function mapEntry(e: ClockifyTimeEntry): TimeEntrySummary {
  return {
    id: e.id,
    description: e.description,
    projectId: e.projectId,
    taskId: e.taskId,
    tagIds: e.tagIds,
    billable: e.billable,
    start: e.timeInterval?.start ?? "",
    end: e.timeInterval?.end ?? null,
  };
}

export function makeTimeEntryRest(core: RestCore, workspaceId: string): TimeEntryPort {
  const ws = `/workspaces/${workspaceId}`;

  return {
    async getRunningTimeEntry(userId) {
      const rows = (await core.call(
        "api",
        "GET",
        `${ws}/user/${userId}/time-entries?in-progress=true`,
      )) as ClockifyTimeEntry[];
      return rows.length ? mapEntry(rows[0]) : null;
    },
    async startTimeEntry(input) {
      const e = (await core.call("api", "POST", `${ws}/time-entries`, {
        start: input.start,
        description: input.description,
        projectId: input.projectId,
        taskId: input.taskId,
        tagIds: input.tagIds,
        billable: input.billable,
      })) as ClockifyTimeEntry;
      return mapEntry(e);
    },
    async stopTimeEntry({ userId, end }) {
      const e = (await core.call(
        "api",
        "PATCH",
        `${ws}/user/${userId}/time-entries`,
        { end },
        true,
      )) as ClockifyTimeEntry | null;
      return e ? mapEntry(e) : null;
    },
    async createTimeEntry(input) {
      const e = (await core.call("api", "POST", `${ws}/time-entries`, {
        start: input.start,
        end: input.end,
        description: input.description,
        projectId: input.projectId,
        taskId: input.taskId,
        tagIds: input.tagIds,
        billable: input.billable,
      })) as ClockifyTimeEntry;
      return mapEntry(e);
    },
    async getEntries({ userId, start, end, projectId, taskId }) {
      const params: Record<string, string> = {};
      if (start) params.start = start;
      if (end) params.end = end;
      if (projectId) params.project = projectId;
      if (taskId) params.task = taskId;
      const { rows, truncated } = await core.paginate(
        "api",
        `${ws}/user/${userId}/time-entries`,
        params,
      );
      return { rows: (rows as ClockifyTimeEntry[]).map(mapEntry), truncated };
    },
    async getEntry(id) {
      const e = (await core.call(
        "api",
        "GET",
        `${ws}/time-entries/${id}`,
        undefined,
        true,
      )) as ClockifyTimeEntry | null;
      return e ? mapEntry(e) : null;
    },
    async updateTimeEntry({ id, description, projectId, taskId, tagIds, billable }) {
      // Clockify's PUT /time-entries/{id} REPLACES the entry and REQUIRES `start`;
      // a sparse body 400s. GET the current entry, flatten timeInterval to the
      // top-level shape PUT expects, merge the caller's fields, then PUT.
      const current = (await core.call("api", "GET", `${ws}/time-entries/${id}`)) as ClockifyTimeEntry;
      const body: Record<string, unknown> = {
        start: current.timeInterval?.start,
        end: current.timeInterval?.end ?? undefined,
        description: description ?? current.description,
        projectId: projectId ?? current.projectId,
        taskId: taskId ?? current.taskId,
        tagIds: tagIds ?? current.tagIds,
        billable: billable ?? current.billable,
      };
      const e = (await core.call("api", "PUT", `${ws}/time-entries/${id}`, body)) as ClockifyTimeEntry;
      return mapEntry(e);
    },
    async markEntriesInvoiced({ ids, invoiced }) {
      await core.call("api", "PATCH", `${ws}/time-entries/invoiced`, {
        timeEntryIds: ids,
        invoiced,
      });
    },
  };
}
