import { Router } from "express";
import type { RunEventFrame } from "../assistant-v2/events.js";
import type { ClarificationResolutionPort } from "./v2-chat-pipeline.js";
import { resolveClarificationBodySchema } from "./request-schemas.js";
import { requestAbortScope } from "./request-abort.js";
import type { RequireSession, WrappedHandler } from "./route-ports.js";

/**
 * `POST /api/clarifications/:id/resolve` (T14-D/T16-F): exact `optionId` ->
 * resolved v2 run, never a natural-language chat request. Transport only —
 * lookups, runner assembly, and resolution live behind the injected
 * `ClarificationResolutionPort`; this file decodes, authorizes, calls it once,
 * and streams the resumed run's new events as the same RunEventFrame |
 * DoneFrame NDJSON union chat/confirm use.
 *
 * Serialization (closure-plan PR 2 / F21): the route runs under the ONE
 * composition-owned session FIFO/async handler shared with chat, confirm,
 * batch, permissions, and undo — an option click cannot race an ordinary
 * message or cancel for the same session, and it inherits the same outer
 * per-request host-call budget.
 */
export function clarificationsRouter(options: {
  requireSession: RequireSession;
  resolution: ClarificationResolutionPort;
  sessionAsyncHandler: WrappedHandler;
}): Router {
  const router = Router();

  router.post("/:id/resolve", options.sessionAsyncHandler(
    async (req, res) => {
      const claims = await options.requireSession(req, res);
      if (!claims) return;

      const parsed = resolveClarificationBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ ok: false, code: "invalid_args", message: "An option id is required." });
        return;
      }

      const requestAbort = requestAbortScope(req, res);
      let result: Awaited<ReturnType<ClarificationResolutionPort["resolve"]>>;
      try {
        result = await options.resolution.resolve({
          claims,
          clarificationId: req.params.id,
          optionId: parsed.data.optionId,
          signal: requestAbort.signal,
        });
      } finally {
        requestAbort.dispose();
      }

      if (!result.ok || !result.page) {
        res.status(result.status).json({ ok: false, code: result.code, message: result.message });
        return;
      }

      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("Cache-Control", "private, no-store, no-transform");
      res.setHeader("X-Accel-Buffering", "no");
      try {
        const page = result.page;
        for (const item of page.events) {
          const frame: RunEventFrame = {
            type: "run_event",
            runId: page.runId,
            sequence: item.sequence,
            event: item.event,
            ...(item.attachment ? { attachment: item.attachment } : {}),
          };
          res.write(`${JSON.stringify(frame)}\n`);
        }
        res.write(`${JSON.stringify({ type: "done", runId: page.runId, lastSequence: page.lastSequence })}\n`);
      } catch {
        res.write(`${JSON.stringify({ type: "transport_error", code: "server_error", message: "Something went wrong." })}\n`);
      }
      res.end();
    }));

  return router;
}
