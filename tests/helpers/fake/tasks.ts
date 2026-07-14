import type { TaskSummary, WorkspaceClient } from "../../../src/clockify/client.js";
import { fakeListResult, type FakeContext } from "./state.js";

export function makeFakeTasks({ state, seed, bump, nextId }: FakeContext): Pick<
  WorkspaceClient,
  "listTasks" | "getTask" | "createTask" | "updateTask" | "deleteTask" | "updateTaskRate" |
  "createTaskAtomic" | "prepareTaskUpdate" | "updateTaskAtomic" | "deleteTaskAtomic" | "updateTaskRateAtomic"
> {
  const createAtomic: WorkspaceClient["createTaskAtomic"] = async ({ projectId, name, assigneeIds }) => {
    bump("createTaskAtomic");
    const task: TaskSummary = { id: nextId("task"), name, projectId, ...(assigneeIds?.length ? { assigneeIds } : {}) };
    state.tasks.push(task);
    return task;
  };
  const prepareUpdate: WorkspaceClient["prepareTaskUpdate"] = async (projectId, id, patch) => {
    bump("prepareTaskUpdate");
    const current = state.tasks.find((task) => task.projectId === projectId && task.id === id);
    if (!current) throw new Error("task_not_found");
    return { ...current, ...patch };
  };
  const updateAtomic: WorkspaceClient["updateTaskAtomic"] = async (projectId, id, body) => {
    bump("updateTaskAtomic");
    const index = state.tasks.findIndex((task) => task.projectId === projectId && task.id === id);
    const updated = { ...(index >= 0 ? state.tasks[index] : { id, name: id, projectId }), ...body, id, projectId } as TaskSummary;
    if (index >= 0) state.tasks[index] = updated;
    else state.tasks.push(updated);
    return updated;
  };
  const deleteAtomic: WorkspaceClient["deleteTaskAtomic"] = async (projectId, id) => {
    bump("deleteTaskAtomic");
    state.tasks = state.tasks.filter((task) => !(task.projectId === projectId && task.id === id));
    state.deleted.push({ entityType: "task", id });
  };
  return {
    async listTasks(projectId, filter) {
      bump("listTasks");
      let rows = state.tasks.filter((t) => t.projectId === projectId);
      if (filter?.name) {
        const needle = filter.name.toLowerCase();
        rows = rows.filter((t) => t.name.toLowerCase().includes(needle));
      }
      return fakeListResult(seed, "listTasks", rows);
    },
    async getTask(projectId, id) {
      bump("getTask");
      return state.tasks.find((t) => t.projectId === projectId && t.id === id) ?? null;
    },
    async createTask({ projectId, name, assigneeIds }) {
      bump("createTask");
      const t: TaskSummary = { id: nextId("task"), name, projectId, ...(assigneeIds?.length ? { assigneeIds } : {}) };
      state.tasks.push(t);
      return t;
    },
    createTaskAtomic: createAtomic,
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
    prepareTaskUpdate: prepareUpdate,
    updateTaskAtomic: updateAtomic,
    async deleteTask(projectId, id) {
      bump("deleteTask");
      state.tasks = state.tasks.filter((t) => !(t.projectId === projectId && t.id === id));
      state.deleted.push({ entityType: "task", id });
    },
    deleteTaskAtomic: deleteAtomic,
    async updateTaskRate(input) {
      bump("updateTaskRate");
      void input;
    },
    async updateTaskRateAtomic(input) {
      bump("updateTaskRateAtomic");
      void input;
    },
  };
}
