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
import {
  createSlidingWindowLimiter,
  DEFAULT_CHAT_RATE_LIMIT_MAX,
  DEFAULT_CHAT_RATE_LIMIT_WINDOW_MS,
} from "./rate-limit.js";
import {
  commitConfirmedOperation,
  executeAction,
} from "../harness/actions.js";
import type { ActionContext, ActionResult, ConfirmableOperation, PreviewCard } from "../harness/action.js";
import type { AtomicIdempotencyLedger } from "../harness/idempotency.js";
import { reversibleCreations } from "../harness/undo.js";
import { catalogForModel, getAction } from "../harness/catalog.js";
import { actionStatusLabel } from "../harness/action-labels.js";
import { canWrite, defaultAdminPolicy, type AdminPolicy } from "../harness/permissions.js";
import {
  confirmPending,
  createPendingConfirmation,
} from "../harness/confirmations.js";
import { errorReceipt, type SuccessReceipt, type ErrorReceipt } from "../harness/receipts.js";
import { runAgentTurn, type AgentStep, type AgentTurnResult } from "../assistant/agent-loop.js";
import { parseAgentState, resumeMessages, type AgentState } from "../assistant/agent-state.js";
import type { ModelMessage, ToolCall } from "../assistant/model-client.js";
import { planConversation, runAgentConversation } from "../assistant/planner.js";
import { trackUsage, type TurnUsage } from "../assistant/usage.js";
import { toolsForModel } from "../harness/tools.js";
import { selectActionsForMessage, CORE_ACTION_NAMES } from "../harness/tool-select.js";
import type { Installation } from "../db/store.js";
import { CLAIM_TTL_MS } from "../db/store.js";
import { resolveSession, type AppDeps } from "./deps.js";
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
  redactNonceForStorage,
  storedContentForReply,
  type Claims,
  type TurnMachinery,
} from "./chat-results.js";
import { HISTORY_WINDOW_MESSAGES, IDEMPOTENCY_WINDOW_MS } from "./chat-constants.js";

/** The outcome of one chat turn, shared by the JSON route and the streaming route. */
export type ChatTurnOutcome =
  | { ok: true; replyKind: string; replyText: string; results: unknown[] }
  | { ok: false; code: string; message: string };

/** What `chatPreconditions` returns when a request is cleared to run a turn. */
export type ChatPreconditions = {
  claims: { sessionId: string; workspaceId: string; adminUserId: string };
  installation: Installation;
  message: string;
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
    };

export interface ChatPipeline {
  loadPolicy: (workspaceId: string, adminUserId: string) => AdminPolicy;
  requireSession: (req: Request, res: Response) => SessionClaims | undefined;
  actionContext: (workspaceId: string, adminUserId: string, installation: Installation) => ActionContext;
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
  ) => Promise<ChatTurnOutcome>;
  chatPreconditions: (req: Request, res: Response) => ChatPreconditions | undefined;
}

