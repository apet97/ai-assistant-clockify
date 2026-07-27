import { Router } from "express";
import type { AppDeps } from "./deps.js";
import { asyncHandler } from "./async-handler.js";
import { createRouteAuthority } from "./route-authority.js";
import { createRunEventViewService } from "../services/run-event-view-service.js";

export function devRunInspectorRouter(deps: AppDeps): Router | undefined {
  if (process.env.NODE_ENV === "production") return undefined;
  const router = Router();
  const { requireSession } = createRouteAuthority(deps);
  const views = createRunEventViewService(deps.store, { sessionSecret: deps.config.sessionSecret, now: deps.now });

  router.get("/:runId", asyncHandler(async (req, res) => {
    const claims = await requireSession(req, res);
    if (!claims) return;
    const installation = deps.store.getInstallation(claims.workspaceId);
    if (!installation || installation.status !== "active") {
      res.status(404).json({ ok: false, code: "not_found", message: "Run not found." });
      return;
    }
    const scope = {
      sessionId: claims.sessionId,
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      installationGeneration: installation.generation,
      authClass: "addon" as const,
    };
    try {
      let after = 0;
      const events = [];
      for (;;) {
        const page = views.list({ scope, runId: req.params.runId, after, limit: 200 });
        events.push(...page.events);
        if (!page.hasMore) break;
        after = page.nextAfter;
      }
      const run = deps.store.getRun({ ...scope, runId: req.params.runId });
      res.json({
        ok: true,
        runId: req.params.runId,
        phase: run?.phase,
        modelCallsUsed: run?.budget.modelCallsUsed ?? 0,
        loadedOperations: run?.loadedToolNames ?? [],
        events,
      });
    } catch {
      res.status(404).json({ ok: false, code: "not_found", message: "Run not found." });
    }
  }));

  return router;
}
