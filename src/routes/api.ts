import { Router, type Request, type Response } from "express";
import { buildMetrics, buildUsageMetrics } from "../metrics/metrics.js";
import { reverseCreation, firstDeniedGroup } from "../harness/undo.js";
import {
  FEATURE_GROUPS,
  applyPolicyPatch,
  defaultAdminPolicy,
  type AdminPolicy,
} from "../harness/permissions.js";
import { rotatePendingNonce } from "../harness/confirmations.js";
import { successReceipt } from "../harness/receipts.js";
import { setSessionCookie, type AppDeps } from "./deps.js";
import { type SessionClaims } from "../auth/sessions.js";
import { THIRTY_DAYS_MS } from "../durations.js";
import { isTransientErrorMessage } from "./history-sanitizer.js";
import {
  groupsPatchSchema,
  confirmBodySchema,
} from "./request-schemas.js";
import { asyncHandler } from "./async-handler.js";
import { bestEffort } from "./best-effort.js";
import { openNdjsonStream } from "./ndjson.js";
import { sanitizeResultsForHistory } from "./chat-results.js";
import { createChatPipeline } from "./chat-pipeline.js";

/**
 * JSON API (SPEC "Chat Flow", "Confirmation Rules", "Permissions Inside Chat").
 * Every route requires an authenticated admin session. Risky actions never
 * execute here: chat creates previews; only the confirm route — with a valid
 * button nonce and an atomic one-use claim — executes the stored operation.
 */

/**
 * How many stored messages GET /api/chat/history replays to the UI after an iframe
 * reload. Distinct from the MODEL context window (`HISTORY_WINDOW_MESSAGES`, 12) —
 * this is the human's restored VIEW (a marathon session stores 100s of messages; 50
 * is plenty to re-anchor without shipping megabytes of payloads). Named *_RESTORE_*
 * so it is never mistaken for the LLM window.
 */
export const CHAT_HISTORY_RESTORE_LIMIT = 50;

