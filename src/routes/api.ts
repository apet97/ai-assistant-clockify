import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
  commitConfirmedOperation,
  executeAction,
} from "../harness/actions.js";
import type { ActionContext, ConfirmableOperation } from "../harness/action.js";
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
import type { ModelMessage } from "../assistant/model-client.js";
import { planConversation } from "../assistant/planner.js";
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
    const history = deps.store.getRecentMessages(claims.sessionId, 12);
    const messages: ModelMessage[] = history
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));

    let plan;
    try {
      plan = await planConversation({
        modelClient: deps.modelClient,
        messages,
        actionCatalog: catalogForModel(),
        policy,
        // Native tool-calling by default (provider validates args); LLM_MODE=json
        // forces the JSON + repair path. The harness re-validates either way.
        useTools: deps.config.llmMode !== "json",
      });
    } catch {
      // A model/transport failure must never crash the server. Surface a calm,
      // non-leaking message and let the admin retry.
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
    }

    const results: unknown[] = [];
    const emit = (result: unknown): void => {
      results.push(result);
      onResult?.(result);
    };

    if (plan.kind === "actions" && plan.actions) {
      const ctx = actionContext(claims.workspaceId, claims.adminUserId, installation);
      for (const proposed of plan.actions) {
        let outcome;
        try {
          outcome = await executeAction({ actionName: proposed.name, args: proposed.arguments, context: ctx });
        } catch (err) {
          // A safe write that throws (e.g. the Clockify API rejects it) returns an
          // error receipt — it must not take down the process (Express 4 does not
          // catch async throws). The message carries no token/secret.
          const receipt = errorReceipt({
            action: proposed.name,
            code: "action_failed",
            message: err instanceof Error ? err.message.slice(0, 200) : "The action could not be completed.",
          });
          deps.store.addAuditEvent({
            workspaceId: claims.workspaceId,
            adminUserId: claims.adminUserId,
            sessionId: claims.sessionId,
            actionName: proposed.name,
            risk: getAction(proposed.name)?.risks ?? [],
            receipt,
          });
          emit({ kind: "receipt", receipt });
          continue;
        }
        if (outcome.kind === "receipt") {
          deps.store.addAuditEvent({
            workspaceId: claims.workspaceId,
            adminUserId: claims.adminUserId,
            sessionId: claims.sessionId,
            actionName: proposed.name,
            risk: getAction(proposed.name)?.risks ?? [],
            receipt: outcome.receipt,
          });
          const undoId = recordUndoIfReversible(claims, outcome.receipt);
          emit({ kind: "receipt", receipt: outcome.receipt, ...(undoId ? { undo: { id: undoId } } : {}) });
        } else if (outcome.kind === "clarify") {
          emit({ kind: "clarify", message: outcome.message, options: outcome.options });
        } else {
          const created = createPendingConfirmation({
            sessionId: claims.sessionId,
            workspaceId: claims.workspaceId,
            adminUserId: claims.adminUserId,
            risk: outcome.operation.risks,
            preview: outcome.preview,
            operation: outcome.operation,
            sessionSecret: deps.config.sessionSecret,
            now: now(),
          });
          deps.store.savePendingConfirmation(created.record);
          emit({
            kind: "preview",
            previewId: created.previewId,
            nonce: created.nonce,
            expiresAt: created.expiresAt,
            preview: outcome.preview,
          });
        }
      }
    }

    // SAFETY (SPEC "never claim a risky action is done"): a risky action only
    // executes on a button confirmation, never on the model's say-so. The model
    // sometimes narrates a false "Done!/Confirmed" for a pending preview, so when
    // the harness returned previews we REPLACE the model's text with a truthful,
    // not-yet-applied instruction — and store THAT (not the false claim) so the
    // model's own history can't convince it the action already happened. The
    // streaming route emits this replyText AFTER the results, for the same reason:
    // the truthful text isn't known until execution finishes.
    const pendingPreviews = results.filter(
      (r): r is { kind: "preview" } => (r as { kind?: string }).kind === "preview",
    ).length;
    const replyText =
      pendingPreviews > 0
        ? pendingPreviews > 1
          ? `I've prepared ${pendingPreviews} changes — review them below and click "Confirm all" to apply. Nothing has been changed yet.`
          : `Review the change below and click "Confirm" to apply it. Nothing has been changed yet.`
        : plan.text;

    deps.store.addMessage({
      sessionId: claims.sessionId,
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      role: "assistant",
      content: replyText,
      payload: { kind: plan.kind, results },
    });

    return { ok: true, replyKind: plan.kind, replyText, results };
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

    const validation = confirmPending({
      record,
      sessionId: claims.sessionId,
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      nonce: parsed.data.nonce,
      sessionSecret: deps.config.sessionSecret,
      now: now(),
    });
    if (!validation.ok) {
      return res.status(400).json({ ok: false, code: validation.code, message: validation.message });
    }

    const operation = record.operation as ConfirmableOperation;

    // Re-check current policy BEFORE consuming the one-use preview, so a policy
    // that was lowered after the preview denies cleanly without burning it
    // (commitConfirmedOperation re-checks again as defense in depth).
    if (!operation.risks.includes("permission_change")) {
      const policy = loadPolicy(claims.workspaceId, claims.adminUserId);
      if (!canWrite(policy, operation.featureGroup)) {
        return res.status(400).json({
          ok: false,
          code: "policy_denied",
          message: `Write access to ${operation.featureGroup} is disabled in your assistant permissions.`,
        });
      }
    }

    // Atomic one-use claim: only the caller that transitions pending → used wins.
    if (!deps.store.markConfirmationUsed(record.id)) {
      return res.status(409).json({ ok: false, code: "already_used", message: "This preview was already used." });
    }
    let receipt;
    if (operation.risks.includes("permission_change")) {
      const groups = (operation.payload as { groups: Record<string, never> }).groups;
      const base = loadPolicy(claims.workspaceId, claims.adminUserId);
      const nextPolicy = applyPolicyPatch(base, { groups });
      deps.store.upsertAdminPolicy(claims.workspaceId, claims.adminUserId, nextPolicy);
      receipt = successReceipt({
        action: operation.actionName,
        entity: "assistant_policy",
        data: { policy: nextPolicy },
      });
    } else {
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
    return res.status(receipt.ok ? 200 : 400).json({ ok: receipt.ok, receipt, ...(undoId ? { undo: { id: undoId } } : {}) });
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
