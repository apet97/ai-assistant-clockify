import { Router } from "express";
import { z } from "zod";
import type { RunEventViewService } from "../services/run-event-view-service.js";
import { asyncHandler } from "./async-handler.js";
import type { RequireSession } from "./route-ports.js";

const listEventsQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative(),
}).strict();

/** GET /api/runs/:runId/events — transport only: decode the cursor, authorize,
 * one scoped view-service call, encode (T16-F). */
export function runsRouter(options: {
  requireSession: RequireSession;
  views: RunEventViewService;
  getInstallation: (workspaceId: string) => { status: string; generation: number } | undefined;
}): Router {
  const router = Router();

  router.get("/:runId/events", asyncHandler(async (req, res) => {
    const claims = await options.requireSession(req, res);
    if (!claims) return;
    const parsed = listEventsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ ok: false, code: "invalid_query", message: "Invalid events cursor." });
      return;
    }
    const installation = options.getInstallation(claims.workspaceId);
    if (!installation || installation.status !== "active") {
      res.status(404).json({ ok: false, code: "not_found", message: "Run not found." });
      return;
    }
    try {
      const page = options.views.list({
        scope: {
          sessionId: claims.sessionId,
          workspaceId: claims.workspaceId,
          adminUserId: claims.adminUserId,
          installationGeneration: installation.generation,
          authClass: "addon",
        },
        runId: req.params.runId,
        after: parsed.data.after,
        limit: 200,
      });
      res.json({ ok: true, ...page });
    } catch {
      res.status(404).json({ ok: false, code: "not_found", message: "Run not found." });
    }
  }));

  return router;
}
