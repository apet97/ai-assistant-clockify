import type { WorkspaceClient } from "../../src/clockify/client.js";
import {
  createFakeState,
  makeNextId,
  type FakeContext,
  type FakeState,
  type FakeWorkspaceSeed,
} from "./fake/state.js";
import { makeFakeTags } from "./fake/tags.js";
import { makeFakeClients } from "./fake/clients.js";
import { makeFakeProjects } from "./fake/projects.js";
import { makeFakeTasks } from "./fake/tasks.js";
import { makeFakeTimeEntries } from "./fake/time-entries.js";
import { makeFakeExpenses } from "./fake/expenses.js";
import { makeFakeCustomFields } from "./fake/custom-fields.js";
import { makeFakeUsers } from "./fake/users.js";
import { makeFakeWebhooks } from "./fake/webhooks.js";
import { makeFakeInvoices } from "./fake/invoices.js";
import { makeFakeTimeOff } from "./fake/time-off.js";
import { makeFakeHolidays } from "./fake/holidays.js";
import { makeFakeScheduling } from "./fake/scheduling.js";
import { makeFakeApprovals } from "./fake/approvals.js";
import { makeFakeReports } from "./fake/reports.js";
import { makeFakeAudit } from "./fake/audit.js";
import { makeFakeWorkspace } from "./fake/workspace.js";
import { makeFakeMiscRisky } from "./fake/misc-risky.js";

/**
 * In-memory fake of the Clockify WorkspaceClient port for deterministic tests.
 * Tracks per-method call counts so tests can assert "called once" / "not called".
 *
 * The implementation is split into one factory per feature area under
 * `tests/helpers/fake/`. Each `makeFake<Area>(ctx)` returns that area's methods
 * over the SHARED state + bump/nextId helpers; `createFakeWorkspace` composes
 * them into the single `WorkspaceClient` — mirroring how the real REST adapter
 * (`src/clockify/rest-workspace.ts`) spreads its per-area modules.
 */
export type { FakeWorkspaceSeed } from "./fake/state.js";

export interface FakeWorkspace {
  client: WorkspaceClient;
  counts: Record<string, number>;
  state: FakeState;
}

export function createFakeWorkspace(seed: FakeWorkspaceSeed = {}): FakeWorkspace {
  const state = createFakeState(seed);
  const counts: Record<string, number> = {};
  const bump = (method: string): void => {
    counts[method] = (counts[method] ?? 0) + 1;
  };
  const nextId = makeNextId();
  const ctx: FakeContext = { state, seed, bump, nextId };

  const client: WorkspaceClient = {
    // Per-area factories spread into the single port — same structure as
    // `createRestWorkspaceClient` in src/clockify/rest-workspace.ts.
    ...makeFakeTags(ctx),
    ...makeFakeClients(ctx),
    ...makeFakeProjects(ctx),
    ...makeFakeTasks(ctx),
    ...makeFakeTimeEntries(ctx),
    ...makeFakeExpenses(ctx),
    ...makeFakeCustomFields(ctx),
    ...makeFakeUsers(ctx),
    ...makeFakeWebhooks(ctx),
    ...makeFakeInvoices(ctx),
    ...makeFakeTimeOff(ctx),
    ...makeFakeHolidays(ctx),
    ...makeFakeScheduling(ctx),
    ...makeFakeApprovals(ctx),
    ...makeFakeReports(ctx),
    ...makeFakeAudit(ctx),
    ...makeFakeWorkspace(ctx),
    ...makeFakeMiscRisky(ctx),
  };

  return { client, counts, state };
}
