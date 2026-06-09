import type { TimeEntrySummary, WorkspaceClient } from "../../../src/clockify/client.js";
import type { FakeContext } from "./state.js";

export function makeFakeTimeEntries({ state, bump, nextId }: FakeContext): Pick<
  WorkspaceClient,
  | "getRunningTimeEntry"
  | "startTimeEntry"
  | "stopTimeEntry"
  | "createTimeEntry"
  | "getEntries"
  | "getEntry"
  | "markEntriesInvoiced"
  | "updateTimeEntry"
> {
  return {
    async getRunningTimeEntry() {
      bump("getRunningTimeEntry");
      return state.running;
    },
    async startTimeEntry(input) {
      bump("startTimeEntry");
      const entry: TimeEntrySummary = {
        id: nextId("entry"),
        description: input.description,
        projectId: input.projectId,
        taskId: input.taskId,
        tagIds: input.tagIds,
        billable: input.billable,
        start: input.start,
      };
      state.running = entry;
      state.timeEntries.push(entry);
      return entry;
    },
    async stopTimeEntry({ end }) {
      bump("stopTimeEntry");
      if (!state.running) return null;
      const stopped: TimeEntrySummary = { ...state.running, end };
      state.running = null;
      return stopped;
    },
    async createTimeEntry(input) {
      bump("createTimeEntry");
      const entry: TimeEntrySummary = {
        id: nextId("entry"),
        description: input.description,
        projectId: input.projectId,
        taskId: input.taskId,
        tagIds: input.tagIds,
        billable: input.billable,
        start: input.start,
        end: input.end ?? null,
      };
      state.timeEntries.push(entry);
      return entry;
    },
    async getEntries({ start, end, projectId, taskId }) {
      bump("getEntries");
      // ISO-8601 UTC strings sort lexicographically, so range filtering works.
      return state.timeEntries.filter((e) => {
        if (start && e.start < start) return false;
        if (end && e.start >= end) return false;
        if (projectId && e.projectId !== projectId) return false;
        if (taskId && e.taskId !== taskId) return false;
        return true;
      });
    },
    async getEntry(id) {
      bump("getEntry");
      return state.timeEntries.find((e) => e.id === id) ?? null;
    },
    async markEntriesInvoiced(input) {
      bump("markEntriesInvoiced");
      void input;
    },
    async updateTimeEntry({ id, description, projectId, taskId, tagIds }) {
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
      };
      if (index >= 0) state.timeEntries[index] = updated;
      else state.timeEntries.push(updated);
      return updated;
    },
  };
}
