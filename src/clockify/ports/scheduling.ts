import type { EntitySummary, ListResult } from "../types.js";

export interface AssignmentSummary {
  id: string;
  userId?: string;
  projectId?: string;
  start?: string;
  end?: string;
  hoursPerDay?: number;
  startTime?: string;
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
  startTime?: string;
  note?: string;
}

export interface UpdateAssignmentInput {
  hoursPerDay?: number;
  note?: string;
  /** ONLY_THIS | ALL | THIS_AND_FOLLOWING — which occurrences of a recurring series to change. */
  seriesUpdateOption?: string;
}

/** Full replace body prepared from an authoritative read before journaling. */
export interface PreparedAssignmentUpdateInput extends CreateAssignmentInput {
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
  listAssignments(filter?: AssignmentFilter): Promise<ListResult<AssignmentSummary>>;
  getAssignment(id: string): Promise<AssignmentSummary | null>;
  prepareAssignmentUpdate(id: string, patch: UpdateAssignmentInput): Promise<PreparedAssignmentUpdateInput>;
  createAssignmentAtomic(input: CreateAssignmentInput): Promise<EntitySummary>;
  updateAssignmentAtomic(id: string, input: PreparedAssignmentUpdateInput): Promise<EntitySummary>;
  deleteAssignmentAtomic(id: string, seriesUpdateOption?: string): Promise<void>;
  publishScheduleAtomic(input: { start: string; end: string; notifyUsers?: boolean; userId?: string }): Promise<void>;
  createAssignment(input: CreateAssignmentInput): Promise<EntitySummary>;
  updateAssignment(id: string, patch: UpdateAssignmentInput): Promise<EntitySummary>;
  deleteAssignment(id: string, seriesUpdateOption?: string): Promise<void>;
  publishSchedule(input: { start: string; end: string; notifyUsers?: boolean; userId?: string }): Promise<void>;
  getAllProjectScheduleTotals(input: { start: string; end: string }): Promise<ListResult<unknown>>;
  getOneProjectScheduleTotals(input: { start: string; end: string; projectId: string }): Promise<ListResult<unknown>>;
  getProjectScheduleTotals(input: { start: string; end: string; projectId?: string }): Promise<ListResult<unknown>>;
  getUserScheduleTotals(userId: string, range: { start: string; end: string }): Promise<unknown>;
}
