/**
 * The deps-capturing chat turn / confirm / commit pipeline (extracted from
 * api.ts, plan 007 Phase B).
 *
 * `createChatPipeline(deps)` captures `deps` (plus a derived `now` and the
 * per-instance chat rate limiter) ONCE and returns the machinery the route
 * handlers call: the turn executor, the confirm validate+commit choke point,
 * the durable resume, and the session/preconditions guards. This is a pure
 * cohesion move — every helper body is verbatim from the old `apiRouter`
 * closure; only the captured `now`/`chatLimiter` now live on the factory. The
 * safety invariants (truthful-preview override, typed-consent guard, the
 * one-use atomic claim ordering, idempotency, undo capture) are unchanged.
 *
 * This module must NOT import from `./api.js` (that would create a cycle); the
 * shared constants live in `./chat-constants.js` and the pure transforms in
 * `./chat-results.js`. `api.ts` imports FROM here.
 */
import type { Request, Response } from "express";
import { createHash, randomUUID } from "node:crypto";
import {
  createSlidingWindowLimiter,
  DEFAULT_CHAT_RATE_LIMIT_MAX,
  DEFAULT_CHAT_RATE_LIMIT_WINDOW_MS,
  DEFAULT_NEW_CHAT_RATE_LIMIT_MAX,
  DEFAULT_NEW_CHAT_RATE_LIMIT_WINDOW_MS,
  type RateLimitDecision,
} from "./rate-limit.js";
import {
  accessDeniedMessage,
  commitConfirmedOperation,
  executeAction,
} from "../harness/actions.js";
import {
  isPartialCommitResult,
  OperationPreparationError,
  type ActionContext,
  type ActionResult,
  type CommitResult,
  type ConfirmableOperation,
  type PreviewCard,
} from "../harness/action.js";
import type { AtomicIdempotencyLedger } from "../harness/idempotency.js";
import { reversibleCreations } from "../harness/undo.js";
import { actionFingerprint, catalogForModel, catalogHash, getAction } from "../harness/catalog.js";
import { actionStatusLabel } from "../harness/action-labels.js";
import { canWrite, type AdminPolicy } from "../harness/permissions.js";
import {
  confirmPending,
  createPendingConfirmation,
  hashOperation,
  rotatePendingNonce,
} from "../harness/confirmations.js";
import { errorReceipt, hasChanges, type SuccessReceipt, type ErrorReceipt } from "../harness/receipts.js";
import { runAgentTurn, type AgentStep, type AgentTurnResult } from "../assistant/agent-loop.js";
import { parseAgentState, resumeMessages, type AgentState } from "../assistant/agent-state.js";
import {
  canonicalIntentAuthoredSource,
  declareIntentCapability,
  filterCatalogByIntentCapability,
} from "../assistant/intent-declaration.js";
import { buildCandidateWriteActionNames } from "../assistant/intent-candidates.js";
import {
  ProviderProtocolError,
  type ModelMessage,
  type ToolCall,
} from "../assistant/model-client.js";
import { planConversation, runAgentConversation } from "../assistant/planner.js";
import { trackUsage, type TurnUsage } from "../assistant/usage.js";
import { hasExplicitWriteRequest } from "../assistant/text-safety.js";
import { toolsForModel } from "../harness/tools.js";
import { selectActionsForMessage } from "../harness/tool-select.js";
import type { Installation, IntentCapabilityRecord } from "../db/store.js";
import type { ActionResultKind, ActionResultRef, DurableResultLink } from "../db/store.js";
import type { CalendarContext } from "../clockify/ports/users.js";
import { CLAIM_TTL_MS } from "../db/store.js";
import type { AppDeps } from "./deps.js";
import {
  sanitizeStoredReplyForModel,
  isTransientErrorMessage,
} from "./history-sanitizer.js";
import { chatBodySchema } from "./request-schemas.js";
import {
  TYPED_CONSENT,
  BARE_AFFIRMATIVE,
  lastTurnCompletedAWrite,
} from "./consent-guard.js";
import {
  settleAgentTurn,
  truthfulReplyText,
  storedContentForReply,
  type Claims,
  type TurnMachinery,
} from "./chat-results.js";
import { HISTORY_WINDOW_MESSAGES, IDEMPOTENCY_WINDOW_MS } from "./chat-constants.js";
import { bestEffort } from "./best-effort.js";
import { authorizeIntentWriteArguments } from "../harness/intent-authority.js";
import { boundedCompleteSanitizedJson } from "../harness/safe-json.js";
import { ACTION_RESULT_SUMMARY_MAX_BYTES } from "../db/action-results.js";
import {
  createWorkspaceMutationCoordinator,
  WorkspaceMutationRevokedError,
  type WorkspaceMutationLease,
} from "../clockify/workspace-mutation-coordinator.js";
import { HostRequestCancelledError } from "../clockify/request-governor.js";
import {
  createRouteAuthority,
  type VerifiedSessionClaims,
  type WriteAuthorityOutcome,
} from "./route-authority.js";

export type { WriteAuthorityOutcome } from "./route-authority.js";

/**
 * The user request that drove a suspended turn: the LAST user-role message in the
 * transcript. The agentic loop appends only assistant/tool turns after the request,
 * so the most recent user message IS the current request — the SAME text
 * `executeChatTurn` subsetted on for the initial turn (never an older history turn;
 * "first" would route the resume off a stale topic). Empty string if somehow none,
 * which `selectActionsForMessage` safely widens to the full catalog.
 */
function lastUserMessage(transcript: ModelMessage[]): string {
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    if (transcript[i].role === "user") return transcript[i].content;
  }
  return "";
}

const MAX_SELECTION_CONTEXT_CHARS = 8_000;
const DEGRADED_INLINE_SUMMARY_MAX_BYTES = 48_000;

/** Keep ordinary degraded results exact, but never persist an unbounded inline
 * fallback when the canonical result row is unavailable. */
function degradedInlineDescriptor(result: Record<string, unknown>): unknown {
  const bounded = boundedCompleteSanitizedJson(result, ACTION_RESULT_SUMMARY_MAX_BYTES);
  if (
    bounded && typeof bounded === "object" && !Array.isArray(bounded) &&
    (bounded as { persistenceDegraded?: unknown }).persistenceDegraded === true
  ) {
    return bounded;
  }
  const kind = result.kind === "partial" ? "partial" : "receipt";
  return {
    kind,
    persistenceDegraded: true,
    summary: boundedCompleteSanitizedJson(result, DEGRADED_INLINE_SUMMARY_MAX_BYTES),
  };
}

/** Keep the original request and latest terse clarification answer within a
 * bounded, admin-authored-only string used solely for deterministic selection. */
function combineSelectionContext(previous: string | undefined, message: string): string {
  const combined = previous ? `${previous}\n\n${message}` : message;
  if (combined.length <= MAX_SELECTION_CONTEXT_CHARS) return combined;
  const half = Math.floor((MAX_SELECTION_CONTEXT_CHARS - 2) / 2);
  return `${combined.slice(0, half)}\n\n${combined.slice(-half)}`;
}

/** The outcome of one chat turn, shared by the JSON route and the streaming route. */
export type ChatTurnOutcome =
  | { ok: true; replyKind: string; replyText: string; results: unknown[]; resultLinks: DurableResultLink[] }
  | { ok: false; code: string; message: string };

/** What `chatPreconditions` returns when a request is cleared to run a turn. */
export type ChatPreconditions = {
  claims: { sessionId: string; workspaceId: string; adminUserId: string };
  installation: Installation;
  message: string;
  requestId: string;
  replay?: { status: number; body: unknown };
};

/** A validated-and-committed confirmation, or the structured rejection to surface. */
export type CommitConfirmationOutcome =
  | { ok: false; status: number; body: { ok: false; code: string; message: string } }
  | {
      ok: true;
      receipt: SuccessReceipt | ErrorReceipt;
      partialResult?: Extract<ActionResult, { kind: "partial" }>;
      undoId: string | undefined;
      agentState: AgentState | undefined;
      installation: Installation | undefined;
      persistenceDegraded?: true;
    };

export interface ChatPipeline {
  loadPolicy: (workspaceId: string, adminUserId: string) => AdminPolicy;
  requireSession: (req: Request, res: Response) => Promise<VerifiedSessionClaims | undefined>;
  verifyWriteAuthority: (
    claims: Claims,
    installation?: Installation,
    signal?: AbortSignal,
  ) => Promise<WriteAuthorityOutcome>;
  /** Per-admin budget for creating fresh sessions (POST /chat/new) — bounds resetting
   *  the per-session paid-loop limit by minting sessions. Keyed by workspace+admin. */
  newChatAllowed: (workspaceId: string, adminUserId: string) => RateLimitDecision;
  actionContext: (
    workspaceId: string,
    adminUserId: string,
    installation: Installation,
    sessionId?: string,
    signal?: AbortSignal,
  ) => ActionContext;
  runResume: (
    claims: Claims,
    installation: Installation | undefined,
    agentState: AgentState | undefined,
    receipt: SuccessReceipt | ErrorReceipt,
    onResult?: (result: unknown) => void,
    onStatus?: (status: { action: string; label: string }) => void,
    signal?: AbortSignal,
  ) => Promise<{ replyKind: string; replyText: string; results: unknown[] } | undefined>;
  commitConfirmation: (
    claims: Claims,
    record: NonNullable<ReturnType<AppDeps["store"]["getPendingConfirmation"]>>,
    nonce: string,
    signal?: AbortSignal,
  ) => Promise<CommitConfirmationOutcome>;
  executeChatTurn: (
    claims: { sessionId: string; workspaceId: string; adminUserId: string },
    installation: Installation,
    message: string,
    onResult?: (result: unknown) => void,
    onStatus?: (status: { action: string; label: string }) => void,
    signal?: AbortSignal,
    requestId?: string,
  ) => Promise<ChatTurnOutcome>;
  chatPreconditions: (req: Request, res: Response) => Promise<ChatPreconditions | undefined>;
}

