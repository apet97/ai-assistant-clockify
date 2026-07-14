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

  const startTimeEntryAtomic: TimeEntryPort["startTimeEntryAtomic"] = async (input) => {
    const e = (await core.mutate("api", "POST", `${ws}/time-entries`, {
      start: input.start,
      description: input.description,
      projectId: input.projectId,
      taskId: input.taskId,
      tagIds: input.tagIds,
      billable: input.billable,
    })) as ClockifyTimeEntry;
    return mapEntry(e);
  };
  const stopTimeEntryAtomic: TimeEntryPort["stopTimeEntryAtomic"] = async ({ userId, end }) => {
    try {
      const e = (await core.mutate("api", "PATCH", `${ws}/user/${userId}/time-entries`, { end })) as ClockifyTimeEntry | null;
      return e ? mapEntry(e) : null;
    } catch (error) {
      if (error instanceof Error && "status" in error && error.status === 404) return null;
      throw error;
    }
  };
  const createTimeEntryAtomic: TimeEntryPort["createTimeEntryAtomic"] = async (input) => {
    const e = (await core.mutate("api", "POST", `${ws}/time-entries`, {
      start: input.start,
      end: input.end,
      description: input.description,
      projectId: input.projectId,
      taskId: input.taskId,
      tagIds: input.tagIds,
      billable: input.billable,
    })) as ClockifyTimeEntry;
    return mapEntry(e);
  };
  const prepareTimeEntryUpdate: TimeEntryPort["prepareTimeEntryUpdate"] = async ({ id, description, projectId, taskId, tagIds, billable }) => {
    const current = (await core.call("api", "GET", `${ws}/time-entries/${id}`)) as ClockifyTimeEntry;
    return {
      start: current.timeInterval?.start,
      end: current.timeInterval?.end ?? undefined,
      description: description ?? current.description,
      projectId: projectId ?? current.projectId,
      taskId: taskId ?? current.taskId,
      tagIds: tagIds ?? current.tagIds,
      billable: billable ?? current.billable,
    };
  };
  const updateTimeEntryAtomic: TimeEntryPort["updateTimeEntryAtomic"] = async (id, body) =>
    mapEntry((await core.mutate("api", "PUT", `${ws}/time-entries/${id}`, body)) as ClockifyTimeEntry);
  const markEntriesInvoicedAtomic: TimeEntryPort["markEntriesInvoicedAtomic"] = async ({ ids, invoiced }) => {
    await core.mutate("api", "PATCH", `${ws}/time-entries/invoiced`, { timeEntryIds: ids, invoiced });
  };
  const deleteTimeEntryAtomic: TimeEntryPort["deleteTimeEntryAtomic"] = async (id) => {
    await core.mutate("api", "DELETE", `${ws}/time-entries/${id}`);
  };

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
      return startTimeEntryAtomic(input);
    },
    startTimeEntryAtomic,
    async stopTimeEntry({ userId, end }) {
      return stopTimeEntryAtomic({ userId, end });
    },
    stopTimeEntryAtomic,
    async createTimeEntry(input) {
      return createTimeEntryAtomic(input);
    },
    createTimeEntryAtomic,
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
      const body = await prepareTimeEntryUpdate({ id, description, projectId, taskId, tagIds, billable });
      return updateTimeEntryAtomic(id, body);
    },
    prepareTimeEntryUpdate,
    updateTimeEntryAtomic,
    async markEntriesInvoiced({ ids, invoiced }) {
      await markEntriesInvoicedAtomic({ ids, invoiced });
    },
    markEntriesInvoicedAtomic,
    deleteTimeEntryAtomic,
  };
}
