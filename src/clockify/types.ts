/**
 * Dependency-free shared-shapes module. It has NO imports, so it is a leaf in the
 * module graph: it breaks the `clockify/client.ts <-> clockify/ports/*` cycle that
 * arose when every port slice imported these summary types back from `client.ts`
 * while `client.ts` imported the ports barrel. Both the port slices and the REST
 * adapter now import these shapes from here instead of from `client.ts`.
 *
 * Shared entity summary shapes returned by the {@link WorkspaceClient} port. The
 * port is composed from per-area sub-interfaces in `./ports/*` so each feature
 * area owns its own method slice (decision D1 in `API_COVERAGE_PLAN.md`); these
 * summary types live here because every slice shares them.
 */

/**
 * Auth credential the REST adapter calls Clockify with: production sends the
 * installation token via `X-Addon-Token`; live-smoke dev scripts send an
 * `X-Api-Key`. Defined here (the import-free leaf) so both `rest/core.ts` and
 * `rest-workspace.ts` share ONE definition instead of re-declaring it. The
 * token/key is sent only in the request header — never logged, never placed in a
 * prompt, never returned.
 */
export type ClockifyAuth = { addonToken: string } | { apiKey: string };

/**
 * Exact collection-read contract shared by every Clockify list/search port.
 * `truncated` is true only when the adapter cannot prove the returned rows are
 * complete (for example, a pagination backstop was reached).
 */
export interface ListResult<T> {
  rows: T[];
  truncated: boolean;
}

export interface EntitySummary {
  id: string;
  name: string;
  archived?: boolean;
}

export interface ProjectSummary extends EntitySummary {
  clientId?: string;
  /** The spec's ProjectDtoV1.billable — the REST map used to DROP it (live item 069). */
  billable?: boolean;
  /** Project default hourly rate (minor units) from the project body, when read. */
  hourlyRate?: { amount: number; currency?: string };
}

export interface TaskSummary {
  id: string;
  name: string;
  projectId: string;
  /** Assignee user ids on the task (set at create or via update). */
  assigneeIds?: string[];
}

export interface TimeEntrySummary {
  id: string;
  description?: string;
  projectId?: string;
  taskId?: string;
  tagIds?: string[];
  billable?: boolean;
  start: string;
  end?: string | null;
}

export interface StartTimeEntryInput {
  userId: string;
  description?: string;
  projectId?: string;
  taskId?: string;
  tagIds?: string[];
  billable?: boolean;
  start: string;
}

export interface CreateTimeEntryInput {
  description?: string;
  projectId?: string;
  taskId?: string;
  tagIds?: string[];
  billable?: boolean;
  start: string;
  end?: string;
}
