import { Router, type Request, type Response } from "express";
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
import { reverseCreation, reversibleCreations, firstDeniedGroup } from "../harness/undo.js";
import { buildMetrics, buildUsageMetrics } from "../metrics/metrics.js";
import { catalogForModel, getAction } from "../harness/catalog.js";
import { actionStatusLabel } from "../harness/action-labels.js";
import {
  FEATURE_GROUPS,
  applyPolicyPatch,
  canWrite,
  defaultAdminPolicy,
  type AdminPolicy,
} from "../harness/permissions.js";
import {
  confirmPending,
  createPendingConfirmation,
  rotatePendingNonce,
} from "../harness/confirmations.js";
import { errorReceipt, successReceipt, type SuccessReceipt, type ErrorReceipt } from "../harness/receipts.js";
import { runAgentTurn, type AgentStep, type AgentTurnResult } from "../assistant/agent-loop.js";
import { capAgentState, parseAgentState, resumeMessages, type AgentState } from "../assistant/agent-state.js";
import type { ModelMessage, ToolCall } from "../assistant/model-client.js";
import { planConversation, runAgentConversation } from "../assistant/planner.js";
import { trackUsage, type TurnUsage } from "../assistant/usage.js";
import { toolsForModel } from "../harness/tools.js";
import type { Installation } from "../db/store.js";
import { CLAIM_TTL_MS } from "../db/store.js";
import { resolveSession, buildSessionCookie, type AppDeps } from "./deps.js";
import { signSessionCookie, type SessionClaims } from "../auth/sessions.js";
import { THIRTY_DAYS_MS } from "../durations.js";
import {
  pruneHistoryResult,
  previewReplyText,
  failureReplyText,
  failedAttemptNote,
  sanitizeStoredReplyForModel,
  isTransientErrorMessage,
} from "./history-sanitizer.js";
import {
  groupsPatchSchema,
  chatBodySchema,
  confirmBodySchema,
} from "./request-schemas.js";
import {
  TYPED_CONSENT,
  BARE_AFFIRMATIVE,
  lastTurnCompletedAWrite,
} from "./consent-guard.js";
import { asyncHandler } from "./async-handler.js";

// Re-export the history-sanitizer/truthful-preview helpers (extracted to
// ./history-sanitizer.ts) so existing importers of api.ts keep resolving — the
// integration test imports `previewReplyText`/`sanitizeStoredReplyForModel` from
// here. This is a temporary compatibility shim (plan 002).
export {
  HISTORY_RESULT_MAX_BYTES,
  pruneHistoryResult,
  previewReplyText,
  failureReplyText,
  failedAttemptNote,
  sanitizeStoredReplyForModel,
  isTransientErrorMessage,
} from "./history-sanitizer.js";

/**
 * JSON API (SPEC "Chat Flow", "Confirmation Rules", "Permissions Inside Chat").
 * Every route requires an authenticated admin session. Risky actions never
 * execute here: chat creates previews; only the confirm route — with a valid
 * button nonce and an atomic one-use claim — executes the stored operation.
 */

/**
 * How many stored chat messages (user + assistant turns, newest first) are sent
 * to the model each turn. The STORED history is complete — this only bounds the
 * model-visible window, so a marathon session (the live loop stored 650
 * messages in one session) keeps a constant-size prompt. Receipts/payloads are
 * never part of this history; the agent loop separately byte-caps tool results
 * (see TOOL_RESULT_MAX_BYTES).
 */
export const HISTORY_WINDOW_MESSAGES = 12;

/**
 * How many stored messages GET /api/chat/history replays to the UI after an
 * iframe reload. Distinct from the MODEL window above — this is the human's
 * restored view (a marathon session stores 100s of messages; 50 is plenty to
 * re-anchor without shipping megabytes of payloads).
 */
export const CHAT_HISTORY_LIMIT = 50;

/** Idempotency window: re-confirming the same intent within this is deduped. */
export const IDEMPOTENCY_WINDOW_MS = 10 * 60 * 1000;

