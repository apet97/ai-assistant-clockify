import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
  commitConfirmedOperation,
  executeAction,
} from "../harness/actions.js";
import type { ActionContext, ActionResult, ConfirmableOperation, PreviewCard } from "../harness/action.js";
import type { IdempotencyLedger } from "../harness/idempotency.js";
import { reverseCreation, reversibleCreations, firstDeniedGroup } from "../harness/undo.js";
import { buildMetrics } from "../metrics/metrics.js";
import { catalogForModel, getAction } from "../harness/catalog.js";
import {
  FEATURE_GROUPS,
  applyPolicyPatch,
  canWrite,
  defaultAdminPolicy,
  permissionLevelSchema,
  type AdminPolicy,
  type FeatureGroup,
} from "../harness/permissions.js";
import {
  confirmPending,
  createPendingConfirmation,
} from "../harness/confirmations.js";
import { errorReceipt, successReceipt, type SuccessReceipt, type ErrorReceipt } from "../harness/receipts.js";
import { runAgentTurn, type AgentStep, type AgentTurnResult } from "../assistant/agent-loop.js";
import { capAgentState, parseAgentState, resumeMessages, type AgentState } from "../assistant/agent-state.js";
import type { ModelMessage, ToolCall } from "../assistant/model-client.js";
import { planConversation, runAgentConversation } from "../assistant/planner.js";
import { toolsForModel } from "../harness/tools.js";
import type { Installation } from "../db/store.js";
import { resolveSession, type AppDeps } from "./deps.js";

/**
 * JSON API (SPEC "Chat Flow", "Confirmation Rules", "Permissions Inside Chat").
 * Every route requires an authenticated admin session. Risky actions never
 * execute here: chat creates previews; only the confirm route — with a valid
 * button nonce and an atomic one-use claim — executes the stored operation.
 */
const groupsPatchSchema = z
  .record(z.enum(FEATURE_GROUPS as [FeatureGroup, ...FeatureGroup[]]), permissionLevelSchema)
  .optional();

const chatBodySchema = z.object({ message: z.string().min(1) });
const confirmBodySchema = z.object({ nonce: z.string().min(1) });

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
 * The deterministic truthful-preview replies this route STORES for pending
 * previews (`truthfulReplyText`). A session saturated with them taught the
 * model to parrot the boilerplate as its own answer with zero tool calls
 * (live item 318) — so the model-visible history rewrites them into a neutral
 * factual note. The stored history (what the admin saw) is never changed.
 */
