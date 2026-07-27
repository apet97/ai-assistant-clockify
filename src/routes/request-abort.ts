import type { Request, Response } from "express";

/**
 * Abort not-yet-dispatched route work when the HTTP client disappears. The
 * REST/governor boundary deliberately stops observing this signal once a host
 * mutation dispatches, so its outcome is still settled truthfully. Shared by
 * the chat, confirmation, undo, and clarification transport routes (T16-F).
 */
export function requestAbortScope(req: Request, res: Response): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const abort = (): void => {
    if (!res.writableEnded && !controller.signal.aborted) {
      controller.abort(new Error("client_disconnected"));
    }
  };
  req.once("aborted", abort);
  res.once("close", abort);
  if (req.aborted || res.destroyed) abort();
  return {
    signal: controller.signal,
    dispose() {
      req.off("aborted", abort);
      res.off("close", abort);
    },
  };
}
