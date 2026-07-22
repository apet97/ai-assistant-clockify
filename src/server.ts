import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express, { type Express } from "express";
import { buildAddon, ADDON_ICON_SVG, ICON_PATH } from "./addon/manifest.js";
import { createSignatureParser } from "./addon/verify.js";
import { loadConfig } from "./config.js";
import { createStore, type Installation } from "./db/store.js";
import type { WorkspaceClient } from "./clockify/client.js";
import { createRestWorkspaceClient } from "./clockify/rest-workspace.js";
import { createWorkspaceRequestGovernor, type WorkspaceRequestGovernor } from "./clockify/request-governor.js";
import { createWorkspaceMutationCoordinator } from "./clockify/workspace-mutation-coordinator.js";
import {
  resolveClockifyApiBase,
  resolveClockifyAuditBase,
  resolveClockifyReportsBase,
} from "./clockify/api-base.js";
import { selectModelClient } from "./assistant/select-model-client.js";
import { apiRouter } from "./routes/api.js";
import { componentRouter } from "./routes/component.js";
import { lifecycleRouter } from "./routes/lifecycle.js";
import { installAttestationRouter } from "./routes/install-attestation.js";
import { finishNdjsonWithServerError } from "./routes/ndjson.js";
import type { AppDeps } from "./routes/deps.js";
import { runProductionStartupReconciliation } from "./harness/startup-reconciliation-registry.js";
import { completeInterruptedDeletionTombstones } from "./db/deletion-tombstones.js";
import { renderPublicDocument, type PublicDocumentKind } from "./public-documents.js";
import { verifyRuntimeReleaseArtifact } from "./release-artifact.js";

/**
 * Compose the Express app from injected dependencies (server-as-a-function, so
 * tests drive it via Supertest with fakes). server.start() builds the real
 * dependencies from config and listens.
 */
