import type {
  TimeEntrySummary,
  StartTimeEntryInput,
  CreateTimeEntryInput,
} from "../client.js";

/**
 * Time-entry slice of the {@link WorkspaceClient} port (goclmcp §2.1). Composed
 * into `WorkspaceClient` via interface extension; the REST adapter and the test
 * fake each implement this slice.
 */
export interface TimeEntryPort {
  getRunningTimeEntry(userId: string): Promise<TimeEntrySummary | null>;
  startTimeEntry(input: StartTimeEntryInput): Promise<TimeEntrySummary>;
  stopTimeEntry(input: { userId: string; end: string }): Promise<TimeEntrySummary | null>;
  createTimeEntry(input: CreateTimeEntryInput): Promise<TimeEntrySummary>;
  /** Read/list coverage for the broader action catalog. */
  getEntries(input: { userId: string; start?: string; end?: string }): Promise<TimeEntrySummary[]>;
  /** Update known time-entry fields (safe write — entry id is already resolved). */
  updateTimeEntry(input: {
    id: string;
    description?: string;
    projectId?: string;
    taskId?: string;
    tagIds?: string[];
  }): Promise<TimeEntrySummary>;
}
