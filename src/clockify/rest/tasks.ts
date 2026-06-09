import type { RestCore } from "./core.js";
import type { TaskPort } from "../ports/tasks.js";
import type { TaskSummary } from "../types.js";

/**
 * Typed task REST module (goclmcp §2.3). Tasks are nested under a project.
 * `updateTask` is GET-then-merge-PUT (PUT replaces, requires `name`).
 * `deleteTask` marks the task DONE (Clockify rejects deleting a non-DONE task in
 * some configurations) before issuing the DELETE. Rate writes the raw integer
 * `amount` to `.../tasks/{id}/{hourly-rate|cost-rate}`.
 */
export function makeTaskRest(core: RestCore, workspaceId: string): TaskPort {
  const ws = `/workspaces/${workspaceId}`;
  const map = (projectId: string, t: any): TaskSummary => ({ id: t.id, name: t.name, projectId });

  return {
    async listTasks(projectId, filter) {
      const params: Record<string, string> = {};
      if (filter?.name) params.name = filter.name;
      if (filter?.isActive !== undefined) params["is-active"] = String(filter.isActive);
      const rows = await core.paginate("api", `${ws}/projects/${projectId}/tasks`, params);
      return rows.map((t) => map(projectId, t));
    },
    async getTask(projectId, id) {
      const t = await core.call("api", "GET", `${ws}/projects/${projectId}/tasks/${id}`, undefined, true);
      return t ? map(projectId, t) : null;
    },
    async createTask({ projectId, name }) {
      const t = await core.call("api", "POST", `${ws}/projects/${projectId}/tasks`, { name });
      return map(projectId, t);
    },
    async updateTask(projectId, id, patch) {
      const t = await core.getThenPut("api", `${ws}/projects/${projectId}/tasks/${id}`, patch);
      return map(projectId, t);
    },
    async deleteTask(projectId, id) {
      // Mark DONE first (full-replacement PUT preserves name), then delete.
      await core.getThenPut("api", `${ws}/projects/${projectId}/tasks/${id}`, { status: "DONE" });
      await core.call("api", "DELETE", `${ws}/projects/${projectId}/tasks/${id}`);
    },
    async updateTaskRate(input) {
      const kind = input.rateKind === "COST" ? "cost-rate" : "hourly-rate";
      await core.call(
        "api",
        "PUT",
        `${ws}/projects/${input.projectId}/tasks/${input.taskId}/${kind}`,
        { amount: input.amountMinor, ...(input.since ? { since: input.since } : {}) },
      );
    },
  };
}