export function createApp(deps: AppDeps): Express {
  const runtimeDeps: AppDeps = deps.mutationCoordinator
    ? deps
    : { ...deps, mutationCoordinator: createWorkspaceMutationCoordinator() };
  const app = express();
  // Express identifies itself by default. The service has no need to disclose
  // that implementation detail to a caller, so remove it before any middleware
  // writes a response.
  app.disable("x-powered-by");
  // Cap the request body: a hostile multi-MB JSON payload must never be parsed
  // into memory or persisted. Oversized bodies are rejected by body-parser before
  // any route runs (it raises a 413 PayloadTooLargeError, mapped below). The chat
  // message/nonce field caps (routes/api.ts) are the second, finer layer.
  app.use(express.json({ limit: "32kb" }));

  // Cheap defense-in-depth on EVERY response (the component HTML route sets its
  // own; this covers the /api JSON routes that previously set none). nosniff stops
  // MIME-confusion; HSTS is emitted only when the deployment is https (it is a
  // no-op/meaningless over local http) in case Railway's edge doesn't add it.
  // X-Frame-Options is intentionally NOT set — the add-on must stay
  // iframe-embeddable; clickjacking is controlled by the component CSP
  // frame-ancestors allow-list.
  const httpsDeployment = runtimeDeps.config.baseUrl.startsWith("https://");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (httpsDeployment) {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });

  const publicDocuments = new Map<string, PublicDocumentKind>([
    ["/privacy", "privacy"],
    ["/terms", "terms"],
    ["/support", "support"],
    ["/security", "security"],
  ]);
  for (const [route, kind] of publicDocuments) {
    app.get(route, (_req, res) => {
      res.setHeader("Cache-Control", "public, max-age=300");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      );
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Frame-Options", "DENY");
      res.type("html").send(renderPublicDocument(kind, runtimeDeps.config.publicContactUrl));
    });
  }

  app.get("/manifest", (_req, res) => {
    res.json(buildAddon(deps.config.baseUrl).getManifest());
  });

  // Public, secret-free deployment identity. Railway CLI uploads are not tied to
  // Git automatically, so release deploys set both values from a clean commit.
  app.get("/version", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json({
      version: "1.0.0",
      releaseSha: runtimeDeps.releaseArtifactIdentity?.releaseSha ?? null,
      buildHash: runtimeDeps.releaseArtifactIdentity?.releaseBuildHash ?? null,
      serverArtifactSha256: runtimeDeps.releaseArtifactIdentity?.serverArtifactSha256 ?? null,
      sourceRelationship: runtimeDeps.releaseArtifactIdentity?.sourceRelationship ?? null,
      sourceBindingSha256: runtimeDeps.releaseArtifactIdentity?.sourceBindingSha256 ?? null,
      modelConfiguration: {
        provider: runtimeDeps.config.llmProvider,
        model: runtimeDeps.config.llmModel ?? null,
        endpointSha256: runtimeDeps.config.llmEndpointSha256 ?? null,
        assistantEngine: runtimeDeps.config.assistantEngine,
        mode: runtimeDeps.config.llmMode,
        agentic: runtimeDeps.config.llmAgentic,
        toolSelect: runtimeDeps.config.llmToolSelect,
        reasoningEffort: runtimeDeps.config.llmReasoningEffort ?? null,
        thinkingMode: runtimeDeps.config.llmThinkingMode ?? null,
      },
    });
  });

  // Process liveness is deliberately independent of dependencies/draining.
  app.get("/live", (_req, res) => {
    res.json({ ok: true });
  });

  // Readiness probe (the platform healthcheck). Unlike the static /manifest, this
  // touches the DB handle, so a hung/locked SQLite instance reports 503 and gets
  // rotated out instead of silently failing live traffic. Public, no auth, no secrets.
  app.get("/health", (_req, res) => {
    try {
      if (deps.readiness && !deps.readiness.isReady()) throw new Error("draining");
      deps.store.healthCheck();
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  // The add-on icon (manifest `iconPath`) — Clockify's sidebar nav entry renders
  // from this. Public, cacheable, no auth.
  app.get(ICON_PATH, (_req, res) => {
    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.status(200).send(ADDON_ICON_SVG);
  });

  app.use(installAttestationRouter(runtimeDeps));
  app.use(lifecycleRouter(runtimeDeps));
  app.use(componentRouter(runtimeDeps));
  app.use("/api", (_req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    next();
  });
  app.use("/api", apiRouter(runtimeDeps));

  // Built UI assets (present after `npm run build`); harmless if absent.
  app.use("/ui", express.static(resolve("dist/ui")));

  // Terminal error handler: async route rejections (e.g. a store write that
  // throws SQLITE_BUSY mid-turn) are routed here by the route asyncHandler.
  // Without it Express 4 leaves the request hanging AND the rejection becomes a
  // fatal unhandledRejection — one bad turn would take down every session. We
  // log (no secrets — the error message only, never headers/tokens) and return a
  // calm response so the server stays up. If an NDJSON stream already started,
  // emit a terminal error line instead of trying to set a status on sent headers.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("request error:", err instanceof Error ? err.message : String(err));
    if (res.headersSent) {
      finishNdjsonWithServerError(res);
      return;
    }
    // Body-parser client errors (oversized payload → 413, malformed JSON → 400)
    // carry their own 4xx status — honor it so the caller learns it was a client
    // mistake, not a server fault. A bare server error (e.g. a SQLITE_BUSY thrown
    // mid-turn, no .status) stays a calm 500. Never echo err.message (it could
    // carry request data); the status is enough.
    const status = (err as { status?: unknown; statusCode?: unknown })?.status ?? (err as { statusCode?: unknown })?.statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      res.status(status).json({ ok: false, code: "invalid_request", message: "The request was rejected (too large or malformed)." });
      return;
    }
    res.status(500).json({ ok: false, code: "server_error", message: "Something went wrong on our side. Please try again." });
  });

  return app;
}

/**
 * Default production Clockify client: the REST adapter over the WorkspaceClient
 * port, authenticated with the installation's add-on token (X-Addon-Token). The
 * base URL is resolved from the install context (apiUrl/backendUrl + /v1) so dev
 * and regional environments work — see resolveClockifyApiBase. No token is logged.
 */
function liveClockifyForWorkspace(
  installation: Installation,
  commitTimeoutMs?: number,
  requestGovernor?: WorkspaceRequestGovernor,
  signal?: AbortSignal,
): WorkspaceClient {
  return createRestWorkspaceClient({
    baseUrl: resolveClockifyApiBase(installation),
    reportsBase: resolveClockifyReportsBase(installation),
    auditBase: resolveClockifyAuditBase(installation),
    workspaceId: installation.workspaceId,
    auth: { addonToken: installation.addonToken },
    commitTimeoutMs,
    requestGovernor,
    ...(signal ? { signal } : {}),
  });
}

