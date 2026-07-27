import type { ToolCall } from "../assistant/model-client.js";
import { DISCOVERY_META_TOOL_NAME } from "../harness/api-operation.js";
import {
  initialV2ToolSet,
  refineLoadedToolSet,
} from "../assistant-v2/discovery/api-search-tool.js";
import { canReserveDiscoveryCall } from "../assistant-v2/budgets.js";
import type { RunnerDependencies, RunScope } from "../assistant-v2/protocol.js";
import type { RunState } from "../assistant-v2/state.js";
import type { ActionRegistry } from "../harness/api-catalog.js";
import { scopedRun } from "./run-service.js";

/**
 * ApiDiscoveryService (T16-C): the discovery-refinement seam extracted from
 * `runner.ts`. It owns the exact-scope cache seed and the bounded discovery
 * batch (reserve → search → refine loaded set → durable operations event). It
 * never executes an API operation and never sees a write port.
 */
export type ApiDiscoveryDeps = Pick<
  RunnerDependencies,
  "discovery" | "eventService" | "runStore"
>;

/** Seed a fresh run's loaded tool set from the latest catalog-compatible prior
 * run in the same exact scope: most-recently-used tools first, then loaded but
 * unused ones, else the registry's initial set. */
export function seedCacheFromPriorRun(
  registry: ActionRegistry,
  prior: RunState | undefined,
  currentCatalogHash: string,
): ReadonlySet<string> {
  if (!prior || prior.registryId !== "v2-api" || prior.catalogHash !== currentCatalogHash) {
    return initialV2ToolSet(registry);
  }
  const used = [...prior.usedToolNames].reverse();
  const unused = prior.loadedToolNames.filter((name) => !prior.usedToolNames.includes(name));
  const ordered = [...used, ...unused].filter((name, index, all) => all.indexOf(name) === index);
  return initialV2ToolSet(registry, ordered);
}

export type DiscoveryBatchResult =
  | { kind: "ok"; state: RunState }
  | { kind: "budget_exhausted"; code: "too_many_refinements"; state: RunState };

export function createApiDiscoveryService(deps: ApiDiscoveryDeps) {
  async function executeDiscoveryBatch(
    state: RunState,
    discoveryCalls: ToolCall[],
    scope: RunScope,
  ): Promise<DiscoveryBatchResult> {
    let searchIndex = state.budget.discoveryCallsUsed;
    for (const call of discoveryCalls) {
      if (!canReserveDiscoveryCall(state.budget)) {
        return { kind: "budget_exhausted", code: "too_many_refinements", state };
      }
      searchIndex += 1;
      const parsed = call.arguments as { query?: string; access?: "read" | "write" | "any" };
      deps.eventService.reserveDiscoveryCall({
        scope: scopedRun(state),
        state,
        payload: {
          searchIndex,
          access: parsed.access ?? "any",
          groups: [],
        },
      });
      state = deps.runStore.getRun(scopedRun(state)) ?? state;
      const searchResult = await deps.discovery.search({ query: String(parsed.query ?? "") }, scope);
      state.loadedToolNames = [
        ...refineLoadedToolSet(new Set(state.loadedToolNames), new Set(state.usedToolNames), searchResult),
      ];
      if (!state.usedToolNames.includes(call.name)) state.usedToolNames.push(call.name);
      deps.eventService.loadOperations({
        scope: scopedRun(state),
        state,
        payload: {
          operationIds: state.loadedToolNames.filter((n) => n !== DISCOVERY_META_TOOL_NAME),
          source: "discovery",
        },
      });
      state = deps.runStore.getRun(scopedRun(state)) ?? state;
    }
    return { kind: "ok", state };
  }

  return { executeDiscoveryBatch };
}

export type ApiDiscoveryService = ReturnType<typeof createApiDiscoveryService>;
