import { Router, type Response } from "express";
import type { SessionClaims } from "../auth/sessions.js";
import type { HistoryService } from "../services/history-service.js";
import type { SessionContextService } from "../services/session-context-service.js";
import type { ChatPipeline } from "./chat-pipeline.js";
import { withHostCallBudget } from "../clockify/request-governor.js";
import { asyncHandler } from "./async-handler.js";
import { openNdjsonStream } from "./ndjson.js";
import { requestAbortScope } from "./request-abort.js";
import type { RequireSession, WrappedHandler } from "./route-ports.js";

/**
 * Chat transport routes (T16-F): history restore, the conversation switcher,
 * and the two turn surfaces (JSON + NDJSON stream). Each handler decodes,
 * authorizes, calls ONE service/pipeline seam, and encodes; conversation
 * logic lives in `HistoryService`/`SessionContextService`/the selected
 * pipeline.
 */
export function chatRouter(options: {
  requireSession: RequireSession;
  history: HistoryService;
  sessionContext: SessionContextService;
  pipeline: Pick<ChatPipeline, "chatPreconditions" | "executeChatTurn" | "newChatAllowed">;
  sessionAsyncHandler: WrappedHandler;
  /** Sign + set the session cookie (composition-owned so attributes never drift). */
  setCookie: (res: Response, claims: SessionClaims) => void;
  /** Durable-generation gate at the session-creation boundary. */
  activeGenerationAt: (workspaceId: string, generation: number) => boolean;
  /** Best-effort turn-run finalization that never replaces a truthful response. */
  finishTurnRun: (
    sessionId: string,
    requestId: string,
    status: "succeeded" | "failed" | "outcome_unknown",
    response: { status: number; body: unknown },
    resultLinks?: Extract<Awaited<ReturnType<ChatPipeline["executeChatTurn"]>>, { ok: true }>["resultLinks"],
  ) => void;
}): Router {
  const router = Router();
  const { chatPreconditions, executeChatTurn, newChatAllowed } = options.pipeline;

  const rejectInstallationChange = (res: Response): void => {
    res.status(409).json({
      ok: false,
      code: "installation_changed",
      message: "The Clockify installation changed before this request could be saved. No change was made.",
    });
  };

  // Session restore after an iframe reload (see HistoryService). Session-gated;
  // NOT behind the chat rate limit (no model call).
  router.get("/chat/history", asyncHandler(async (req, res) => {
    const claims = await options.requireSession(req, res);
    if (!claims) return;
    res.json({ ok: true, ...options.history.view(claims) });
  }));

  router.get("/chat/sessions", asyncHandler(async (req, res) => {
    const claims = await options.requireSession(req, res);
    if (!claims) return;
    res.json({ ok: true, ...options.sessionContext.listSessions(claims) });
  }));

  // Start a new conversation: mint a FRESH session and re-cookie. Capped per
  // admin so minting sessions cannot reset the per-session paid-loop budget.
  router.post("/chat/new", asyncHandler(async (req, res) => {
    const claims = await options.requireSession(req, res);
    if (!claims) return;
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
    // requireSession awaited current-role I/O. Recheck the exact generation at
    // the session-creation boundary so uninstall/reinstall cannot recreate a
    // session after workspace erasure at the promise handoff.
    if (!options.activeGenerationAt(claims.workspaceId, claims.installationGeneration)) {
      rejectInstallationChange(res);
      return;
    }
    options.setCookie(res, options.sessionContext.startNewSession(claims));
    res.json({ ok: true });
  }));

  // Switch to a PAST conversation. `:id` is attacker-controlled; the service's
  // ownership check is the IDOR guard — a foreign/unknown/expired target 404s
  // (existence is never confirmed) and sets no cookie.
  router.post("/chat/sessions/:id/open", asyncHandler(async (req, res) => {
    const claims = await options.requireSession(req, res);
    if (!claims) return;
    const target = options.sessionContext.openSession(claims, req.params.id);
    if (!target) {
      res.status(404).json({ ok: false, code: "not_found", message: "Conversation not found." });
      return;
    }
    options.setCookie(res, target);
    res.json({ ok: true });
  }));

  // Non-streaming turn (request/response) — the tested fallback surface.
  router.post("/chat/messages", options.sessionAsyncHandler(async (req, res) => {
    const pre = await chatPreconditions(req, res);
    if (!pre) return;
    if (pre.replay) return res.status(pre.replay.status).json(pre.replay.body);
    const requestAbort = requestAbortScope(req, res);
    let turn: Awaited<ReturnType<typeof executeChatTurn>>;
    try {
      turn = await withHostCallBudget(() => executeChatTurn(
        pre.claims,
        pre.installation,
        pre.message,
        undefined,
        undefined,
        requestAbort.signal,
        pre.requestId,
        pre.continuationRunId,
      ));
    } finally {
      requestAbort.dispose();
    }
    const status = turn.ok ? 200 : 502;
    const body = turn.ok
      ? { ok: true, reply: { kind: turn.replyKind, text: turn.replyText }, results: turn.results }
      : { ok: false, code: turn.code, message: turn.message };
    options.finishTurnRun(
      pre.claims.sessionId,
      pre.requestId,
      turn.ok ? "succeeded" : "failed",
      { status, body },
      turn.ok ? turn.resultLinks : [],
    );
    return res.status(status).json(body);
  }));

  // Streaming variant (NDJSON): the SAME turn, but each harness result is
  // written as it is produced, then the truthful reply, then `done`. Never the
  // model's tokens (truthful-preview override).
  router.post("/chat/stream", options.sessionAsyncHandler(async (req, res) => {
    const pre = await chatPreconditions(req, res);
    if (!pre) return;
    const { write, signal } = openNdjsonStream(res);
    if (pre.replay) {
      const body = pre.replay.body as { ok?: boolean; reply?: { kind?: string; text?: string }; results?: unknown[]; code?: string; message?: string };
      if (body.ok) {
        for (const result of body.results ?? []) write({ type: "result", result });
        write({ type: "reply", kind: body.reply?.kind ?? "answer", text: body.reply?.text ?? "" });
      } else {
        write({ type: "error", code: body.code ?? "operation_failed", message: body.message ?? "The prior request failed." });
      }
      write({ type: "done" });
      return res.end();
    }
    try {
      const turn = await withHostCallBudget(() => executeChatTurn(
        pre.claims,
        pre.installation,
        pre.message,
        (result) => write({ type: "result", result }),
        (status) => write({ type: "status", ...status }),
        signal,
        pre.requestId,
        pre.continuationRunId,
      ));
      const status = turn.ok ? 200 : 502;
      const body = turn.ok
        ? { ok: true, reply: { kind: turn.replyKind, text: turn.replyText }, results: turn.results }
        : { ok: false, code: turn.code, message: turn.message };
      options.finishTurnRun(
        pre.claims.sessionId,
        pre.requestId,
        turn.ok ? "succeeded" : "failed",
        { status, body },
        turn.ok ? turn.resultLinks : [],
      );
      if (!turn.ok) write({ type: "error", code: turn.code, message: turn.message });
      else write({ type: "reply", kind: turn.replyKind, text: turn.replyText });
    } catch {
      options.finishTurnRun(pre.claims.sessionId, pre.requestId, "outcome_unknown", {
        status: 500,
        body: { ok: false, code: "operation_outcome_unknown", message: "The turn was interrupted and its outcome is unknown." },
      });
      write({ type: "error", code: "stream_error", message: "Something went wrong." });
    }
    write({ type: "done" });
    res.end();
  }));

  return router;
}