/** Operational-table retention sweep cadence (see Store.pruneExpired). */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/** Drain budget before force-exit — Railway SIGKILLs shortly after SIGTERM. */
const FORCE_EXIT_AFTER_MS = 10_000;
const RESTORE_PROBE_CHILD_ARG = "--restore-readiness-probe-child";
const RESTORE_PROBE_HOST = "127.0.0.1";

export interface ShutdownDeps {
  server: { close(cb: (err?: Error) => void): void; closeIdleConnections?: () => void };
  store: { close(): void };
  /** Cleared first so the retention sweep can't fire mid-teardown. */
  pruneTimer?: NodeJS.Timeout;
  exit?: (code: number) => void;
  forceExitAfterMs?: number;
  log?: (message: string) => void;
  onDraining?: () => void;
}

/**
 * Graceful SIGTERM/SIGINT teardown: stop the prune loop, drop keep-alive
 * sockets, drain in-flight requests, close the store, exit 0. A hung drain
 * (e.g. an in-flight 120s model call) force-exits 1 before Railway's SIGKILL —
 * WAL keeps the DB crash-safe either way. Idempotent: the second signal is a
 * no-op while the first teardown runs.
 */
export function createShutdownHandler(deps: ShutdownDeps): (signal: string, exitCode?: number) => void {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const log = deps.log ?? ((message: string) => console.log(message));
  let shuttingDown = false;
  let finished = false;
  return (signal: string, exitCode = 0): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    deps.onDraining?.();
    log(`${signal} received — draining`);
    if (deps.pruneTimer) clearInterval(deps.pruneTimer);
    // Close the store then exit. The store close may throw if the drain still
    // holds a statement open — exit regardless (so a throw never hangs teardown).
    const finish = (code: number): void => {
      if (finished) return;
      finished = true;
      try {
        deps.store.close();
      } catch {
        // A statement may still be open — exit cleanly regardless.
      }
      exit(code);
    };
    const force = setTimeout(() => finish(1), deps.forceExitAfterMs ?? FORCE_EXIT_AFTER_MS);
    force.unref?.();
    deps.server.closeIdleConnections?.();
    deps.server.close((error) => {
      // clearTimeout BEFORE finish: the force timer must be dead before the store
      // close runs, so a throw there can't be raced by a force-exit (and finish
      // never double-exits).
      clearTimeout(force);
      finish(error ? 1 : exitCode);
    });
  };
}

