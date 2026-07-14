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
import type { ActionContext, ActionResult, ConfirmableOperation, PreviewCard } from "../harness/action.js";
import type { AtomicIdempotencyLedger } from "../harness/idempotency.js";
import { reversibleCreations } from "../harness/undo.js";
import { actionFingerprint, catalogForModel, catalogHash, getAction } from "../harness/catalog.js";
import { actionStatusLabel } from "../harness/action-labels.js";
import { canWrite, defaultAdminPolicy, type AdminPolicy } from "../harness/permissions.js";
import {
  confirmPending,
  createPendingConfirmation,
  hashOperation,
  rotatePendingNonce,
} from "../harness/confirmations.js";
import { errorReceipt, type SuccessReceipt, type ErrorReceipt } from "../harness/receipts.js";
import { runAgentTurn, type AgentStep, type AgentTurnResult } from "../assistant/agent-loop.js";
import { parseAgentState, resumeMessages, type AgentState } from "../assistant/agent-state.js";
import type { ModelMessage, ToolCall } from "../assistant/model-client.js";
import { planConversation, runAgentConversation } from "../assistant/planner.js";
import { trackUsage, type TurnUsage } from "../assistant/usage.js";
import { toolsForModel } from "../harness/tools.js";
import { selectActionsForMessage } from "../harness/tool-select.js";
import type { Installation } from "../db/store.js";
import type { ActionResultKind, ActionResultRef, DurableResultLink } from "../db/store.js";
import type { CalendarContext } from "../clockify/ports/users.js";
import { CLAIM_TTL_MS } from "../db/store.js";
import { resolveSession, type AppDeps } from "./deps.js";
import { createRoleRechecker } from "../auth/role-recheck.js";
import type { SessionClaims } from "../auth/sessions.js";
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
      undoId: string | undefined;
      agentState: AgentState | undefined;
      installation: Installation | undefined;
      persistenceDegraded?: true;
    };

export type WriteAuthorityOutcome =
  | { ok: true }
  | { ok: false; status: 403 | 503; code: "admin_required" | "role_verification_unavailable"; message: string };

export interface ChatPipeline {
  loadPolicy: (workspaceId: string, adminUserId: string) => AdminPolicy;
  requireSession: (req: Request, res: Response) => Promise<SessionClaims | undefined>;
  verifyWriteAuthority: (claims: Claims, installation?: Installation) => Promise<WriteAuthorityOutcome>;
  /** Per-admin budget for creating fresh sessions (POST /chat/new) — bounds resetting
   *  the per-session paid-loop limit by minting sessions. Keyed by workspace+admin. */
  newChatAllowed: (workspaceId: string, adminUserId: string) => RateLimitDecision;
  actionContext: (workspaceId: string, adminUserId: string, installation: Installation, sessionId?: string) => ActionContext;
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

  const roleRechecker = createRoleRechecker(
    deps.config.roleRecheckTtlMs ?? 60_000,
    () => now().getTime(),
  );

  function loadPolicy(workspaceId: string, adminUserId: string): AdminPolicy {
    return deps.store.getAdminPolicy(workspaceId, adminUserId) ?? defaultAdminPolicy();
  }

  async function requireSession(req: Request, res: Response): Promise<SessionClaims | undefined> {
    const claims = resolveSession(req, deps);
    if (!claims) {
      res.status(401).json({ ok: false, code: "unauthorized", message: "No valid session." });
      return undefined;
    }
    if (deps.config.roleRecheckEnabled) {
      // Re-verify the caller is STILL a Clockify admin/owner (authz-surface-01).
      // Cached per (workspace, admin); a Clockify outage fails OPEN (no verdict),
      // bounded by the session TTL. Only an explicit non-admin verdict denies.
      const installation = deps.store.getInstallation(claims.workspaceId);
      if (installation && installation.status === "active") {
        const live = await roleRechecker.check(
          claims.workspaceId,
          claims.adminUserId,
          deps.clockifyForWorkspace(installation),
        );
        if (live === "non_admin") {
          deps.store.invalidateAdminSessions(claims.workspaceId, claims.adminUserId);
          res.status(403).json({ ok: false, code: "forbidden", message: "Admin access is required." });
          return undefined;
        }
        // An ordinary read retains the configured cached/fail-open posture. Every
        // mutation separately calls verifyWriteAuthority and fails closed.
      }
    }
    return claims;
  }

