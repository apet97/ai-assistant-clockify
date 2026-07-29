import { Router, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { reversibleCreations } from "../harness/undo.js";
import { isBatchOwnedConfirmation, isV2AssistantPreviewConfirmation } from "../harness/confirmations.js";
import { setSessionCookie, resolveSession, type AppDeps } from "./deps.js";
import { type SessionClaims } from "../auth/sessions.js";
import { fifoAsyncHandler } from "./async-handler.js";
import {
  createChatPipeline,
  type ChatPipeline,
} from "./chat-pipeline.js";
import { createV2RunnerPipeline, createClarificationResolutionPort } from "./v2-chat-pipeline.js";
import { runsRouter } from "./runs.js";
import { clarificationsRouter } from "./clarifications.js";
import { devRunInspectorRouter } from "./dev-run-inspector.js";
import { CSRF_HEADER, verifyCsrfToken } from "../auth/csrf.js";
import { KeyedFifo } from "./fifo-lock.js";
import { withHostCallBudget } from "../clockify/request-governor.js";
import { createWorkspaceMutationCoordinator } from "../clockify/workspace-mutation-coordinator.js";
import { createConfirmationService } from "../services/confirmation-service.js";
import { createHistoryService } from "../services/history-service.js";
import { createSessionContextService } from "../services/session-context-service.js";
import { createPermissionService } from "../services/permission-service.js";
import { createMetricsService } from "../services/metrics-service.js";
import { createArtifactService } from "../services/artifact-service.js";
import { createUndoService } from "../services/undo-service.js";
import { createRunEventViewService } from "../services/run-event-view-service.js";
import { MODEL_API_ACTION_CATALOG } from "../harness/api-catalog.js";
import { meRouter } from "./me.js";
import { metricsRouter } from "./metrics.js";
import { permissionsRouter } from "./permissions.js";
import { artifactsRouter } from "./artifacts.js";
import { undoRouter } from "./undo.js";
import { operationsRouter } from "./operations.js";
import { chatRouter } from "./chat.js";
import { confirmationsRouter } from "./confirmations.js";
import { confirmationBatchesRouter } from "./confirmation-batches.js";
import {
  DEFAULT_API_RATE_LIMIT_MAX,
  DEFAULT_API_RATE_LIMIT_WINDOW_MS,
} from "./rate-limit.js";

/**
 * The API composition root (T16-G): selects the assistant engine ONCE, builds
 * the narrow services, installs the rate-limit + CSRF middleware, and mounts
 * transport-only routers. Every route requires an authenticated admin session.
 * Risky actions never execute in chat routes: chat creates previews; only the
 * confirm routes — with a valid button nonce and an atomic one-use claim —
 * execute the stored operation.
 */

export type ChatPipelineFactory = (deps: AppDeps) => ChatPipeline;

/** The sole top-level assistant-engine seam. Each arm constructs one complete
 * pipeline so selection happens once, before any route handles a request. */
export interface AssistantPipelineFactories {
  v1: ChatPipelineFactory;
  v2: ChatPipelineFactory;
}

export const defaultAssistantPipelineFactories: AssistantPipelineFactories = {
  v1: createChatPipeline,
  v2: createV2RunnerPipeline,
};

function createSelectedAssistantPipeline(
  engine: AppDeps["config"]["assistantEngine"],
  deps: AppDeps,
  factories: AssistantPipelineFactories,
): ChatPipeline {
  switch (engine) {
    case "v1":
      return factories.v1(deps);
    case "v2":
      return factories.v2(deps);
  }
}

export function apiRouter(
  deps: AppDeps,
  pipelineFactories: AssistantPipelineFactories,
): Router {
  const router = Router();
  const now = deps.now ?? (() => new Date());
  const mutationCoordinator = deps.mutationCoordinator ?? createWorkspaceMutationCoordinator();
  const pipelineDeps = deps.mutationCoordinator ? deps : { ...deps, mutationCoordinator };
  const pipeline = createSelectedAssistantPipeline(
    deps.config.assistantEngine,
    pipelineDeps,
    pipelineFactories,
  );
  const { loadPolicy, requireSession, verifyWriteAuthority, actionContext } = pipeline;

  const confirmationService = createConfirmationService({
    store: deps.store,
    registry: MODEL_API_ACTION_CATALOG,
    sessionSecret: deps.config.sessionSecret,
    catalogHash: () => MODEL_API_ACTION_CATALOG.hash(),
    now,
    loadPolicy,
    verifyWriteAuthority,
    actionContext,
    mutationCoordinator,
    recordUndoIfReversible(claims, installationGeneration, receipt) {
      if (!receipt.ok) return undefined;
      if (receipt.warnings?.some((w) => w.code === "idempotent_replay")) return undefined;
      const reversal = reversibleCreations(receipt);
      if (reversal.length === 0) return undefined;
      return deps.store.recordUndoable({
        sessionId: claims.sessionId,
        workspaceId: claims.workspaceId,
        adminUserId: claims.adminUserId,
        actionName: receipt.action,
        installationGeneration,
        reversal,
      });
    },
  });

  // Narrow per-concern services (T16-D/T16-E).
  const historyService = createHistoryService({
    store: deps.store,
    sessionSecret: deps.config.sessionSecret,
    now,
  });
  const sessionContextService = createSessionContextService({
    store: deps.store,
    sessionSecret: deps.config.sessionSecret,
    baseUrl: deps.config.baseUrl,
    sessionTtlMs: deps.config.sessionTtlMs,
    now,
  });
  const permissionService = createPermissionService({
    store: deps.store,
    loadPolicy,
    sessionSecret: deps.config.sessionSecret,
    now,
  });
  const metricsService = createMetricsService({ store: deps.store, now });
  const artifactService = createArtifactService({ store: deps.store });
  const undoService = createUndoService({
    store: deps.store,
    loadPolicy,
    verifyWriteAuthority,
    actionContext,
    mutationCoordinator,
    undoCommits: confirmationService,
  });
  const runEventViews = createRunEventViewService(deps.store, {
    sessionSecret: deps.config.sessionSecret,
    now: deps.now,
  });
  const clarificationResolution = createClarificationResolutionPort(deps);

  const expectedOrigin = new URL(deps.config.baseUrl).origin;
  const authenticatedRateLimitClaims = new WeakMap<Request, SessionClaims>();
  const sessionFifo = new KeyedFifo();
  const sessionAsyncHandler = (
    handler: (req: Request, res: Response) => Promise<unknown>,
  ): ReturnType<typeof fifoAsyncHandler> =>
    fifoAsyncHandler(
      sessionFifo,
      (req) => resolveSession(req, deps)?.sessionId,
      // Install the request budget before requireSession performs its cold role
      // lookup. Nested chat/confirm/undo scopes reuse this same budget.
      (req, res) => withHostCallBudget(() => handler(req, res)),
    );
  const finishTurnRunSafely = (...args: Parameters<AppDeps["store"]["finishTurnRun"]>): void => {
    try {
      deps.store.finishTurnRun(...args);
    } catch {
      // A host mutation may already be known successful. Do not replace its
      // truthful response with a retry invitation, and do not claim this turn
      // reached a durable terminal state: the existing executing row remains.
      console.error("turn-run finalization degraded; response preserved");
    }
  };
  const activeGenerationAtBoundary = (workspaceId: string, generation: number): boolean => {
    const installation = deps.store.getInstallation(workspaceId);
    return installation?.status === "active" && installation.generation === generation;
  };

  // Bound every authenticated API surface before authorization, DB hydration,
  // or model/Clockify work. The key deliberately excludes sessionId: opening a
  // prior chat or minting a new session cannot reset the workspace/admin budget.
  // Invalid/absent sessions continue to the ordinary 401 path and cannot create
  // attacker-controlled limiter keys. One HTTP request counts once, so NDJSON
  // event volume and artifact bytes do not consume extra quota.
  router.use(rateLimit({
    windowMs: deps.config.apiRateLimitWindowMs ?? DEFAULT_API_RATE_LIMIT_WINDOW_MS,
    limit: deps.config.apiRateLimitMax ?? DEFAULT_API_RATE_LIMIT_MAX,
    // Draft 7 reports only quota/reset numbers. Draft 8 also emits a stable
    // partition-key hash; avoid giving clients a cross-request scope correlator.
    standardHeaders: "draft-7",
    legacyHeaders: false,
    passOnStoreError: false,
    skip: (req) => {
      if (req.method === "OPTIONS") return true;
      const claims = resolveSession(req, deps);
      if (!claims) return true;
      // Reuse the verified, server-backed claims in keyGenerator so the hot
      // path pays for one session lookup here, not two. WeakMap cannot retain a
      // request after Express releases it.
      authenticatedRateLimitClaims.set(req, claims);
      return false;
    },
    keyGenerator: (req) => {
      const claims = authenticatedRateLimitClaims.get(req);
      // express-rate-limit runs `skip` before `keyGenerator`; this fallback is
      // fail-closed if that package contract ever changes.
      return claims
        ? `workspace:${claims.workspaceId}:admin:${claims.adminUserId}`
        : "invalid-authenticated-session";
    },
    handler: (_req, res) => {
      res.status(429).json({
        ok: false,
        code: "rate_limited",
        message: "Too many API requests. Please wait a moment and try again.",
      });
    },
  }));

  router.use((req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method) || deps.config.nodeEnv === "test") {
      next();
      return;
    }
    const origin = req.get("origin");
    const fetchSite = req.get("sec-fetch-site");
    const explicitCrossSite =
      (origin !== undefined && origin !== expectedOrigin)
      || (fetchSite !== undefined && fetchSite !== "same-origin");
    if (explicitCrossSite) {
      res.status(403).json({ ok: false, code: "csrf_rejected", message: "Request origin could not be verified." });
      return;
    }
    if (origin === expectedOrigin || fetchSite === "same-origin") {
      next();
      return;
    }
    const claims = resolveSession(req, deps);
    if (claims && verifyCsrfToken(req.get(CSRF_HEADER), claims.sessionId, deps.config.sessionSecret)) {
      next();
      return;
    }
    res.status(403).json({ ok: false, code: "csrf_rejected", message: "Request origin could not be verified." });
  });

  // Transport-only routers (T16-F/T16-G): each decodes, authorizes, calls one
  // service seam, and encodes/streams.
  router.use(meRouter({ requireSession, sessionContext: sessionContextService }));
  router.use(metricsRouter({ requireSession, metrics: metricsService }));
  router.use(permissionsRouter({
    requireSession,
    verifyWriteAuthority,
    permissions: permissionService,
    sessionAsyncHandler,
  }));
  router.use(artifactsRouter({ requireSession, artifacts: artifactService }));
  router.use(chatRouter({
    requireSession,
    history: historyService,
    sessionContext: sessionContextService,
    pipeline,
    sessionAsyncHandler,
    setCookie: (res, claims) =>
      setSessionCookie(res, claims, deps.config.sessionSecret, deps.config.baseUrl, deps.config.sessionTtlMs),
    activeGenerationAt: activeGenerationAtBoundary,
    finishTurnRun: finishTurnRunSafely,
  }));
  router.use(operationsRouter({
    requireSession,
    getTurnRun: (sessionId, requestId) => deps.store.getTurnRun(sessionId, requestId),
    getScopedOperationRun: (operationId, workspaceId, adminUserId, sessionId) =>
      deps.store.getScopedOperationRun(operationId, workspaceId, adminUserId, sessionId),
  }));
  router.use(confirmationsRouter({
    requireSession,
    confirmationService,
    pipeline,
    isV2Preview: isV2AssistantPreviewConfirmation,
    isBatchOwned: isBatchOwnedConfirmation,
    getPendingConfirmation: (id) => deps.store.getPendingConfirmation(id),
    // Closure-plan PR 4 (F02): cancelling a v2 preview also settles its
    // assistant run (bounded no-mutation result + operation terminal +
    // run.completed) in one store transaction; a v1 preview keeps the plain
    // row cancel.
    cancelConfirmation: (id) => {
      const record = deps.store.getPendingConfirmation(id);
      if (record && isV2AssistantPreviewConfirmation(record)) {
        const { settled } = deps.store.settleV2ConfirmationRun({ record, kind: "cancelled" });
        // A run that already settled (or a record without run scope) still
        // needs the plain row cancel.
        if (settled) return true;
      }
      return deps.store.cancelConfirmation(id);
    },
    sessionAsyncHandler,
  }));
  router.use(confirmationBatchesRouter({
    requireSession,
    confirmationService,
    getScopedConfirmationBatch: (id, workspaceId, adminUserId, sessionId) =>
      deps.store.getScopedConfirmationBatch(id, workspaceId, adminUserId, sessionId),
    sessionAsyncHandler,
  }));
  router.use(undoRouter({ requireSession, undo: undoService, sessionAsyncHandler }));
  router.use("/runs", runsRouter({
    requireSession,
    views: runEventViews,
    getInstallation: (workspaceId) => deps.store.getInstallation(workspaceId),
  }));
  router.use("/clarifications", clarificationsRouter({
    requireSession,
    resolution: clarificationResolution,
    sessionAsyncHandler,
  }));
  const inspector = devRunInspectorRouter(deps);
  if (inspector) router.use("/dev/runs", inspector);

  return router;
}
