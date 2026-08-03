import type { ModelMessage, ToolDefinition } from "../assistant/model-client.js";
import { DISCOVERY_META_TOOL_NAME } from "../harness/api-operation.js";
import {
  chargeFailedModelAttempt,
  chargeSuccessfulModelAttempt,
  preflightModelRequest,
  serializeModelRequestForPreflight,
  utf8ByteLength,
} from "../assistant-v2/budgets.js";
import { buildResumeUserMessage, buildV2SystemPrompt } from "../assistant-v2/prompt.js";
import type {
  NativeToolModelClient,
  RunOutcome,
  RunnerDependencies,
  RunScope,
} from "../assistant-v2/protocol.js";
import type { RunState } from "../assistant-v2/state.js";

/**
 * RunService (T16-C): the model-call machinery and run lifecycle transitions
 * extracted from `runner.ts`. It owns budget preflight/charging around one
 * provider call, the durable model events, and the terminal/suspension outcome
 * builders. It has no Express, no discovery, and no tool execution: those seams
 * live in `api-discovery-service.ts` and `action-execution-service.ts`.
 */
export type RunServiceDeps = Pick<
  RunnerDependencies,
  "modelClient" | "eventService" | "runStore" | "clock"
> & Pick<RunnerDependencies, "priorMessages">;

/** The scoped identity every store/event call keys on — never a bare runId. */
export function scopedRun(state: RunState): RunScope & { runId: string } {
  return {
    sessionId: state.sessionId,
    workspaceId: state.workspaceId,
    adminUserId: state.adminUserId,
    installationGeneration: state.installationGeneration,
    authClass: state.authClass,
    runId: state.runId,
  };
}

function serializeToolsForPreflight(tools: ToolDefinition[]): string {
  return JSON.stringify(tools);
}

function serializeMessagesForPreflight(messages: ModelMessage[]): string {
  return JSON.stringify(messages);
}

