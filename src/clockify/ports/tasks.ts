import type { TaskSummary } from "../client.js";

/** List filter for tasks (name / active state). */
export interface TaskFilter {
  name?: string;
  isActive?: boolean;
}

/** Task billing-rate write (minor units on the wire). */
export interface UpdateTaskRateInput {
  projectId: string;
  taskId: string;
  rateKind: "HOURLY" | "COST";
  amountMinor: number;
  since?: string;
}

/**
 * Task slice of the {@link WorkspaceClient} port (goclmcp §2.3). Tasks live under
 * a project. `updateTask` is fetch-then-merge (PUT replaces, requires `name`);
 * `deleteTask` marks the task DONE before deleting (Clockify requirement).
 */
export interface TaskPort {
  listTasks(projectId: string, filter?: TaskFilter): Promise<TaskSummary[]>;
  getTask(projectId: string, id: string): Promise<TaskSummary | null>;
  createTask(input: { projectId: string; name: string }): Promise<TaskSummary>;
  updateTask(projectId: string, id: string, patch: Record<string, unknown>): Promise<TaskSummary>;
  /** Mark the task DONE (if needed) then DELETE. */
  deleteTask(projectId: string, id: string): Promise<void>;
  updateTaskRate(input: UpdateTaskRateInput): Promise<void>;
}
