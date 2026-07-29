import type { WorkspaceClient } from "../../src/clockify/client.js";
import { AsyncLocalStorage } from "node:async_hooks";
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
import { beginScopedMutationDispatchForTest } from "../../src/clockify/rest/core.js";

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

const nestedFakeMutation = new AsyncLocalStorage<boolean>();

/** The one definition of "this WorkspaceClient method mutates Clockify" — used by
 * the dispatch proxy below and by the production-composition harness's mutation
 * counter, so the two can never disagree about what counts as a write. */
export const FAKE_MUTATION_METHOD_PATTERN =
  /^(?:add|archive|create|deactivate|delete|import|invite|mark|publish|remove|resubmit|set|start|stop|submit|update)/;

export function createFakeWorkspace(seed: FakeWorkspaceSeed = {}): FakeWorkspace {
  // One independent object graph backs both mutable state and every factory's
  // failure/list control reads. No factory can mutate the caller's seed or a
  // later cohort through a shared nested object.
  const isolatedSeed = structuredClone(seed);
  const state = createFakeState(isolatedSeed);
  const counts: Record<string, number> = {};
  const bump = (method: string): void => {
    counts[method] = (counts[method] ?? 0) + 1;
  };
  const nextId = makeNextId();
  const ctx: FakeContext = { state, seed: isolatedSeed, bump, nextId };

  const rawClient: WorkspaceClient = {
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

  const mutationMethod = FAKE_MUTATION_METHOD_PATTERN;
  const client = new Proxy(rawClient, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== "string" || typeof value !== "function" || !mutationMethod.test(property)) {
        return value;
      }
      return async (...args: unknown[]) => {
        if (nestedFakeMutation.getStore()) {
          return (value as (...methodArgs: unknown[]) => unknown).apply(target, args);
        }
        await beginScopedMutationDispatchForTest();
        return nestedFakeMutation.run(true, () =>
          (value as (...methodArgs: unknown[]) => unknown).apply(target, args));
      };
    },
  }) as WorkspaceClient;

  return { client, counts, state };
}
