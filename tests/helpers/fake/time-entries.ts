import type { TimeEntrySummary, WorkspaceClient } from "../../../src/clockify/client.js";
import { fakeListResult, type FakeContext } from "./state.js";

export function makeFakeTimeEntries({ state, seed, bump, nextId }: FakeContext): Pick<
  WorkspaceClient,
  | "getRunningTimeEntry"
  | "startTimeEntry"
  | "stopTimeEntry"
  | "createTimeEntry"
  | "getEntries"
  | "getEntry"
  | "markEntriesInvoiced"
  | "updateTimeEntry"
  | "startTimeEntryAtomic"
  | "stopTimeEntryAtomic"
  | "createTimeEntryAtomic"
  | "prepareTimeEntryUpdate"
  | "updateTimeEntryAtomic"
  | "markEntriesInvoicedAtomic"
  | "deleteTimeEntryAtomic"
> {
  const startAtomic: WorkspaceClient["startTimeEntryAtomic"] = async (input) => {
    bump("startTimeEntryAtomic");
    const entry: TimeEntrySummary = {
      id: nextId("entry"),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.tagIds !== undefined ? { tagIds: input.tagIds } : {}),
      ...(input.billable !== undefined ? { billable: input.billable } : {}),
      start: input.start,
    };
    state.running = entry;
    state.timeEntries.push(entry);
    return entry;
  };
  const stopAtomic: WorkspaceClient["stopTimeEntryAtomic"] = async ({ end }) => {
    bump("stopTimeEntryAtomic");
    if (!state.running) return null;
    const stopped = { ...state.running, end };
    const index = state.timeEntries.findIndex((entry) => entry.id === stopped.id);
    if (index >= 0) state.timeEntries[index] = stopped;
    state.running = null;
    return stopped;
  };
  const createAtomic: WorkspaceClient["createTimeEntryAtomic"] = async (input) => {
    bump("createTimeEntryAtomic");
    const entry: TimeEntrySummary = {
      id: nextId("entry"),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.tagIds !== undefined ? { tagIds: input.tagIds } : {}),
      ...(input.billable !== undefined ? { billable: input.billable } : {}),
      start: input.start, end: input.end ?? null,
    };
    state.timeEntries.push(entry);
    return entry;
  };
  const prepareUpdate: WorkspaceClient["prepareTimeEntryUpdate"] = async ({ id, ...patch }) => {
    bump("prepareTimeEntryUpdate");
    const current = state.timeEntries.find((entry) => entry.id === id);
    if (!current) throw new Error("entry_not_found");
    // Mirror the REAL body `rest/time-entries.ts prepareTimeEntryUpdate`
    // builds, including the wire's nulls. Clockify returns `tagIds: null` and
    // `taskId: null` for an entry with none, and this fake used to omit the
    // keys entirely — so a tagless entry produced no `body.tagIds` leaf at all
    // and the write-authority check never saw the shape it refuses in
    // production. Every preview-matrix fixture passed while editing a tagless
    // entry was impossible on a real workspace.
    const merged = { ...current, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) } as Record<string, unknown>;
    // EXACTLY the seven keys `rest/time-entries.ts prepareTimeEntryUpdate`
    // returns — no `id`, and the wire's nulls. Spreading the whole stored entry
    // handed callers an `id` the real adapter never sends, which is what let
    // `fetchStructureSnapshot` (it requires a string `id`) pass here and fail
    // in production with "The target changed or could not be verified".
    return {
      start: merged.start,
      end: merged.end ?? undefined,
      description: merged.description,
      projectId: merged.projectId ?? null,
      taskId: merged.taskId ?? null,
      tagIds: merged.tagIds ?? null,
      billable: merged.billable,
    } as Awaited<ReturnType<WorkspaceClient["prepareTimeEntryUpdate"]>>;
  };
  const updateAtomic: WorkspaceClient["updateTimeEntryAtomic"] = async (id, body) => {
    bump("updateTimeEntryAtomic");
    const index = state.timeEntries.findIndex((entry) => entry.id === id);
    const updated = { ...(index >= 0 ? state.timeEntries[index] : { id, start: "" }), ...body, id } as TimeEntrySummary;
    if (index >= 0) state.timeEntries[index] = updated;
    else state.timeEntries.push(updated);
    return updated;
  };
  return {
    async getRunningTimeEntry() {
      bump("getRunningTimeEntry");
      return state.running;
    },
    async startTimeEntry(input) {
      bump("startTimeEntry");
      return startAtomic(input);
    },
    startTimeEntryAtomic: startAtomic,
    async stopTimeEntry({ end }) {
      bump("stopTimeEntry");
      return stopAtomic({ userId: "", end });
    },
    stopTimeEntryAtomic: stopAtomic,
    async createTimeEntry(input) {
      bump("createTimeEntry");
      return createAtomic(input);
    },
    createTimeEntryAtomic: createAtomic,
    async getEntries({ start, end, projectId, taskId }) {
      bump("getEntries");
      // ISO-8601 UTC strings sort lexicographically, so range filtering works.
      const entries = state.timeEntries.filter((e) => {
        if (start && e.start < start) return false;
        if (end && e.start >= end) return false;
        if (projectId && e.projectId !== projectId) return false;
        if (taskId && e.taskId !== taskId) return false;
        return true;
      });
      return fakeListResult(seed, "getEntries", entries);
    },
    async getEntry(id) {
      bump("getEntry");
      return state.timeEntries.find((e) => e.id === id) ?? null;
    },
    async markEntriesInvoiced(input) {
      bump("markEntriesInvoiced");
      void input;
    },
    async markEntriesInvoicedAtomic(input) {
      bump("markEntriesInvoicedAtomic");
      void input;
    },
    async updateTimeEntry({ id, description, projectId, taskId, tagIds, billable }) {
      bump("updateTimeEntry");
      const index = state.timeEntries.findIndex((e) => e.id === id);
      const base: TimeEntrySummary =
        index >= 0 ? state.timeEntries[index] : { id, start: "" };
      const updated: TimeEntrySummary = {
        ...base,
        description: description ?? base.description,
        projectId: projectId ?? base.projectId,
        taskId: taskId ?? base.taskId,
        tagIds: tagIds ?? base.tagIds,
        billable: billable ?? base.billable,
      };
      if (index >= 0) state.timeEntries[index] = updated;
      else state.timeEntries.push(updated);
      return updated;
    },
    prepareTimeEntryUpdate: prepareUpdate,
    updateTimeEntryAtomic: updateAtomic,
    async deleteTimeEntryAtomic(id) {
      bump("deleteTimeEntryAtomic");
      state.timeEntries = state.timeEntries.filter((entry) => entry.id !== id);
      if (state.running?.id === id) state.running = null;
      state.deleted.push({ entityType: "time_entry", id });
    },
  };
}
