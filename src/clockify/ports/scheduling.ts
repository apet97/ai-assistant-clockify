import type { EntitySummary } from "../types.js";

export interface AssignmentSummary {
  id: string;
  userId?: string;
  projectId?: string;
  start?: string;
  end?: string;
  hoursPerDay?: number;
  note?: string;
  published?: boolean;
}

export interface AssignmentFilter {
  start?: string;
  end?: string;
  userId?: string;
  projectId?: string;
}

export interface CreateAssignmentInput {
  userId: string;
  projectId: string;
  start: string;
  end: string;
  hoursPerDay: number;
  note?: string;
}

export interface UpdateAssignmentInput {
  hoursPerDay?: number;
  note?: string;
  /** ONLY_THIS | ALL | THIS_AND_FOLLOWING — which occurrences of a recurring series to change. */
  seriesUpdateOption?: string;
}

/**
 * Scheduling slice of the {@link WorkspaceClient} port (goclmcp §2.10). Reads are
 * immediate; create (safe) / update / delete / publish run from the handler.
 * Gotchas pinned by the unit tests: assignments live under
 * `/scheduling/assignments/recurring`; list is a bare array under `…/all`; the
 * single GET is a list-scan; delete takes a `seriesUpdateOption` query; PUBLISH
 * is a PUT to `…/publish`; project totals is a POST search.
 */
export interface SchedulingPort {
  listAssignments(filter?: AssignmentFilter): Promise<AssignmentSummary[]>;
  getAssignment(id: string): Promise<AssignmentSummary | null>;
  createAssignment(input: CreateAssignmentInput): Promise<EntitySummary>;
  updateAssignment(id: string, patch: UpdateAssignmentInput): Promise<EntitySummary>;
  deleteAssignment(id: string, seriesUpdateOption?: string): Promise<void>;
  publishSchedule(input: { start: string; end: string; notifyUsers?: boolean; userId?: string }): Promise<void>;
  getProjectScheduleTotals(input: { start: string; end: string; projectId?: string }): Promise<unknown[]>;
  getUserScheduleTotals(userId: string, range: { start: string; end: string }): Promise<unknown>;
}
