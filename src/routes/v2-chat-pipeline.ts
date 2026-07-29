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
import { deterministicGuardReply } from "./chat-guards.js";
import { createRunEventService } from "../services/run-event-service.js";
import { createRunEventViewService } from "../services/run-event-view-service.js";
import { createOperationPreparationService } from "../services/operation-preparation-service.js";
import { createClarificationService } from "../services/clarification-service.js";
import type { Installation } from "../db/store.js";
import { withRunScopedHostCallBudget } from "../clockify/request-governor.js";

/**
 * Closure-plan PR 6 (F04): the ONE persisted run ledger governs every v2
 * physical host call. Each charge is an atomic conditional store write
 * (`used + reserved < 60`) at the pre-dispatch boundary — it survives
 * clarification resume and process restart by construction, and call 61 is
 * denied before any fetch.
 */
function requestGovernorFor(deps: AppDeps, scope: RunScope & { runId: string }) {
  const assistantScope = {
    sessionId: scope.sessionId,
    runId: scope.runId,
    workspaceId: scope.workspaceId,
    adminUserId: scope.adminUserId,
    installationGeneration: scope.installationGeneration,
    authClass: scope.authClass,
  };
  return {
    runRead: async <T>(_readScope: RunScope, op: () => Promise<T>) =>
      withRunScopedHostCallBudget(op, {
        charge: () => deps.store.chargeRunHostCall(assistantScope),
        refund: () => deps.store.refundRunHostCall(assistantScope),
      }),
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
    preparations: {
      ...preparationService,
      // Preview-time target/support reads run under the SAME persisted run
      // ledger as ordinary reads (F04) — no unscoped 60-call fallthrough.
      prepare: (calls, prepareScope) => withRunScopedHostCallBudget(
        () => preparationService.prepare(calls, prepareScope),
        {
          charge: () => deps.store.chargeRunHostCall({ ...scope }),
          refund: () => deps.store.refundRunHostCall({ ...scope }),
        },
      ),
    },
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

export interface ClarificationResolutionResult {
  ok: boolean;
  status: number;
  code?: string;
  message?: string;
  page?: ReturnType<ReturnType<typeof createRunEventViewService>["list"]>;
}

/**
 * The clarification-resolve seam for the transport route (T16-F): owns the
 * installation/active-run lookups, per-request runner-dependency assembly, the
 * exact-option resolution, and the post-resolution event page. The route only
 * decodes, authorizes, calls this, and streams the returned frames.
 */
export function createClarificationResolutionPort(deps: AppDeps) {
  const eventViews = createRunEventViewService(deps.store, { sessionSecret: deps.config.sessionSecret, now: deps.now });
  return {
    async resolve(input: {
      claims: { sessionId: string; workspaceId: string; adminUserId: string; installationGeneration: number };
      clarificationId: string;
      optionId: string;
      signal?: AbortSignal;
    }): Promise<ClarificationResolutionResult> {
      const { claims } = input;
      const installation = deps.store.getInstallation(claims.workspaceId);
      if (!installation || installation.status !== "active") {
        return { ok: false, status: 404, code: "not_found", message: "No active installation for this workspace." };
      }
      const active = deps.store.getActiveRunForSession(claims.sessionId, claims.workspaceId, claims.adminUserId);
      if (!active) {
        return { ok: false, status: 404, code: "not_found", message: "No active run in this chat." };
      }
      const scope = {
        sessionId: claims.sessionId,
        workspaceId: claims.workspaceId,
        adminUserId: claims.adminUserId,
        installationGeneration: claims.installationGeneration,
        authClass: "addon" as const,
      };
      const runScope = { ...scope, runId: active.runId };
      const lastSequenceBefore = deps.store.getLastRunEventSequence(runScope);
      const runnerDeps = buildV2RunnerDependencies(deps, installation, runScope, input.signal);
      const clarificationService = createClarificationService({
        store: deps.store,
        registry: MODEL_API_ACTION_CATALOG,
        reads: runnerDeps.reads,
        preparations: runnerDeps.preparations,
        runner: {
          resume: (resumeInput: { runId: string; scope: RunScope; signal?: AbortSignal }) => runAssistantV2(
            { runId: resumeInput.runId, scope: resumeInput.scope, signal: resumeInput.signal },
            runnerDeps,
          ),
        },
      });
      const result = await clarificationService.resolveOption({
        clarificationId: input.clarificationId,
        scope,
        runId: active.runId,
        optionId: input.optionId,
        signal: input.signal,
      });
      if (!result.ok) {
        return { ok: false, status: result.status, code: result.code, message: result.message };
      }
      const page = eventViews.list({ scope, runId: active.runId, after: lastSequenceBefore, limit: 200 });
      return { ok: true, status: 200, page };
    },
  };
}

export type ClarificationResolutionPort = ReturnType<typeof createClarificationResolutionPort>;

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
        const lastSequenceBefore = deps.store.getLastRunEventSequence(continuationScope);
        const runnerDeps = buildV2RunnerDependencies(deps, installation, continuationScope, signal);
        const outcome = await runAssistantV2({
          runId: continuationRunId,
          scope,
          continuationMessage: message,
          signal,
        }, runnerDeps);
        const turn = settleV2Turn(deps, scope, newRequestId, outcome);
        return attachRunEventsPage(deps, scope, continuationRunId, lastSequenceBefore, turn);
      }

      // Persist the admin's message first (identity chain + faithful
      // transcript), then run the shared deterministic guards (F20): a
      // whitespace-only turn or bare typed consent never reaches the provider,
      // never supersedes a pending clarification, and never trips the
      // awaiting-confirmation refusal below — it settles a deterministic
      // answer through the same path a model reply uses.
      deps.store.beginClaimedTurnMessage({
        sessionId: claims.sessionId,
        workspaceId: claims.workspaceId,
        adminUserId: claims.adminUserId,
        requestId,
        content: message,
      });
      const guardReply = deterministicGuardReply(
        deps.store,
        claims,
        message,
        (deps.now?.() ?? new Date()).toISOString(),
      );
      if (guardReply !== undefined) {
        settleAssistantReplyBestEffort(deps, claims, requestId, guardReply, "answer", []);
        return { ok: true, replyKind: "answer", replyText: guardReply, results: [], resultLinks: [] };
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
          // Closure-plan PR 4 (F02): reconcile a LAPSED awaiting-confirmation
          // run before refusing. `listPendingConfirmations` sweeps expired
          // rows as a side effect; any live pending row for THIS run keeps
          // the refusal. With none left (expired, or settlement degraded
          // after a confirm), settle the run from its terminal confirmations
          // so the session can never be permanently wedged.
          const nowIso = (deps.now?.() ?? new Date()).toISOString();
          const live = deps.store.listPendingConfirmations(claims.sessionId, nowIso)
            .filter((row) => row.runId === active.runId);
          if (live.length > 0) {
            return {
              ok: false,
              code: "run_awaiting_confirmation",
              message: "A previous action is awaiting your confirmation. Confirm or cancel it before starting something new.",
            };
          }
          const lapsedScope = { ...scope, runId: active.runId };
          const lapsedState = deps.store.getRun(lapsedScope);
          const lapsedIds = lapsedState?.continuation.kind === "awaiting_operations"
            ? lapsedState.continuation.operationIds
            : [];
          let reconciled = false;
          for (const operationId of lapsedIds) {
            const operationRun = deps.store.getOperationRun(operationId);
            const record = operationRun?.confirmationId
              ? deps.store.getPendingConfirmation(operationRun.confirmationId)
              : undefined;
            if (!record) continue;
            const { settled } = deps.store.settleV2ConfirmationRun({
              record,
              kind: record.status === "pending" || record.status === "expired" ? "expired" : "confirmed",
              ...(record.actionResultId ? { actionResultId: record.actionResultId } : {}),
            });
            if (settled) {
              reconciled = true;
              break;
            }
          }
          if (!reconciled) {
            deps.store.failActiveRunsForSession(
              claims.sessionId,
              claims.workspaceId,
              claims.adminUserId,
              "confirmation_lapsed",
            );
          }
        }
        if (active.phase === "model" || active.phase === "discovering" ||
            active.phase === "executing_reads" || active.phase === "preparing_writes") {
          // Closure-plan PR 5 (F03): an ACTIVE phase surviving to the next
          // FIFO-serialized request is impossible for a healthy run — the
          // prior request died mid-flight. Fail it durably WITH its
          // `run.failed` event (never the eventless bulk update) so the
          // journal stays truthful and the new run can start.
          const strandedScope = { ...scope, runId: active.runId };
          const strandedState = deps.store.getRun(strandedScope);
          if (strandedState) {
            deps.store.failRunWithEvent(strandedScope, strandedState, { code: "stranded_active_run" });
          } else {
            deps.store.failActiveRunsForSession(
              claims.sessionId,
              claims.workspaceId,
              claims.adminUserId,
              "stranded_active_run",
            );
          }
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
          } else {
            // T14-T16 review gate HIGH-1: a run suspended awaiting_clarification
            // with NO live pending_clarifications row (e.g. the read-execution
            // producer gap, or a row that expired) can never be superseded by
            // the branch above, and `idx_assistant_runs_one_active_per_session`
            // would then reject every future run in this session. Fail the
            // orphaned run here so the session stays usable.
            deps.store.failActiveRunsForSession(
              claims.sessionId,
              claims.workspaceId,
              claims.adminUserId,
              "clarification_missing",
            );
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
        requestId,
        signal,
      }, runnerDeps);
      const turn = settleV2Turn(deps, scope, requestId, outcome);
      return attachRunEventsPage(deps, scope, runId, 0, turn);
    },
  };
}

