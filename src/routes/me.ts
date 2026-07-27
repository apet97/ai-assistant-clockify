import { Router } from "express";
import type { SessionContextService } from "../services/session-context-service.js";
import { asyncHandler } from "./async-handler.js";
import type { RequireSession } from "./route-ports.js";

/** GET /api/me — transport only: authorize, one service call, encode (T16-F). */
export function meRouter(options: {
  requireSession: RequireSession;
  sessionContext: SessionContextService;
}): Router {
  const router = Router();
  router.get("/me", asyncHandler(async (req, res) => {
    const claims = await options.requireSession(req, res);
    if (!claims) return;
    res.json({ ok: true, ...options.sessionContext.me(claims) });
  }));
  return router;
}
