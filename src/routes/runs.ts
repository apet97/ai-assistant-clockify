import { Router } from "express";
import { z } from "zod";
import type { AppDeps } from "./deps.js";
import { asyncHandler } from "./async-handler.js";
import { createRouteAuthority } from "./route-authority.js";
import { createRunEventViewService } from "../services/run-event-view-service.js";

const listEventsQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative(),
}).strict();

export function runsRouter(deps: AppDeps): Router {
  const router = Router();
  const { requireSession } = createRouteAuthority(deps);
  const views = createRunEventViewService(deps.store, { sessionSecret: deps.config.sessionSecret, now: deps.now });

  router.get("/:runId/events", asyncHandler(async (req, res) => {
    const claims = await requireSession(req, res);
    if (!claims) return;
    const parsed = listEventsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ ok: false, code: "invalid_query", message: "Invalid events cursor." });
      return;
    }
    const installation = deps.store.getInstallation(claims.workspaceId);
    if (!installation || installation.status !== "active") {
      res.status(404).json({ ok: false, code: "not_found", message: "Run not found." });
      return;
    }
    try {
      const page = views.list({
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