/**
 * Deliver the turn's hydrated run-event page ON THE ORIGINAL TURN (closure-plan
 * PR 3 / F01's delivery half): canonical result cards and — when the run
 * suspended on a preview — the pending confirmation with its freshly rotated
 * one-use nonce. Best-effort: a hydration failure must never convert a settled
 * turn into an error.
 */
function attachRunEventsPage(
  deps: AppDeps,
  scope: RunScope,
  runId: string,
  after: number,
  turn: ChatTurnOutcome,
): ChatTurnOutcome {
  if (!turn.ok) return turn;
  try {
    const eventViews = createRunEventViewService(deps.store, {
      sessionSecret: deps.config.sessionSecret,
      now: deps.now,
    });
    const page = eventViews.list({ scope, runId, after, limit: 200 });
    return { ...turn, runEvents: page };
  } catch {
    console.error("run-event delivery degraded (reply preserved; error details suppressed)");
    return turn;
  }
}

/**
 * Best-effort assistant-reply settlement (mirrors v1's `persistAssistantReply`
 * isolation): the turn's real work already happened, so a transient persistence
 * failure must not convert a truthful reply into a 502.
 */
function settleAssistantReplyBestEffort(
  deps: AppDeps,
  claims: { sessionId: string; workspaceId: string; adminUserId: string },
  requestId: string | undefined,
  content: string,
  replyKind: string,
  orderedRefs: Array<
    | { kind: "action_result"; id: string }
    | { kind: "confirmation"; confirmationId: string }
  >,
): void {
  try {
    deps.store.settleAssistantTurnMessage({
      sessionId: claims.sessionId,
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      requestId,
      content,
      payload: { kind: replyKind },
      orderedRefs,
    });
  } catch {
    // Driver errors can contain SQL values or serialized payloads.
    console.error("assistant-turn settlement failed (turn already executed; reply preserved; error details suppressed)");
  }
}

