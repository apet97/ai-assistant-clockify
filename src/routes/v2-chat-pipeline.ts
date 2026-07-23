import { randomUUID } from "node:crypto";
import type { AppDeps } from "./deps.js";
import type { ChatPipeline, ChatTurnOutcome } from "./chat-pipeline.js";
import { createChatPipeline } from "./chat-pipeline.js";
import { runAssistantV2 } from "../assistant-v2/runner.js";
import { createReadExecutionPort } from "../assistant-v2/read-execution.js";
import { MODEL_API_ACTION_CATALOG } from "../harness/api-catalog.js";
import { assertNativeToolClient, type NativeToolModelClient, type RunScope } from "../assistant-v2/protocol.js";
import { runDiscoverySearch } from "../assistant-v2/discovery/api-search-tool.js";
import { createRunEventService } from "../services/run-event-service.js";
import { createRunEventViewService } from "../services/run-event-view-service.js";
import { createOperationPreparationService } from "../services/operation-preparation-service.js";
import {
  persistRunHostCallAllowance,
  remainingHostCallsFromRunBudget,
  withHostCallBudgetFromUsed,
} from "../clockify/request-governor.js";

function requestGovernorFor(deps: AppDeps, scope: RunScope & { runId: string }) {
  const run = deps.store.getRun({
    sessionId: scope.sessionId,
    runId: scope.runId,
    workspaceId: scope.workspaceId,
    adminUserId: scope.adminUserId,
    installationGeneration: scope.installationGeneration,
    authClass: scope.authClass,
  });
  const budget = run?.budget ?? { hostCallsUsed: 0, hostCallsReserved: 0 };
  return {
    runRead: async <T>(_readScope: RunScope, op: () => Promise<T>) =>
      withHostCallBudgetFromUsed(op, budget.hostCallsUsed, remainingHostCallsFromRunBudget(budget) + budget.hostCallsUsed),
    remainingHostCalls: () => remainingHostCallsFromRunBudget(budget),
    persistHostCallAllowance: (_readScope: RunScope, remaining: number) => {
      if (!run) return;
      deps.store.saveRun({
        ...run,
        budget: {
          ...run.budget,
          ...persistRunHostCallAllowance(run.budget, remaining),
        },
      });
    },
  };
}

/** V2 chat pipeline: native-tool runner only — never falls through to v1 planner. */
export function createV2RunnerPipeline(deps: AppDeps): ChatPipeline {
  const controlPlane = createChatPipeline(deps);
  const eventService = createRunEventService(deps.store);
  const eventViews = createRunEventViewService(deps.store, { sessionSecret: deps.config.sessionSecret, now: deps.now });
  return {
    ...controlPlane,
    runResume: async () => undefined,
    executeChatTurn: async (
      claims,
      installation,
      message,
      _onResult,
      _onStatus,
      signal,
      requestId,
    ): Promise<ChatTurnOutcome> => {
      try {
        assertNativeToolClient(deps.modelClient as NativeToolModelClient);
      } catch {
        return {
          ok: false,
          code: "model_unavailable",
          message: "Assistant engine v2 requires a native tool-calling model client.",
        };
      }
      const runId = requestId ?? randomUUID();
      const scope = {
        sessionId: claims.sessionId,
        workspaceId: claims.workspaceId,
        adminUserId: claims.adminUserId,
        installationGeneration: installation.generation,
        authClass: "addon" as const,
      };
      const preparationService = createOperationPreparationService({
        store: deps.store,
        registry: MODEL_API_ACTION_CATALOG,
        sessionSecret: deps.config.sessionSecret,
        clockifyForScope: () => deps.clockifyForWorkspace(installation, { signal }),
        now: deps.now,
        getAdminPolicy: (workspaceId, adminUserId) => deps.store.getAdminPolicy(workspaceId, adminUserId),
        loadCalendarContext: async (readScope) => {
          try {
            return (await deps.clockifyForWorkspace(installation, { signal }).getCalendarContext(readScope.adminUserId)) ?? {};
          } catch {
            return {};
          }
        },
      });
      const outcome = await runAssistantV2({
        runId,
        scope,
        originalRequest: message,
        signal,
      }, {
        modelClient: deps.modelClient as NativeToolModelClient,
        runStore: deps.store,
        eventStore: deps.store,
        eventService,
        eventViews,
        actionRegistry: MODEL_API_ACTION_CATALOG,
        discovery: {
          search: async (input, discoveryScope) => {
            if (!deps.apiOperationIndex) {
              return { kind: "notice", code: "no_available_operation_for_auth_class", authClass: discoveryScope.authClass };
            }
            return runDiscoverySearch(deps.apiOperationIndex, input, discoveryScope.authClass);
          },
        },
        reads: createReadExecutionPort({
          registry: MODEL_API_ACTION_CATALOG,
          store: deps.store,
          clockifyForScope: () => deps.clockifyForWorkspace(installation, { signal }),
          now: deps.now,
          loadCalendarContext: async (readScope) => {
            try {
              return (await deps.clockifyForWorkspace(installation, { signal }).getCalendarContext(readScope.adminUserId)) ?? {};
            } catch {
              return {};
            }
          },
        }),
        preparations: preparationService,
        installationGuard: {
          assertCurrent: () => {
            const current = deps.store.getInstallation(claims.workspaceId);
            if (!current || current.status !== "active" || current.generation !== installation.generation) {
              throw new Error("installation_not_current");
            }
          },
        },
        requestGovernor: requestGovernorFor(deps, { ...scope, runId }),
        clock: { now: () => new Date(), monotonicMs: () => performance.now() },
      });

      if (outcome.kind === "completed") {
        return {
          ok: true,
          replyKind: "final",
          replyText: "Completed.",
          results: [],
          resultLinks: [],
        };
      }
      if (outcome.kind === "suspended") {
        return {
          ok: true,
          replyKind: "preview",
          replyText: outcome.reason === "awaiting_confirmation"
            ? "Review the preview and click Confirm."
            : "Choose a clarification option to continue.",
          results: [],
          resultLinks: [],
        };
      }
      return {
        ok: false,
        code: outcome.code,
        message: `Assistant run failed: ${outcome.code}`,
      };
    },
  };
}