export function apiRouter(deps: AppDeps): Router {
  const router = Router();
  const now = deps.now ?? (() => new Date());
  // The deps-capturing turn/confirm/commit pipeline (plan 007 Phase B). It
  // owns the per-instance chat rate limiter and a derived clock; the route
  // handlers below call its methods.
  const pipeline = createChatPipeline(deps);
  const { loadPolicy, requireSession, newChatAllowed, actionContext, runResume, commitConfirmation, executeChatTurn, chatPreconditions } =
    pipeline;

  // Shared validate→apply step for the two permission routes (preview + confirm):
  // Zod-parse the groups patch, load the caller's base policy, and apply the patch.
  // Returns the resolved triple, or `undefined` AFTER writing the exact 400 the
  // route used to write inline (so both routes keep byte-identical error codes and
  // messages). The caller does `const r = resolvePermissionPatch(...); if (!r) return;`.
  function resolvePermissionPatch(
    req: Request,
    res: Response,
    claims: SessionClaims,
  ): { base: AdminPolicy; next: AdminPolicy; changedGroups: string[] } | undefined {
    const parsed = groupsPatchSchema.safeParse(req.body?.groups);
    if (!parsed.success) {
      res.status(400).json({ ok: false, code: "invalid_args", message: "Invalid permission groups." });
      return undefined;
    }
    const base = loadPolicy(claims.workspaceId, claims.adminUserId);
    try {
      const next = applyPolicyPatch(base, { groups: parsed.data ?? {} });
      const changedGroups = Object.keys(parsed.data ?? {});
      return { base, next, changedGroups };
    } catch {
      res.status(400).json({ ok: false, code: "invalid_args", message: "Invalid permission change." });
      return undefined;
    }
  }

  router.get("/me", asyncHandler(async (req, res) => {
    const claims = await requireSession(req, res);
    if (!claims) return;
    res.json({
      ok: true,
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      workspaceRole: claims.workspaceRole,
    });
  }));

  // Operational metrics (Phase 7): per-action success/failure, error taxonomy, and
  // confirm/cancel/expire rates — scoped to the caller's own actions (privacy).
  // Optional ?since=<ISO> windows the report. Absent ?since DEFAULTS to the last
  // 30 days (matching the telemetry/confirmation retention horizon): audit_events
  // is retained for RETENTION_DAYS (default 90), so even an unbounded read scans
  // at most that window — the 30-day default still avoids aggregating every
  // retained row in JS. An explicit ?since override reaches the full retained
  // history for ops (r1-efficiency-01).
  router.get("/metrics", asyncHandler(async (req, res) => {
    const claims = await requireSession(req, res);
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
  }));

  router.get("/permissions", asyncHandler(async (req, res) => {
    const claims = await requireSession(req, res);
    if (!claims) return;
    const existing = deps.store.getAdminPolicy(claims.workspaceId, claims.adminUserId);
    res.json({
      ok: true,
      policy: existing ?? defaultAdminPolicy(),
      firstRun: !existing,
      featureGroups: FEATURE_GROUPS,
    });
  }));

  router.post("/permissions/preview", asyncHandler(async (req, res) => {
    const claims = await requireSession(req, res);
    if (!claims) return;
    const r = resolvePermissionPatch(req, res, claims);
    if (!r) return;
    res.json({ ok: true, preview: { current: r.base, next: r.next, changedGroups: r.changedGroups } });
  }));

  router.post("/permissions/confirm", asyncHandler(async (req, res) => {
    const claims = await requireSession(req, res);
    if (!claims) return;
    const r = resolvePermissionPatch(req, res, claims);
    if (!r) return;
    const next = r.next;
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
    res.json({ ok: true, receipt, policy: next });
  }));

  // Session restore after an iframe reload: replay the stored conversation and
  // re-serve the session's still-live pending previews. Each recovered preview
  // gets a ROTATED one-use nonce (the plaintext lives only in the UI; the old
  // one dies atomically — see rotatePendingNonce). Session-gated; NOT behind
  // the chat rate limit (no model call).
  router.get("/chat/history", asyncHandler(async (req, res) => {
    const claims = await requireSession(req, res);
    if (!claims) return;
    const messages = deps.store
      .getRecentMessages(claims.sessionId, CHAT_HISTORY_RESTORE_LIMIT, true)
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
  }));

  // List this admin's live, non-empty conversations (the chat-history switcher).
  // Session-gated and tenant-scoped (listSessions filters by workspace+admin), so
  // it can never enumerate another tenant's sessions. `current` is decided HERE
  // from the cookie's claims — the UI can't know its own (HttpOnly) session id.
  router.get("/chat/sessions", asyncHandler(async (req, res) => {
    const claims = await requireSession(req, res);
    if (!claims) return;
    const sessions = deps.store
      .listSessions(claims.workspaceId, claims.adminUserId, now().toISOString())
      .map((s) => ({ ...s, current: s.id === claims.sessionId }));
    res.json({ ok: true, sessions });
  }));

  // Start a new conversation: mint a FRESH session for the same admin+workspace
  // and re-cookie. The previous session's messages are NOT deleted (they remain
  // under retention; the audit log keeps the actions) — only the transcript the
  // UI shows resets. Mirrors the cookie the component route issues so subsequent
  // chat calls bind the new session.
  router.post("/chat/new", asyncHandler(async (req, res) => {
    const claims = await requireSession(req, res);
    if (!claims) return;
    // Per-admin cap on session creation: the chat limiter is per-session, so without
    // this an admin could mint fresh sessions to reset the paid-model-loop budget.
    const limited = newChatAllowed(claims.workspaceId, claims.adminUserId);
    if (!limited.allowed) {
      res.setHeader("Retry-After", String(Math.ceil(limited.retryAfterMs / 1000)));
      res.status(429).json({
        ok: false,
        code: "rate_limited",
        message: "You're starting new chats too quickly — please wait a moment and try again.",
      });
      return;
    }
    const session = deps.store.createSession({
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      ttlMs: deps.config.sessionTtlMs,
    });
    const sessionClaims: SessionClaims = {
      sessionId: session.id,
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      workspaceRole: claims.workspaceRole,
      expiresAt: session.expiresAt,
    };
    setSessionCookie(res, sessionClaims, deps.config.sessionSecret, deps.config.baseUrl);
    res.json({ ok: true });
  }));

  // Switch the cookie to a PAST conversation (the chat-history switcher). `:id` is
  // attacker-controlled, so this is the IDOR-guarded re-cookie: the target must be
  // a LIVE session owned by THIS workspace+admin. getSession already drops expired
  // sessions (so an expired/unknown id 404s for free, no TTL revival); the ownership
  // check mirrors resolveSession / the component reuse gate. A foreign/other-admin
  // target returns 404 (NOT 403 — existence is never confirmed) and sets no cookie.
  // The re-cookie carries the TARGET session's own expiry — never extended.
  router.post("/chat/sessions/:id/open", asyncHandler(async (req, res) => {
    const claims = await requireSession(req, res);
    if (!claims) return;
    const target = deps.store.getSession(req.params.id);
    if (
      !target ||
      target.workspaceId !== claims.workspaceId ||
      target.adminUserId !== claims.adminUserId
    ) {
      res.status(404).json({ ok: false, code: "not_found", message: "Conversation not found." });
      return;
    }
    const sessionClaims: SessionClaims = {
      sessionId: target.id,
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      workspaceRole: claims.workspaceRole,
      expiresAt: target.expiresAt,
    };
    setSessionCookie(res, sessionClaims, deps.config.sessionSecret, deps.config.baseUrl);
    res.json({ ok: true });
  }));

  // Non-streaming turn (request/response). The mounted UI uses /chat/stream
  // below; this is the tested fallback surface (its client is `submitMessage`).
  // A failed turn returns 502 {ok:false,code,message} — the client surfaces that
  // copy (json() only throws on 401), it never silently renders nothing.
  router.post("/chat/messages", asyncHandler(async (req, res) => {
    const pre = await chatPreconditions(req, res);
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
    const pre = await chatPreconditions(req, res);
    if (!pre) return;
    // openNdjsonStream sets the streaming headers and wires cooperative
    // cancellation: `signal` fires if the client (iframe/proxy) drops mid-turn,
    // so no further model calls or writes run for a turn nobody is watching.
    const { write, signal } = openNdjsonStream(res);
    try {
      const turn = await executeChatTurn(
        pre.claims,
        pre.installation,
        pre.message,
        (result) => write({ type: "result", result }),
        (status) => write({ type: "status", ...status }),
        signal,
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
    const claims = await requireSession(req, res);
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
      // openNdjsonStream sets the streaming headers and fires `signal` if the
      // client drops mid-resume (see /chat/stream).
      const { write, signal } = openNdjsonStream(res);
      write({ type: "receipt", receipt, ...(undoId ? { undo: { id: undoId } } : {}) });
      try {
        const resumed = await runResume(
          claims,
          installation,
          agentState,
          receipt,
          (result) => write({ type: "result", result }),
          (status) => write({ type: "status", ...status }),
          signal,
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
    const claims = await requireSession(req, res);
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
    // The reversal already happened (and the one-use claim is already flipped to
    // undone). A transient audit-write failure must NOT surface as a 500 — the admin
    // would retry and hit already_undone (409), believing it failed when it succeeded.
    // Mirror commitConfirmation: best-effort audit, message-only log, return the receipt.
    bestEffort("undo bookkeeping", () => {
      deps.store.addAuditEvent({
        workspaceId: claims.workspaceId,
        adminUserId: claims.adminUserId,
        sessionId: claims.sessionId,
        actionName: "undo",
        risk: ["destructive"],
        receipt,
      });
    });
    return res.status(receipt.ok ? 200 : 400).json({ ok: receipt.ok, receipt });
  }));

  router.post("/confirmations/:id/cancel", asyncHandler(async (req, res) => {
    const claims = await requireSession(req, res);
    if (!claims) return;
    const record = deps.store.getPendingConfirmation(req.params.id);
    if (!record) {
      res.status(404).json({ ok: false, code: "not_found", message: "No such pending preview." });
      return;
    }
    if (
      record.workspaceId !== claims.workspaceId ||
      record.adminUserId !== claims.adminUserId ||
      record.sessionId !== claims.sessionId
    ) {
      res.status(403).json({ ok: false, code: "forbidden", message: "This preview belongs to a different session." });
      return;
    }
    if (!deps.store.cancelConfirmation(record.id)) {
      res.status(409).json({ ok: false, code: "not_pending", message: "This preview is no longer pending." });
      return;
    }
    res.json({ ok: true, status: "cancelled" });
  }));

  return router;
}