/**
 * Settle a v2 outcome into the durable transcript (closure-plan PR 2, the
 * transcript half of F01): persist the assistant reply exactly once with its
 * ordered canonical result links, then return the HTTP turn shape. Failed
 * outcomes pass through unchanged (fault settlement is PR 5's seam).
 */
function settleV2Turn(
  deps: AppDeps,
  claims: { sessionId: string; workspaceId: string; adminUserId: string },
  requestId: string | undefined,
  outcome: Awaited<ReturnType<typeof runAssistantV2>>,
): ChatTurnOutcome {
  const turn = v2OutcomeToTurn(outcome);
  if (!turn.ok) return turn;
  const orderedRefs: Array<
    | { kind: "action_result"; id: string }
    | { kind: "confirmation"; confirmationId: string }
  > = outcome.presentationRefs
    .filter((ref): ref is { kind: "action_result"; id: string } => ref.kind === "action_result")
    .map((ref) => ({ kind: "action_result" as const, id: ref.id }));
  if (outcome.kind === "suspended" && outcome.reason === "awaiting_confirmation") {
    // `continuationId` is the confirmation id on a fresh suspension; a resumed
    // short-circuit can carry an operation id instead, so link only a value
    // that names a real confirmation.
    const record = deps.store.getPendingConfirmation(outcome.continuationId);
    if (record) orderedRefs.push({ kind: "confirmation", confirmationId: record.id });
  }
  settleAssistantReplyBestEffort(deps, claims, requestId, turn.replyText, turn.replyKind, orderedRefs);
  return turn;
}

function v2OutcomeToTurn(outcome: Awaited<ReturnType<typeof runAssistantV2>>): ChatTurnOutcome {
  if (outcome.kind === "completed") {
    return {
      ok: true,
      replyKind: "final",
      // The model's own answer, when it produced one. A read's answer IS the
      // deliverable, and substituting "Completed." unconditionally made a run
      // that really executed and really answered look like it did nothing.
      // The fallback stays for a completion with no prose (e.g. a resumed run
      // short-circuiting on an already-terminal phase).
      replyText: outcome.replyText ?? "Completed.",
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