export function createRunService(deps: RunServiceDeps) {
  function lastSequence(state: RunState): number {
    return deps.runStore.getLastRunEventSequence(scopedRun(state));
  }

  function budgetStopOutcome(state: RunState, code: string): RunOutcome {
    return {
      kind: "failed",
      runId: state.runId,
      lastSequence: lastSequence(state),
      code,
      presentationRefs: state.completedResults.map((r) => ({ kind: "action_result", id: r.actionResultId })),
    };
  }

  function suspendOutcome(
    state: RunState,
    reason: "awaiting_confirmation" | "awaiting_clarification",
    continuationId: string,
  ): RunOutcome {
    return {
      kind: "suspended",
      runId: state.runId,
      lastSequence: lastSequence(state),
      reason,
      continuationId,
      presentationRefs: state.completedResults.map((r) => ({ kind: "action_result", id: r.actionResultId })),
    };
  }

  /** The model's own final answer is bounded before it leaves the runner:
   * it is admin-visible prose, not a tool result, and nothing downstream
   * re-checks its size. */
  const MAX_REPLY_BYTES = 8_000;

  function boundedReply(replyText: string | undefined): string | undefined {
    if (replyText === undefined) return undefined;
    const trimmed = replyText.trim();
    if (trimmed.length === 0) return undefined;
    const buffer = Buffer.from(trimmed, "utf8");
    if (buffer.byteLength <= MAX_REPLY_BYTES) return trimmed;
    return new TextDecoder("utf-8").decode(buffer.subarray(0, MAX_REPLY_BYTES)).replace(/\uFFFD$/, "");
  }

  function completeOutcome(state: RunState, replyText?: string): RunOutcome {
    return {
      kind: "completed",
      runId: state.runId,
      lastSequence: lastSequence(state),
      presentationRefs: state.completedResults.map((r) => ({ kind: "action_result", id: r.actionResultId })),
      ...(boundedReply(replyText) === undefined ? {} : { replyText: boundedReply(replyText) }),
    };
  }

  function failRun(state: RunState, code: string): RunOutcome {
    deps.eventService.failRun({
      scope: scopedRun(state),
      state,
      payload: { code },
    });
    state = deps.runStore.getRun(scopedRun(state)) ?? state;
    return budgetStopOutcome(state, code);
  }

  function completeRun(state: RunState, chatMessageId?: string, replyText?: string): RunOutcome {
    deps.eventService.completeRun({
      scope: scopedRun(state),
      state,
      payload: {
        chatMessageId,
        actionResultIds: state.completedResults.map((r) => r.actionResultId),
      },
    });
    state = deps.runStore.getRun(scopedRun(state)) ?? state;
    return completeOutcome(state, replyText);
  }

  /** A run's model input is always rebuilt fresh — never a persisted provider
   * transcript. Resume summaries and the admin's clarification follow-up are
   * surfaced only on the first model call of a resumed invocation. */
  /**
   * v2 shipped with NO conversation history: this returned exactly
   * `[system, currentRequest]`, so every admin message started a run that knew
   * nothing about any previous turn. In one observed session the assistant
   * listed a single time entry by id, and the very next message — "UPDATE THE
   * DESCRIPTION TO 'DESC'" — was answered with "doesn't specify which entity";
   * a following "both.." got "Could you clarify what you'd like me to do?".
   * Neither is a model failure. It was never shown the turn it was continuing.
   *
   * `priorMessages` is the bounded, already-sanitized window (the caller owns
   * the window size, the transient-error filter, and the stored-reply rewrite,
   * exactly as v1's `buildModelHistory` does). It sits between the system
   * prompt and the current request so the request stays LAST and is
   * unambiguously the thing being answered.
   */
  function buildFreshMessages(state: RunState, resumeSummaries: string[] = [], adminFollowUp?: string): ModelMessage[] {
    const userContent = resumeSummaries.length > 0 || adminFollowUp
      ? buildResumeUserMessage({
          originalRequest: state.originalRequest,
          structuredSummaries: resumeSummaries,
          adminFollowUp,
        })
      : state.originalRequest;
    return [
      { role: "system", content: buildV2SystemPrompt() },
      ...(deps.priorMessages ?? []),
      { role: "user", content: userContent },
    ];
  }

  async function callModel(
    state: RunState,
    messages: ModelMessage[],
    tools: ToolDefinition[],
    modelCall: number,
    signal?: AbortSignal,
  ): Promise<{ completion: Awaited<ReturnType<NativeToolModelClient["completeWithTools"]>>; providerAttempts: 1 | 2; latencyMs: number }> {
    const requestBytes = serializeModelRequestForPreflight(
      serializeMessagesForPreflight(messages),
      serializeToolsForPreflight(tools),
    );
    const preflight = preflightModelRequest(state.budget, requestBytes);
    if (!preflight.ok) throw new Error("token_budget_exhausted");
    let providerAttempts: 1 | 2 = 1;
    // F10: a FAILED provider attempt charges its conservative reservation
    // exactly once, durably — attempt 2's start records attempt 1's failure
    // BEFORE its own model.started, and a both-fail call charges both.
    let attempt1FailureCharged = false;
    const chargeAttemptFailure = (once: boolean): void => {
      if (once && attempt1FailureCharged) return;
      attempt1FailureCharged = true;
      const fresh = deps.runStore.getRun(scopedRun(state)) ?? state;
      fresh.budget = chargeFailedModelAttempt(fresh.budget, preflight.inputReserve, preflight.maxOutputTokens);
      deps.runStore.saveRun({ ...fresh, updatedAt: new Date().toISOString() });
      state = fresh;
    };
    deps.eventService.reserveModelCall({
      scope: scopedRun(state),
      state,
      payload: {
        modelCall,
        providerAttempt: 1,
        loadedOperationIds: state.loadedToolNames.filter((n) => n !== DISCOVERY_META_TOOL_NAME),
        cacheSeeded: state.usedToolNames.length > 0,
      },
    });
    state = deps.runStore.getRun(scopedRun(state)) ?? state;
    const started = deps.clock.monotonicMs();
    try {
      const completion = await deps.modelClient.completeWithTools(messages, tools, signal, {
        maxOutputTokens: preflight.maxOutputTokens,
        onProviderAttempt: (attempt) => {
          if (attempt === 2 && providerAttempts === 1) {
            providerAttempts = 2;
            chargeAttemptFailure(true);
            deps.eventService.reserveModelCall({
              scope: scopedRun(state),
              state: deps.runStore.getRun(scopedRun(state)) ?? state,
              payload: {
                modelCall,
                providerAttempt: 2,
                loadedOperationIds: state.loadedToolNames.filter((n) => n !== DISCOVERY_META_TOOL_NAME),
                cacheSeeded: state.usedToolNames.length > 0,
              },
            });
          }
        },
      });
      const responseBytes = utf8ByteLength(JSON.stringify(completion));
      state = deps.runStore.getRun(scopedRun(state)) ?? state;
      // F10: usage is accepted only when every value is a finite nonnegative
      // safe integer; anything else falls back to the conservative estimate.
      const usage = completion.usage;
      const safeUsage = usage &&
        Number.isSafeInteger(usage.promptTokens) && usage.promptTokens >= 0 &&
        Number.isSafeInteger(usage.completionTokens) && usage.completionTokens >= 0
        ? { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens }
        : undefined;
      state.budget = chargeSuccessfulModelAttempt(
        state.budget,
        safeUsage,
        requestBytes,
        responseBytes,
      );
      const latencyMs = deps.clock.monotonicMs() - started;
      deps.eventService.completeModelCall({
        scope: scopedRun(state),
        state,
        payload: {
          modelCall,
          providerAttempts,
          usage: {
            promptTokens: completion.usage?.promptTokens,
            completionTokens: completion.usage?.completionTokens,
          },
          latencyMs,
        },
      });
      state = deps.runStore.getRun(scopedRun(state)) ?? state;
      return { completion, providerAttempts, latencyMs };
    } catch (error) {
      state = deps.runStore.getRun(scopedRun(state)) ?? state;
      if (providerAttempts === 1) {
        // Attempt 1 failed with no retry.
        state.budget = chargeFailedModelAttempt(state.budget, preflight.inputReserve, preflight.maxOutputTokens);
      } else {
        // Both attempts failed: attempt 1 was charged at attempt 2's start;
        // charge attempt 2's failure too (F10 — previously NEITHER was).
        chargeAttemptFailure(false);
      }
      throw error;
    } finally {
      state = deps.runStore.getRun(scopedRun(state)) ?? state;
      state.budget = {
        ...state.budget,
        activeWallMsUsed: state.budget.activeWallMsUsed + (deps.clock.monotonicMs() - started),
      };
      deps.runStore.saveRun({ ...state, updatedAt: new Date().toISOString() });
    }
  }

  return {
    budgetStopOutcome,
    suspendOutcome,
    completeOutcome,
    failRun,
    completeRun,
    buildFreshMessages,
    callModel,
  };
}

export type RunService = ReturnType<typeof createRunService>;
