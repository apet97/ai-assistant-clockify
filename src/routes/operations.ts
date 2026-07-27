import { Router } from "express";
import { asyncHandler } from "./async-handler.js";
import type { RequireSession } from "./route-ports.js";

/**
 * Passive operation-status reads (T16-F): the durable request-identity replay
 * surface and the scoped operation-run card. Store access arrives as injected
 * scoped lookup ports from the composition root — this file never touches the
 * store layer itself.
 */
export function operationsRouter(options: {
  requireSession: RequireSession;
  getTurnRun: (sessionId: string, requestId: string) => {
    workspaceId: string;
    adminUserId: string;
    requestId: string;
    status: string;
    response?: unknown;
  } | undefined;
  getScopedOperationRun: (
    operationId: string,
    workspaceId: string,
    adminUserId: string,
    sessionId: string,
  ) => unknown;
}): Router {
  const router = Router();

  router.get("/operations/:requestId", asyncHandler(async (req, res) => {
    const claims = await options.requireSession(req, res);
    if (!claims) return;
    const run = options.getTurnRun(claims.sessionId, req.params.requestId);
    if (!run || run.workspaceId !== claims.workspaceId || run.adminUserId !== claims.adminUserId) {
      return res.status(404).json({ ok: false, code: "not_found", message: "Operation not found." });
    }
    return res.json({ ok: true, requestId: run.requestId, status: run.status, response: run.response });
  }));

  router.get("/operation-runs/:operationId", asyncHandler(async (req, res) => {
    const claims = await options.requireSession(req, res);
    if (!claims) return;
    const operation = options.getScopedOperationRun(
      req.params.operationId,
      claims.workspaceId,
      claims.adminUserId,
      claims.sessionId,
    );
    if (!operation) {
      return res.status(404).json({ ok: false, code: "not_found", message: "Operation not found." });
    }
    return res.json({ ok: true, operation });
  }));

  return router;
}
