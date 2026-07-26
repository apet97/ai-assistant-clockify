import { Router } from "express";
import type { MetricsService } from "../services/metrics-service.js";
import { asyncHandler } from "./async-handler.js";
import type { RequireSession } from "./route-ports.js";

/** GET /api/metrics — transport only: authorize, one service call, encode (T16-G). */
export function metricsRouter(options: {
  requireSession: RequireSession;
  metrics: MetricsService;
}): Router {
  const router = Router();
  router.get("/metrics", asyncHandler(async (req, res) => {
    const claims = await options.requireSession(req, res);
    if (!claims) return;
    const since = typeof req.query.since === "string" ? req.query.since : undefined;
    res.json({ ok: true, ...options.metrics.view(claims, since) });
  }));
  return router;
}