export async function start(): Promise<void> {
  const restoreProbeRequested = process.argv.includes(RESTORE_PROBE_CHILD_ARG);
  if (restoreProbeRequested && typeof process.send !== "function") {
    throw new Error("restore_readiness_probe_requires_ipc");
  }
  const config = loadConfig();
  // Runtime variables are claims, not proof. Bind them to the deterministic
  // post-build manifest and the exact complete dist/server bytes before opening
  // the database, initializing the provider, or listening on any port.
  const releaseArtifactIdentity = verifyRuntimeReleaseArtifact({
    // Compiled entrypoint: dist/server/server.js -> repository root.
    repositoryRoot: fileURLToPath(new URL("../../", import.meta.url)),
    nodeEnv: config.nodeEnv,
    releaseSha: config.releaseSha,
    releaseBuildHash: config.releaseBuildHash,
    sourceBindingSha256: config.releaseSourceBindingSha256,
  });
  const store = createStore(config.databasePath, {
    encryptionKey: config.dataEncryptionKey,
    previousEncryptionKey: config.dataEncryptionKeyPrevious,
    retentionDays: config.retentionDays,
  });
  const parser = createSignatureParser(config.clockifyAddonKey, config.clockifyAddonPublicKeyPem);
  const modelClient = selectModelClient(config);

  const readiness = { ready: true };
  const requestGovernors = new Map<string, WorkspaceRequestGovernor>();
  const requestGovernorFor = (workspaceId: string): WorkspaceRequestGovernor => {
    const existing = requestGovernors.get(workspaceId);
    if (existing) return existing;
    const created = createWorkspaceRequestGovernor();
    requestGovernors.set(workspaceId, created);
    return created;
  };
  const completedDeletionTombstones = completeInterruptedDeletionTombstones(store);
  if (completedDeletionTombstones.length > 0) {
    console.log(`completed interrupted uninstall tombstones count=${completedDeletionTombstones.length}`);
  }
  // Store construction has already marked dispatched orphans unknown. Complete
  // the read-only reconciliation pass before any listener can accept mutation
  // traffic. The pass can neither resume a prepared step nor compensate.
  try {
    await runProductionStartupReconciliation({
      store,
      clockifyForWorkspace: (installation) => liveClockifyForWorkspace(
        installation,
        config.commitTimeoutMs,
        requestGovernorFor(installation.workspaceId),
      ),
    });
  } catch (error) {
    store.close();
    throw error;
  }
  const app = createApp({
    config,
    store,
    parser,
    modelClient,
    clockifyForWorkspace: (installation, options) => liveClockifyForWorkspace(
      installation,
      config.commitTimeoutMs,
      requestGovernorFor(installation.workspaceId),
      options?.signal,
    ),
    readiness: { isReady: () => readiness.ready },
    ...(releaseArtifactIdentity ? { releaseArtifactIdentity } : {}),
  });

  // Retention: prune expired operational rows + chat transcripts/audit log past
  // the retention window at startup (catches backlog after long-idle deploys) and
  // hourly. chat_messages/audit_events age out on RETENTION_DAYS (default 90).
  let pruning = false;
  const prune = async (): Promise<void> => {
    if (pruning) return;
    pruning = true;
    let continueBacklog = false;
    try {
      const counts = await store.pruneExpired(new Date().toISOString());
      continueBacklog = counts.backlog;
      if (counts.total > 0 || counts.backlog) {
        console.log(
          `retention prune: total=${counts.total} deleted=${counts.deletedTotal} expired=${counts.expiredTotal} batches=${counts.batches} durationMs=${counts.durationMs} backlog=${counts.backlog} confirmationsDeleted=${counts.pendingConfirmations} confirmationsExpired=${counts.expiredConfirmations} idempotency=${counts.idempotencyKeys} undoDeleted=${counts.undoRecords} undoExpired=${counts.expiredUndoRecords} telemetry=${counts.turnTelemetry} chat=${counts.chatMessages} audit=${counts.auditEvents} operations=${counts.operationRuns} results=${counts.actionResults} artifacts=${counts.artifacts} sessions=${counts.chatSessions} walBusy=${counts.walCheckpoint.busy} walLog=${counts.walCheckpoint.log} walCheckpointed=${counts.walCheckpoint.checkpointed}`,
        );
      }
    } catch (error) {
      console.warn("retention prune failed:", error instanceof Error ? error.message : String(error));
    } finally {
      pruning = false;
      if (continueBacklog) setImmediate(() => { void prune(); });
    }
  };
  const pruneTimer = setInterval(() => { void prune(); }, PRUNE_INTERVAL_MS);
  pruneTimer.unref();

  const onListening = (): void => {
    // Intentionally minimal, non-secret startup log.
    if (restoreProbeRequested) {
      const address = server.address();
      if (!address || typeof address === "string" || typeof process.send !== "function") {
        throw new Error("restore_readiness_probe_listen_failed");
      }
      process.send({ type: "restore_readiness_listening", port: address.port });
    } else {
      console.log(`AI Assistant add-on listening on port ${config.port}`);
    }
    // Run the at-startup backlog sweep AFTER listen so readiness isn't gated by
    // it — the prune now seeks narrow retention indexes, but on a long-lived
    // instance the first sweep should never delay accepting connections.
    void prune();
  };
  // Ordinary PORT validation remains strictly positive. Only the explicit
  // restore-probe child with a live IPC channel may ask the OS for loopback port
  // 0, eliminating the reserve-close-bind race without opening a public listener.
  const server = restoreProbeRequested
    ? app.listen(0, RESTORE_PROBE_HOST, onListening)
    : app.listen(config.port, onListening);

  // Railway redeploys SIGTERM the container — drain instead of dropping
  // in-flight turns, and close the store cleanly.
  const shutdown = createShutdownHandler({
    server,
    store,
    pruneTimer,
    onDraining: () => {
      readiness.ready = false;
    },
  });
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("unhandledRejection", (reason) => {
    console.error("unhandledRejection:", reason instanceof Error ? reason.message : String(reason));
    shutdown("unhandledRejection", 1);
  });
  process.once("uncaughtException", (error) => {
    console.error("uncaughtException:", error.message);
    shutdown("uncaughtException", 1);
  });
}

// Run only when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void start().catch((error: unknown) => {
    console.error("startup failed:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