export function createChatPipeline(deps: AppDeps): ChatPipeline {
  const now = deps.now ?? (() => new Date());
  // Per-SESSION chat rate limit — each turn drives a paid model loop, and
  // nothing else bounds it (confirm/cancel/undo are button-driven + one-use).
  const chatLimiter = createSlidingWindowLimiter(
    deps.config.chatRateLimitMax ?? DEFAULT_CHAT_RATE_LIMIT_MAX,
    deps.config.chatRateLimitWindowMs ?? DEFAULT_CHAT_RATE_LIMIT_WINDOW_MS,
  );

  function loadPolicy(workspaceId: string, adminUserId: string): AdminPolicy {
    return deps.store.getAdminPolicy(workspaceId, adminUserId) ?? defaultAdminPolicy();
  }

  function requireSession(req: Request, res: Response) {
    const claims = resolveSession(req, deps);
    if (!claims) {
      res.status(401).json({ ok: false, code: "unauthorized", message: "No valid session." });
      return undefined;
    }
    return claims;
  }

  function actionContext(
    workspaceId: string,
    adminUserId: string,
    installation: Installation,
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
  ): TurnMachinery {
    const results: unknown[] = [];
    const emit = (result: unknown): void => {
      results.push(result);
      onResult?.(result);
    };
    const ctx = actionContext(claims.workspaceId, claims.adminUserId, installation);

    // Every executed action — success or error, single-turn or agentic — is
    // audited under the catalog's risk labels and offered an undo if reversible.
    const auditAndEmitReceipt = (actionName: string, receipt: SuccessReceipt | ErrorReceipt): void => {
      // Post-execution bookkeeping is best-effort: a safe write executes
      // immediately (no confirm round-trip), so by the time we audit it the
      // change has ALREADY happened on the host. A transient DB error here (e.g.
      // a microsecond SQLITE_BUSY) must NOT throw the turn — that would 502
      // (agentic) / 500 (single-turn), drop the committed receipt, and invite a
      // duplicate write. Mirror the confirm-tail fix: log (message only, no
      // secrets) and still emit the receipt for the change that already ran.
      let undoId: string | undefined;
      try {
        deps.store.addAuditEvent({
          workspaceId: claims.workspaceId,
          adminUserId: claims.adminUserId,
          sessionId: claims.sessionId,
          actionName,
          risk: getAction(actionName)?.risks ?? [],
          receipt,
        });
        undoId = recordUndoIfReversible(claims, receipt);
      } catch (error) {
        console.error(
          "post-execution bookkeeping failed (action already applied; receipt preserved):",
          error instanceof Error ? error.message : String(error),
        );
      }
      emit({ kind: "receipt", receipt, ...(undoId ? { undo: { id: undoId } } : {}) });
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
        agentState,
      });
      deps.store.savePendingConfirmation(created.record);
      emit({
        kind: "preview",
        previewId: created.previewId,
        nonce: created.nonce,
        expiresAt: created.expiresAt,
        preview,
      });
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
      if (result.kind === "receipt") auditAndEmitReceipt(call.name, result.receipt);
      else if (result.kind === "clarify") emit({ kind: "clarify", message: result.message, options: result.options });
    };

    return { ctx, results, emit, auditAndEmitReceipt, emitPreviewFor, runAction, onStep };
  }

  function persistAssistantReply(claims: Claims, replyKind: string, replyText: string, results: unknown[]): void {
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
        payload: { kind: replyKind, results: redactNonceForStorage(results) },
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
    const m = createTurnMachinery(claims, installation, onResult, onStatus);
    const resumeStartMs = now().getTime();
    const tracked = trackUsage(deps.modelClient, now);
    let turn: AgentTurnResult | undefined;
    try {
      turn = await runAgentTurn({
        modelClient: tracked.client,
        messages: resumeMessages(agentState, receipt),
        tools: toolsForModel(),
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
    persistAssistantReply(claims, replyKind, replyText, m.results);
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
    });
    if (!validation.ok) {
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
            message: `Write access to ${operation.featureGroup} is disabled in your assistant permissions.`,
          },
        };
      }
    }

    // Atomic one-use claim: only the caller that transitions pending → used wins.
    if (!deps.store.markConfirmationUsed(record.id)) {
      return { ok: false, status: 409, body: { ok: false, code: "already_used", message: "This preview was already used." } };
    }

    // ALL confirmed operations go through the SAME commit path. The action's own
    // `commit` does the work; for a permission change that commit persists the new
    // policy itself via the `savePolicy` capability the context carries.
    let receipt: SuccessReceipt | ErrorReceipt;
    const installation = deps.store.getInstallation(claims.workspaceId);
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
        lookup: (key) => deps.store.lookupIdempotency(key, now().getTime() - IDEMPOTENCY_WINDOW_MS),
        record: (key, r) => deps.store.recordIdempotency(key, r, now().getTime()),
        claim: (key) =>
          deps.store.claimIdempotency(
            key,
            now().getTime(),
            now().getTime() - IDEMPOTENCY_WINDOW_MS,
            now().getTime() - CLAIM_TTL_MS,
          ),
        lookupCompleted: (key) => deps.store.claimIdempotencyReceipt(key),
        fill: (key, r) => deps.store.fillIdempotency(key, r, now().getTime()),
        release: (key) => deps.store.releaseIdempotency(key),
        // Heartbeat a long multi-call commit's live claim so it is never swept
        // mid-flight and double-committed (r1-concurrency-races-01 follow-up).
        touch: (key) => deps.store.touchIdempotencyClaim(key, now().getTime()),
      };
      receipt = await commitConfirmedOperation(
        { ...actionContext(claims.workspaceId, claims.adminUserId, installation), idempotency },
        operation,
      );
    }

    let undoId: string | undefined;
    try {
      // Post-commit bookkeeping is best-effort: the commit already happened and
      // is durably recorded in the idempotency ledger. A DB hiccup here (e.g. a
      // transient SQLITE_BUSY) must NOT drop the receipt on the floor or 500 the
      // turn — log (message only, no secrets) and still return the receipt. The
      // committed write stays safe and the receipt still reaches the admin, but a
      // failure here is PERMANENT for this receipt: the confirmation was marked
      // 'used' above (before the commit), so a re-confirm 409s and never re-runs
      // this block — a dropped audit entry / undo handle is lost for good.
      deps.store.setConfirmationResult(record.id, receipt.ok ? "used" : "failed", receipt);
      deps.store.addAuditEvent({
        workspaceId: claims.workspaceId,
        adminUserId: claims.adminUserId,
        sessionId: claims.sessionId,
        actionName: operation.actionName,
        risk: operation.risks,
        receipt,
      });
      undoId = recordUndoIfReversible(claims, receipt);
    } catch (error) {
      console.error(
        "post-commit bookkeeping failed (commit already applied; receipt preserved):",
        error instanceof Error ? error.message : String(error),
      );
    }
    const agentState = receipt.ok ? parseAgentState(record.agentState) : undefined;
    return { ok: true, receipt, undoId, agentState, installation };
  }

  async function executeChatTurn(
    claims: { sessionId: string; workspaceId: string; adminUserId: string },
    installation: Installation,
    message: string,
    onResult?: (result: unknown) => void,
    onStatus?: (status: { action: string; label: string }) => void,
    signal?: AbortSignal,
  ): Promise<ChatTurnOutcome> {
    deps.store.addMessage({
      sessionId: claims.sessionId,
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      role: "user",
      content: message,
    });

    // A whitespace-only message is no input at all (finding new-6: a blank turn
    // sent the model guessing — it invoked clockify_review_day / clockify_status
    // unsolicited and fabricated a context). Treat it as empty and ask what the
    // admin wants, deterministically — never let it reach the planner.
    if (message.trim().length === 0) {
      const text = "I didn't catch a message there — what would you like me to do?";
      persistAssistantReply(claims, "answer", text, []);
      return { ok: true, replyKind: "answer", replyText: text, results: [] };
    }

    // SAFETY (live item 157): a bare typed consent while a preview is pending
    // must never reach the planner — live, "yes" made the model plan a NEW
    // operation instead of pointing at the button. Deterministic reply; only
    // the button nonce can execute the pending change.
    if (TYPED_CONSENT.test(message) && deps.store.countPendingConfirmations(claims.sessionId, now().toISOString()) > 0) {
      const text =
        "Typed approval can't apply a pending change — only the Confirm button on its preview card can. The change is still waiting: click Confirm to apply it, or Cancel to discard it.";
      persistAssistantReply(claims, "answer", text, []);
      return { ok: true, replyKind: "answer", replyText: text, results: [] };
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
        const text =
          "That's already done — the previous change was applied when you asked, so there's nothing left to confirm. Let me know if you'd like another change.";
        persistAssistantReply(claims, "answer", text, []);
        return { ok: true, replyKind: "answer", replyText: text, results: [] };
      }
    }

    const policy = loadPolicy(claims.workspaceId, claims.adminUserId);
    // includePayload so transient model-failure rows (payload.kind="error") can be
    // dropped — the model must never re-read its own "I'm unavailable" turn as
    // conversational fact (finding r2-new-session-restore-05).
    const history = deps.store.getRecentMessages(claims.sessionId, HISTORY_WINDOW_MESSAGES, true);
    const messages: ModelMessage[] = history
      .filter((m) => m.role !== "system" && !isTransientErrorMessage(m))
      .map((m) =>
        m.role === "assistant"
          ? { role: "assistant" as const, content: sanitizeStoredReplyForModel(m.content) }
          : { role: "user" as const, content: m.content },
      );

    const m = createTurnMachinery(claims, installation, onResult, onStatus);

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

    const useTools = deps.config.llmMode !== "json";
    let replyKind: string;
    let baseText: string;

    // Tool subsetting (LLM_TOOL_SELECT=1): show the model only the actions relevant
    // to THIS message (+ the always-on core), for weak-model consistency. OFF ⇒
    // undefined ⇒ the full catalog (byte-identical). The harness still validates and
    // gates every proposed action — subsetting changes only what the model SEES.
    const subsetNames = deps.config.llmToolSelect ? new Set(selectActionsForMessage(message)) : undefined;
    const subsetTools = subsetNames ? toolsForModel(subsetNames) : undefined;
    const subsetCatalog = subsetNames ? catalogForModel(subsetNames) : catalogForModel();
    // Did subsetting actually NARROW (a domain intent matched) vs collapse to just
    // the core (smalltalk)? Only a narrowed turn that executed NOTHING is a possible
    // recall miss worth a full-catalog retry — smalltalk never triggers it.
    const subsetNarrowed = subsetNames !== undefined && subsetNames.size > CORE_ACTION_NAMES.size;

    if (deps.config.llmAgentic && useTools && typeof deps.modelClient.completeWithTools === "function") {
      // Agentic turn (LLM_AGENTIC=1): the durable tool-loop. Reads + safe writes
      // auto-chain with their receipts fed back to the model; the FIRST risky
      // write interrupts into the preview→button-confirm flow with its suspended
      // transcript persisted, so the confirm route can resume the loop.
      let turn: AgentTurnResult;
      const currentDate = now().toISOString().slice(0, 10);
      try {
        turn = await runAgentConversation({
          modelClient: tracked.client,
          messages,
          policy,
          authClass: m.ctx.clockify.authClass,
          // The server clock's date so the model narrates the real date instead
          // of its stale knowledge cutoff (finding new-3: "we're still in 2025").
          currentDate,
          tools: subsetTools,
          runAction: m.runAction,
          onStep: m.onStep,
          signal,
        });
        // Recall escape hatch: a NARROWED turn that finished without executing
        // anything may have had the needed tool hidden. Retry ONCE with the full
        // catalog. Side-effect-free — guarded on `m.results.length === 0`, so no
        // read/write is ever duplicated; never fires for smalltalk (not narrowed).
        if (subsetNarrowed && m.results.length === 0 && (turn.kind === "final" || turn.kind === "exhausted")) {
          turn = await runAgentConversation({
            modelClient: tracked.client,
            messages,
            policy,
            authClass: m.ctx.clockify.authClass,
            currentDate,
            runAction: m.runAction,
            onStep: m.onStep,
            signal,
          });
        }
      } catch {
        return modelUnavailable();
      }
      ({ replyKind, baseText } = settleAgentTurn(m, turn));
    } else {
      let plan;
      const currentDate = now().toISOString().slice(0, 10);
      try {
        plan = await planConversation({
          modelClient: tracked.client,
          messages,
          actionCatalog: subsetCatalog,
          policy,
          authClass: m.ctx.clockify.authClass,
          // The server clock's date so the model narrates the real date instead
          // of its stale knowledge cutoff (finding new-3: "we're still in 2025").
          currentDate,
          tools: subsetTools,
          // Native tool-calling by default (provider validates args); LLM_MODE=json
          // forces the JSON + repair path. The harness re-validates either way.
          useTools,
        });
        // Recall escape hatch (mirrors the agentic path): a NARROWED turn that
        // proposed no action may have hidden the needed tool — re-plan ONCE with the
        // full catalog before executing (nothing has run yet → no double side effects).
        if (subsetNarrowed && plan.kind !== "actions") {
          plan = await planConversation({
            modelClient: tracked.client,
            messages,
            actionCatalog: catalogForModel(),
            policy,
            authClass: m.ctx.clockify.authClass,
            currentDate,
            useTools,
          });
        }
      } catch {
        return modelUnavailable();
      }

      let emittedClarify = false;
      if (plan.kind === "actions" && plan.actions) {
        for (const proposed of plan.actions) {
          // The single-turn path runs each proposed action through the same
          // machinery: a throwing action becomes an audited error receipt, a
          // risky one becomes a pending preview (no agent state — no resume).
          const outcome = await m.runAction({ id: "", name: proposed.name, arguments: proposed.arguments });
          if (outcome.kind === "receipt") {
            m.auditAndEmitReceipt(proposed.name, outcome.receipt);
          } else if (outcome.kind === "clarify") {
            m.emit({ kind: "clarify", message: outcome.message, options: outcome.options });
            emittedClarify = true;
          } else {
            m.emitPreviewFor(outcome.preview, outcome.operation);
          }
        }
      }
      replyKind = plan.kind;
      // fix-clarify-double-render: when a single-turn action resolved to a
      // clarify, that grounded message is ALREADY in results[]. The model's
      // pre-action narration (`plan.text`) can echo it VERBATIM — keeping it in
      // reply.text would render the clarify twice (the clarify bubble AND the
      // assistant reply bubble). Mirror settleAgentTurn: drop the narration so the
      // clarify rides ONLY in results[]. (Previews still override via
      // truthfulReplyText, so this never weakens the truthful-preview path.)
      baseText = emittedClarify ? "" : plan.text;
    }

    // The truthful-preview override (see truthfulReplyText): a pending preview
    // replaces the model's text. The streaming route emits this replyText AFTER
    // the results — the truthful text isn't known until execution finishes.
    const replyText = truthfulReplyText(m.results, baseText, replyKind);
    persistAssistantReply(claims, replyKind, replyText, m.results);
    recordTurn();
    return { ok: true, replyKind, replyText, results: m.results };
  }

  function chatPreconditions(req: Request, res: Response): ChatPreconditions | undefined {
    const claims = requireSession(req, res);
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
    const installation = deps.store.getInstallation(claims.workspaceId);
    if (!installation || installation.status !== "active") {
      res.status(409).json({ ok: false, code: "not_installed", message: "The add-on is not active for this workspace." });
      return undefined;
    }
    return { claims, installation, message: parsed.data.message };
  }

  return { loadPolicy, requireSession, actionContext, runResume, commitConfirmation, executeChatTurn, chatPreconditions };
}
