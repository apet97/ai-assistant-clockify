import { randomUUID } from "node:crypto";
import type { AppDeps } from "./deps.js";
import type { ChatPipeline, ChatTurnOutcome } from "./chat-pipeline.js";
import { createChatPipeline } from "./chat-pipeline.js";
import { runAssistantV2 } from "../assistant-v2/runner.js";
import { createReadExecutionPort } from "../assistant-v2/read-execution.js";
import { MODEL_API_ACTION_CATALOG } from "../harness/api-catalog.js";
import {
  assertNativeToolClient,
  type NativeToolModelClient,
  type RunnerDependencies,
  type RunScope,
} from "../assistant-v2/protocol.js";
import { runDiscoverySearch } from "../assistant-v2/discovery/api-search-tool.js";
import { createRunEventService } from "../services/run-event-service.js";
import { createRunEventViewService } from "../services/run-event-view-service.js";
import { createOperationPreparationService } from "../services/operation-preparation-service.js";
import type { Installation } from "../db/store.js";
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

/**
 * The one place that assembles `runAssistantV2`'s full dependency set for a
 * given installation/scope. Used by the chat pipeline (starts/continues a turn)
 * and by the clarification-resolve route (resumes a suspended run) so both
 * construct the identical read/write/discovery/governor wiring.
 */
export function buildV2RunnerDependencies(
  deps: AppDeps,
  installation: Installation,
  scope: RunScope & { runId: string },
  signal?: AbortSignal,
): RunnerDependencies {
  const eventService = createRunEventService(deps.store);
  const eventViews = createRunEventViewService(deps.store, { sessionSecret: deps.config.sessionSecret, now: deps.now });
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
  return {
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
        const current = deps.store.getInstallation(installation.workspaceId);
        if (!current || current.status !== "active" || current.generation !== installation.generation) {
          throw new Error("installation_not_current");
        }
      },
    },
    requestGovernor: requestGovernorFor(deps, scope),
    // `model.completed`'s `latencyMs` is a strict integer (events.ts); round the
    // fractional `performance.now()` reading here rather than at every call site.
    clock: { now: () => new Date(), monotonicMs: () => Math.round(performance.now()) },
  };
}

/** V2 chat pipeline: native-tool runner only — never falls through to v1 planner. */
export function createV2RunnerPipeline(deps: AppDeps): ChatPipeline {
  const controlPlane = createChatPipeline(deps);
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
      continuationRunId,
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
      const scope = {
        sessionId: claims.sessionId,
        workspaceId: claims.workspaceId,
        adminUserId: claims.adminUserId,
        installationGeneration: installation.generation,
        authClass: "addon" as const,
      };

      // T14-E: an explicit continuationRunId resumes the exact scoped run's
      // single `pending` clarification with admin-authored free text — never
      // an implicit "latest clarification" and never a second assistant run.
      if (continuationRunId) {
        const continuationScope = { ...scope, runId: continuationRunId };
        const clarification = deps.store.getActiveClarificationForRun(continuationScope);
        if (!clarification || clarification.status !== "pending") {
          return {
            ok: false,
            code: "clarification_not_pending",
            message: "That clarification is no longer pending.",
          };
        }
        const newRequestId = requestId ?? randomUUID();
        try {
          deps.store.continueClarificationWithFreeTextAndLink({
            clarificationId: clarification.id,
            scope: continuationScope,
            requestId: newRequestId,
            messageContent: message,
          });
        } catch (error) {
          return {
            ok: false,
            code: error instanceof Error ? error.message : "clarification_continuation_failed",
            message: "That clarification could not be continued.",
          };
        }
        const runnerDeps = buildV2RunnerDependencies(deps, installation, continuationScope, signal);
        const outcome = await runAssistantV2({
          runId: continuationRunId,
          scope,
          continuationMessage: message,
          signal,
        }, runnerDeps);
        return v2OutcomeToTurn(outcome);
      }

      // New-run supersession: a session has at most one nonterminal run
      // (`idx_assistant_runs_one_active_per_session`). An ordinary new message
      // while that run awaits clarification supersedes it (cancelled +
      // superseded, run failed). While it awaits confirmation, refuse instead
      // of guessing a cancellation path for a pending write preview (T16-C/E
      // own building that safely) — the admin must confirm or cancel it first.
      const active = deps.store.getActiveRunForSession(claims.sessionId, claims.workspaceId, claims.adminUserId);
      if (active) {
        if (active.phase === "awaiting_confirmation") {
          return {
            ok: false,
            code: "run_awaiting_confirmation",
            message: "A previous action is awaiting your confirmation. Confirm or cancel it before starting something new.",
          };
        }
        if (active.phase === "awaiting_clarification") {
          const activeScope = { ...scope, runId: active.runId };
          const clarification = deps.store.getActiveClarificationForRun(activeScope);
          const activeState = deps.store.getRun(activeScope);
          if (clarification && activeState) {
            deps.store.supersedeClarificationForNewRun({
              clarificationId: clarification.id,
              scope: activeScope,
              state: activeState,
            });
          }
        }
      }

      // A fresh v2 run's own identity is always independently minted — it
      // must never equal the HTTP request's `requestId`. `chatPreconditions`
      // already claims a `turn_runs` row for `requestId`; `runAssistantV2`'s
      // `eventService.startRun` claims its OWN `turn_runs`/
      // `assistant_run_request_links` row keyed on `runId` (kind='initial',
      // request_id=run_id — a self-referential link, not the HTTP request).
      // Reusing `requestId` here collided both claims on the same primary key
      // (only reachable once a real HTTP turn drove a fresh v2 run end to end,
      // which no test did before T14-E).
      const runId = randomUUID();
      const runnerDeps = buildV2RunnerDependencies(deps, installation, { ...scope, runId }, signal);
      const outcome = await runAssistantV2({
        runId,
        scope,
        originalRequest: message,
        signal,
      }, runnerDeps);
      return v2OutcomeToTurn(outcome);
    },
  };
}

function v2OutcomeToTurn(outcome: Awaited<ReturnType<typeof runAssistantV2>>): ChatTurnOutcome {
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
}
