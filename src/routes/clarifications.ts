import { Router, type Request, type Response } from "express";
import { runAssistantV2 } from "../assistant-v2/runner.js";
import { MODEL_API_ACTION_CATALOG } from "../harness/api-catalog.js";
import { createClarificationService } from "../services/clarification-service.js";
import { createRunEventViewService } from "../services/run-event-view-service.js";
import { resolveSession, type AppDeps } from "./deps.js";
import { createRouteAuthority } from "./route-authority.js";
import { resolveClarificationBodySchema } from "./request-schemas.js";
import { buildV2RunnerDependencies } from "./v2-chat-pipeline.js";
import type { RunEventFrame } from "../assistant-v2/events.js";
import { fifoAsyncHandler } from "./async-handler.js";
import { KeyedFifo } from "./fifo-lock.js";

/** Abort not-yet-dispatched route work when the HTTP client disappears — same
 * shape as api.ts's requestAbortScope, kept local since this router is v2-only
 * and does not share api.ts's module scope. */
function requestAbortScope(req: Request, res: Response): { signal: AbortSignal; dispose(): void } {
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

/**
 * `POST /api/clarifications/:id/resolve` (T14-D): exact `optionId` -> resolved
 * v2 run, never a natural-language chat request. Only active for
 * `ASSISTANT_ENGINE=v2` — v1 has its own, separate clarify-followup path.
 */
export function clarificationsRouter(deps: AppDeps): Router {
  const router = Router();
  const { requireSession } = createRouteAuthority(deps);
  const eventViews = createRunEventViewService(deps.store, { sessionSecret: deps.config.sessionSecret, now: deps.now });
  const sessionFifo = new KeyedFifo();

  router.post("/:id/resolve", fifoAsyncHandler(
    sessionFifo,
    (req) => resolveSession(req, deps)?.sessionId,
    async (req, res) => {
    const claims = await requireSession(req, res);
    if (!claims) return;

    const parsed = resolveClarificationBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, code: "invalid_args", message: "An option id is required." });
      return;
    }

    const installation = deps.store.getInstallation(claims.workspaceId);
    if (!installation || installation.status !== "active") {
      res.status(404).json({ ok: false, code: "not_found", message: "No active installation for this workspace." });
      return;
    }

    const active = deps.store.getActiveRunForSession(claims.sessionId, claims.workspaceId, claims.adminUserId);
    if (!active) {
      res.status(404).json({ ok: false, code: "not_found", message: "No active run in this chat." });
      return;
    }

    const scope = {
      sessionId: claims.sessionId,
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      installationGeneration: claims.installationGeneration,
      authClass: "addon" as const,
    };
    const runScope = { ...scope, runId: active.runId };
    const lastSequenceBefore = deps.store.getLastRunEventSequence(runScope);

    const requestAbort = requestAbortScope(req, res);
    const runnerDeps = buildV2RunnerDependencies(deps, installation, runScope, requestAbort.signal);
    const clarificationService = createClarificationService({
      store: deps.store,
      registry: MODEL_API_ACTION_CATALOG,
      reads: runnerDeps.reads,
      preparations: runnerDeps.preparations,
      runner: {
        resume: (input) => runAssistantV2({ runId: input.runId, scope: input.scope, signal: input.signal }, runnerDeps),
      },
    });

    let result: Awaited<ReturnType<typeof clarificationService.resolveOption>>;
    try {
      result = await clarificationService.resolveOption({
        clarificationId: req.params.id,
        scope,
        runId: active.runId,
        optionId: parsed.data.optionId,
        signal: requestAbort.signal,
      });
    } finally {
      requestAbort.dispose();
    }

    if (!result.ok) {
      res.status(result.status).json({ ok: false, code: result.code, message: result.message });
      return;
    }

    // Stream the resumed run's new events as the same RunEventFrame | DoneFrame
    // NDJSON union chat/confirm use (canonical plan §14 "UI correction").
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "private, no-store, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    try {
      const page = eventViews.list({ scope, runId: active.runId, after: lastSequenceBefore, limit: 200 });
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