const PREVIEW_BOILERPLATE =
  /^(Review the change below and click "Confirm" to apply it\.|I've prepared \d+ changes — review them below and click "Confirm all" to apply\.)/;

export function sanitizeStoredReplyForModel(content: string): string {
  if (!PREVIEW_BOILERPLATE.test(content)) return content;
  return "[I prepared a pending change here; it awaited the admin's button confirmation and had not been applied at that point.]";
}

/** Idempotency window: re-confirming the same intent within this is deduped. */
const IDEMPOTENCY_WINDOW_MS = 10 * 60 * 1000;

export function apiRouter(deps: AppDeps): Router {
  const router = Router();
  const now = deps.now ?? (() => new Date());

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
      deps.store.addAuditEvent({
        workspaceId: claims.workspaceId,
        adminUserId: claims.adminUserId,
        sessionId: claims.sessionId,
        actionName,
        risk: getAction(actionName)?.risks ?? [],
        receipt,
      });
      const undoId = recordUndoIfReversible(claims, receipt);
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
    if (turn.kind === "clarify") return { replyKind: "clarify", baseText: turn.message };
    // "final" and "exhausted" both carry truthful text from the loop.
    return { replyKind: "answer", baseText: turn.text };
  }

  // SAFETY (SPEC "never claim a risky action is done"): a risky action only
  // executes on a button confirmation, never on the model's say-so. The model
  // sometimes narrates a false "Done!/Confirmed" for a pending preview, so when
  // the turn produced previews we REPLACE the model's text with a truthful,
  // not-yet-applied instruction — and store THAT (not the false claim) so the
  // model's own history can't convince it the action already happened.
  function truthfulReplyText(results: unknown[], baseText: string): string {
    const pendingPreviews = results.filter(
      (r): r is { kind: "preview" } => (r as { kind?: string }).kind === "preview",
    ).length;
    if (pendingPreviews === 0) return baseText;
    return pendingPreviews > 1
      ? `I've prepared ${pendingPreviews} changes — review them below and click "Confirm all" to apply. Nothing has been changed yet.`
      : `Review the change below and click "Confirm" to apply it. Nothing has been changed yet.`;
  }

  function persistAssistantReply(claims: Claims, replyKind: string, replyText: string, results: unknown[]): void {
    deps.store.addMessage({
      sessionId: claims.sessionId,
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      role: "assistant",
      content: replyText,
      payload: { kind: replyKind, results },
    });
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
    const m = createTurnMachinery(claims, installation, onResult);
    let turn: AgentTurnResult | undefined;
    try {
      turn = await runAgentTurn({
        modelClient: deps.modelClient,
        messages: resumeMessages(agentState, receipt),
        tools: toolsForModel(),
        runAction: m.runAction,
        onStep: m.onStep,
      });
    } catch {
      // The commit already happened and its receipt is returned regardless; a
      // model failure here only loses the follow-up narration.
      return undefined;
    }
    const { replyKind, baseText } = settleAgentTurn(m, turn);
    const replyText = truthfulReplyText(m.results, baseText);
    persistAssistantReply(claims, replyKind, replyText, m.results);
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
      // A store-backed idempotency ledger (10-min window) so re-confirming the
      // same intent (e.g. the same invoice) can't create a duplicate.
      const idempotency: IdempotencyLedger = {
        lookup: (key) => deps.store.lookupIdempotency(key, now().getTime() - IDEMPOTENCY_WINDOW_MS),
        record: (key, r) => deps.store.recordIdempotency(key, r, now().getTime()),
      };
      receipt = await commitConfirmedOperation(
        { ...actionContext(claims.workspaceId, claims.adminUserId, installation), idempotency },
        operation,
      );
    }

    deps.store.setConfirmationResult(record.id, receipt.ok ? "used" : "failed", receipt);
    deps.store.addAuditEvent({
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      sessionId: claims.sessionId,
      actionName: operation.actionName,
      risk: operation.risks,
      receipt,
    });
    const undoId = recordUndoIfReversible(claims, receipt);
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
  // Optional ?since=<ISO> windows the report.
  router.get("/metrics", (req, res) => {
    const claims = requireSession(req, res);
    if (!claims) return;
    const since = typeof req.query.since === "string" ? req.query.since : undefined;
    const outcomes = deps.store.listActionOutcomes(claims.workspaceId, claims.adminUserId, since);
    const confirmations = deps.store.listConfirmationOutcomes(claims.workspaceId, claims.adminUserId, since);
    res.json({ ok: true, metrics: buildMetrics(outcomes, confirmations, now().toISOString()) });
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
  ): Promise<ChatTurnOutcome> {
    deps.store.addMessage({
      sessionId: claims.sessionId,
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      role: "user",
      content: message,
    });

    const policy = loadPolicy(claims.workspaceId, claims.adminUserId);
    const history = deps.store.getRecentMessages(claims.sessionId, HISTORY_WINDOW_MESSAGES);
    const messages: ModelMessage[] = history
      .filter((m) => m.role !== "system")
      .map((m) =>
        m.role === "assistant"
          ? { role: "assistant" as const, content: sanitizeStoredReplyForModel(m.content) }
          : { role: "user" as const, content: m.content },
      );

    const m = createTurnMachinery(claims, installation, onResult);

    // A model/transport failure must never crash the server. Surface a calm,
    // non-leaking message and let the admin retry.
    const modelUnavailable = (): ChatTurnOutcome => {
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
          modelClient: deps.modelClient,
          messages,
          policy,
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
          modelClient: deps.modelClient,
          messages,
          actionCatalog: catalogForModel(),
          policy,
          // Native tool-calling by default (provider validates args); LLM_MODE=json
          // forces the JSON + repair path. The harness re-validates either way.
          useTools,
        });
      } catch {
        return modelUnavailable();
      }

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
          } else {
            m.emitPreviewFor(outcome.preview, outcome.operation);
          }
        }
      }
      replyKind = plan.kind;
      baseText = plan.text;
    }

    // The truthful-preview override (see truthfulReplyText): a pending preview
    // replaces the model's text. The streaming route emits this replyText AFTER
    // the results — the truthful text isn't known until execution finishes.
    const replyText = truthfulReplyText(m.results, baseText);
    persistAssistantReply(claims, replyKind, replyText, m.results);
    return { ok: true, replyKind, replyText, results: m.results };
  }

  function chatPreconditions(req: Request, res: Response):
    | { claims: { sessionId: string; workspaceId: string; adminUserId: string }; installation: Installation; message: string }
    | undefined {
    const claims = requireSession(req, res);
    if (!claims) return undefined;
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

  router.post("/chat/messages", async (req, res) => {
    const pre = chatPreconditions(req, res);
    if (!pre) return;
    const turn = await executeChatTurn(pre.claims, pre.installation, pre.message);
    if (!turn.ok) return res.status(502).json({ ok: false, code: turn.code, message: turn.message });
    return res.json({ ok: true, reply: { kind: turn.replyKind, text: turn.replyText }, results: turn.results });
  });

  // Streaming variant (NDJSON): the SAME turn, but each harness result is written
  // as it is produced, then the truthful reply, then `done`. This streams the
  // harness's progress (receipts/clarifies/previews) — never the model's tokens,
  // which would conflict with the truthful-preview override.
  router.post("/chat/stream", async (req, res) => {
    const pre = chatPreconditions(req, res);
    if (!pre) return;
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no"); // don't let a proxy buffer the stream
    const write = (event: unknown): void => {
      res.write(`${JSON.stringify(event)}\n`);
    };
    try {
      const turn = await executeChatTurn(pre.claims, pre.installation, pre.message, (result) =>
        write({ type: "result", result }),
      );
      if (!turn.ok) write({ type: "error", code: turn.code, message: turn.message });
      else write({ type: "reply", kind: turn.replyKind, text: turn.replyText });
    } catch {
      write({ type: "error", code: "stream_error", message: "Something went wrong." });
    }
    write({ type: "done" });
    res.end();
  });

  router.post("/confirmations/:id/confirm", async (req, res) => {
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
        const resumed = await runResume(claims, installation, agentState, receipt, (result) =>
          write({ type: "result", result }),
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
  });

  // Undo the last reversible action (Phase 5b): delete the entities it created.
  router.post("/undo/:id", async (req, res) => {
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
  });

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
