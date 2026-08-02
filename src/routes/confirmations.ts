import { Router } from "express";
import type { ConfirmationService } from "../services/confirmation-service.js";
import type { ChatPipeline } from "./chat-pipeline.js";
import { withHostCallBudget } from "../clockify/request-governor.js";
import { confirmBodySchema } from "./request-schemas.js";
import { openNdjsonStream } from "./ndjson.js";
import { requestAbortScope } from "./request-abort.js";
import type { RequireSession, WrappedHandler } from "./route-ports.js";

type PendingRecord = Parameters<ConfirmationService["confirmSingle"]>[0]["record"];

/**
 * Single-confirmation transport routes (T16-F): confirm (v1 commit or the v2
 * ConfirmationService — chosen by the injected discriminator port) and cancel.
 * Risky writes execute ONLY through these confirm seams, with a valid button
 * nonce; the batch surface lives in `confirmation-batches.ts`.
 */
export function confirmationsRouter(options: {
  requireSession: RequireSession;
  confirmationService: Pick<ConfirmationService, "confirmSingle">;
  pipeline: Pick<ChatPipeline, "commitConfirmation" | "runResume">;
  /** True when the stored record is a v2 preview (authorityModel discriminator). */
  isV2Preview: (record: PendingRecord) => boolean;
  /** True when the record belongs to a Confirm-all batch — per-item cancel is
   * rejected with `batch_cancel_required` (closure-plan PR 4), and per-item
   * confirm with `batch_confirmation_required` (C12).
   *
   * REQUIRED, not optional. Both guards are pure wiring: an omitted port used
   * to disable them silently, with no compile error and no failing test, and
   * the C12 guard is exactly what makes `commitConfirmation` v1-only — a
   * reachability fact that was true of one call site and enforced by nothing.
   * A future router built without this port now fails to compile instead of
   * quietly restoring the false `incompatible_confirmation` message this
   * branch exists to remove. */
  isBatchOwned: (record: PendingRecord) => boolean;
  getPendingConfirmation: (id: string) => PendingRecord | undefined;
  cancelConfirmation: (id: string) => boolean;
  sessionAsyncHandler: WrappedHandler;
}): Router {
  const router = Router();
  const { commitConfirmation, runResume } = options.pipeline;

  router.post("/confirmations/:id/confirm", options.sessionAsyncHandler(async (req, res) => {
    const claims = await options.requireSession(req, res);
    if (!claims) return;
    const parsed = confirmBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, code: "invalid_args", message: "A confirmation nonce is required." });
    }

    const record = options.getPendingConfirmation(req.params.id);
    if (!record) {
      return res.status(404).json({ ok: false, code: "not_found", message: "No such pending preview." });
    }
    // C12. This guard mirrors the one cancel has had since closure-plan PR 4,
    // and it must run BEFORE the v1/v2 discriminator below.
    //
    // `isV2Preview` is `isV2AssistantPreviewConfirmation`, which requires
    // `!record.batchId` (harness/confirmations.ts:419). A BATCH-OWNED v2 row
    // therefore failed that test and fell through to v1's `commitConfirmation`,
    // which rejected it for having no capability — v2 previews never carry one
    // — with "This preview predates the current intent-safety contract."
    // That sentence is false: the preview is current and valid, it was simply
    // sent to the per-item route instead of the batch route.
    //
    // `confirmSingle` already returns the TRUTHFUL rejection for this exact
    // case (confirmation-service.ts:220), but routing meant it could never run
    // for it. Same code as the service, so one condition has one code.
    //
    // Batches are v2-only (`chat-pipeline.ts` creates none), so this cannot
    // change a v1 outcome.
    if (options.isBatchOwned(record)) {
      return res.status(400).json({
        ok: false,
        code: "batch_confirmation_required",
        message: "This preview belongs to a Confirm all batch. Use the batch confirmation route.",
      });
    }

    const requestAbort = requestAbortScope(req, res);
    let committed: Awaited<ReturnType<typeof commitConfirmation>>;
    try {
      committed = await withHostCallBudget(
        () => options.isV2Preview(record)
          ? options.confirmationService.confirmSingle({
              claims,
              record,
              nonce: parsed.data.nonce,
              signal: requestAbort.signal,
            })
          : commitConfirmation(claims, record, parsed.data.nonce, requestAbort.signal),
      );
    } catch (error) {
      requestAbort.dispose();
      throw error;
    }
    if (!committed.ok) {
      requestAbort.dispose();
      // Validation/policy/the one-use claim rejected BEFORE any commit — always
      // JSON (the stream is never opened), and a denied confirm never burns the nonce.
      return res.status(committed.status).json(committed.body);
    }
    const { receipt, partialResult, undoId, agentState, installation, persistenceDegraded } = committed;

    // Streaming confirm (?stream=1, used by the embedded UI): the committed
    // receipt flushes IMMEDIATELY so the button is responsive, then the durable
    // resume streams its continuation as it runs. The JSON path (no ?stream) is
    // unchanged for scripts/tests.
    if (req.query.stream === "1") {
      requestAbort.dispose();
      const { write, signal } = openNdjsonStream(res);
      if (partialResult) {
        write({
          type: "result",
          result: { ...partialResult, ...(undoId ? { undo: { id: undoId } } : {}) },
          ...(persistenceDegraded ? { persistenceDegraded: true } : {}),
        });
      } else {
        write({
          type: "receipt",
          receipt,
          ...(undoId ? { undo: { id: undoId } } : {}),
          ...(persistenceDegraded ? { persistenceDegraded: true } : {}),
        });
      }
      try {
        const resumed = partialResult
          ? undefined
          : await withHostCallBudget(() => runResume(
              claims,
              installation,
              agentState,
              receipt,
              (result) => write({ type: "result", result }),
              (status) => write({ type: "status", ...status }),
              signal,
            ));
        if (resumed) write({ type: "reply", kind: resumed.replyKind, text: resumed.replyText });
      } catch {
        write({ type: "error", code: "resume_error", message: "The follow-up couldn't complete, but your change was applied." });
      }
      write({ type: "done" });
      return res.end();
    }

    // JSON path: collect the resume into the response (unchanged behavior).
    let resumed: Awaited<ReturnType<typeof runResume>>;
    try {
      resumed = partialResult
        ? undefined
        : await withHostCallBudget(
            () => runResume(
              claims,
              installation,
              agentState,
              receipt,
              undefined,
              undefined,
              requestAbort.signal,
            ),
          );
    } finally {
      requestAbort.dispose();
    }
    return res.status(receipt.ok ? 200 : 400).json({
      ok: receipt.ok,
      receipt,
      ...(partialResult ? { result: partialResult } : {}),
      ...(undoId ? { undo: { id: undoId } } : {}),
      ...(persistenceDegraded ? { persistenceDegraded: true } : {}),
      ...(resumed ? { resume: { reply: { kind: resumed.replyKind, text: resumed.replyText }, results: resumed.results } } : {}),
    });
  }));

  router.post("/confirmations/:id/cancel", options.sessionAsyncHandler(async (req, res) => {
    const claims = await options.requireSession(req, res);
    if (!claims) return;
    const record = options.getPendingConfirmation(req.params.id);
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
    if (options.isBatchOwned(record)) {
      res.status(400).json({
        ok: false,
        code: "batch_cancel_required",
        message: "This preview belongs to a Confirm all batch. Use the batch cancellation route.",
      });
      return;
    }
    if (!options.cancelConfirmation(record.id)) {
      res.status(409).json({ ok: false, code: "not_pending", message: "This preview is no longer pending." });
      return;
    }
    res.json({ ok: true, status: "cancelled" });
  }));

  return router;
}
