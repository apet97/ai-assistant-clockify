import type { TaskSummary, WorkspaceClient } from "../../../src/clockify/client.js";
import type { FakeContext } from "./state.js";

export function makeFakeTasks({ state, bump, nextId }: FakeContext): Pick<
  WorkspaceClient,
  "listTasks" | "getTask" | "createTask" | "updateTask" | "deleteTask" | "updateTaskRate"
> {
  return {
    async listTasks(projectId, filter) {
      bump("listTasks");
      let rows = state.tasks.filter((t) => t.projectId === projectId);
      if (filter?.name) {
        const needle = filter.name.toLowerCase();
        rows = rows.filter((t) => t.name.toLowerCase().includes(needle));
      }
      return rows;
    },
    async getTask(projectId, id) {
      bump("getTask");
      return state.tasks.find((t) => t.projectId === projectId && t.id === id) ?? null;
    },
    async createTask({ projectId, name }) {
      bump("createTask");
      const t: TaskSummary = { id: nextId("task"), name, projectId };
      state.tasks.push(t);
      return t;
    },
    async updateTask(projectId, id, patch) {
      bump("updateTask");
      const index = state.tasks.findIndex((t) => t.projectId === projectId && t.id === id);
      const base: TaskSummary = index >= 0 ? state.tasks[index] : { id, name: id, projectId };
      const updated: TaskSummary = {
        ...base,
        ...(typeof patch.name === "string" ? { name: patch.name } : {}),
      };
      if (index >= 0) state.tasks[index] = updated;
      else state.tasks.push(updated);
      return updated;
    },
    async deleteTask(projectId, id) {
      bump("deleteTask");
      state.tasks = state.tasks.filter((t) => !(t.projectId === projectId && t.id === id));
      state.deleted.push({ entityType: "task", id });
    },
    async updateTaskRate(input) {
      bump("updateTaskRate");
      void input;
    },
  };
}
