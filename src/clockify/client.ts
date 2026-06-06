import { createRequire } from "node:module";

/**
 * The single Clockify SDK entrypoint (backend rule: all Clockify client
 * creation goes through this module). The add-on authenticates with the stored
 * installation token via `X-Addon-Token` — never an API key — and targets the
 * backend URL from verified token claims.
 *
 * The real factory (`createClockifyClient` from `clockify-sdk-ts-115`) is loaded
 * lazily and injected, so this module type-checks and unit-tests with a fake
 * even when the SDK package is not built locally, and live calls only touch the
 * SDK when an installation client is actually constructed.
 */

/**
 * Workspace-client port: the narrow Clockify surface the harness workflows use.
 * Tests provide a fake implementing this; a future live adapter would wrap the
 * SDK's `Workspace` resource clients (tags/projects/tasks/clients/timeEntries)
 * onto these methods. Keeping the port here means handlers depend only on the
 * Clockify module, not on the SDK package directly.
 */
export interface EntitySummary {
  id: string;
  name: string;
  archived?: boolean;
}

export interface ProjectSummary extends EntitySummary {
  clientId?: string;
}

export interface TaskSummary {
  id: string;
  name: string;
  projectId: string;
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

export interface WorkspaceClient {
  listTags(): Promise<EntitySummary[]>;
  createTag(input: { name: string }): Promise<EntitySummary>;
  listClients(): Promise<EntitySummary[]>;
  createClient(input: { name: string }): Promise<EntitySummary>;
  listProjects(): Promise<ProjectSummary[]>;
  createProject(input: { name: string; clientId?: string }): Promise<ProjectSummary>;
  listTasks(projectId: string): Promise<TaskSummary[]>;
  createTask(input: { projectId: string; name: string }): Promise<TaskSummary>;
  getRunningTimeEntry(userId: string): Promise<TimeEntrySummary | null>;
  startTimeEntry(input: StartTimeEntryInput): Promise<TimeEntrySummary>;
  stopTimeEntry(input: { userId: string; end: string }): Promise<TimeEntrySummary | null>;
  createTimeEntry(input: CreateTimeEntryInput): Promise<TimeEntrySummary>;
  /** Read/list coverage for the broader action catalog. */
  getEntries(input: { userId: string; start?: string; end?: string }): Promise<TimeEntrySummary[]>;
  listExpenses(): Promise<EntitySummary[]>;
  listUsers(): Promise<EntitySummary[]>;
  listWebhooks(): Promise<EntitySummary[]>;
  /** Update known time-entry fields (safe write — entry id is already resolved). */
  updateTimeEntry(input: {
    id: string;
    description?: string;
    projectId?: string;
    taskId?: string;
    tagIds?: string[];
  }): Promise<TimeEntrySummary>;
  /** Risky-write methods (used only at confirm time, after button confirmation). */
  deleteEntity?(input: { entityType: string; id: string }): Promise<void>;
  createInvoice?(input: { clientId: string; title?: string }): Promise<EntitySummary>;
  manageWebhook?(input: {
    operation: "create" | "update" | "delete";
    id?: string;
    name?: string;
    url?: string;
  }): Promise<EntitySummary | null>;
  /** Generic entity update (risky — committed only after button confirmation). */
  updateEntity?(input: {
    entityType: string;
    id: string;
    fields?: Record<string, unknown>;
  }): Promise<EntitySummary>;
  /** Expense create/update/delete (risky — confirm-gated). */
  manageExpense?(input: {
    operation: "create" | "update" | "delete";
    id?: string;
    name?: string;
    amount?: number;
  }): Promise<EntitySummary | null>;
  /** Approve/deny a time-off request (risky external side effect — confirm-gated). */
  manageTimeOff?(input: {
    requestId: string;
    decision: "approve" | "deny";
  }): Promise<EntitySummary | null>;
  /** Publish a schedule (risky external side effect — confirm-gated). */
  manageSchedule?(input: { operation: "publish"; id?: string }): Promise<EntitySummary | null>;
}

export interface ClockifyClientOptions {
  addonToken: string;
  environment?: string;
}

export interface ClockifyClientLike {
  workspace(id: string): unknown;
}

export type ClockifyClientFactory = (options: ClockifyClientOptions) => ClockifyClientLike;

export interface CreateWorkspaceClientInput {
  addonToken: string;
  backendUrl?: string;
  workspaceId: string;
}

let cachedFactory: ClockifyClientFactory | undefined;

function realFactory(): ClockifyClientFactory {
  if (!cachedFactory) {
    const requireFromHere = createRequire(import.meta.url);
    const sdk = requireFromHere("clockify-sdk-ts-115") as {
      createClockifyClient: ClockifyClientFactory;
    };
    cachedFactory = sdk.createClockifyClient;
  }
  return cachedFactory;
}

/**
 * Build a workspace-scoped Clockify client using add-on token auth.
 *
 * @param factory injectable client factory (tests pass a fake); defaults to the
 *   real `createClockifyClient` from the Clockify SDK.
 */
export function createWorkspaceClockifyClient(
  input: CreateWorkspaceClientInput,
  factory?: ClockifyClientFactory,
): unknown {
  const create = factory ?? realFactory();
  const client = create({
    addonToken: input.addonToken,
    environment: input.backendUrl,
  });
  return client.workspace(input.workspaceId);
}
