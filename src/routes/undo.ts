import { Router } from "express";
import type { UndoService } from "../services/undo-service.js";
import { requestAbortScope } from "./request-abort.js";
import type { RequireSession, WrappedHandler } from "./route-ports.js";

/** POST /api/undo/:id — transport only: authorize, one service call under the
 * request abort scope, encode (T16-G). All undo policy/authority/lease logic
 * lives in `UndoService`. */
export function undoRouter(options: {
  requireSession: RequireSession;
  undo: UndoService;
  sessionAsyncHandler: WrappedHandler;
}): Router {
  const router = Router();
  router.post("/undo/:id", options.sessionAsyncHandler(async (req, res) => {
    const claims = await options.requireSession(req, res);
    if (!claims) return;
    const requestAbort = requestAbortScope(req, res);
    try {
      const result = await options.undo.execute(claims, req.params.id, requestAbort.signal);
      return res.status(result.status).json(result.body);
    } finally {
      requestAbort.dispose();
    }
  }));
  return router;
}
