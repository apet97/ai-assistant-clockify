import type { TaskSummary } from "../client.js";

/**
 * Task slice of the {@link WorkspaceClient} port (goclmcp §2.3).
 */
export interface TaskPort {
  listTasks(projectId: string): Promise<TaskSummary[]>;
  createTask(input: { projectId: string; name: string }): Promise<TaskSummary>;
}
