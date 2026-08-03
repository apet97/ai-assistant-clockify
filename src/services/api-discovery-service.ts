import type { ToolCall } from "../assistant/model-client.js";
import { DISCOVERY_META_TOOL_NAME } from "../harness/api-operation.js";
import {
  initialV2ToolSet,
  parseFindApiOperationsInput,
  refineLoadedToolSet,
} from "../assistant-v2/discovery/api-search-tool.js";
import { canReserveDiscoveryCall } from "../assistant-v2/budgets.js";
import type { RunnerDependencies, RunScope } from "../assistant-v2/protocol.js";
import type { RunState } from "../assistant-v2/state.js";
import type { RunObservation } from "../assistant-v2/observations.js";
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
 * unused ones, else the registry's initial set.
 *
 * Readiness-plan A2 (defect D-1): only READ operations may cross the turn
 * boundary. Reads are idempotent and re-caching them is the latency win; a
 * WRITE seeded from a prior turn let the model skip discovery and reach a
 * prepared `clockify_stop_timer` on a turn that asked for a time entry. Every
 * write must be rediscovered against the current turn's own words — an
 * unseeded write call is denied `tool_not_loaded` and that denial feeds the
 * next model request in the same run, so the model searches and recovers
 * in-turn. The predicate is `apiOperation?.access === "read"`, the exact
 * classifier `partitionToolCalls` uses (`isReadAction`/`isWriteAction`,
 * action-execution-service.ts), where unknown access grades as write — so the
 * seed filter and the partitioner can never disagree about what a write is. */
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
  const ordered = [...used, ...unused]
    .filter((name, index, all) => all.indexOf(name) === index)
    .filter((name) => registry.get(name)?.apiOperation?.access === "read");
  return initialV2ToolSet(registry, ordered);
}

/**
 * Discovery never fails a run.
 *
 * Exceeding `maxDiscoveryCalls` used to return a fatal outcome that the runner
 * turned into `run.failed: too_many_refinements`, destroying the turn along
 * with every tool already loaded and every result already produced. Every other
 * budget in v2 — reads, writes, validation — denies the individual call and
 * lets the run continue, and discovery is the least destructive of them: the
 * model can simply use the operations it already has. The over-budget search is
 * now denied, journaled, and reported back so the model stops searching.
 */
export type DiscoveryBatchResult = { kind: "ok"; state: RunState; observations: RunObservation[] };

export function createApiDiscoveryService(deps: ApiDiscoveryDeps) {
  async function executeDiscoveryBatch(
    state: RunState,
    discoveryCalls: ToolCall[],
    scope: RunScope,
  ): Promise<DiscoveryBatchResult> {
    let searchIndex = state.budget.discoveryCallsUsed;
    const observations: RunObservation[] = [];
    for (const call of discoveryCalls) {
      if (!canReserveDiscoveryCall(state.budget)) {
        deps.eventService.denyTool({
          scope: scopedRun(state),
          state,
          payload: {
            toolCallId: call.id,
            actionName: call.name,
            code: "too_many_refinements",
          },
        });
        state = deps.runStore.getRun(scopedRun(state)) ?? state;
        observations.push({
          kind: "denied",
          actionName: call.name,
          code: "too_many_refinements",
        });
        continue;
      }
      // Closure-plan PR 7 (F18): the runtime — not the provider — is the
      // trust boundary for the one always-loaded tool. Every discovery call
      // goes through the canonical strict parser; invalid input produces a
      // bounded denial and NO search, and the full parsed object (query,
      // access, groups, limit) is forwarded and journaled exactly.
      let parsed;
      try {
        parsed = parseFindApiOperationsInput(call.arguments);
      } catch {
        deps.eventService.denyTool({
          scope: scopedRun(state),
          state,
          payload: { toolCallId: call.id, actionName: call.name, code: "invalid_args" },
        });
        state = deps.runStore.getRun(scopedRun(state)) ?? state;
        observations.push({ kind: "denied", actionName: call.name, code: "invalid_args" });
        continue;
      }
      searchIndex += 1;
      deps.eventService.reserveDiscoveryCall({
        scope: scopedRun(state),
        state,
        payload: {
          searchIndex,
          access: parsed.access ?? "any",
          groups: [...(parsed.groups ?? [])],
        },
      });
      state = deps.runStore.getRun(scopedRun(state)) ?? state;
      const searchResult = await deps.discovery.search(parsed, scope);
      const loadedBefore = new Set(state.loadedToolNames);
      state.loadedToolNames = [
        ...refineLoadedToolSet(new Set(state.loadedToolNames), new Set(state.usedToolNames), searchResult),
      ];
      // A successful search used to push NO observation, so the model's only
      // feedback was the operation list itself — identical every time it
      // re-ran the same query, and therefore indistinguishable from new
      // information. Production run 562f149d spent two of its four searches
      // re-fetching an unchanged set that already contained everything the
      // request needed, then died on `too_many_refinements`. Say what the
      // search actually CHANGED.
      const added = state.loadedToolNames.filter(
        (name) => name !== DISCOVERY_META_TOOL_NAME && !loadedBefore.has(name),
      );
      observations.push({
        kind: "result",
        actionName: call.name,
        summary: added.length > 0
          ? `loaded ${added.length} new operation(s): ${added.join(", ")}.`
          : "no new operations — every match was already loaded."
            + " Searching again with a similar query will return the same set and waste the search budget;"
            + " call the operations you already have instead.",
      });
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
    return { kind: "ok", state, observations };
  }

  return { executeDiscoveryBatch };
}

export type ApiDiscoveryService = ReturnType<typeof createApiDiscoveryService>;