export function createChatPipeline(deps: AppDeps): ChatPipeline {
  const now = deps.now ?? (() => new Date());
  const mutationCoordinator = deps.mutationCoordinator ?? createWorkspaceMutationCoordinator();
  const intentCapabilitiesEnforced = deps.config.nodeEnv !== "test" ||
    deps.enforceIntentCapabilitiesInTests === true;
  // Per-SESSION chat rate limit — each turn drives a paid model loop, and
  // nothing else bounds it (confirm/cancel/undo are button-driven + one-use).
  const chatLimiter = createSlidingWindowLimiter(
    deps.config.chatRateLimitMax ?? DEFAULT_CHAT_RATE_LIMIT_MAX,
    deps.config.chatRateLimitWindowMs ?? DEFAULT_CHAT_RATE_LIMIT_WINDOW_MS,
  );
  // Per-ADMIN session-creation limiter (POST /chat/new): the chat limiter above is
  // keyed by sessionId, so minting fresh sessions resets its budget — this bounds that.
  const newChatLimiter = createSlidingWindowLimiter(
    deps.config.newChatRateLimitMax ?? DEFAULT_NEW_CHAT_RATE_LIMIT_MAX,
    deps.config.newChatRateLimitWindowMs ?? DEFAULT_NEW_CHAT_RATE_LIMIT_WINDOW_MS,
  );
  const newChatAllowed = (workspaceId: string, adminUserId: string): RateLimitDecision =>
    newChatLimiter.check(`${workspaceId}:${adminUserId}`, now().getTime());

  const {
    loadPolicy,
    requireSession,
    verifyWriteAuthority,
    actionContext,
  } = createRouteAuthority(deps, now);

  /** Synchronous final gate for persistence that is not protected by a mutation
   * settlement lease. No await may appear between this check and the write. */
  const turnAuthorityCurrent = (
    claims: Claims,
    installation: Installation,
    signal?: AbortSignal,
  ): boolean => {
    if (signal?.aborted) return false;
    const currentInstallation = deps.store.getInstallation(claims.workspaceId);
    if (!currentInstallation || currentInstallation.status !== "active" ||
      currentInstallation.generation !== installation.generation) return false;
    const currentSession = deps.store.getSession(claims.sessionId);
    return !!currentSession && currentSession.workspaceId === claims.workspaceId &&
      currentSession.adminUserId === claims.adminUserId;
  };

  /** Record a one-use undo for a successful reversible creation; return its id. */
  function recordUndoIfReversible(
    claims: { sessionId: string; workspaceId: string; adminUserId: string },
    installationGeneration: number,
    receipt: SuccessReceipt | ErrorReceipt,
  ): string | undefined {
    if (!receipt.ok) return undefined;
    // An idempotent replay returns the ORIGINAL commit's receipt (with a replay
    // warning) — its changed.created survives, but that first commit ALREADY minted
    // an undo record. Minting a second here would give one entity two live undo
    // handles. Suppress on replay (markReplayed tags the warning).
    if (receipt.warnings?.some((w) => w.code === "idempotent_replay")) return undefined;
    const reversal = reversibleCreations(receipt);
    if (reversal.length === 0) return undefined;
    return deps.store.recordUndoable({
      sessionId: claims.sessionId,
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      actionName: receipt.action,
      installationGeneration,
      reversal,
    });
  }

  function createTurnMachinery(
    claims: Claims,
    installation: Installation,
    onResult?: (result: unknown) => void,
    onStatus?: (status: { action: string; label: string }) => void,
    requestId?: string,
    calendar?: CalendarContext,
    selectionContext?: string,
    intentCapability?: IntentCapabilityRecord,
    signal?: AbortSignal,
  ): TurnMachinery {
    const results: unknown[] = [];
    const resultLinks: DurableResultLink[] = [];
    const emit = (result: unknown, link: DurableResultLink): void => {
      results.push(result);
      resultLinks.push(link);
      onResult?.(result);
    };
    let calendarLoaded = calendar !== undefined;
    let calendarPromise: Promise<void> | undefined;
    const ensureCalendar = (): Promise<void> => {
      if (calendarLoaded) return Promise.resolve();
      calendarPromise ??= deps.clockifyForWorkspace(
        installation,
        signal ? { signal } : undefined,
      )
        .getCalendarContext(claims.adminUserId)
        .then((resolved) => {
          Object.assign(ctx, resolved);
          calendarLoaded = true;
        })
        .catch(() => {
          calendarLoaded = true;
        });
      return calendarPromise;
    };
    const baseCtx = {
      ...actionContext(claims.workspaceId, claims.adminUserId, installation, claims.sessionId, signal),
      ...(calendar ?? {}),
      ...(intentCapability
        ? {
            authorizeWriteArguments: async (input: Parameters<NonNullable<ActionContext["authorizeWriteArguments"]>>[0]) => {
              const denial = authorizeIntentWriteArguments({
                capability: intentCapability.capability,
                actionName: input.actionName,
                rawArgs: input.rawArgs,
                authority: input.authority,
                catalogHash: catalogHash(),
                authenticatedAdminUserId: claims.adminUserId,
              });
              if (denial) return denial;
              await ensureCalendar();
              return undefined;
            },
          }
        : {}),
    };
    const ctx: ActionContext = requestId
      ? {
          ...baseCtx,
          operationJournal: {
            prepare(actionName, actionArgs, mutationPlan) {
              const operationId = deps.store.prepareOperationRun({
                requestId,
                sessionId: claims.sessionId,
                workspaceId: claims.workspaceId,
                adminUserId: claims.adminUserId,
                actionName,
                actionFingerprint: actionFingerprint(actionName) ?? hashOperation({ actionName }),
                catalogHash: catalogHash(),
                operationHash: hashOperation({ actionName, operation: actionArgs, mutationPlan }),
                operation: actionArgs,
                mutationPlan,
              });
              if (intentCapability) {
                try {
                  deps.store.bindIntentCapabilityOperation({
                    workspaceId: claims.workspaceId,
                    adminUserId: claims.adminUserId,
                    sessionId: claims.sessionId,
                    requestId: intentCapability.requestId,
                    requestHash: intentCapability.requestHash,
                    catalogHash: intentCapability.catalogHash,
                    capabilityId: intentCapability.id,
                    capabilityHash: intentCapability.capabilityHash,
                    actionName,
                    operationId,
                  });
                  const consumed = deps.store.consumeIntentCapabilityForOperation({
                    operationId,
                    workspaceId: claims.workspaceId,
                    adminUserId: claims.adminUserId,
                    sessionId: claims.sessionId,
                    capabilityId: intentCapability.id,
                    capabilityHash: intentCapability.capabilityHash,
                    expectedCatalogHash: catalogHash(),
                    expectedActionName: actionName,
                  });
                  if (consumed.state === "denied") {
                    throw new Error(`intent_capability_${consumed.reason}`);
                  }
                } catch (error) {
                  throw new OperationPreparationError(operationId, error);
                }
              }
              return operationId;
            },
            markExecuting(operationId) {
              if (!deps.store.markOperationExecuting(operationId)) throw new Error("operation_not_prepared");
            },
            scope(operationId) {
              return deps.store.mutationStepJournal(operationId);
            },
            settle(_operationId, _status, _result) {
              // The emitter below owns the terminal transition because it creates
              // the canonical result and links both in one synchronous turn. Keep
              // the journal executing until then: if the process dies in this
              // narrow handoff, startup recovery records outcome_unknown instead
              // of leaving a terminal operation with no canonical result.
            },
          },
        }
      : baseCtx;

    // A safe write owns its workspace lease until its canonical result has been
    // settled/emitted. Key by the concrete result object so both the agentic and
    // single-turn settlement paths release exactly the lease that produced it.
    const resultLeases = new WeakMap<object, WorkspaceMutationLease>();
    const releaseResultLease = (result: object): void => {
      const lease = resultLeases.get(result);
      if (!lease) return;
      resultLeases.delete(result);
      lease.release();
    };

    // Every executed action — success or error, single-turn or agentic — is
    // audited under the catalog's risk labels and offered an undo if reversible.
    const persistCanonicalResult = (
      actionName: string,
      status: ActionResultKind,
      result: unknown,
      operationId?: string,
    ): ActionResultRef | undefined => {
      const attempts = 2;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          return operationId
            ? deps.store.settleOperationResult(operationId, status, result)
            : deps.store.recordActionResult({
                workspaceId: claims.workspaceId,
                adminUserId: claims.adminUserId,
                sessionId: claims.sessionId,
                actionName,
                status,
                result,
              });
        } catch {
          // A known host outcome is never redispatched because its local result
          // row is temporarily unavailable. Retry only this synchronous store
          // transition, then preserve the truthful result as an inline link.
        }
      }
      console.error("canonical action-result persistence degraded; response preserved", {
        status,
        operationBound: operationId !== undefined,
        attempts,
      });
      return undefined;
    };

    const auditAndEmitReceipt = (actionName: string, receipt: SuccessReceipt | ErrorReceipt, operationId?: string): void => {
      try {
      // Reads and pre-dispatch errors own no mutation lease. If lifecycle
      // revocation erased the workspace while their async host/model work was
      // outstanding, do not let canonical results or audit rows recreate it.
      // A safe write DOES retain its lease here: uninstall is waiting for this
      // truthful settlement, so it must be persisted/emitted before release.
      if (!resultLeases.has(receipt) &&
        !turnAuthorityCurrent(claims, installation, signal)) return;
      // Post-execution bookkeeping is best-effort: a safe write executes
      // immediately (no confirm round-trip), so by the time we audit it the
      // change has ALREADY happened on the host. A transient DB error here (e.g.
      // a microsecond SQLITE_BUSY) must NOT throw the turn — that would 502
      // (agentic) / 500 (single-turn), drop the committed receipt, and invite a
      // duplicate write. Mirror the confirm-tail fix: log (message only, no
      // secrets) and still emit the receipt for the change that already ran.
      const status: ActionResultKind = receipt.ok
        ? "succeeded"
        : receipt.code === "commit_outcome_unknown"
          ? "outcome_unknown"
          : "definitive_failed";
      let undoId: string | undefined;
      bestEffort("post-execution undo bookkeeping failed", () => {
        undoId = recordUndoIfReversible(claims, installation.generation, receipt);
      });
      const canonicalResult = {
        kind: "receipt" as const,
        receipt,
        ...(undoId ? { undo: { id: undoId } } : {}),
      };
      const resultRef = persistCanonicalResult(actionName, status, canonicalResult, operationId);
      if (resultRef) {
        bestEffort("post-execution bookkeeping failed", () => {
          deps.store.addAuditEvent({
            workspaceId: claims.workspaceId,
            adminUserId: claims.adminUserId,
            sessionId: claims.sessionId,
            actionName,
            risk: getAction(actionName)?.risks ?? [],
            resultRef,
          });
        });
        emit(canonicalResult, { kind: "action_result", ref: resultRef });
        return;
      }
      const degradedResult = { ...canonicalResult, persistenceDegraded: true as const };
      emit(degradedResult, { kind: "inline", descriptor: degradedInlineDescriptor(degradedResult) });
      } finally {
        releaseResultLease(receipt);
      }
    };

    const auditAndEmitPartial = (
      actionName: string,
      result: Extract<ActionResult, { kind: "partial" }>,
      operationId?: string,
    ): void => {
      try {
      if (!resultLeases.has(result) &&
        !turnAuthorityCurrent(claims, installation, signal)) return;
      let undoId: string | undefined;
      bestEffort("partial-result undo bookkeeping failed", () => {
        undoId = recordUndoIfReversible(claims, installation.generation, result.receipt);
      });
      const canonicalResult = { ...result, ...(undoId ? { undo: { id: undoId } } : {}) };
      delete canonicalResult.operationId;
      const resultRef = persistCanonicalResult(actionName, "partial", canonicalResult, operationId);
      if (resultRef) {
        bestEffort("partial-result bookkeeping failed", () => {
          deps.store.addAuditEvent({
            workspaceId: claims.workspaceId,
            adminUserId: claims.adminUserId,
            sessionId: claims.sessionId,
            actionName,
            risk: getAction(actionName)?.risks ?? [],
            resultRef,
          });
        });
        emit(canonicalResult, { kind: "action_result", ref: resultRef });
        return;
      }
      const degradedResult = { ...canonicalResult, persistenceDegraded: true as const };
      emit(degradedResult, { kind: "inline", descriptor: degradedInlineDescriptor(degradedResult) });
      } finally {
        releaseResultLease(result);
      }
    };

    // An agentic interrupt persists its suspended transcript alongside the
    // pending confirmation (Phase 3) so the confirm route can resume the loop.
    const emitPreviewFor = (preview: PreviewCard, operation: ConfirmableOperation, agentState?: AgentState): void => {
      try {
        if (intentCapabilitiesEnforced && !intentCapability) throw new Error("intent_capability_missing");
        const lease = resultLeases.get(operation);
        if (lease?.signal.aborted) {
          const reason = lease.signal.reason;
          if (reason instanceof WorkspaceMutationRevokedError) throw reason;
          throw new HostRequestCancelledError();
        }
        // This synchronous reload is the final lifecycle gate before any preview
        // or operation row is persisted. The workspace lease prevents uninstall
        // from erasing the workspace until this block either finishes or fails.
        const currentInstallation = deps.store.getInstallation(claims.workspaceId);
        if (!currentInstallation || currentInstallation.status !== "active" ||
            currentInstallation.generation !== installation.generation) {
          throw new WorkspaceMutationRevokedError(claims.workspaceId, installation.generation);
        }
        const created = createPendingConfirmation({
          sessionId: claims.sessionId,
          workspaceId: claims.workspaceId,
          adminUserId: claims.adminUserId,
          risk: operation.risks,
          preview,
          operation,
          installationGeneration: installation.generation,
          sessionSecret: deps.config.sessionSecret,
          now: now(),
          agentState: agentState && intentCapability
            ? {
                ...agentState,
                intentCapability: {
                  operationId: operation.operationId,
                  id: intentCapability.id,
                  hash: intentCapability.capabilityHash,
                },
              }
            : agentState,
          actionFingerprint: actionFingerprint(operation.actionName),
          catalogHash: catalogHash(),
        });
        const boundOperation = created.record.operation as ConfirmableOperation;
        deps.store.prepareOperationRun({
          id: created.record.operationId,
          requestId: intentCapability?.requestId ?? requestId,
          confirmationId: created.record.id,
          sessionId: claims.sessionId,
          workspaceId: claims.workspaceId,
          adminUserId: claims.adminUserId,
          actionName: boundOperation.actionName,
          actionFingerprint: created.record.actionFingerprint,
          catalogHash: created.record.catalogHash,
          operationHash: created.record.operationHash,
          operation: boundOperation,
          mutationPlan: boundOperation.mutationPlan,
        });
        deps.store.savePendingConfirmation(created.record);
        if (intentCapability) {
          deps.store.bindIntentCapabilityOperation({
            workspaceId: claims.workspaceId,
            adminUserId: claims.adminUserId,
            sessionId: claims.sessionId,
            requestId: intentCapability.requestId,
            requestHash: intentCapability.requestHash,
            catalogHash: intentCapability.catalogHash,
            capabilityId: intentCapability.id,
            capabilityHash: intentCapability.capabilityHash,
            actionName: boundOperation.actionName,
            operationId: created.record.operationId,
            confirmationId: created.record.id,
          });
        }
        const livePreview = {
          kind: "preview",
          previewId: created.previewId,
          nonce: created.nonce,
          expiresAt: created.expiresAt,
          preview,
        };
        const { nonce: _nonce, ...descriptor } = livePreview;
        emit(livePreview, { kind: "preview", descriptor });
      } finally {
        releaseResultLease(operation);
      }
    };

    // Execute one model tool call through the harness trust boundary; an action
    // that throws becomes an error receipt (also fed back to the model), never a
    // crash.
    const runAction = async (call: ToolCall): Promise<ActionResult> => {
      // Progress status BEFORE execution (a 30-120s agentic turn otherwise looks
      // frozen). Label derived from the action NAME only — args can carry admin
      // text and never ride a status line. Ephemeral: never persisted/audited.
      onStatus?.({ action: call.name, label: actionStatusLabel(call.name) });
      let lease: WorkspaceMutationLease | undefined;
      try {
        const action = getAction(call.name);
        const isWrite = !!action && action.risks.some((risk) => risk !== "read");
        const writeDeclared = intentCapability?.capability.mode === "allow" &&
          intentCapability.capability.writeActions.some((grant) => grant.actionName === call.name);
        if (intentCapabilitiesEnforced && isWrite && !writeDeclared) {
          return {
            kind: "receipt",
            receipt: errorReceipt({
              action: call.name,
              code: "intent_capability_denied",
              message: "This write was not authorized by the admin-authored request.",
              recovery: { hint: "Ask for the write explicitly in a fresh request.", retryable: false },
            }),
          };
        }
        if (action && (!isWrite || !intentCapabilitiesEnforced)) await ensureCalendar();
        let executionContext = ctx;
        if (isWrite) {
          lease = mutationCoordinator.acquire(
            claims.workspaceId,
            installation.generation,
            signal,
          );
          if (lease.signal.aborted) throw new HostRequestCancelledError();
          executionContext = {
            ...ctx,
            signal: lease.signal,
            clockify: deps.clockifyForWorkspace(installation, { signal: lease.signal }),
          };
        }
        const result = await executeAction({ actionName: call.name, args: call.arguments, context: executionContext });
        if (lease) {
          if (result.kind === "receipt") resultLeases.set(result.receipt, lease);
          else if (result.kind === "partial") resultLeases.set(result, lease);
          else if (result.kind === "preview") resultLeases.set(result.operation, lease);
          else lease.release();
          lease = undefined;
        }
        return result;
      } catch (err) {
        lease?.release();
        const revoked = err instanceof WorkspaceMutationRevokedError;
        const cancelled = err instanceof HostRequestCancelledError;
        return {
          kind: "receipt",
          receipt: errorReceipt({
            action: call.name,
            code: revoked
              ? "installation_changed"
              : cancelled
                ? "request_cancelled"
                : "action_failed",
            message: revoked
              ? "The Clockify installation changed before this action could run. No change was made."
              : cancelled
                ? "The request was cancelled before the Clockify change was dispatched. No change was made."
                : err instanceof Error
                  ? err.message.slice(0, 200)
                  : "The action could not be completed.",
            ...((revoked || cancelled)
              ? { recovery: { hint: revoked ? "Retry from the active installation." : "Send the request again if you still want this change.", retryable: false } }
              : {}),
          }),
        };
      }
    };

    const onStep = ({ call, result }: AgentStep): void => {
      if (result.kind === "receipt") auditAndEmitReceipt(call.name, result.receipt, result.operationId);
      else if (result.kind === "partial") auditAndEmitPartial(call.name, result, result.operationId);
      else if (result.kind === "clarify") {
        const descriptor = { kind: "clarify", message: result.message, options: result.options };
        emit(descriptor, { kind: "inline", descriptor });
      }
    };

    return {
      ctx,
      results,
      resultLinks,
      selectionContext,
      emit,
      auditAndEmitReceipt,
      auditAndEmitPartial,
      emitPreviewFor,
      runAction,
      onStep,
    };
  }

  function persistAssistantReply(
    claims: Claims,
    replyKind: string,
    replyText: string,
    results: unknown[],
    resultLinks: DurableResultLink[],
    clarificationContext?: string,
    failureCode?: "provider_protocol_error",
    unresolvedRequestContext?: { actionName: "clockify_projects_create"; text: string },
  ): void {
    // Persisting the assistant reply is post-execution bookkeeping: it runs AFTER
    // the turn's action(s) executed (a safe write already hit the host; a risky one
    // is already a stored pending preview). A transient DB error on this write
    // (e.g. a microsecond SQLITE_BUSY) must NOT throw the turn — that would 502
    // (agentic) / 500 (single-turn) a turn whose change already happened, dropping
    // the committed receipt and inviting a duplicate write. Mirror the safe-write
    // (auditAndEmitReceipt) and confirm-tail isolation: log (message only, no
    // secrets) and continue so the receipt/reply still reaches the admin.
    try {
      deps.store.addMessage({
        sessionId: claims.sessionId,
        workspaceId: claims.workspaceId,
        adminUserId: claims.adminUserId,
        role: "assistant",
        content: storedContentForReply(replyText, results),
        payload: {
          kind: replyKind,
          ...(replyKind === "clarify" && clarificationContext
            ? { clarificationContext }
            : {}),
          ...(failureCode ? { code: failureCode } : {}),
          ...(unresolvedRequestContext ? { unresolvedRequestContext } : {}),
        },
        resultLinks,
      });
    } catch {
      // Driver errors can contain SQL values or serialized result payloads.
      console.error("assistant-reply persistence failed (turn already executed; reply preserved; error details suppressed)");
    }
  }

  /** Telemetry must never break a turn — best-effort write, swallow failures. */
  function recordTurnTelemetrySafely(
    claims: Claims,
    kind: "chat" | "resume",
    usage: TurnUsage,
    turnMs: number,
    installation: Installation,
    signal?: AbortSignal,
  ): void {
    // turn_telemetry intentionally has no session FK, so an in-flight provider
    // response must not be able to recreate it after uninstall erases the workspace.
    if (!turnAuthorityCurrent(claims, installation, signal)) return;
    try {
      deps.store.recordTurnTelemetry({
        sessionId: claims.sessionId,
        workspaceId: claims.workspaceId,
        adminUserId: claims.adminUserId,
        kind,
        modelCalls: usage.modelCalls,
        // Honest absence: only report token counts the backend actually gave us.
        ...(usage.usageReported
          ? { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens }
          : {}),
        // Cache hits are reported separately (DeepSeek always; some backends never) —
        // store the count only when the backend gave us cache info, NULL otherwise.
        ...(usage.cachedPromptReported ? { cachedPromptTokens: usage.cachedPromptTokens } : {}),
        turnMs,
        modelMs: usage.modelMs,
      });
    } catch {
      // Never let telemetry take down a chat turn.
    }
  }

  /**
   * Run the durable resume (Phase 3) for a confirmed risky write: feed the
   * committed receipt back as the risky call's tool result and let the loop finish
   * the task. The resumed loop can only emit receipts/clarifies or chain ANOTHER
   * pending preview — it goes through `runAction` (`executeAction`), NEVER a commit,
   * so it cannot re-execute the original (or any) risky write inline. `onResult`
   * streams each continuation result as it is produced; omit it to collect them.
   * Returns undefined when there's nothing to resume (no/invalid agent state,
   * agentic off, or the backend can't tool-call) — the caller then behaves as
   * pre-Phase-3.
   */
  async function runResume(
    claims: Claims,
    installation: Installation | undefined,
    agentState: AgentState | undefined,
    receipt: SuccessReceipt | ErrorReceipt,
    onResult?: (result: unknown) => void,
    onStatus?: (status: { action: string; label: string }) => void,
    signal?: AbortSignal,
  ): Promise<{ replyKind: string; replyText: string; results: unknown[] } | undefined> {
    if (
      !agentState ||
      (intentCapabilitiesEnforced && !agentState.intentCapability) ||
      !installation ||
      installation.status !== "active" ||
      !deps.config.llmAgentic ||
      deps.config.llmMode === "json" ||
      typeof deps.modelClient.completeWithTools !== "function"
    ) {
      return undefined;
    }
    let turnSignal: AbortSignal;
    try {
      turnSignal = mutationCoordinator.observe(
        claims.workspaceId,
        installation.generation,
        signal,
      );
    } catch (error) {
      if (error instanceof WorkspaceMutationRevokedError) return undefined;
      throw error;
    }
    if (!turnAuthorityCurrent(claims, installation, turnSignal)) return undefined;
    let intentCapability: IntentCapabilityRecord | undefined;
    if (intentCapabilitiesEnforced) {
      const binding = agentState.intentCapability;
      if (!binding) return undefined;
      try {
        intentCapability = deps.store.getIntentCapabilityForOperation({
          operationId: binding.operationId,
          workspaceId: claims.workspaceId,
          adminUserId: claims.adminUserId,
          sessionId: claims.sessionId,
          capabilityId: binding.id,
          capabilityHash: binding.hash,
          expectedCatalogHash: catalogHash(),
          expectedActionName: agentState.call.name,
        });
      } catch {
        return undefined;
      }
    }
    // r2-new-ops-layer-04: the resume is a PAID model loop (up to DEFAULT_MAX_STEPS
    // round-trips), and a chain of confirm→resume→preview→confirm could otherwise
    // keep it running with the chat limiter never seeing it. Charge it against the
    // SAME per-session budget so the limiter's "paid-loop damping" purpose holds.
    // The commit already happened and its receipt is returned regardless — an
    // over-budget resume only loses the follow-up narration (the same outcome as a
    // model failure mid-resume), never the commit.
    if (!chatLimiter.check(claims.sessionId, now().getTime()).allowed) {
      return undefined;
    }
    const resumeSelectionContext = agentState.selectionContext ?? lastUserMessage(agentState.transcript);
    const m = createTurnMachinery(
      claims,
      installation,
      onResult,
      onStatus,
      intentCapability?.requestId,
      undefined,
      resumeSelectionContext,
      intentCapability,
      turnSignal,
    );
    const resumeStartMs = now().getTime();
    const tracked = trackUsage(deps.modelClient, now);
    // STEP 6: subset the resume too, using the admin-authored selection context
    // persisted with the suspended agent state. This includes unresolved
    // clarification context, so a terse follow-up cannot hide the original domain.
    // Recall-risk inputs (no lexical match, non-ASCII, or >3 matched areas) already
    // fail open to the full catalog. There is deliberately no post-resume retry: a
    // no-tool result is the normal "done" narration and must not double provider cost.
    const { subsetTools: resumeTools } = deriveToolSubset(resumeSelectionContext, intentCapability);
    let turn: AgentTurnResult | undefined;
    try {
      turn = await runAgentTurn({
        modelClient: tracked.client,
        messages: resumeMessages(agentState, receipt),
        tools: resumeTools,
        runAction: m.runAction,
        onStep: m.onStep,
        signal: turnSignal,
      });
    } catch {
      // The commit already happened and its receipt is returned regardless; a
      // model failure here only loses the follow-up narration.
      recordTurnTelemetrySafely(
        claims,
        "resume",
        tracked.usage,
        now().getTime() - resumeStartMs,
        installation,
        turnSignal,
      );
      return undefined;
    }
    const { replyKind, baseText } = settleAgentTurn(m, turn);
    // The receipt that TRIGGERED this resume is a mutation this turn already
    // applied (the confirmed risky write). Include it in the truthfulness check so
    // a genuine post-confirm completion ("Done!", "I've created …", "has been …")
    // is NOT wrongly replaced by NO_CHANGE_MADE_REPLY — the F10 guard is for
    // read-then-fabricate, not for a real completion whose receipt lives outside
    // the resume turn's own results. Only the CHECK sees it; persistence/streaming
    // keep using m.results so the committed receipt is never double-counted.
    const resultsForTruthfulness = receipt.ok ? [{ kind: "receipt" as const, receipt }, ...m.results] : m.results;
    const replyText = truthfulReplyText(resultsForTruthfulness, baseText, replyKind, {
      writeIntentDeclared: intentCapability?.capability.mode === "allow" &&
        intentCapability.capability.writeActions.length > 0,
      writeAuthorityUnresolved: intentCapability?.capability.mode === "deny_all_writes" &&
        (intentCapability.capability.reason !== "no_write_intent" ||
          hasExplicitWriteRequest(resumeSelectionContext)),
    });
    if (!turnAuthorityCurrent(claims, installation, turnSignal)) {
      return { replyKind: "aborted", replyText: "", results: m.results };
    }
    persistAssistantReply(
      claims,
      replyKind,
      replyText,
      m.results,
      m.resultLinks,
      resumeSelectionContext,
    );
    recordTurnTelemetrySafely(
      claims,
      "resume",
      tracked.usage,
      now().getTime() - resumeStartMs,
      installation,
      turnSignal,
    );
    return { replyKind, replyText, results: m.results };
  }

  /**
   * Validate + commit a confirmed risky write through the single choke point.
   * Returns the structured error (with its HTTP status) when validation/policy/
   * the one-use claim rejects — BEFORE any commit, so a denied confirm never
   * burns the nonce — or the committed receipt + undo + (valid) agent state for
   * the resume. Mirrors the exact ordering the safety review verified.
   */
  async function commitConfirmation(
    claims: Claims,
    record: NonNullable<ReturnType<typeof deps.store.getPendingConfirmation>>,
    nonce: string,
    signal?: AbortSignal,
  ): Promise<CommitConfirmationOutcome> {
    const validation = confirmPending({
      record,
      sessionId: claims.sessionId,
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      nonce,
      sessionSecret: deps.config.sessionSecret,
      now: now(),
      expectedActionFingerprint: actionFingerprint((record.operation as ConfirmableOperation).actionName),
      expectedCatalogHash: catalogHash(),
    });
    if (!validation.ok) {
      if (validation.code === "expired") deps.store.expireConfirmation(record.id);
      return { ok: false, status: 400, body: { ok: false, code: validation.code, message: validation.message } };
    }

    const operation = record.operation as ConfirmableOperation;
    const installation = deps.store.getInstallation(claims.workspaceId);
    if (!installation || installation.status !== "active") {
      return {
        ok: false,
        status: 503,
        body: {
          ok: false,
          code: "role_verification_unavailable",
          message: "The add-on is not active for this workspace. No change was made.",
        },
      };
    }
    if (!Number.isSafeInteger(record.installationGeneration) ||
        record.installationGeneration !== installation.generation ||
        operation.installationGeneration !== record.installationGeneration) {
      return {
        ok: false,
        status: 409,
        body: {
          ok: false,
          code: "installation_changed",
          message: "The Clockify installation changed after this preview was created. Create a fresh preview.",
        },
      };
    }
    let capabilityScope: Parameters<typeof deps.store.consumeIntentCapabilityForOperation>[0] | undefined;
    if (intentCapabilitiesEnforced) {
      if (!record.capabilityId || !record.capabilityHash) {
        return {
          ok: false,
          status: 400,
          body: {
            ok: false,
            code: "incompatible_confirmation",
            message: "This preview predates the current intent-safety contract. Create a fresh preview.",
          },
        };
      }
      capabilityScope = {
        operationId: record.operationId,
        workspaceId: claims.workspaceId,
        adminUserId: claims.adminUserId,
        sessionId: claims.sessionId,
        capabilityId: record.capabilityId,
        capabilityHash: record.capabilityHash,
        expectedCatalogHash: catalogHash(),
        expectedActionName: operation.actionName,
      };
      try {
        deps.store.getIntentCapabilityForOperation(capabilityScope);
      } catch {
        return {
          ok: false,
          status: 400,
          body: {
            ok: false,
            code: "incompatible_confirmation",
            message: "This preview's intent authority is no longer compatible. Create a fresh preview.",
          },
        };
      }
    }

    // Re-check current policy BEFORE consuming the one-use preview, so a policy
    // that was lowered after the preview denies cleanly without burning it
    // (commitConfirmedOperation re-checks again as defense in depth).
    if (!operation.risks.includes("permission_change")) {
      const policy = loadPolicy(claims.workspaceId, claims.adminUserId);
      if (!canWrite(policy, operation.featureGroup)) {
        return {
          ok: false,
          status: 400,
          body: {
            ok: false,
            code: "policy_denied",
            message: accessDeniedMessage(operation.featureGroup, "write"),
          },
        };
      }
    }

    const authority = await verifyWriteAuthority(claims, installation, signal);
    if (!authority.ok) {
      return {
        ok: false,
        status: authority.status,
        body: { ok: false, code: authority.code, message: authority.message },
      };
    }

    let mutationLease: WorkspaceMutationLease;
    try {
      mutationLease = mutationCoordinator.acquire(
        claims.workspaceId,
        installation.generation,
        signal,
      );
    } catch (error) {
      if (!(error instanceof WorkspaceMutationRevokedError)) throw error;
      return {
        ok: false,
        status: 409,
        body: { ok: false, code: "installation_changed", message: error.message },
      };
    }
    if (mutationLease.signal.aborted) {
      mutationLease.release();
      return {
        ok: false,
        status: 409,
        body: {
          ok: false,
          code: "request_cancelled",
          message: "The confirmation was cancelled before dispatch. No change was made.",
        },
      };
    }

    // Atomic one-use claim: only the caller that transitions pending → executing wins.
    if (!deps.store.markConfirmationExecuting(record.id)) {
      mutationLease.release();
      return { ok: false, status: 409, body: { ok: false, code: "already_used", message: "This preview was already used." } };
    }

    try {
    // ALL confirmed operations go through the SAME commit path. The action's own
    // `commit` does the work; for a permission change that commit persists the new
    // policy itself via the `savePolicy` capability the context carries.
    let commitResult: CommitResult;
    const consumed = capabilityScope
      ? deps.store.consumeIntentCapabilityForOperation(capabilityScope)
      : undefined;
    if (consumed?.state === "denied") {
      commitResult = errorReceipt({
        action: operation.actionName,
        code: "intent_capability_denied",
        message: "This write exceeds the exact admin-authored intent capability.",
        recovery: { hint: "Create a fresh request and preview.", retryable: false },
      });
    } else {
      // A store-backed ATOMIC idempotency ledger (10-min window) so re-confirming
      // the same intent (e.g. the same invoice) can't create a duplicate — even
      // under CONCURRENT confirms: claim is taken before the commit await, so two
      // simultaneous confirms reach the host at most once (r1-concurrency-races-01).
      const idempotency: AtomicIdempotencyLedger = {
        lookup: (key) => deps.store.lookupIdempotency(
          key,
          claims.workspaceId,
          claims.adminUserId,
          now().getTime() - IDEMPOTENCY_WINDOW_MS,
        ),
        // The atomic path never calls legacy record; canonical persistence owns fill.
        record: () => undefined,
        claim: (key) => {
          const state = deps.store.claimIdempotency(
            key,
            claims.workspaceId,
            claims.adminUserId,
            now().getTime(),
            now().getTime() - IDEMPOTENCY_WINDOW_MS,
            now().getTime() - CLAIM_TTL_MS,
          );
          if (state === "won") {
            try {
              deps.store.bindConfirmationIdempotencyKey(record.id, key);
            } catch (error) {
              deps.store.releaseIdempotency(key, claims.workspaceId, claims.adminUserId);
              throw error;
            }
          }
          return state;
        },
        lookupCompleted: (key) => deps.store.claimIdempotencyReceipt(key, claims.workspaceId, claims.adminUserId),
        // The claim was bound before dispatch; settleConfirmation fills it in
        // the same transaction as the canonical result + confirmation scrub.
        fill: () => undefined,
        release: (key) => deps.store.releaseConfirmationIdempotencyKey(record.id, key),
        // Heartbeat a long multi-call commit's live claim so it is never swept
        // mid-flight and double-committed (r1-concurrency-races-01 follow-up).
        touch: (key) => deps.store.touchIdempotencyClaim(key, claims.workspaceId, claims.adminUserId, now().getTime()),
      };
      const authorizedContext = {
        ...actionContext(
          claims.workspaceId,
          claims.adminUserId,
          installation,
          undefined,
          mutationLease.signal,
        ),
        mutationJournal: deps.store.mutationStepJournal(record.operationId),
      };
      // Keep authorizeWrite on the context: the exact mutation scope invokes it
      // again immediately before every primary/compensation network dispatch.
      commitResult = operation.mutationPlan
        ? await commitConfirmedOperation(
            { ...authorizedContext, idempotency },
            { ...operation, mutationPlan: operation.mutationPlan },
          )
        : await commitConfirmedOperation({ ...authorizedContext, idempotency }, operation);
    }

    let partialResult: Extract<ActionResult, { kind: "partial" }> | undefined;
    let receipt: SuccessReceipt | ErrorReceipt;
    if (isPartialCommitResult(commitResult)) {
      partialResult = commitResult;
      receipt = commitResult.receipt;
    } else {
      receipt = commitResult;
    }

    // The host dispatch already happened. Retry only the synchronous SQLite
    // settlement (never the Clockify mutation), then return the truthful host
    // receipt even if persistence remains degraded. Claim-time persistence has
    // already scrubbed dispatch material and bound the one unknown result that
    // startup recovery will reuse if final settlement never persists.
    const terminalStatus = partialResult
      ? "partial"
      : receipt.ok
        ? "succeeded"
      : receipt.code === "commit_outcome_unknown"
        ? "outcome_unknown"
        : "definitive_failed";
    let resultRef: ActionResultRef | undefined;
    let settlementError: unknown;
    for (let attempt = 0; attempt < 2 && !resultRef; attempt += 1) {
      try {
        resultRef = deps.store.settleConfirmedOperation(
          record.id,
          terminalStatus,
          operation.actionName,
          partialResult ?? receipt,
        );
      } catch (error) {
        settlementError = error;
      }
    }
    if (!resultRef) {
      console.error(
        "canonical action-result persistence degraded (change already applied; receipt preserved):",
        settlementError instanceof Error ? settlementError.message : String(settlementError),
      );
    }
    if (resultRef) {
      bestEffort("post-commit audit failed", () => {
        deps.store.addAuditEvent({
          workspaceId: claims.workspaceId,
          adminUserId: claims.adminUserId,
          sessionId: claims.sessionId,
          actionName: operation.actionName,
          risk: operation.risks,
          resultRef: resultRef!,
        });
      });
    }
    let undoId: string | undefined;
    bestEffort("post-commit undo bookkeeping failed", () => {
      undoId = recordUndoIfReversible(claims, installation.generation, receipt);
    });
    const agentState = receipt.ok && !partialResult ? parseAgentState(record.agentState) : undefined;
    return {
      ok: true,
      receipt,
      ...(partialResult ? { partialResult } : {}),
      undoId,
      agentState,
      installation,
      ...(!resultRef ? { persistenceDegraded: true as const } : {}),
    };
    } finally {
      mutationLease.release();
    }
  }

  /**
   * A deterministic, model-free answer turn (the three short-circuit guards below
   * share this exact tail): persist the reply as a plain `answer` and return it.
   * Each guard keeps its OWN distinct predicate + copy text; only the persist+return
   * shape is shared here. These early returns deliberately never touch a model and so
   * never reach `recordTurn()` (no model call ⇒ no telemetry row).
   */
  function deterministicAnswer(claims: Claims, text: string): ChatTurnOutcome {
    persistAssistantReply(claims, "answer", text, [], []);
    return { ok: true, replyKind: "answer", replyText: text, results: [], resultLinks: [] };
  }

  /**
   * The three deterministic guards that must short-circuit a turn BEFORE it reaches
   * the planner — in this exact order: whitespace-only → typed-consent → bare
   * affirmative after a completed safe write. Returns the deterministic answer when a
   * guard fires, or `undefined` to let the turn run a model. (The user message is
   * already persisted by the caller before this runs.)
   */
  function shortCircuitReply(
    claims: { sessionId: string; workspaceId: string; adminUserId: string },
    message: string,
  ): ChatTurnOutcome | undefined {
    // A whitespace-only message is no input at all (finding new-6: a blank turn
    // sent the model guessing — it invoked clockify_review_day / clockify_status
    // unsolicited and fabricated a context). Treat it as empty and ask what the
    // admin wants, deterministically — never let it reach the planner.
    if (message.trim().length === 0) {
      return deterministicAnswer(claims, "I didn't catch a message there — what would you like me to do?");
    }

    // SAFETY (live item 157): bare typed consent must never reach the planner —
    // live, "yes" made the model plan a NEW operation instead of pointing at the
    // button. Deterministic reply; only a button nonce can execute a pending
    // change, and without one no action is taken.
    if (TYPED_CONSENT.test(message)) {
      if (deps.store.countPendingConfirmations(claims.sessionId, now().toISOString()) > 0) {
        return deterministicAnswer(
          claims,
          "No action was taken from this message. Use the button on the pending preview, or Cancel to discard it.",
        );
      }
      const prior = deps.store.getRecentMessages(claims.sessionId, 2, true);
      const lastAssistant = [...prior].reverse().find((msg) => msg.role === "assistant");
      const lastResults = (lastAssistant?.payload as { results?: unknown[] } | undefined)?.results ?? [];
      return deterministicAnswer(
        claims,
        lastTurnCompletedAWrite(lastResults)
          ? "No new action was taken. The previous completed change is recorded above."
          : "No action was taken. State the change you want in one fresh message.",
      );
    }

    // SAFETY (finding new-2-affirmative-after-completed-safe): a bare affirmative
    // ("great", "perfect") right after a safe write ALREADY completed — with
    // nothing pending — must not re-plan another write. These acknowledgment-only
    // phrases do not match the typed-consent guard above; here we detect the
    // just-finished write from that turn's persisted
    // receipts and answer deterministically that it's already done. The model
    // never sees the affirmative, so it can't duplicate the action.
    if (BARE_AFFIRMATIVE.test(message)) {
      const prior = deps.store.getRecentMessages(claims.sessionId, 2, true);
      const lastAssistant = [...prior].reverse().find((msg) => msg.role === "assistant");
      const lastResults = (lastAssistant?.payload as { results?: unknown[] } | undefined)?.results ?? [];
      if (lastTurnCompletedAWrite(lastResults)) {
        return deterministicAnswer(
          claims,
          "No new action was taken. The previous completed change is recorded above.",
        );
      }
    }

    return undefined;
  }

  /** Build the bounded, model-visible history for a turn (the HISTORY_WINDOW_MESSAGES filter+map). */
  function buildModelHistory(claims: { sessionId: string }): ModelMessage[] {
    // includePayload so transient model-failure rows (payload.kind="error") can be
    // dropped — the model must never re-read its own "I'm unavailable" turn as
    // conversational fact (finding r2-new-session-restore-05).
    const history = deps.store.getRecentMessages(claims.sessionId, HISTORY_WINDOW_MESSAGES, true);
    return history
      .filter((msg) => msg.role !== "system" && !isTransientErrorMessage(msg))
      .map((msg) =>
        msg.role === "assistant"
          ? { role: "assistant" as const, content: sanitizeStoredReplyForModel(msg.content) }
          : { role: "user" as const, content: msg.content },
      );
  }

  /** The prior turn's unresolved, admin-authored selection context. It lives in
   * the assistant payload (not model text), and is consumed only when that most
   * recent assistant turn was a clarification. */
  function unresolvedClarificationContext(sessionId: string): string | undefined {
    const latest = deps.store.getRecentMessages(sessionId, 1, true)[0];
    if (latest?.role !== "assistant" || !latest.payload || typeof latest.payload !== "object") return undefined;
    const payload = latest.payload as { kind?: unknown; clarificationContext?: unknown };
    return payload.kind === "clarify" && typeof payload.clarificationContext === "string"
      ? payload.clarificationContext
      : undefined;
  }

  function unresolvedRequestContext(
    sessionId: string,
  ): { actionName: "clockify_projects_create"; text: string } | undefined {
    const latest = deps.store.getRecentMessages(sessionId, 1, true)[0];
    if (latest?.role !== "assistant" || !latest.payload || typeof latest.payload !== "object") return undefined;
    const context = (latest.payload as { unresolvedRequestContext?: unknown }).unresolvedRequestContext;
    if (!context || typeof context !== "object" || Array.isArray(context)) return undefined;
    const row = context as { actionName?: unknown; text?: unknown };
    return Object.keys(row).length === 2 && row.actionName === "clockify_projects_create" && typeof row.text === "string"
      ? { actionName: row.actionName, text: row.text }
      : undefined;
  }

  function explicitProjectCreateContinuation(message: string): boolean {
    return /^(?:create|make)\s+(?:it|that)[.!?\s]*$/iu.test(message);
  }

  function containsStandaloneExact(source: string, literal: string): boolean {
    const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(
      `(?:^|[^\\p{L}\\p{M}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{M}\\p{N}_])`,
      "u",
    ).test(source);
  }

  /** Resolve only an explicit, type-matched demonstrative from the directly
   * adjacent successful create turn. The model receives the prior admin's exact
   * text, never assistant prose, receipt data, or the created id. */
  function adjacentCreatedClientContext(sessionId: string, message: string): string | undefined {
    if (!/\b(?:that|this)\s+client\b/iu.test(message)) return undefined;
    const recent = deps.store.getRecentMessages(sessionId, 2, true);
    const [priorUser, priorAssistant] = recent;
    if (recent.length !== 2 || priorUser?.role !== "user" || priorAssistant?.role !== "assistant") return undefined;
    const results = (priorAssistant.payload as { results?: unknown[] } | undefined)?.results;
    if (!Array.isArray(results) || results.length !== 1) return undefined;
    const result = results[0] as {
      kind?: unknown;
      receipt?: {
        ok?: unknown;
        action?: unknown;
        changed?: { created?: Array<{ type?: unknown; id?: unknown; name?: unknown }> };
      };
    };
    const changed = result.receipt?.changed;
    const created = changed?.created;
    const ref = created?.[0];
    if (
      result.kind !== "receipt"
      || result.receipt?.ok !== true
      || result.receipt.action !== "clockify_clients_create"
      || !changed
      || Object.keys(changed).some((bucket) => bucket !== "created")
      || created?.length !== 1
      || ref?.type !== "client"
      || typeof ref.name !== "string"
      || ref.name.length === 0
      || typeof ref.id !== "string"
      || priorUser.content.includes(ref.id)
      || !containsStandaloneExact(priorUser.content, ref.name)
    ) return undefined;
    return priorUser.content;
  }

  /** Resolve an explicit project referent only from the directly adjacent,
   * successful single-project create. As with clients, the only carried text is
   * the prior admin's authored request; receipt ids and assistant prose remain
   * outside the model's authority input. */
  function adjacentCreatedProjectContext(sessionId: string, message: string): string | undefined {
    if (!/\b(?:the|that|this)\s+project\b/iu.test(message)) return undefined;
    const recent = deps.store.getRecentMessages(sessionId, 2, true);
    const [priorUser, priorAssistant] = recent;
    if (recent.length !== 2 || priorUser?.role !== "user" || priorAssistant?.role !== "assistant") return undefined;
    const results = (priorAssistant.payload as { results?: unknown[] } | undefined)?.results;
    if (!Array.isArray(results) || results.length !== 1) return undefined;
    const result = results[0] as {
      kind?: unknown;
      receipt?: {
        ok?: unknown;
        action?: unknown;
        changed?: { created?: Array<{ type?: unknown; id?: unknown; name?: unknown }> };
      };
    };
    const changed = result.receipt?.changed;
    const created = changed?.created;
    const ref = created?.[0];
    if (
      result.kind !== "receipt"
      || result.receipt?.ok !== true
      || result.receipt.action !== "clockify_projects_create"
      || !changed
      || Object.keys(changed).some((bucket) => bucket !== "created")
      || created?.length !== 1
      || ref?.type !== "project"
      || typeof ref.name !== "string"
      || ref.name.length === 0
      || typeof ref.id !== "string"
      || priorUser.content.includes(ref.id)
      || !containsStandaloneExact(priorUser.content, ref.name)
    ) return undefined;
    return priorUser.content;
  }

  /**
   * Tool subsetting (LLM_TOOL_SELECT=1): show the model only the actions relevant
   * to THIS message (+ the always-on core), for weak-model consistency. OFF ⇒
   * undefined tools/full catalog (byte-identical). The harness still validates and
   * gates every proposed action — subsetting changes only what the model SEES.
   * Recall-risk inputs fail open to the full catalog. `subsetNarrowed` is true only
   * for an actual strict subset, so only a narrowed turn that executed NOTHING is a
   * possible recall miss worth a full-catalog retry.
   */
  function deriveToolSubset(message: string, intentCapability?: IntentCapabilityRecord): {
    subsetTools: ReturnType<typeof toolsForModel>;
    subsetCatalog: ReturnType<typeof catalogForModel>;
    subsetNarrowed: boolean;
    fullIntentTools: ReturnType<typeof toolsForModel>;
    fullIntentCatalog: ReturnType<typeof catalogForModel>;
  } {
    const fullIntentCatalog = intentCapability
      ? filterCatalogByIntentCapability(catalogForModel(), intentCapability.capability)
      : catalogForModel();
    const fullIntentNames = new Set(fullIntentCatalog.map((entry) => entry.name));
    const selectedNames = deps.config.llmToolSelect
      ? new Set(selectActionsForMessage(message).filter((name) => fullIntentNames.has(name)))
      : fullIntentNames;
    return {
      subsetTools: toolsForModel(selectedNames),
      subsetCatalog: catalogForModel(selectedNames),
      subsetNarrowed: selectedNames.size < fullIntentNames.size,
      fullIntentTools: toolsForModel(fullIntentNames),
      fullIntentCatalog,
    };
  }

  /**
   * Run the model turn — owns BOTH the agentic tool-loop and the single-turn planner
   * paths. Returns `{ replyKind, baseText }` to settle into a reply, or `{ failed: true }`
   * when the model/transport threw (the caller surfaces `modelUnavailable`). The two
   * paths keep DISTINCT "produced nothing" predicates and execute their actions
   * separately — they are NOT merged (that would double the side effects).
   */
  async function runModelTurn(args: {
    m: TurnMachinery;
    messages: ModelMessage[];
    policy: AdminPolicy;
    tracked: ReturnType<typeof trackUsage>;
    subsetTools: ReturnType<typeof toolsForModel> | undefined;
    subsetCatalog: ReturnType<typeof catalogForModel>;
    subsetNarrowed: boolean;
    fullIntentTools: ReturnType<typeof toolsForModel>;
    fullIntentCatalog: ReturnType<typeof catalogForModel>;
    signal?: AbortSignal;
  }): Promise<
    | { replyKind: string; baseText: string }
    | { failed: true; code: "model_unavailable" | "provider_protocol_error" }
  > {
    const {
      m,
      messages,
      policy,
      tracked,
      subsetTools,
      subsetCatalog,
      subsetNarrowed,
      fullIntentTools,
      fullIntentCatalog,
      signal,
    } = args;
    const useTools = deps.config.llmMode !== "json";
    // The server clock's date so the model narrates the real date instead of its
    // stale knowledge cutoff (finding new-3: "we're still in 2025"). Hoisted once —
    // both paths read the SAME instant.
    const currentDate = now().toISOString().slice(0, 10);

    if (deps.config.llmAgentic && useTools && typeof deps.modelClient.completeWithTools === "function") {
      // Agentic turn (LLM_AGENTIC=1): the durable tool-loop. Reads + safe writes
      // auto-chain with their receipts fed back to the model; the FIRST risky
      // write interrupts into the preview→button-confirm flow with its suspended
      // transcript persisted, so the confirm route can resume the loop.
      const runAgentic = (tools: ReturnType<typeof toolsForModel> | undefined): Promise<AgentTurnResult> =>
        runAgentConversation({
          modelClient: tracked.client,
          messages,
          policy,
          authClass: m.ctx.clockify.authClass,
          currentDate,
          tools,
          runAction: m.runAction,
          onStep: m.onStep,
          signal,
        });
      let turn: AgentTurnResult;
      try {
        turn = await runAgentic(subsetTools);
        // Recall escape hatch: a NARROWED turn that finished without executing
        // anything may have had the needed tool hidden. Retry ONCE with the full
        // catalog. Side-effect-free — guarded on `m.results.length === 0` AFTER
        // execution, so no read/write is ever duplicated; never fires for smalltalk
        // (not narrowed). (This predicate gates AFTER execution; the single-turn one
        // gates BEFORE — keep them distinct.)
        if (subsetNarrowed && m.results.length === 0 && (turn.kind === "final" || turn.kind === "exhausted")) {
          turn = await runAgentic(fullIntentTools);
        }
      } catch (error) {
        return {
          failed: true,
          code: error instanceof ProviderProtocolError
            ? "provider_protocol_error"
            : "model_unavailable",
        };
      }
      return settleAgentTurn(m, turn);
    }

    const runPlan = (catalog: ReturnType<typeof catalogForModel>, tools: ReturnType<typeof toolsForModel> | undefined) =>
      planConversation({
        modelClient: tracked.client,
        messages,
        actionCatalog: catalog,
        policy,
        authClass: m.ctx.clockify.authClass,
        currentDate,
        tools,
        // Native tool-calling by default (provider validates args); LLM_MODE=json
        // forces the JSON + repair path. The harness re-validates either way.
        useTools,
        signal,
      });
    let plan;
    try {
      plan = await runPlan(subsetCatalog, subsetTools);
      if (signal?.aborted) return { replyKind: "aborted", baseText: "" };
      // Recall escape hatch (mirrors the agentic path): a NARROWED turn that
      // proposed no action may have hidden the needed tool — re-plan ONCE with the
      // full catalog before executing (nothing has run yet → no double side effects).
      // (This predicate gates BEFORE the action loop; the agentic one gates AFTER —
      // keep them distinct.)
      if (subsetNarrowed && plan.kind !== "actions") {
        plan = await runPlan(fullIntentCatalog, fullIntentTools);
        if (signal?.aborted) return { replyKind: "aborted", baseText: "" };
      }
    } catch (error) {
      return signal?.aborted
        ? { replyKind: "aborted", baseText: "" }
        : {
            failed: true,
            code: error instanceof ProviderProtocolError
              ? "provider_protocol_error"
              : "model_unavailable",
          };
    }

    let emittedClarify = false;
    if (plan.kind === "actions" && plan.actions) {
      for (const proposed of plan.actions) {
        if (signal?.aborted) return { replyKind: "aborted", baseText: "" };
        // The single-turn path runs each proposed action through the same
        // machinery: a throwing action becomes an audited error receipt, a
        // risky one becomes a pending preview (no agent state — no resume).
        const outcome = await m.runAction({ id: "", name: proposed.name, arguments: proposed.arguments });
        if (outcome.kind === "receipt") {
          m.auditAndEmitReceipt(proposed.name, outcome.receipt, outcome.operationId);
        } else if (outcome.kind === "partial") {
          m.auditAndEmitPartial(proposed.name, outcome, outcome.operationId);
          break;
        } else if (outcome.kind === "clarify") {
          const descriptor = { kind: "clarify", message: outcome.message, options: outcome.options };
          m.emit(descriptor, { kind: "inline", descriptor });
          emittedClarify = true;
          break;
        } else {
          m.emitPreviewFor(outcome.preview, outcome.operation);
          break;
        }
      }
    }
    // fix-clarify-double-render: when a single-turn action resolved to a
    // clarify, that grounded message is ALREADY in results[]. The model's
    // pre-action narration (`plan.text`) can echo it VERBATIM — keeping it in
    // reply.text would render the clarify twice (the clarify bubble AND the
    // assistant reply bubble). Mirror settleAgentTurn: drop the narration so the
    // clarify rides ONLY in results[]. (Previews still override via
    // truthfulReplyText, so this never weakens the truthful-preview path.)
    return { replyKind: plan.kind, baseText: emittedClarify ? "" : plan.text };
  }

  async function executeChatTurn(
    claims: { sessionId: string; workspaceId: string; adminUserId: string },
    installation: Installation,
    message: string,
    onResult?: (result: unknown) => void,
    onStatus?: (status: { action: string; label: string }) => void,
    signal?: AbortSignal,
    requestId?: string,
  ): Promise<ChatTurnOutcome> {
    const aborted = (results: unknown[] = [], resultLinks: DurableResultLink[] = []): ChatTurnOutcome => ({
      ok: true,
      replyKind: "aborted",
      replyText: "",
      results,
      resultLinks,
    });
    let turnSignal: AbortSignal;
    try {
      // Unlike a mutation lease, this observer is NOT part of uninstall's drain:
      // revocation cancels provider work immediately, while only already-
      // dispatched-capable mutations may delay erasure for truthful settlement.
      turnSignal = mutationCoordinator.observe(
        claims.workspaceId,
        installation.generation,
        signal,
      );
    } catch (error) {
      if (error instanceof WorkspaceMutationRevokedError) return aborted();
      throw error;
    }
    if (!turnAuthorityCurrent(claims, installation, turnSignal)) return aborted();
    const priorClarificationContext = unresolvedClarificationContext(claims.sessionId);
    const failedRequestCandidate = priorClarificationContext ? undefined : unresolvedRequestContext(claims.sessionId);
    const priorFailedRequestContext = failedRequestCandidate &&
      failedRequestCandidate.actionName === "clockify_projects_create" &&
      explicitProjectCreateContinuation(message)
      ? failedRequestCandidate.text
      : undefined;
    const adjacentReferentContext = priorClarificationContext || priorFailedRequestContext
      ? undefined
      : adjacentCreatedClientContext(claims.sessionId, message)
        ?? adjacentCreatedProjectContext(claims.sessionId, message);
    const priorAuthoredContext = priorClarificationContext ?? priorFailedRequestContext ?? adjacentReferentContext;
    const requireCurrentActionSpan = !priorClarificationContext && priorAuthoredContext !== undefined;
    const selectionContext = combineSelectionContext(priorAuthoredContext, message);
    // The user message is persisted BEFORE the deterministic guards so even a
    // short-circuited turn keeps a faithful transcript record.
    deps.store.addMessage({
      sessionId: claims.sessionId,
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      role: "user",
      content: message,
    });

    // Deterministic short-circuits (whitespace → typed-consent → bare-affirmative)
    // never reach a model and so never reach recordTurn().
    const shortCircuit = shortCircuitReply(claims, message);
    if (shortCircuit) return shortCircuit;

    // The declaration is the FIRST provider pass. Its input contains only exact
    // admin-authored current/unresolved text plus the write allowlist/catalog
    // hash — never chat history, assistant prose, or Clockify results.
    const turnStartMs = now().getTime();
    const tracked = trackUsage(deps.modelClient, now);
    const effectiveRequestId = requestId ?? randomUUID();
    let intentCapability: IntentCapabilityRecord | undefined;
    if (intentCapabilitiesEnforced) {
      const writeActionNames = catalogForModel()
        .filter((entry) => entry.risks.some((risk) => risk !== "read"))
        .map((entry) => entry.name);
      const candidateWriteActionNames = buildCandidateWriteActionNames(selectionContext, writeActionNames);
      let declaredCapability;
      try {
        declaredCapability = await declareIntentCapability({
          modelClient: tracked.client,
          currentText: message,
          ...(priorAuthoredContext ? { unresolvedPriorText: priorAuthoredContext } : {}),
          ...(requireCurrentActionSpan ? { requireCurrentActionSpan: true } : {}),
          writeActionNames,
          candidateWriteActionNames,
          catalogHash: catalogHash(),
          signal: turnSignal,
        });
      } catch {
        if (turnSignal.aborted) {
          recordTurnTelemetrySafely(
            claims,
            "chat",
            tracked.usage,
            now().getTime() - turnStartMs,
            installation,
            turnSignal,
          );
          return aborted();
        }
        throw new Error("intent_declaration_failed");
      }
      // The provider may ignore AbortSignal. Reload durable authority after the
      // await and immediately before the non-FK capability insert.
      if (!turnAuthorityCurrent(claims, installation, turnSignal)) return aborted();
      intentCapability = deps.store.createIntentCapability({
        workspaceId: claims.workspaceId,
        adminUserId: claims.adminUserId,
        sessionId: claims.sessionId,
        requestId: effectiveRequestId,
        authoredSource: canonicalIntentAuthoredSource({
          currentText: message,
          ...(priorAuthoredContext ? { unresolvedPriorText: priorAuthoredContext } : {}),
        }),
        capability: declaredCapability,
      });
    }

    const policy = loadPolicy(claims.workspaceId, claims.adminUserId);
    const messages = buildModelHistory(claims);
    const {
      subsetTools,
      subsetCatalog,
      subsetNarrowed,
      fullIntentTools,
      fullIntentCatalog,
    } = deriveToolSubset(selectionContext, intentCapability);

    const m = createTurnMachinery(
      claims,
      installation,
      onResult,
      onStatus,
      effectiveRequestId,
      undefined,
      selectionContext,
      intentCapability,
      turnSignal,
    );

    // Cost/latency telemetry: every model-touching turn records one row (the
    // deterministic early returns above never reach here — no model, no row).
    const recordTurn = (): void => {
      recordTurnTelemetrySafely(
        claims,
        "chat",
        tracked.usage,
        now().getTime() - turnStartMs,
        installation,
        turnSignal,
      );
    };

    // A model/transport failure must never crash the server. Surface a calm,
    // non-leaking message and let the admin retry.
    const modelUnavailable = (): ChatTurnOutcome => {
      recordTurn(); // failures cost latency too
      const errorText = "The assistant is temporarily unavailable. Please try again.";
      deps.store.addMessage({
        sessionId: claims.sessionId,
        workspaceId: claims.workspaceId,
        adminUserId: claims.adminUserId,
        role: "assistant",
        content: errorText,
        payload: { kind: "error" },
      });
      return { ok: false, code: "model_unavailable", message: errorText };
    };

    const providerProtocolFailure = (): ChatTurnOutcome => {
      recordTurn();
      const errorText = "The model provider returned an invalid tool response. No change was made. Please try again.";
      deps.store.addMessage({
        sessionId: claims.sessionId,
        workspaceId: claims.workspaceId,
        adminUserId: claims.adminUserId,
        role: "assistant",
        content: errorText,
        payload: { kind: "error", code: "provider_protocol_error" },
      });
      return { ok: false, code: "provider_protocol_error", message: errorText };
    };

    // A provider failure after one or more settled actions is not a failed turn:
    // those receipts are already canonical and a safe write may already exist on
    // Clockify. Preserve them, avoid a duplicate-inviting retry response, and use
    // deterministic server copy instead of any incomplete provider narration.
    const settledModelFailure = (
      failureCode: "model_unavailable" | "provider_protocol_error",
    ): ChatTurnOutcome => {
      recordTurn();
      const appliedMutation = m.results.some((result) => {
        if (!result || typeof result !== "object" || Array.isArray(result)) return false;
        const receipt = (result as { kind?: unknown; receipt?: SuccessReceipt | ErrorReceipt }).receipt;
        return (result as { kind?: unknown }).kind === "receipt" &&
          receipt?.ok === true && hasChanges(receipt.changed);
      });
      const protocolFailure = failureCode === "provider_protocol_error";
      const replyText = protocolFailure
        ? appliedMutation
          ? "The completed change is recorded above. The response then ended with provider_protocol_error (an invalid model-provider tool response). Review the receipt before requesting any unfinished work."
          : "The completed results are shown above. The response then ended with provider_protocol_error (an invalid model-provider tool response)."
        : appliedMutation
          ? "The completed change is recorded above, but the assistant could not finish the rest of the response. Review the receipt before requesting any unfinished work."
          : "The completed results are shown above, but the assistant could not finish the response.";
      persistAssistantReply(
        claims,
        "partial",
        replyText,
        m.results,
        m.resultLinks,
        selectionContext,
        protocolFailure ? "provider_protocol_error" : undefined,
      );
      return {
        ok: true,
        replyKind: "partial",
        replyText,
        results: m.results,
        resultLinks: m.resultLinks,
      };
    };

    const turn = await runModelTurn({
      m,
      messages,
      policy,
      tracked,
      subsetTools,
      subsetCatalog,
      subsetNarrowed,
      fullIntentTools,
      fullIntentCatalog,
      signal: turnSignal,
    });
    // Agentic providers may resolve after ignoring AbortSignal, including a
    // text-only completion for which the loop has no further boundary. Reload
    // durable authority before any unleased reply/telemetry persistence.
    // Mutation results already truthfully settled under a draining lease remain
    // in `m.results` so an already-dispatched outcome is never concealed.
    if (!turnAuthorityCurrent(claims, installation, turnSignal)) {
      return aborted(m.results, m.resultLinks);
    }
    if ("failed" in turn) {
      if (m.results.length > 0) return settledModelFailure(turn.code);
      return turn.code === "provider_protocol_error"
        ? providerProtocolFailure()
        : modelUnavailable();
    }
    const { replyKind, baseText } = turn;

    // Client disconnected mid-turn (settleAgentTurn → "aborted"): the socket is gone.
    // Both planner paths check the signal before every not-yet-dispatched action, but
    // never pass it into a Clockify mutation once dispatch starts. Persist no abandoned
    // reply; any earlier completed result still has its own canonical journal/receipt.
    if (replyKind === "aborted") {
      return { ok: true, replyKind, replyText: "", results: m.results, resultLinks: m.resultLinks };
    }

    // The truthful-preview override (see truthfulReplyText): a pending preview
    // replaces the model's text. The streaming route emits this replyText AFTER
    // the results — the truthful text isn't known until execution finishes.
    const writeAuthorityUnresolved = intentCapability?.capability.mode === "deny_all_writes" &&
      (intentCapability.capability.reason !== "no_write_intent" || hasExplicitWriteRequest(selectionContext));
    const capabilityAuthorityFailures = m.results.flatMap((result) => {
      const receipt = (result as { kind?: unknown; receipt?: { ok?: unknown; code?: unknown } } | undefined)?.receipt;
      return receipt?.ok === false && typeof receipt.code === "string" && receipt.code.startsWith("intent_capability_")
        ? [receipt as { ok: false; code: string; action?: unknown }]
        : [];
    });
    const projectCreateGrant = intentCapability?.capability.mode === "allow"
      ? intentCapability.capability.writeActions.find((grant) =>
          grant.actionName === "clockify_projects_create" && grant.sourceSpans.length > 0)
      : undefined;
    const replyText = truthfulReplyText(m.results, baseText, replyKind, {
      writeIntentDeclared: intentCapability?.capability.mode === "allow" &&
        intentCapability.capability.writeActions.length > 0,
      writeAuthorityUnresolved,
    });
    persistAssistantReply(
      claims,
      replyKind,
      replyText,
      m.results,
      m.resultLinks,
      selectionContext,
      undefined,
      !priorAuthoredContext && capabilityAuthorityFailures.length === 1 &&
        capabilityAuthorityFailures[0]?.action === "clockify_projects_create" && projectCreateGrant
        ? { actionName: "clockify_projects_create", text: selectionContext }
        : undefined,
    );
    recordTurn();
    return { ok: true, replyKind, replyText, results: m.results, resultLinks: m.resultLinks };
  }

  async function chatPreconditions(req: Request, res: Response): Promise<ChatPreconditions | undefined> {
    const claims = await requireSession(req, res);
    if (!claims) return undefined;
    // Rate-limit BEFORE parsing/persisting anything — a limited turn never
    // stores the user message nor opens the NDJSON stream.
    const limited = chatLimiter.check(claims.sessionId, now().getTime());
    if (!limited.allowed) {
      res.setHeader("Retry-After", String(Math.ceil(limited.retryAfterMs / 1000)));
      res.status(429).json({
        ok: false,
        code: "rate_limited",
        message: "You're sending messages too quickly — please wait a moment and try again.",
      });
      return undefined;
    }
    const parsed = chatBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, code: "invalid_args", message: "A message is required." });
      return undefined;
    }
    if (!parsed.data.requestId && deps.config.nodeEnv !== "test") {
      res.status(400).json({ ok: false, code: "invalid_args", message: "A client-generated requestId UUID is required." });
      return undefined;
    }
    const installation = deps.store.getInstallation(claims.workspaceId);
    if (!installation || installation.status !== "active") {
      res.status(409).json({ ok: false, code: "not_installed", message: "The add-on is not active for this workspace." });
      return undefined;
    }
    const requestId = parsed.data.requestId ?? randomUUID();
    const intentHash = createHash("sha256").update(parsed.data.message).digest("hex");
    const claim = deps.store.claimTurnRun({
      requestId,
      sessionId: claims.sessionId,
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      intentHash,
    });
    if (claim.state === "conflict") {
      res.status(409).json({
        ok: false,
        code: "operation_id_conflict",
        message: "This requestId was already used for a different chat intent.",
      });
      return undefined;
    }
    if (claim.state === "in_flight") {
      res.status(409).json({
        ok: false,
        code: "operation_in_progress",
        message: "This request is already in progress.",
      });
      return undefined;
    }
    if (claim.state === "outcome_unknown") {
      res.status(409).json({
        ok: false,
        code: "operation_outcome_unknown",
        message: "The prior request was interrupted and its outcome is unknown.",
      });
      return undefined;
    }
    if (claim.state === "replay") {
      const storedResponse = claim.response as { status: number; body: unknown };
      const storedBody = storedResponse.body && typeof storedResponse.body === "object"
        ? storedResponse.body as Record<string, unknown>
        : undefined;
      const storedResults = Array.isArray(storedBody?.results) ? storedBody.results : [];
      const replayResults: unknown[] = [];
      for (const result of storedResults) {
        const previewId = result && typeof result === "object" && (result as { kind?: unknown }).kind === "preview"
          ? (result as { previewId?: unknown }).previewId
          : undefined;
        if (typeof previewId !== "string") {
          replayResults.push(result);
          continue;
        }
        const record = deps.store.getPendingConfirmation(previewId);
        if (
          !record ||
          record.status !== "pending" ||
          record.sessionId !== claims.sessionId ||
          record.workspaceId !== claims.workspaceId ||
          record.adminUserId !== claims.adminUserId
        ) {
          continue;
        }
        const rotated = rotatePendingNonce({
          record,
          sessionId: claims.sessionId,
          workspaceId: claims.workspaceId,
          adminUserId: claims.adminUserId,
          sessionSecret: deps.config.sessionSecret,
          now: now(),
        });
        if (!rotated.ok) {
          if (rotated.code === "expired") deps.store.expireConfirmation(record.id);
          continue;
        }
        if (!deps.store.updateConfirmationNonceHash(record.id, rotated.record.nonceHash)) continue;
        replayResults.push({ ...result as object, nonce: rotated.nonce });
      }
      return {
        claims,
        installation,
        message: parsed.data.message,
        requestId,
        replay: storedBody
          ? { ...storedResponse, body: { ...storedBody, results: replayResults } }
          : storedResponse,
      };
    }
    deps.store.markTurnRunExecuting(claims.sessionId, requestId);
    return { claims, installation, message: parsed.data.message, requestId };
  }

  return {
    loadPolicy,
    requireSession,
    verifyWriteAuthority,
    newChatAllowed,
    actionContext,
    runResume,
    commitConfirmation,
    executeChatTurn,
    chatPreconditions,
  };
}