  async function verifyWriteAuthority(
    claims: Claims,
    suppliedInstallation?: Installation,
  ): Promise<WriteAuthorityOutcome> {
    const installation = suppliedInstallation ?? deps.store.getInstallation(claims.workspaceId);
    if (!installation || installation.status !== "active") {
      return {
        ok: false,
        status: 503,
        code: "role_verification_unavailable",
        message: "Your current Clockify admin role could not be verified. No change was made.",
      };
    }
    const verdict = await roleRechecker.check(
      claims.workspaceId,
      claims.adminUserId,
      deps.clockifyForWorkspace(installation),
      { force: true },
    );
    if (verdict === "admin") return { ok: true };
    if (verdict === "non_admin") {
      deps.store.invalidateAdminSessions(claims.workspaceId, claims.adminUserId);
      return {
        ok: false,
        status: 403,
        code: "admin_required",
        message: "Clockify admin or owner access is required. Your assistant sessions were ended.",
      };
    }
    return {
      ok: false,
      status: 503,
      code: "role_verification_unavailable",
      message: "Your current Clockify admin role could not be verified. No change was made.",
    };
  }

  function actionContext(
    workspaceId: string,
    adminUserId: string,
    installation: Installation,
    sessionId?: string,
  ): ActionContext {
    return {
      workspaceId,
      adminUserId,
      policy: loadPolicy(workspaceId, adminUserId),
      clockify: deps.clockifyForWorkspace(installation),
      now,
      savePolicy: (policy) => deps.store.upsertAdminPolicy(workspaceId, adminUserId, policy),
      recentOutcomes: (sinceIso) => ({
        outcomes: deps.store.listActionOutcomes(workspaceId, adminUserId, sinceIso),
        confirmationStatuses: deps.store.listConfirmationOutcomes(workspaceId, adminUserId, sinceIso),
      }),
      authorizeWrite: async (actionName) => {
        const verdict = await verifyWriteAuthority({ workspaceId, adminUserId, sessionId: "" }, installation);
        return verdict.ok
          ? undefined
          : errorReceipt({
              action: actionName,
              code: verdict.code,
              message: verdict.message,
              recovery: { hint: "Restore admin access or retry after Clockify is reachable.", retryable: verdict.status === 503 },
            });
      },
      ...(sessionId
        ? {
            saveArtifact: (artifact: { contentType: string; filename: string; bytes: Uint8Array }) =>
              deps.store.createArtifact({
                workspaceId,
                adminUserId,
                sessionId,
                ...artifact,
              }),
          }
        : {}),
    };
  }