export function apiRouter(deps: AppDeps): Router {
  const router = Router();
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

  type Claims = { sessionId: string; workspaceId: string; adminUserId: string };

  /**
   * Per-turn execution machinery shared by the chat turn AND the confirm-time
   * resume: result collection/streaming plus the audited receipt, clarify, and
   * preview emitters. `emitPreviewFor` is the ONLY way a risky write leaves
   * either path — as a pending confirmation that the button-confirm route alone
   * can commit.
   */
  interface TurnMachinery {
    ctx: ActionContext;
    results: unknown[];
    emit: (result: unknown) => void;
    auditAndEmitReceipt: (actionName: string, receipt: SuccessReceipt | ErrorReceipt) => void;
    emitPreviewFor: (preview: PreviewCard, operation: ConfirmableOperation, agentState?: AgentState) => void;
    runAction: (call: ToolCall) => Promise<ActionResult>;
    onStep: (step: AgentStep) => void;
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

  /** Map a finished agent turn onto the result stream: an interrupt becomes a pending preview. */
  function settleAgentTurn(m: TurnMachinery, turn: AgentTurnResult): { replyKind: string; baseText: string } {
    if (turn.kind === "interrupt") {
      // capAgentState drops (never truncates) an oversized suspension — the
      // confirm still commits, it just won't resume (the pre-agentic behavior).
      m.emitPreviewFor(
        turn.preview,
        turn.operation,
        capAgentState({
          transcript: turn.transcript,
          call: { id: turn.call.id, name: turn.call.name },
        }),
      );
      // The truthful-preview override supplies the reply text for a pending preview.
      return { replyKind: "actions", baseText: "" };
    }
    // The clarify (with its grounded options) is ALREADY emitted as a result via
    // `onStep` before the loop returns, so leave `baseText` empty — echoing the
    // message into reply.text too would render it twice in the UI (the clarify
    // bubble AND the assistant reply bubble). fix-clarify-double-render.
    if (turn.kind === "clarify") return { replyKind: "clarify", baseText: "" };
    // "final" and "exhausted" both carry truthful text from the loop.
    return { replyKind: "answer", baseText: turn.text };
  }

  // SAFETY (SPEC "never claim a risky action is done"): a risky action only
  // executes on a button confirmation, never on the model's say-so. The model
  // sometimes narrates a false "Done!/Confirmed" for a pending preview, so when
  // the turn produced previews we REPLACE the model's text with a truthful,
  // not-yet-applied instruction — and store THAT (not the false claim) so the
  // model's own history can't convince it the action already happened.
  function truthfulReplyText(results: unknown[], baseText: string, replyKind: string): string {
    const pendingPreviews = results.filter(
      (r): r is { kind: "preview" } => (r as { kind?: string }).kind === "preview",
    ).length;
    if (pendingPreviews > 0) {
      // Single source of truth (safety-invariants-02): the stored boilerplate and
      // the sanitizer's PREVIEW_BOILERPLATE both come from `previewReplyText`.
      // finding new-4: the loop can fail a tool call and then recover to THIS
      // preview in the same turn. Acknowledge those failed attempts after the
      // boilerplate (which stays first so PREVIEW_BOILERPLATE still anchors), so
      // the admin understands why a different/pivoted card appeared instead of a
      // wholesale replacement that erases the failure.
      const failedReceipts = results.filter(
        (r): r is { kind: "receipt"; receipt: { ok: boolean } } =>
          (r as { kind?: string }).kind === "receipt" && (r as { receipt?: { ok?: boolean } }).receipt?.ok === false,
      ).length;
      return failedReceipts > 0
        ? `${previewReplyText(pendingPreviews)}${failedAttemptNote(failedReceipts)}`
        : previewReplyText(pendingPreviews);
    }
    // truthfulness-02: in the single-turn `actions` path `baseText` is the model's
    // narration written BEFORE any action ran, so an optimistic "Done!/I created…"
    // can survive a failed safe write. When every executed receipt failed, replace
    // that pre-execution claim with the actual failure count. The agentic loop's
    // "final"/"answer" text already follows its receipts, so leave it untouched.
    if (replyKind === "actions") {
      const receipts = results.filter(
        (r): r is { kind: "receipt"; receipt: { ok: boolean } } =>
          (r as { kind?: string }).kind === "receipt",
      );
      const failed = receipts.filter((r) => r.receipt.ok === false).length;
      if (receipts.length > 0 && failed === receipts.length) {
        return failureReplyText(failed, receipts.length);
      }
    }
    return baseText;
  }

  // The raw one-use confirmation nonce belongs ONLY in the live HTTP
  // response / page state (confirmations.ts: "only its hash is stored"). The
  // live `results` carry it to the client, but the DURABLE copy in
  // chat_messages.payload_json must not — strip it so the nonce is never
  // write-only DB residue (nothing re-serves the persisted payload, and the
  // model never sees it). Everything else about the preview is kept.
  function redactNonceForStorage(results: unknown[]): unknown[] {
    return results.map((r) => {
      if (r && typeof r === "object" && (r as { kind?: string }).kind === "preview" && "nonce" in (r as object)) {
        const { nonce: _nonce, ...rest } = r as { nonce?: unknown };
        return rest;
      }
      return r;
    });
  }

  /**
   * The content to STORE for an assistant turn. Normally this is `replyText`.
   * But a clarify turn deliberately keeps `reply.text` EMPTY so the UI renders
   * the clarify ONCE (the grounded bubble rides in results[], not a second reply
   * bubble — fix-clarify-double-render). The side effect was a dead-end loop
   * (finding new-7): the model-visible history is built from this stored content,
   * so an empty clarify turn left the model with NO record of having asked. On the
   * next turn a one-word follow-up ("Acme Corp") had nothing to anchor to and the
   * model re-issued the same losing tool call, clarifying forever.
   *
   * Fix: when `replyText` is empty but the turn produced clarify result(s), store
   * the clarify QUESTION(S) as the assistant content. The model then sees what it
   * asked and can resolve the follow-up. The LIVE `reply.text` is untouched (still
   * empty) — only the durable, model-visible copy gains the question. (When a
   * preview is also pending, `replyText` is the non-empty truthful-preview
   * boilerplate, so this never overrides the preview-truthfulness invariant.)
   */
  function storedContentForReply(replyText: string, results: unknown[]): string {
    if (replyText.trim().length > 0) return replyText;
    const clarifyMessages = results
      .filter((r): r is { kind: "clarify"; message?: string } => (r as { kind?: string }).kind === "clarify")
      .map((r) => (r.message ?? "").trim())
      .filter((m) => m.length > 0);
    return clarifyMessages.length > 0 ? clarifyMessages.join("\n\n") : replyText;
  }

  function persistAssistantReply(claims: Claims, replyKind: string, replyText: string, results: unknown[]): void {
    deps.store.addMessage({
      sessionId: claims.sessionId,
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      role: "assistant",
      content: storedContentForReply(replyText, results),
      payload: { kind: replyKind, results: redactNonceForStorage(results) },
    });
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
      });
    } catch {
      // The commit already happened and its receipt is returned regardless; a
      // model failure here only loses the follow-up narration.
      recordTurnTelemetrySafely(claims, "resume", tracked.usage, now().getTime() - resumeStartMs);
      return undefined;
    }
    const { replyKind, baseText } = settleAgentTurn(m, turn);
    const replyText = truthfulReplyText(m.results, baseText, replyKind);
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
  ): Promise<
    | { ok: false; status: number; body: { ok: false; code: string; message: string } }
    | {
        ok: true;
        receipt: SuccessReceipt | ErrorReceipt;
        undoId: string | undefined;
        agentState: AgentState | undefined;
        installation: Installation | undefined;
      }
  > {
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
      // turn — log (message only, no secrets) and still return the receipt. A
      // later re-confirm replays idempotently and re-attempts the bookkeeping.
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

  router.get("/me", (req, res) => {
    const claims = requireSession(req, res);
    if (!claims) return;
    res.json({
      ok: true,
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      workspaceRole: claims.workspaceRole,
    });
  });

  // Operational metrics (Phase 7): per-action success/failure, error taxonomy, and
  // confirm/cancel/expire rates — scoped to the caller's own actions (privacy).
  // Optional ?since=<ISO> windows the report. Absent ?since DEFAULTS to the last
  // 30 days (matching the telemetry/confirmation retention horizon): audit_events
  // is retained for RETENTION_DAYS (default 90), so even an unbounded read scans
  // at most that window — the 30-day default still avoids aggregating every
  // retained row in JS. An explicit ?since override reaches the full retained
  // history for ops (r1-efficiency-01).
  router.get("/metrics", (req, res) => {
    const claims = requireSession(req, res);
    if (!claims) return;
    const since =
      typeof req.query.since === "string"
        ? req.query.since
        : new Date(now().getTime() - THIRTY_DAYS_MS).toISOString();
    const nowIsoStamp = now().toISOString();
    const outcomes = deps.store.listActionOutcomes(claims.workspaceId, claims.adminUserId, since);
    const confirmations = deps.store.listConfirmationOutcomes(claims.workspaceId, claims.adminUserId, since);
    const telemetry = deps.store.listTurnTelemetry(claims.workspaceId, claims.adminUserId, since);
    res.json({
      ok: true,
      metrics: {
        ...buildMetrics(outcomes, confirmations, nowIsoStamp),
        // Cost + latency (the pending prod cost review): per-admin token/turn
        // aggregates from turn_telemetry.
        usage: buildUsageMetrics(telemetry, nowIsoStamp),
      },
    });
  });

  router.get("/permissions", (req, res) => {
    const claims = requireSession(req, res);
    if (!claims) return;
    const existing = deps.store.getAdminPolicy(claims.workspaceId, claims.adminUserId);
    res.json({
      ok: true,
      policy: existing ?? defaultAdminPolicy(),
      firstRun: !existing,
      featureGroups: FEATURE_GROUPS,
    });
  });

  router.post("/permissions/preview", (req, res) => {
    const claims = requireSession(req, res);
    if (!claims) return;
    const parsed = groupsPatchSchema.safeParse(req.body?.groups);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, code: "invalid_args", message: "Invalid permission groups." });
    }
    const base = loadPolicy(claims.workspaceId, claims.adminUserId);
    try {
      const next = applyPolicyPatch(base, { groups: parsed.data ?? {} });
      const changedGroups = Object.keys(parsed.data ?? {});
      return res.json({ ok: true, preview: { current: base, next, changedGroups } });
    } catch {
      return res.status(400).json({ ok: false, code: "invalid_args", message: "Invalid permission change." });
    }
  });

  router.post("/permissions/confirm", (req, res) => {
    const claims = requireSession(req, res);
    if (!claims) return;
    const parsed = groupsPatchSchema.safeParse(req.body?.groups);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, code: "invalid_args", message: "Invalid permission groups." });
    }
    const base = loadPolicy(claims.workspaceId, claims.adminUserId);
    let next: AdminPolicy;
    try {
      next = applyPolicyPatch(base, { groups: parsed.data ?? {} });
    } catch {
      return res.status(400).json({ ok: false, code: "invalid_args", message: "Invalid permission change." });
    }
    deps.store.upsertAdminPolicy(claims.workspaceId, claims.adminUserId, next);
    const receipt = successReceipt({
      action: "assistant_update_permissions",
      entity: "assistant_policy",
      data: { policy: next },
    });
    deps.store.addAuditEvent({
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      sessionId: claims.sessionId,
      actionName: "assistant_update_permissions",
      risk: ["permission_change"],
      receipt,
    });
    return res.json({ ok: true, receipt, policy: next });
  });

  // Shared chat-turn logic for both the JSON route and the streaming route, so the
  // safety logic (model-error handling, per-result audit + undo capture, the
  // truthful-preview text override, history persistence) lives in ONE place and the
  // two transports can't drift. `onResult` is called as each result is produced
  // (the streaming route writes it immediately); the JSON route ignores it.
  type ChatTurnOutcome =
    | { ok: true; replyKind: string; replyText: string; results: unknown[] }
    | { ok: false; code: string; message: string };

  async function executeChatTurn(
    claims: { sessionId: string; workspaceId: string; adminUserId: string },
    installation: Installation,
    message: string,
    onResult?: (result: unknown) => void,
    onStatus?: (status: { action: string; label: string }) => void,
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

    if (deps.config.llmAgentic && useTools && typeof deps.modelClient.completeWithTools === "function") {
      // Agentic turn (LLM_AGENTIC=1): the durable tool-loop. Reads + safe writes
      // auto-chain with their receipts fed back to the model; the FIRST risky
      // write interrupts into the preview→button-confirm flow with its suspended
      // transcript persisted, so the confirm route can resume the loop.
      let turn: AgentTurnResult;
      try {
        turn = await runAgentConversation({
          modelClient: tracked.client,
          messages,
          policy,
          authClass: m.ctx.clockify.authClass,
          // The server clock's date so the model narrates the real date instead
          // of its stale knowledge cutoff (finding new-3: "we're still in 2025").
          currentDate: now().toISOString().slice(0, 10),
          runAction: m.runAction,
          onStep: m.onStep,
        });
      } catch {
        return modelUnavailable();
      }
      ({ replyKind, baseText } = settleAgentTurn(m, turn));
    } else {
      let plan;
      try {
        plan = await planConversation({
          modelClient: tracked.client,
          messages,
          actionCatalog: catalogForModel(),
          policy,
          authClass: m.ctx.clockify.authClass,
          // The server clock's date so the model narrates the real date instead
          // of its stale knowledge cutoff (finding new-3: "we're still in 2025").
          currentDate: now().toISOString().slice(0, 10),
          // Native tool-calling by default (provider validates args); LLM_MODE=json
          // forces the JSON + repair path. The harness re-validates either way.
          useTools,
        });
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

  function chatPreconditions(req: Request, res: Response):
    | { claims: { sessionId: string; workspaceId: string; adminUserId: string }; installation: Installation; message: string }
    | undefined {
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

  /**
   * Strip results for HISTORY replay: history is a record, not a control
   * surface. Preview-kind results are dropped (settled ones are inert; LIVE
   * ones are re-served in `pendingPreviews` with a freshly rotated nonce) and
   * `undo` handles are removed (one-use live-moment affordances with unknown
   * liveness after a reload).
   */
  function sanitizeResultsForHistory(results: unknown[]): unknown[] {
    return results
      .filter((r) => !(r && typeof r === "object" && (r as { kind?: string }).kind === "preview"))
      .map((r) => {
        if (r && typeof r === "object" && "undo" in (r as object)) {
          const { undo: _undo, ...rest } = r as { undo?: unknown };
          return pruneHistoryResult(rest);
        }
        // Byte-backstop the count cap: a fat read-action receipt's `data` blob is
        // dropped with an honest note so a marathon session doesn't re-ship
        // megabytes on every reload (r2-new-session-restore-06).
        return pruneHistoryResult(r);
      });
  }

  // Session restore after an iframe reload: replay the stored conversation and
  // re-serve the session's still-live pending previews. Each recovered preview
  // gets a ROTATED one-use nonce (the plaintext lives only in the UI; the old
  // one dies atomically — see rotatePendingNonce). Session-gated; NOT behind
  // the chat rate limit (no model call).
  router.get("/chat/history", (req, res) => {
    const claims = requireSession(req, res);
    if (!claims) return;
    const messages = deps.store
      .getRecentMessages(claims.sessionId, CHAT_HISTORY_LIMIT, true)
      // Drop transient model-failure rows (payload.kind="error"): they are an
      // out-of-band notice the admin already saw live, not a reply to resurrect
      // on reload (finding r2-new-session-restore-05).
      .filter((m) => (m.role === "user" || m.role === "assistant") && !isTransientErrorMessage(m))
      .map((m) => ({
        role: m.role,
        content: m.content,
        results: sanitizeResultsForHistory((m.payload as { results?: unknown[] } | undefined)?.results ?? []),
      }));
    const pendingPreviews: unknown[] = [];
    for (const record of deps.store.listPendingConfirmations(claims.sessionId, now().toISOString())) {
      const rotated = rotatePendingNonce({
        record,
        sessionId: claims.sessionId,
        workspaceId: claims.workspaceId,
        adminUserId: claims.adminUserId,
        sessionSecret: deps.config.sessionSecret,
        now: now(),
      });
      if (!rotated.ok) continue;
      // Conditional swap: a concurrent confirm/cancel wins and the card is dropped.
      if (!deps.store.updateConfirmationNonceHash(record.id, rotated.record.nonceHash)) continue;
      pendingPreviews.push({
        kind: "preview",
        previewId: record.id,
        nonce: rotated.nonce,
        expiresAt: record.expiresAt,
        preview: record.preview,
      });
    }
    res.json({ ok: true, messages, pendingPreviews });
  });

  // Start a new conversation: mint a FRESH session for the same admin+workspace
  // and re-cookie. The previous session's messages are NOT deleted (they remain
  // under retention; the audit log keeps the actions) — only the transcript the
  // UI shows resets. Mirrors the cookie the component route issues so subsequent
  // chat calls bind the new session.
  router.post("/chat/new", (req, res) => {
    const claims = requireSession(req, res);
    if (!claims) return;
    const session = deps.store.createSession({
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
    });
    const sessionClaims: SessionClaims = {
      sessionId: session.id,
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      workspaceRole: claims.workspaceRole,
      expiresAt: session.expiresAt,
    };
    const secure = deps.config.baseUrl.startsWith("https://");
    res.setHeader(
      "Set-Cookie",
      buildSessionCookie(signSessionCookie(sessionClaims, deps.config.sessionSecret), secure),
    );
    res.json({ ok: true });
  });

  // Non-streaming turn (request/response). The mounted UI uses /chat/stream
  // below; this is the tested fallback surface (its client is `submitMessage`).
  // A failed turn returns 502 {ok:false,code,message} — the client surfaces that
  // copy (json() only throws on 401), it never silently renders nothing.
  router.post("/chat/messages", asyncHandler(async (req, res) => {
    const pre = chatPreconditions(req, res);
    if (!pre) return;
    const turn = await executeChatTurn(pre.claims, pre.installation, pre.message);
    if (!turn.ok) return res.status(502).json({ ok: false, code: turn.code, message: turn.message });
    return res.json({ ok: true, reply: { kind: turn.replyKind, text: turn.replyText }, results: turn.results });
  }));

  // Streaming variant (NDJSON): the SAME turn, but each harness result is written
  // as it is produced, then the truthful reply, then `done`. This streams the
  // harness's progress (receipts/clarifies/previews) — never the model's tokens,
  // which would conflict with the truthful-preview override.
  router.post("/chat/stream", asyncHandler(async (req, res) => {
    const pre = chatPreconditions(req, res);
    if (!pre) return;
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no"); // don't let a proxy buffer the stream
    const write = (event: unknown): void => {
      res.write(`${JSON.stringify(event)}\n`);
    };
    try {
      const turn = await executeChatTurn(
        pre.claims,
        pre.installation,
        pre.message,
        (result) => write({ type: "result", result }),
        (status) => write({ type: "status", ...status }),
      );
      if (!turn.ok) write({ type: "error", code: turn.code, message: turn.message });
      else write({ type: "reply", kind: turn.replyKind, text: turn.replyText });
    } catch {
      write({ type: "error", code: "stream_error", message: "Something went wrong." });
    }
    write({ type: "done" });
    res.end();
  }));

  router.post("/confirmations/:id/confirm", asyncHandler(async (req, res) => {
    const claims = requireSession(req, res);
    if (!claims) return;
    const parsed = confirmBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, code: "invalid_args", message: "A confirmation nonce is required." });
    }

    const record = deps.store.getPendingConfirmation(req.params.id);
    if (!record) {
      return res.status(404).json({ ok: false, code: "not_found", message: "No such pending preview." });
    }

    const committed = await commitConfirmation(claims, record, parsed.data.nonce);
    if (!committed.ok) {
      // Validation/policy/the one-use claim rejected BEFORE any commit — always
      // JSON (the stream is never opened), and a denied confirm never burns the nonce.
      return res.status(committed.status).json(committed.body);
    }
    const { receipt, undoId, agentState, installation } = committed;

    // Streaming confirm (?stream=1, used by the embedded UI): the committed
    // receipt flushes IMMEDIATELY so the button is responsive, then the durable
    // resume streams its continuation as it runs. The continuous stream also keeps
    // the connection alive, so a slow multi-step resume can't surface as a tunnel
    // timeout / "Confirmation failed" the way one blocking JSON response could. The
    // JSON path (no ?stream) is unchanged for scripts/tests.
    if (req.query.stream === "1") {
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("X-Accel-Buffering", "no");
      const write = (event: unknown): void => {
        res.write(`${JSON.stringify(event)}\n`);
      };
      write({ type: "receipt", receipt, ...(undoId ? { undo: { id: undoId } } : {}) });
      try {
        const resumed = await runResume(
          claims,
          installation,
          agentState,
          receipt,
          (result) => write({ type: "result", result }),
          (status) => write({ type: "status", ...status }),
        );
        if (resumed) write({ type: "reply", kind: resumed.replyKind, text: resumed.replyText });
      } catch {
        write({ type: "error", code: "resume_error", message: "The follow-up couldn't complete, but your change was applied." });
      }
      write({ type: "done" });
      return res.end();
    }

    // JSON path: collect the resume into the response (unchanged behavior).
    const resumed = await runResume(claims, installation, agentState, receipt);
    return res.status(receipt.ok ? 200 : 400).json({
      ok: receipt.ok,
      receipt,
      ...(undoId ? { undo: { id: undoId } } : {}),
      ...(resumed ? { resume: { reply: { kind: resumed.replyKind, text: resumed.replyText }, results: resumed.results } } : {}),
    });
  }));

  // Undo the last reversible action (Phase 5b): delete the entities it created.
  router.post("/undo/:id", asyncHandler(async (req, res) => {
    const claims = requireSession(req, res);
    if (!claims) return;

    const record = deps.store.getUndoRecord(req.params.id);
    if (!record || record.workspaceId !== claims.workspaceId || record.adminUserId !== claims.adminUserId) {
      return res.status(404).json({ ok: false, code: "not_found", message: "No such undoable action." });
    }
    if (record.status !== "available") {
      return res.status(409).json({ ok: false, code: "already_undone", message: "This action was already undone." });
    }

    // Re-check write policy BEFORE consuming the one-use record, so a lowered policy
    // denies cleanly without burning it (reverseCreation re-checks as defense in depth).
    const denied = firstDeniedGroup(loadPolicy(claims.workspaceId, claims.adminUserId), record.reversal);
    if (denied) {
      return res.status(400).json({
        ok: false,
        code: "policy_denied",
        message: `Undo needs write access to ${denied}, which is disabled in your assistant permissions.`,
      });
    }

    const installation = deps.store.getInstallation(claims.workspaceId);
    if (!installation || installation.status !== "active") {
      return res.status(400).json({ ok: false, code: "not_installed", message: "The add-on is not active for this workspace." });
    }

    // Atomic one-use claim: only the caller that flips available → undone reverses.
    if (!deps.store.markUndone(record.id)) {
      return res.status(409).json({ ok: false, code: "already_undone", message: "This action was already undone." });
    }

    const receipt = await reverseCreation(
      actionContext(claims.workspaceId, claims.adminUserId, installation),
      record.reversal,
    );
    deps.store.addAuditEvent({
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      sessionId: claims.sessionId,
      actionName: "undo",
      risk: ["destructive"],
      receipt,
    });
    return res.status(receipt.ok ? 200 : 400).json({ ok: receipt.ok, receipt });
  }));

  router.post("/confirmations/:id/cancel", (req, res) => {
    const claims = requireSession(req, res);
    if (!claims) return;
    const record = deps.store.getPendingConfirmation(req.params.id);
    if (!record) {
      return res.status(404).json({ ok: false, code: "not_found", message: "No such pending preview." });
    }
    if (
      record.workspaceId !== claims.workspaceId ||
      record.adminUserId !== claims.adminUserId ||
      record.sessionId !== claims.sessionId
    ) {
      return res.status(403).json({ ok: false, code: "forbidden", message: "This preview belongs to a different session." });
    }
    if (!deps.store.cancelConfirmation(record.id)) {
      return res.status(409).json({ ok: false, code: "not_pending", message: "This preview is no longer pending." });
    }
    return res.json({ ok: true, status: "cancelled" });
  });

  return router;
}
