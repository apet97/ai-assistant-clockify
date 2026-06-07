import { createRequire } from "node:module";
import type {
  TimeEntryPort,
  ProjectPort,
  TaskPort,
  ClientPort,
  TagPort,
  InvoicePort,
  ExpensePort,
  CustomFieldPort,
  TimeOffPort,
  HolidayPort,
  UserPort,
  WebhookPort,
  MiscRiskyPort,
} from "./ports/index.js";

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
 * Shared entity summary shapes returned by the {@link WorkspaceClient} port.
 * The port itself is composed from per-area sub-interfaces in `./ports/*` so
 * each feature area owns its own method slice (decision D1 in
 * `API_COVERAGE_PLAN.md`); these summary types stay here because every slice
 * shares them.
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

/**
 * Workspace-client port: the narrow Clockify surface the harness workflows use.
 * Composed (decision D1) from per-area sub-interfaces — each feature area's
 * method slice lives in `./ports/<area>.ts`. Call sites are unchanged
 * (`ctx.clockify.listProjects()`); risky/commit-only methods stay optional. The
 * test fake and the live REST adapter both implement this composed interface.
 */
export interface WorkspaceClient
  extends TimeEntryPort,
    ProjectPort,
    TaskPort,
    ClientPort,
    TagPort,
    InvoicePort,
    ExpensePort,
    CustomFieldPort,
    TimeOffPort,
    HolidayPort,
    UserPort,
    WebhookPort,
    MiscRiskyPort {}

// Re-export the port slices so importers can depend on a single barrel
// (`clockify/client.js`) for both the composed port and its pieces.
export type {
  TimeEntryPort,
  ProjectPort,
  TaskPort,
  ClientPort,
  TagPort,
  InvoicePort,
  ExpensePort,
  CustomFieldPort,
  TimeOffPort,
  HolidayPort,
  UserPort,
  WebhookPort,
  MiscRiskyPort,
} from "./ports/index.js";

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
