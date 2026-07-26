import { Router } from "express";
import type { ConfirmationService } from "../services/confirmation-service.js";
import { withHostCallBudget } from "../clockify/request-governor.js";
import { confirmBatchBodySchema } from "./request-schemas.js";
import { openNdjsonStream } from "./ndjson.js";
import { requestAbortScope } from "./request-abort.js";
import type { RequireSession, WrappedHandler } from "./route-ports.js";

/**
 * Exact batch confirmation transport (T16-F): `Confirm all` applies only to
 * the exact previewed batch, dispatched through `ConfirmationService`'s one
 * transactional ownership claim. Decode, authorize, one service call,
 * encode/stream — nothing else.
 */
export function confirmationBatchesRouter(options: {
  requireSession: RequireSession;
  confirmationService: Pick<ConfirmationService, "confirmBatch">;
  getScopedConfirmationBatch: (
    id: string,
    workspaceId: string,
    adminUserId: string,
    sessionId: string,
  ) => { id: string } | undefined;
  sessionAsyncHandler: WrappedHandler;
}): Router {
  const router = Router();

  router.post("/confirmation-batches/:id/confirm", options.sessionAsyncHandler(async (req, res) => {
    const claims = await options.requireSession(req, res);
    if (!claims) return;
    const parsed = confirmBatchBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, code: "invalid_args", message: "Batch confirmation payload is invalid." });
    }

    const batch = options.getScopedConfirmationBatch(
      req.params.id,
      claims.workspaceId,
      claims.adminUserId,
      claims.sessionId,
    );
    if (!batch) {
      return res.status(404).json({ ok: false, code: "not_found", message: "No such confirmation batch." });
    }

    const requestAbort = requestAbortScope(req, res);
    const stream = req.query.stream === "1";

    if (stream) {
      const { write, signal } = openNdjsonStream(res);
      try {
        const committed = await withHostCallBudget(() => options.confirmationService.confirmBatch({
          claims,
          batchId: batch.id,
          items: parsed.data.items,
          signal,
          onItem: (item) => {
            if (item.partialResult) {
              write({ type: "result", result: item.partialResult });
            } else {
              write({
                type: "receipt",
                receipt: item.receipt,
                ...(item.undoId ? { undo: { id: item.undoId } } : {}),
              });
            }
          },
        }));
        if (!committed.ok) {
          write({ type: "error", code: committed.body.code, message: committed.body.message });
        } else {
          write({
            type: "reply",
            kind: committed.status,
            text: JSON.stringify({
              batchId: committed.batchId,
              status: committed.status,
              items: committed.items.map((item) => ({
                confirmationId: item.confirmationId,
                status: item.status,
                replayed: item.replayed ?? false,
              })),
              ...(committed.persistenceDegraded ? { persistenceDegraded: true } : {}),
            }),
          });
        }
      } catch {
        write({ type: "error", code: "batch_confirm_error", message: "Batch confirmation failed." });
      }
      write({ type: "done" });
      return res.end();
    }

    let committed: Awaited<ReturnType<typeof options.confirmationService.confirmBatch>>;
    try {
      committed = await withHostCallBudget(() => options.confirmationService.confirmBatch({
        claims,
        batchId: batch.id,
        items: parsed.data.items,
        signal: requestAbort.signal,
      }));
    } finally {
      requestAbort.dispose();
    }
    if (!committed.ok) {
      return res.status(committed.status).json(committed.body);
    }
    return res.status(committed.status === "succeeded" || committed.status === "partial" ? 200 : 400).json({
      ok: committed.status === "succeeded" || committed.status === "partial",
      batchId: committed.batchId,
      status: committed.status,
      items: committed.items,
      ...(committed.persistenceDegraded ? { persistenceDegraded: true } : {}),
    });
  }));

  return router;
}
