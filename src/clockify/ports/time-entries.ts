import type {
  TimeEntrySummary,
  StartTimeEntryInput,
  CreateTimeEntryInput,
  ListResult,
} from "../types.js";

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
  /**
   * Read/list coverage for the broader action catalog (paginated, user-scoped).
   * Returns `truncated: true` when the list hit the pagination backstop (more
   * rows exist than were fetched) so callers can caveat an incomplete result.
   */
  getEntries(input: {
    userId: string;
    start?: string;
    end?: string;
    projectId?: string;
    taskId?: string;
  }): Promise<ListResult<TimeEntrySummary>>;
  /** Fetch a single time entry by id. */
  getEntry(id: string): Promise<TimeEntrySummary | null>;
  /** Update known time-entry fields (safe write — entry id is already resolved). */
  updateTimeEntry(input: {
    id: string;
    description?: string;
    projectId?: string;
    taskId?: string;
    tagIds?: string[];
    billable?: boolean;
  }): Promise<TimeEntrySummary>;
  /** Bulk mark/unmark entries as invoiced (billing — PATCH /time-entries/invoiced). */
  markEntriesInvoiced(input: { ids: string[]; invoiced: boolean }): Promise<void>;
}