  /** Record a one-use undo for a successful reversible creation; return its id. */
  function recordUndoIfReversible(
    claims: { sessionId: string; workspaceId: string; adminUserId: string },
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
  ): TurnMachinery {
    const results: unknown[] = [];
    const resultLinks: DurableResultLink[] = [];
    const emit = (result: unknown, link: DurableResultLink): void => {
      results.push(result);
      resultLinks.push(link);
      onResult?.(result);
    };
    const baseCtx = {
      ...actionContext(claims.workspaceId, claims.adminUserId, installation, claims.sessionId),
      ...(calendar ?? {}),
    };
    const ctx: ActionContext = requestId
      ? {
          ...baseCtx,
          operationJournal: {
            prepare(actionName, actionArgs) {
              return deps.store.prepareOperationRun({
                requestId,
                sessionId: claims.sessionId,
                workspaceId: claims.workspaceId,
                adminUserId: claims.adminUserId,
                actionName,
                actionFingerprint: actionFingerprint(actionName) ?? hashOperation({ actionName }),
                catalogHash: catalogHash(),
                operationHash: hashOperation({ actionName, args: actionArgs }),
              });
            },
            markExecuting(operationId) {
              if (!deps.store.markOperationExecuting(operationId)) throw new Error("operation_not_prepared");
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

    // Every executed action — success or error, single-turn or agentic — is
    // audited under the catalog's risk labels and offered an undo if reversible.
    const auditAndEmitReceipt = (actionName: string, receipt: SuccessReceipt | ErrorReceipt, operationId?: string): void => {
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
        undoId = recordUndoIfReversible(claims, receipt);
      });
      const canonicalResult = {
        kind: "receipt" as const,
        receipt,
        ...(undoId ? { undo: { id: undoId } } : {}),
      };
      const resultRef = operationId
        ? deps.store.settleOperationResult(operationId, status, canonicalResult)
        : deps.store.recordActionResult({
            workspaceId: claims.workspaceId,
            adminUserId: claims.adminUserId,
            sessionId: claims.sessionId,
            actionName,
            status,
            result: canonicalResult,
          });
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
    };

    const auditAndEmitPartial = (
      actionName: string,
      result: Extract<ActionResult, { kind: "partial" }>,
      operationId?: string,
    ): void => {
      let undoId: string | undefined;
      bestEffort("partial-result undo bookkeeping failed", () => {
        undoId = recordUndoIfReversible(claims, result.receipt);
      });
      const canonicalResult = { ...result, ...(undoId ? { undo: { id: undoId } } : {}) };
      delete canonicalResult.operationId;
      const resultRef = operationId
        ? deps.store.settleOperationResult(operationId, "partial", canonicalResult)
        : deps.store.recordActionResult({
            workspaceId: claims.workspaceId,
            adminUserId: claims.adminUserId,
            sessionId: claims.sessionId,
            actionName,
            status: "partial",
            result: canonicalResult,
          });
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
    };

    // An agentic interrupt persists its suspended transcript alongside the
    // pending confirmation (Phase 3) so the confirm route can resume the loop.
    const emitPreviewFor = (preview: PreviewCard, operation: ConfirmableOperation, agentState?: AgentState): void => {
      const created = createPendingConfirmation({
        sessionId: claims.sessionId,
        workspaceId: claims.workspaceId,
        adminUserId: claims.adminUserId,
        risk: operation.risks,
        preview,
        operation,
        sessionSecret: deps.config.sessionSecret,
        now: now(),
        agentState: agentState && selectionContext
          ? { ...agentState, selectionContext }
          : agentState,
        actionFingerprint: actionFingerprint(operation.actionName),
        catalogHash: catalogHash(),
      });
      deps.store.prepareOperationRun({
        id: created.record.operationId,
        confirmationId: created.record.id,
        sessionId: claims.sessionId,
        workspaceId: claims.workspaceId,
        adminUserId: claims.adminUserId,
        actionName: operation.actionName,
        actionFingerprint: created.record.actionFingerprint,
        catalogHash: created.record.catalogHash,
        operationHash: created.record.operationHash,
      });
      deps.store.savePendingConfirmation(created.record);
      const livePreview = {
        kind: "preview",
        previewId: created.previewId,
        nonce: created.nonce,
        expiresAt: created.expiresAt,
        preview,
      };
      const { nonce: _nonce, ...descriptor } = livePreview;
      emit(livePreview, { kind: "preview", descriptor });
    };

    // Execute one model tool call through the harness trust boundary; an action
    // that throws becomes an error receipt (also fed back to the model), never a
    // crash.
    const runAction = async (call: ToolCall): Promise<ActionResult> => {
      // Progress status BEFORE execution (a 30-120s agentic turn otherwise looks
      // frozen). Label derived from the action NAME only — args can carry admin
      // text and never ride a status line. Ephemeral: never persisted/audited.
      onStatus?.({ action: call.name, label: actionStatusLabel(call.name) });
      try {
        return await executeAction({ actionName: call.name, args: call.arguments, context: ctx });
      } catch (err) {
        return {
          kind: "receipt",
          receipt: errorReceipt({
            action: call.name,
            code: "action_failed",
            message: err instanceof Error ? err.message.slice(0, 200) : "The action could not be completed.",
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

    return { ctx, results, resultLinks, emit, auditAndEmitReceipt, auditAndEmitPartial, emitPreviewFor, runAction, onStep };
  }

  function persistAssistantReply(
    claims: Claims,
    replyKind: string,
    replyText: string,
    results: unknown[],
    resultLinks: DurableResultLink[],
    clarificationContext?: string,
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
        },
        resultLinks,
      });
    } catch (error) {
      console.error(
        "assistant-reply persistence failed (turn already executed; reply preserved):",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /** Telemetry must never break a turn — best-effort write, swallow failures. */
  function recordTurnTelemetrySafely(claims: Claims, kind: "chat" | "resume", usage: TurnUsage, turnMs: number): void {
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
      !installation ||
      installation.status !== "active" ||
      !deps.config.llmAgentic ||
      deps.config.llmMode === "json" ||
      typeof deps.modelClient.completeWithTools !== "function"
    ) {
      return undefined;
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
    const calendar = await deps.clockifyForWorkspace(installation).getCalendarContext(claims.adminUserId).catch(() => undefined);
    const resumeSelectionContext = agentState.selectionContext ?? lastUserMessage(agentState.transcript);
    const m = createTurnMachinery(
      claims,
      installation,
      onResult,
      onStatus,
      undefined,
      calendar,
      resumeSelectionContext,
    );
    const resumeStartMs = now().getTime();
    const tracked = trackUsage(deps.modelClient, now);
    // STEP 6: subset the resume too, using the admin-authored selection context
    // persisted with the suspended agent state. This includes unresolved
    // clarification context, so a terse follow-up cannot hide the original domain.
    // Recall-risk inputs (no lexical match, non-ASCII, or >3 matched areas) already
    // fail open to the full catalog. There is deliberately no post-resume retry: a
    // no-tool result is the normal "done" narration and must not double provider cost.
    const resumeTools = deps.config.llmToolSelect
      ? toolsForModel(new Set(selectActionsForMessage(resumeSelectionContext)))
      : toolsForModel();
    let turn: AgentTurnResult | undefined;
    try {
      turn = await runAgentTurn({
        modelClient: tracked.client,
        messages: resumeMessages(agentState, receipt),
        tools: resumeTools,
        runAction: m.runAction,
        onStep: m.onStep,
        signal,
      });
    } catch {
      // The commit already happened and its receipt is returned regardless; a
      // model failure here only loses the follow-up narration.
      recordTurnTelemetrySafely(claims, "resume", tracked.usage, now().getTime() - resumeStartMs);
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
    const replyText = truthfulReplyText(resultsForTruthfulness, baseText, replyKind);
    persistAssistantReply(
      claims,
      replyKind,
      replyText,
      m.results,
      m.resultLinks,
      resumeSelectionContext,
    );
    recordTurnTelemetrySafely(claims, "resume", tracked.usage, now().getTime() - resumeStartMs);
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

    const installation = deps.store.getInstallation(claims.workspaceId);
    const authority = await verifyWriteAuthority(claims, installation);
    if (!authority.ok) {
      return {
        ok: false,
        status: authority.status,
        body: { ok: false, code: authority.code, message: authority.message },
      };
    }

    // Atomic one-use claim: only the caller that transitions pending → executing wins.
    if (!deps.store.markConfirmationExecuting(record.id)) {
      return { ok: false, status: 409, body: { ok: false, code: "already_used", message: "This preview was already used." } };
    }

    // ALL confirmed operations go through the SAME commit path. The action's own
    // `commit` does the work; for a permission change that commit persists the new
    // policy itself via the `savePolicy` capability the context carries.
    let receipt: SuccessReceipt | ErrorReceipt;
    if (!installation || installation.status !== "active") {
      receipt = errorReceipt({
        action: operation.actionName,
        code: "not_installed",
        message: "The add-on is not active for this workspace.",
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
      const authorizedContext = actionContext(claims.workspaceId, claims.adminUserId, installation);
      // The fresh role verdict above happened before consuming the nonce. Avoid a
      // redundant host lookup inside the generic harness for this same dispatch.
      delete authorizedContext.authorizeWrite;
      receipt = await commitConfirmedOperation({ ...authorizedContext, idempotency }, operation);
    }

    // The host dispatch already happened. Retry only the synchronous SQLite
    // settlement (never the Clockify mutation), then return the truthful host
    // receipt even if persistence remains degraded. Claim-time persistence has
    // already scrubbed dispatch material and bound the one unknown result that
    // startup recovery will reuse if final settlement never persists.
    const terminalStatus = receipt.ok
      ? "succeeded"
      : receipt.code === "commit_outcome_unknown"
        ? "outcome_unknown"
        : "definitive_failed";
    let resultRef: ActionResultRef | undefined;
    let settlementError: unknown;
    for (let attempt = 0; attempt < 2 && !resultRef; attempt += 1) {
      try {
        resultRef = deps.store.settleConfirmation(record.id, terminalStatus, operation.actionName, receipt);
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
      undoId = recordUndoIfReversible(claims, receipt);
    });
    const agentState = receipt.ok ? parseAgentState(record.agentState) : undefined;
    return {
      ok: true,
      receipt,
      undoId,
      agentState,
      installation,
      ...(!resultRef ? { persistenceDegraded: true as const } : {}),
    };
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

    // SAFETY (live item 157): a bare typed consent while a preview is pending
    // must never reach the planner — live, "yes" made the model plan a NEW
    // operation instead of pointing at the button. Deterministic reply; only
    // the button nonce can execute the pending change.
    if (TYPED_CONSENT.test(message) && deps.store.countPendingConfirmations(claims.sessionId, now().toISOString()) > 0) {
      return deterministicAnswer(
        claims,
        "Typed approval can't apply a pending change — only the Confirm button on its preview card can. The change is still waiting: click Confirm to apply it, or Cancel to discard it.",
      );
    }

    // SAFETY (finding new-2-affirmative-after-completed-safe): a bare affirmative
    // ("yes please go ahead", "do it") right after a safe write ALREADY completed
    // — with nothing pending — must not re-plan another write. Live, that
    // affirmative logged a DUPLICATE time entry. The prior turn left no pending
    // confirmation (a safe write executes immediately), so the guard above can't
    // catch it; here we detect the just-finished write from that turn's persisted
    // receipts and answer deterministically that it's already done. The model
    // never sees the affirmative, so it can't duplicate the action.
    if (BARE_AFFIRMATIVE.test(message)) {
      const prior = deps.store.getRecentMessages(claims.sessionId, 2, true);
      const lastAssistant = [...prior].reverse().find((msg) => msg.role === "assistant");
      const lastResults = (lastAssistant?.payload as { results?: unknown[] } | undefined)?.results ?? [];
      if (lastTurnCompletedAWrite(lastResults)) {
        return deterministicAnswer(
          claims,
          "That's already done — the previous change was applied when you asked, so there's nothing left to confirm. Let me know if you'd like another change.",
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

  /**
   * Tool subsetting (LLM_TOOL_SELECT=1): show the model only the actions relevant
   * to THIS message (+ the always-on core), for weak-model consistency. OFF ⇒
   * undefined tools/full catalog (byte-identical). The harness still validates and
   * gates every proposed action — subsetting changes only what the model SEES.
   * Recall-risk inputs fail open to the full catalog. `subsetNarrowed` is true only
   * for an actual strict subset, so only a narrowed turn that executed NOTHING is a
   * possible recall miss worth a full-catalog retry.
   */
  function deriveToolSubset(message: string): {
    subsetTools: ReturnType<typeof toolsForModel> | undefined;
    subsetCatalog: ReturnType<typeof catalogForModel>;
    subsetNarrowed: boolean;
  } {
    const subsetNames = deps.config.llmToolSelect ? new Set(selectActionsForMessage(message)) : undefined;
    return {
      subsetTools: subsetNames ? toolsForModel(subsetNames) : undefined,
      subsetCatalog: subsetNames ? catalogForModel(subsetNames) : catalogForModel(),
      subsetNarrowed: subsetNames !== undefined && subsetNames.size < catalogForModel().length,
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
    signal?: AbortSignal;
  }): Promise<{ replyKind: string; baseText: string } | { failed: true }> {
    const { m, messages, policy, tracked, subsetTools, subsetCatalog, subsetNarrowed, signal } = args;
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
          turn = await runAgentic(undefined);
        }
      } catch {
        return { failed: true };
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
        plan = await runPlan(catalogForModel(), undefined);
        if (signal?.aborted) return { replyKind: "aborted", baseText: "" };
      }
    } catch {
      return signal?.aborted
        ? { replyKind: "aborted", baseText: "" }
        : { failed: true };
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
    const priorClarificationContext = unresolvedClarificationContext(claims.sessionId);
    const selectionContext = combineSelectionContext(priorClarificationContext, message);
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

    const policy = loadPolicy(claims.workspaceId, claims.adminUserId);
    const messages = buildModelHistory(claims);
    const { subsetTools, subsetCatalog, subsetNarrowed } = deriveToolSubset(selectionContext);

    const calendar = await deps.clockifyForWorkspace(installation).getCalendarContext(claims.adminUserId).catch(() => undefined);
    const m = createTurnMachinery(
      claims,
      installation,
      onResult,
      onStatus,
      requestId,
      calendar,
      selectionContext,
    );

    // Cost/latency telemetry: every model-touching turn records one row (the
    // deterministic early returns above never reach here — no model, no row).
    const turnStartMs = now().getTime();
    const tracked = trackUsage(deps.modelClient, now);
    const recordTurn = (): void => {
      recordTurnTelemetrySafely(claims, "chat", tracked.usage, now().getTime() - turnStartMs);
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

    const turn = await runModelTurn({
      m,
      messages,
      policy,
      tracked,
      subsetTools,
      subsetCatalog,
      subsetNarrowed,
      signal,
    });
    if ("failed" in turn) return modelUnavailable();
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
    const replyText = truthfulReplyText(m.results, baseText, replyKind);
    persistAssistantReply(
      claims,
      replyKind,
      replyText,
      m.results,
      m.resultLinks,
      selectionContext,
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
