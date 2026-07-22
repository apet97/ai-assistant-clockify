import { Router, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { buildMetrics, buildUsageMetrics } from "../metrics/metrics.js";
import { firstDeniedGroup, reverseCreationDurably, undoMutationPlan } from "../harness/undo.js";
import {
  FEATURE_GROUPS,
  applyPolicyPatch,
  defaultAdminPolicy,
  type AdminPolicy,
} from "../harness/permissions.js";
import { rotatePendingNonce } from "../harness/confirmations.js";
import { successReceipt } from "../harness/receipts.js";
import { setSessionCookie, type AppDeps } from "./deps.js";
import { type SessionClaims } from "../auth/sessions.js";
import { THIRTY_DAYS_MS } from "../durations.js";
import { isTransientErrorMessage } from "./history-sanitizer.js";
import {
  groupsPatchSchema,
  confirmBodySchema,
} from "./request-schemas.js";
import { asyncHandler, fifoAsyncHandler } from "./async-handler.js";
import { bestEffort } from "./best-effort.js";
import { openNdjsonStream } from "./ndjson.js";
import { sanitizeResultsForHistory } from "./chat-results.js";
import {
  createChatPipeline,
  type ChatPipeline,
  type ChatTurnOutcome,
} from "./chat-pipeline.js";
import { createCsrfToken, CSRF_HEADER, verifyCsrfToken } from "../auth/csrf.js";
import { resolveSession } from "./deps.js";
import { KeyedFifo } from "./fifo-lock.js";
import { withHostCallBudget } from "../clockify/request-governor.js";
import { hashOperation } from "../harness/confirmations.js";
import { catalogHash } from "../harness/catalog.js";
import {
  createWorkspaceMutationCoordinator,
  WorkspaceMutationRevokedError,
  type WorkspaceMutationLease,
} from "../clockify/workspace-mutation-coordinator.js";
import {
  DEFAULT_API_RATE_LIMIT_MAX,
  DEFAULT_API_RATE_LIMIT_WINDOW_MS,
} from "./rate-limit.js";

/**
 * JSON API (SPEC "Chat Flow", "Confirmation Rules", "Permissions Inside Chat").
 * Every route requires an authenticated admin session. Risky actions never
 * execute here: chat creates previews; only the confirm route — with a valid
 * button nonce and an atomic one-use claim — executes the stored operation.
 */

/**
 * How many stored messages GET /api/chat/history replays to the UI after an iframe
 * reload. Distinct from the MODEL context window (`HISTORY_WINDOW_MESSAGES`, 12) —
 * this is the human's restored VIEW (a marathon session stores 100s of messages; 50
 * is plenty to re-anchor without shipping megabytes of payloads). Named *_RESTORE_*
 * so it is never mistaken for the LLM window.
 */
export const CHAT_HISTORY_RESTORE_LIMIT = 50;

export type ChatPipelineFactory = (deps: AppDeps) => ChatPipeline;

/** The sole top-level assistant-engine seam. Each arm constructs one complete
 * pipeline so selection happens once, before any route handles a request. */
export interface AssistantPipelineFactories {
  v1: ChatPipelineFactory;
  v2: ChatPipelineFactory;
}

const V2_NOT_READY: ChatTurnOutcome = {
  ok: false,
  code: "not_ready",
  message: "Assistant engine v2 is not ready.",
};

function createV2NotReadyPipeline(deps: AppDeps): ChatPipeline {
  const sharedControlPlane = createChatPipeline(deps);
  return {
    ...sharedControlPlane,
    runResume: async () => undefined,
    executeChatTurn: async () => V2_NOT_READY,
  };
}

export const defaultAssistantPipelineFactories: AssistantPipelineFactories = {
  v1: createChatPipeline,
  v2: createV2NotReadyPipeline,
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

/** Abort not-yet-dispatched route work when the HTTP client disappears. The
 * REST/governor boundary deliberately stops observing this signal once a host
 * mutation dispatches, so its outcome is still settled truthfully. */
function requestAbortScope(req: Request, res: Response): {
  signal: AbortSignal;
  dispose(): void;
} {
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

export function apiRouter(
  deps: AppDeps,
  pipelineFactories: AssistantPipelineFactories,
): Router {
  const router = Router();
  const now = deps.now ?? (() => new Date());
  const mutationCoordinator = deps.mutationCoordinator ?? createWorkspaceMutationCoordinator();
  const pipelineDeps = deps.mutationCoordinator ? deps : { ...deps, mutationCoordinator };
  // The deps-capturing turn/confirm/commit pipeline (plan 007 Phase B). It
  // owns the per-instance chat rate limiter and a derived clock; the route
  // handlers below call its methods.
  const pipeline = createSelectedAssistantPipeline(
    deps.config.assistantEngine,
    pipelineDeps,
    pipelineFactories,
  );
  const { loadPolicy, requireSession, verifyWriteAuthority, newChatAllowed, actionContext, runResume, commitConfirmation, executeChatTurn, chatPreconditions } =
    pipeline;

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
  const rejectInstallationChange = (res: Response): void => {
    res.status(409).json({
      ok: false,
      code: "installation_changed",
      message: "The Clockify installation changed before this request could be saved. No change was made.",
    });
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

  // Shared validate→apply step for the two permission routes (preview + confirm):
  // Zod-parse the groups patch, load the caller's base policy, and apply the patch.
  // Returns the resolved triple, or `undefined` AFTER writing the exact 400 the
  // route used to write inline (so both routes keep byte-identical error codes and
  // messages). The caller does `const r = resolvePermissionPatch(...); if (!r) return;`.
  function resolvePermissionPatch(
    req: Request,
    res: Response,
    claims: SessionClaims,
  ): { base: AdminPolicy; next: AdminPolicy; changedGroups: string[] } | undefined {
    const parsed = groupsPatchSchema.safeParse(req.body?.groups);
    if (!parsed.success) {
      res.status(400).json({ ok: false, code: "invalid_args", message: "Invalid permission groups." });
      return undefined;
    }
    const base = loadPolicy(claims.workspaceId, claims.adminUserId);
    try {
      const next = applyPolicyPatch(base, { groups: parsed.data ?? {} });
      const changedGroups = Object.keys(parsed.data ?? {});
      return { base, next, changedGroups };
    } catch {
      res.status(400).json({ ok: false, code: "invalid_args", message: "Invalid permission change." });
      return undefined;
    }
  }

  router.get("/me", asyncHandler(async (req, res) => {
    const claims = await requireSession(req, res);
    if (!claims) return;
    res.json({
      ok: true,
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      workspaceRole: claims.workspaceRole,
      preferences: claims.uiPreferences ?? { theme: "system" },
      links: {
        privacy: new URL("/privacy", deps.config.baseUrl).toString(),
        support: new URL("/support", deps.config.baseUrl).toString(),
        security: new URL("/security", deps.config.baseUrl).toString(),
      },
      csrfToken: createCsrfToken(claims.sessionId, deps.config.sessionSecret),
    });
  }));

  // Operational metrics (Phase 7): per-action success/failure, error taxonomy, and
  // confirm/cancel/expire rates — scoped to the caller's own actions (privacy).
  // Optional ?since=<ISO> windows the report. Absent ?since DEFAULTS to the last
  // 30 days (matching the telemetry/confirmation retention horizon): audit_events
  // is retained for RETENTION_DAYS (default 90), so even an unbounded read scans
  // at most that window — the 30-day default still avoids aggregating every
  // retained row in JS. An explicit ?since override reaches the full retained
  // history for ops (r1-efficiency-01).
  router.get("/metrics", asyncHandler(async (req, res) => {
    const claims = await requireSession(req, res);
    if (!claims) return;
    const since =
      typeof req.query.since === "string"
        ? req.query.since
        : new Date(now().getTime() - THIRTY_DAYS_MS).toISOString();
    const nowIsoStamp = now().toISOString();
    const outcomes = deps.store.listActionOutcomes(claims.workspaceId, claims.adminUserId, since);
    const confirmations = deps.store.listConfirmationOutcomes(claims.workspaceId, claims.adminUserId, since);
    const telemetry = deps.store.listTurnTelemetry(claims.workspaceId, claims.adminUserId, since);
    res.json({
      ok: true,
      metrics: {
        ...buildMetrics(outcomes, confirmations, nowIsoStamp),
        // Cost + latency (the pending prod cost review): per-admin token/turn
        // aggregates from turn_telemetry.
        usage: buildUsageMetrics(telemetry, nowIsoStamp),
      },
    });
  }));

  router.get("/permissions", asyncHandler(async (req, res) => {
    const claims = await requireSession(req, res);
    if (!claims) return;
    const existing = deps.store.getAdminPolicy(claims.workspaceId, claims.adminUserId);
    res.json({
      ok: true,
      policy: existing ?? defaultAdminPolicy(),
      firstRun: !existing,
      featureGroups: FEATURE_GROUPS,
    });
  }));

  router.post("/permissions/preview", asyncHandler(async (req, res) => {
    const claims = await requireSession(req, res);
    if (!claims) return;
    const r = resolvePermissionPatch(req, res, claims);
    if (!r) return;
    res.json({ ok: true, preview: { current: r.base, next: r.next, changedGroups: r.changedGroups } });
  }));

  router.post("/permissions/confirm", sessionAsyncHandler(async (req, res) => {
    const claims = await requireSession(req, res);
    if (!claims) return;
    const authority = await verifyWriteAuthority(claims);
    if (!authority.ok) {
      return res.status(authority.status).json({ ok: false, code: authority.code, message: authority.message });
    }
    const r = resolvePermissionPatch(req, res, claims);
    if (!r) return;
    const next = r.next;
    // verifyWriteAuthority awaited Clockify. No await may occur between this
    // final durable generation check and the policy/result/audit transaction-
    // free synchronous writes below, so uninstall cannot recreate erased rows.
    if (!activeGenerationAtBoundary(claims.workspaceId, authority.installationGeneration)) {
      rejectInstallationChange(res);
      return;
    }
    deps.store.upsertAdminPolicy(claims.workspaceId, claims.adminUserId, next);
    const receipt = successReceipt({
      action: "assistant_update_permissions",
      entity: "assistant_policy",
      data: { policy: next },
    });
    const resultRef = deps.store.recordActionResult({
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      sessionId: claims.sessionId,
      actionName: "assistant_update_permissions",
      status: "succeeded",
      result: { kind: "receipt", receipt },
    });
    deps.store.addAuditEvent({
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      sessionId: claims.sessionId,
      actionName: "assistant_update_permissions",
      risk: ["permission_change"],
      resultRef,
    });
    res.json({ ok: true, receipt, policy: next });
  }));

  // Session restore after an iframe reload: replay the stored conversation and
  // re-serve the session's still-live pending previews. Each recovered preview
  // gets a ROTATED one-use nonce (the plaintext lives only in the UI; the old
  // one dies atomically — see rotatePendingNonce). Session-gated; NOT behind
  // the chat rate limit (no model call).
  router.get("/chat/history", asyncHandler(async (req, res) => {
    const claims = await requireSession(req, res);
    if (!claims) return;
    const messages = deps.store
      .getRecentMessages(claims.sessionId, CHAT_HISTORY_RESTORE_LIMIT, true)
      // Drop transient model-failure rows (payload.kind="error"): they are an
      // out-of-band notice the admin already saw live, not a reply to resurrect
      // on reload (finding r2-new-session-restore-05).
      .filter((m) => (m.role === "user" || m.role === "assistant") && !isTransientErrorMessage(m))
      .map((m) => ({
        role: m.role,
        content: m.content,
        results: sanitizeResultsForHistory((m.payload as { results?: unknown[] } | undefined)?.results ?? []),
      }));
    const pendingPreviews: unknown[] = [];
    for (const record of deps.store.listPendingConfirmations(claims.sessionId, now().toISOString())) {
      const rotated = rotatePendingNonce({
        record,
        sessionId: claims.sessionId,
        workspaceId: claims.workspaceId,
        adminUserId: claims.adminUserId,
        sessionSecret: deps.config.sessionSecret,
        now: now(),
      });
      if (!rotated.ok) continue;
      // Conditional swap: a concurrent confirm/cancel wins and the card is dropped.
      if (!deps.store.updateConfirmationNonceHash(record.id, rotated.record.nonceHash)) continue;
      pendingPreviews.push({
        kind: "preview",
        previewId: record.id,
        nonce: rotated.nonce,
        expiresAt: record.expiresAt,
        preview: record.preview,
      });
    }
    const operationRuns = deps.store.listScopedOperationRuns(
      claims.workspaceId,
      claims.adminUserId,
      claims.sessionId,
    ).map((operation) => ({
      id: operation.id,
      actionName: operation.actionName,
      status: operation.status,
      steps: operation.steps.map((step) => ({
        planStepId: step.planStepId,
        name: step.name,
        status: step.status,
      })),
      ...(operation.stepsTruncated ? { stepsTruncated: true } : {}),
      ...(operation.reconciliation ? { reconciliation: operation.reconciliation } : {}),
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
    }));
    res.json({
      ok: true,
      messages,
      pendingPreviews,
      ...(operationRuns.length > 0 ? { operationRuns } : {}),
    });
  }));

  // List this admin's live, non-empty conversations (the chat-history switcher).
  // Session-gated and tenant-scoped (listSessions filters by workspace+admin), so
  // it can never enumerate another tenant's sessions. `current` is decided HERE
  // from the cookie's claims — the UI can't know its own (HttpOnly) session id.
  router.get("/chat/sessions", asyncHandler(async (req, res) => {
    const claims = await requireSession(req, res);
    if (!claims) return;
    const sessions = deps.store
      .listSessions(claims.workspaceId, claims.adminUserId, now().toISOString())
      .map((s) => ({ ...s, current: s.id === claims.sessionId }));
    res.json({ ok: true, sessions });
  }));

  // Start a new conversation: mint a FRESH session for the same admin+workspace
  // and re-cookie. The previous session's messages are NOT deleted (they remain
  // under retention; the audit log keeps the actions) — only the transcript the
  // UI shows resets. Mirrors the cookie the component route issues so subsequent
  // chat calls bind the new session.
  router.post("/chat/new", asyncHandler(async (req, res) => {
    const claims = await requireSession(req, res);
    if (!claims) return;
    // Per-admin cap on session creation: the chat limiter is per-session, so without
    // this an admin could mint fresh sessions to reset the paid-model-loop budget.
    const limited = newChatAllowed(claims.workspaceId, claims.adminUserId);
    if (!limited.allowed) {
      res.setHeader("Retry-After", String(Math.ceil(limited.retryAfterMs / 1000)));
      res.status(429).json({
        ok: false,
        code: "rate_limited",
        message: "You're starting new chats too quickly — please wait a moment and try again.",
      });
      return;
    }
    // requireSession awaited current-role I/O. Recheck the exact generation at
    // the session-creation boundary so uninstall/reinstall cannot recreate a
    // session after workspace erasure at the promise handoff.
    if (!activeGenerationAtBoundary(claims.workspaceId, claims.installationGeneration)) {
      rejectInstallationChange(res);
      return;
    }
    const session = deps.store.createSession({
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      ttlMs: deps.config.sessionTtlMs,
    });
    const sessionClaims: SessionClaims = {
      sessionId: session.id,
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      workspaceRole: claims.workspaceRole,
      ...(claims.uiPreferences ? { uiPreferences: claims.uiPreferences } : {}),
      expiresAt: session.expiresAt,
    };
    setSessionCookie(res, sessionClaims, deps.config.sessionSecret, deps.config.baseUrl, deps.config.sessionTtlMs);
    res.json({ ok: true });
  }));

  // Switch the cookie to a PAST conversation (the chat-history switcher). `:id` is
  // attacker-controlled, so this is the IDOR-guarded re-cookie: the target must be
  // a LIVE session owned by THIS workspace+admin. getSession already drops expired
  // sessions (so an expired/unknown id 404s for free, no TTL revival); the ownership
  // check mirrors resolveSession / the component reuse gate. A foreign/other-admin
  // target returns 404 (NOT 403 — existence is never confirmed) and sets no cookie.
  // The re-cookie carries the TARGET session's own expiry — never extended.
  router.post("/chat/sessions/:id/open", asyncHandler(async (req, res) => {
    const claims = await requireSession(req, res);
    if (!claims) return;
    const target = deps.store.getSession(req.params.id);
    if (
      !target ||
      target.workspaceId !== claims.workspaceId ||
      target.adminUserId !== claims.adminUserId
    ) {
      res.status(404).json({ ok: false, code: "not_found", message: "Conversation not found." });
      return;
    }
    const sessionClaims: SessionClaims = {
      sessionId: target.id,
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      workspaceRole: claims.workspaceRole,
      ...(claims.uiPreferences ? { uiPreferences: claims.uiPreferences } : {}),
      expiresAt: target.expiresAt,
    };
    setSessionCookie(res, sessionClaims, deps.config.sessionSecret, deps.config.baseUrl, deps.config.sessionTtlMs);
    res.json({ ok: true });
  }));

  // Non-streaming turn (request/response). The mounted UI uses /chat/stream
  // below; this is the tested fallback surface (its client is `submitMessage`).
  // A failed turn returns 502 {ok:false,code,message} — the client surfaces that
  // copy (json() only throws on 401), it never silently renders nothing.
  router.post("/chat/messages", sessionAsyncHandler(async (req, res) => {
    const pre = await chatPreconditions(req, res);
    if (!pre) return;
    if (pre.replay) return res.status(pre.replay.status).json(pre.replay.body);
    const requestAbort = requestAbortScope(req, res);
    let turn: Awaited<ReturnType<typeof executeChatTurn>>;
    try {
      turn = await withHostCallBudget(() => executeChatTurn(
        pre.claims,
        pre.installation,
        pre.message,
        undefined,
        undefined,
        requestAbort.signal,
        pre.requestId,
      ));
    } finally {
      requestAbort.dispose();
    }
    const status = turn.ok ? 200 : 502;
    const body = turn.ok
      ? { ok: true, reply: { kind: turn.replyKind, text: turn.replyText }, results: turn.results }
      : { ok: false, code: turn.code, message: turn.message };
    finishTurnRunSafely(
      pre.claims.sessionId,
      pre.requestId,
      turn.ok ? "succeeded" : "failed",
      { status, body },
      turn.ok ? turn.resultLinks : [],
    );
    return res.status(status).json(body);
  }));

  // Streaming variant (NDJSON): the SAME turn, but each harness result is written
  // as it is produced, then the truthful reply, then `done`. This streams the
  // harness's progress (receipts/clarifies/previews) — never the model's tokens,
  // which would conflict with the truthful-preview override.
  router.post("/chat/stream", sessionAsyncHandler(async (req, res) => {
    const pre = await chatPreconditions(req, res);
    if (!pre) return;
    // openNdjsonStream sets the streaming headers and wires cooperative
    // cancellation: `signal` fires if the client (iframe/proxy) drops mid-turn,
    // so no further model calls or writes run for a turn nobody is watching.
    const { write, signal } = openNdjsonStream(res);
    if (pre.replay) {
      const body = pre.replay.body as { ok?: boolean; reply?: { kind?: string; text?: string }; results?: unknown[]; code?: string; message?: string };
      if (body.ok) {
        for (const result of body.results ?? []) write({ type: "result", result });
        write({ type: "reply", kind: body.reply?.kind ?? "answer", text: body.reply?.text ?? "" });
      } else {
        write({ type: "error", code: body.code ?? "operation_failed", message: body.message ?? "The prior request failed." });
      }
      write({ type: "done" });
      return res.end();
    }
    try {
      const turn = await withHostCallBudget(() => executeChatTurn(
        pre.claims,
        pre.installation,
        pre.message,
        (result) => write({ type: "result", result }),
        (status) => write({ type: "status", ...status }),
        signal,
        pre.requestId,
      ));
      const status = turn.ok ? 200 : 502;
      const body = turn.ok
        ? { ok: true, reply: { kind: turn.replyKind, text: turn.replyText }, results: turn.results }
        : { ok: false, code: turn.code, message: turn.message };
      finishTurnRunSafely(
        pre.claims.sessionId,
        pre.requestId,
        turn.ok ? "succeeded" : "failed",
        { status, body },
        turn.ok ? turn.resultLinks : [],
      );
      if (!turn.ok) write({ type: "error", code: turn.code, message: turn.message });
      else write({ type: "reply", kind: turn.replyKind, text: turn.replyText });
    } catch {
      finishTurnRunSafely(pre.claims.sessionId, pre.requestId, "outcome_unknown", {
        status: 500,
        body: { ok: false, code: "operation_outcome_unknown", message: "The turn was interrupted and its outcome is unknown." },
      });
      write({ type: "error", code: "stream_error", message: "Something went wrong." });
    }
    write({ type: "done" });
    res.end();
  }));

  router.get("/operations/:requestId", asyncHandler(async (req, res) => {
    const claims = await requireSession(req, res);
    if (!claims) return;
    const run = deps.store.getTurnRun(claims.sessionId, req.params.requestId);
    if (!run || run.workspaceId !== claims.workspaceId || run.adminUserId !== claims.adminUserId) {
      return res.status(404).json({ ok: false, code: "not_found", message: "Operation not found." });
    }
    return res.json({ ok: true, requestId: run.requestId, status: run.status, response: run.response });
  }));

  router.get("/operation-runs/:operationId", asyncHandler(async (req, res) => {
    const claims = await requireSession(req, res);
    if (!claims) return;
    const operation = deps.store.getScopedOperationRun(
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

  router.get("/artifacts/:id", asyncHandler(async (req, res) => {
    const claims = await requireSession(req, res);
    if (!claims) return;
    const artifact = deps.store.getArtifact(
      req.params.id,
      claims.workspaceId,
      claims.adminUserId,
      claims.sessionId,
    );
    if (!artifact) {
      return res.status(404).json({ ok: false, code: "not_found", message: "Artifact not found or expired." });
    }
    const safeFilename = artifact.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    res.setHeader("Content-Type", artifact.contentType);
    res.setHeader("Content-Length", String(artifact.bytes.byteLength));
    res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}"`);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Checksum-Sha256", artifact.checksum);
    return res.status(200).send(Buffer.from(artifact.bytes));
  }));

  router.post("/confirmations/:id/confirm", sessionAsyncHandler(async (req, res) => {
    const claims = await requireSession(req, res);
    if (!claims) return;
    const parsed = confirmBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ ok: false, code: "invalid_args", message: "A confirmation nonce is required." });
    }

    const record = deps.store.getPendingConfirmation(req.params.id);
    if (!record) {
      return res.status(404).json({ ok: false, code: "not_found", message: "No such pending preview." });
    }

    const requestAbort = requestAbortScope(req, res);
    let committed: Awaited<ReturnType<typeof commitConfirmation>>;
    try {
      committed = await withHostCallBudget(
        () => commitConfirmation(claims, record, parsed.data.nonce, requestAbort.signal),
      );
    } catch (error) {
      requestAbort.dispose();
      throw error;
    }
    if (!committed.ok) {
      requestAbort.dispose();
      // Validation/policy/the one-use claim rejected BEFORE any commit — always
      // JSON (the stream is never opened), and a denied confirm never burns the nonce.
      return res.status(committed.status).json(committed.body);
    }
    const { receipt, partialResult, undoId, agentState, installation, persistenceDegraded } = committed;

    // Streaming confirm (?stream=1, used by the embedded UI): the committed
    // receipt flushes IMMEDIATELY so the button is responsive, then the durable
    // resume streams its continuation as it runs. The continuous stream also keeps
    // the connection alive, so a slow multi-step resume can't surface as a tunnel
    // timeout / "Confirmation failed" the way one blocking JSON response could. The
    // JSON path (no ?stream) is unchanged for scripts/tests.
    if (req.query.stream === "1") {
      requestAbort.dispose();
      // openNdjsonStream sets the streaming headers and fires `signal` if the
      // client drops mid-resume (see /chat/stream).
      const { write, signal } = openNdjsonStream(res);
      if (partialResult) {
        write({
          type: "result",
          result: { ...partialResult, ...(undoId ? { undo: { id: undoId } } : {}) },
          ...(persistenceDegraded ? { persistenceDegraded: true } : {}),
        });
      } else {
        write({
          type: "receipt",
          receipt,
          ...(undoId ? { undo: { id: undoId } } : {}),
          ...(persistenceDegraded ? { persistenceDegraded: true } : {}),
        });
      }
      try {
        const resumed = partialResult
          ? undefined
          : await withHostCallBudget(() => runResume(
              claims,
              installation,
              agentState,
              receipt,
              (result) => write({ type: "result", result }),
              (status) => write({ type: "status", ...status }),
              signal,
            ));
        if (resumed) write({ type: "reply", kind: resumed.replyKind, text: resumed.replyText });
      } catch {
        write({ type: "error", code: "resume_error", message: "The follow-up couldn't complete, but your change was applied." });
      }
      write({ type: "done" });
      return res.end();
    }

    // JSON path: collect the resume into the response (unchanged behavior).
    let resumed: Awaited<ReturnType<typeof runResume>>;
    try {
      resumed = partialResult
        ? undefined
        : await withHostCallBudget(
            () => runResume(
              claims,
              installation,
              agentState,
              receipt,
              undefined,
              undefined,
              requestAbort.signal,
            ),
          );
    } finally {
      requestAbort.dispose();
    }
    return res.status(receipt.ok ? 200 : 400).json({
      ok: receipt.ok,
      receipt,
      ...(partialResult ? { result: partialResult } : {}),
      ...(undoId ? { undo: { id: undoId } } : {}),
      ...(persistenceDegraded ? { persistenceDegraded: true } : {}),
      ...(resumed ? { resume: { reply: { kind: resumed.replyKind, text: resumed.replyText }, results: resumed.results } } : {}),
    });
  }));

  // Undo the last reversible action (Phase 5b): delete the entities it created.
  router.post("/undo/:id", sessionAsyncHandler(async (req, res) => {
    const claims = await requireSession(req, res);
    if (!claims) return;

    const record = deps.store.getUndoRecord(req.params.id);
    if (!record || record.workspaceId !== claims.workspaceId || record.adminUserId !== claims.adminUserId) {
      return res.status(404).json({ ok: false, code: "not_found", message: "No such undoable action." });
    }
    if (record.status !== "available") {
      const expired = record.status === "expired";
      return res.status(409).json({
        ok: false,
        code: expired ? "undo_expired" : "undo_not_available",
        message: expired ? "This undo window expired after 30 minutes." : "This undo is no longer available.",
      });
    }

    // Re-check write policy BEFORE consuming the one-use record, so a lowered policy
    // denies cleanly without burning it (reverseCreation re-checks as defense in depth).
    const denied = firstDeniedGroup(loadPolicy(claims.workspaceId, claims.adminUserId), record.reversal);
    if (denied) {
      return res.status(400).json({
        ok: false,
        code: "policy_denied",
        message: `Undo needs write access to ${denied}, which is disabled in your assistant permissions.`,
      });
    }

    const installation = deps.store.getInstallation(claims.workspaceId);
    if (!installation || installation.status !== "active") {
      return res.status(400).json({ ok: false, code: "not_installed", message: "The add-on is not active for this workspace." });
    }
    if (!Number.isSafeInteger(record.installationGeneration) ||
        record.installationGeneration !== installation.generation) {
      return res.status(409).json({
        ok: false,
        code: "installation_changed",
        message: "The Clockify installation changed after this undo was created. Run the action again before undoing it.",
      });
    }

    const requestAbort = requestAbortScope(req, res);
    const authority = await verifyWriteAuthority(claims, installation, requestAbort.signal);
    if (!authority.ok) {
      requestAbort.dispose();
      return res.status(authority.status).json({ ok: false, code: authority.code, message: authority.message });
    }

    let mutationLease: WorkspaceMutationLease;
    try {
      mutationLease = mutationCoordinator.acquire(
        claims.workspaceId,
        installation.generation,
        requestAbort.signal,
      );
    } catch (error) {
      requestAbort.dispose();
      if (!(error instanceof WorkspaceMutationRevokedError)) throw error;
      return res.status(409).json({ ok: false, code: "installation_changed", message: error.message });
    }
    if (mutationLease.signal.aborted) {
      mutationLease.release();
      requestAbort.dispose();
      return res.status(409).json({
        ok: false,
        code: "request_cancelled",
        message: "The undo was cancelled before dispatch. No change was made.",
      });
    }

    try {
    const mutationPlan = undoMutationPlan(record.reversal);
    const operation = {
      undoId: record.id,
      installationGeneration: record.installationGeneration,
      reversal: record.reversal,
    };
    const operationId = deps.store.startUndoOperation(record.id, {
      sessionId: claims.sessionId,
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      actionName: "undo",
      actionFingerprint: hashOperation({ actionName: "undo", version: 1 }),
      catalogHash: catalogHash(),
      operationHash: hashOperation({ actionName: "undo", operation, mutationPlan }),
      operation,
      mutationPlan,
    });
    // Atomic one-use + durable-operation claim: only its winner may dispatch.
    if (!operationId) {
      return res.status(409).json({ ok: false, code: "undo_not_available", message: "This undo is no longer available." });
    }

    const undoContext = actionContext(
      claims.workspaceId,
      claims.adminUserId,
      installation,
      claims.sessionId,
      mutationLease.signal,
    );
    undoContext.mutationJournal = deps.store.mutationStepJournal(operationId);
    const undo = await withHostCallBudget(() => reverseCreationDurably(
      undoContext,
      record.reversal,
      operationId,
      mutationPlan,
    ));
    const { receipt, remaining, status: undoStatus } = undo;
    let undoResultRef: import("../db/store.js").ActionResultRef | undefined;
    let undoSettlementError: unknown;
    for (let attempt = 0; attempt < 2 && !undoResultRef; attempt += 1) {
      try {
        undoResultRef = deps.store.settleUndoOperation(record.id, operationId, undoStatus, remaining, receipt);
      } catch (error) {
        undoSettlementError = error;
      }
    }
    if (!undoResultRef) {
      console.error(
        "undo settlement persistence degraded (reversal already dispatched; receipt preserved):",
        undoSettlementError instanceof Error ? undoSettlementError.message : String(undoSettlementError),
      );
    }
    // The reversal already happened (and the one-use claim is executing). A
    // transient audit-write failure must NOT surface as a 500 — the admin
    // would retry and hit already_undone (409), believing it failed when it succeeded.
    // Mirror commitConfirmation: best-effort audit, message-only log, return the receipt.
    if (undoResultRef) bestEffort("undo bookkeeping", () => {
      deps.store.addAuditEvent({
        workspaceId: claims.workspaceId,
        adminUserId: claims.adminUserId,
        sessionId: claims.sessionId,
        actionName: "undo",
        risk: ["destructive"],
        resultRef: undoResultRef!,
      });
    });
    return res.status(receipt.ok ? 200 : 400).json({
      ok: receipt.ok,
      receipt,
      ...(!undoResultRef ? { persistenceDegraded: true } : {}),
    });
    } finally {
      mutationLease.release();
      requestAbort.dispose();
    }
  }));

  router.post("/confirmations/:id/cancel", sessionAsyncHandler(async (req, res) => {
    const claims = await requireSession(req, res);
    if (!claims) return;
    const record = deps.store.getPendingConfirmation(req.params.id);
    if (!record) {
      res.status(404).json({ ok: false, code: "not_found", message: "No such pending preview." });
      return;
    }
    if (
      record.workspaceId !== claims.workspaceId ||
      record.adminUserId !== claims.adminUserId ||
      record.sessionId !== claims.sessionId
    ) {
      res.status(403).json({ ok: false, code: "forbidden", message: "This preview belongs to a different session." });
      return;
    }
    if (!deps.store.cancelConfirmation(record.id)) {
      res.status(409).json({ ok: false, code: "not_pending", message: "This preview is no longer pending." });
      return;
    }
    res.json({ ok: true, status: "cancelled" });
  }));

  return router;
}
