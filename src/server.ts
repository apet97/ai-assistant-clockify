import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express, { type Express } from "express";
import { buildAddon, ADDON_ICON_SVG, ICON_PATH } from "./addon/manifest.js";
import { createSignatureParser } from "./addon/verify.js";
import { loadConfig } from "./config.js";
import { createStore, type Installation, type Store } from "./db/store.js";
import type { WorkspaceClient } from "./clockify/client.js";
import { createRestWorkspaceClient, type RestWorkspaceOptions } from "./clockify/rest-workspace.js";
import { createWorkspaceRequestGovernor, type WorkspaceRequestGovernor } from "./clockify/request-governor.js";
import { createTokenRejectionMonitor, type TokenRejectionMonitor } from "./clockify/token-rejection-monitor.js";
import { createHostThrottleMonitor, type HostThrottleMonitor } from "./clockify/host-throttle-monitor.js";
import { logAlias } from "./log-alias.js";
import { classifyLoggableError } from "./log-error-class.js";
import {
  classifySqliteFailure,
  createReadinessAlertMonitor,
  logSqliteUnavailable,
} from "./readiness-alerts.js";
import { createRetentionAlertMonitor, type RetentionAlertMonitor } from "./retention-alerts.js";
import {
  OPERATOR_HEALTH_SNAPSHOT_INTERVAL_MS,
  createOperatorHealthSnapshotEmitter,
  type OperatorHealthSnapshotEmitter,
} from "./operator-health.js";
import { createWorkspaceMutationCoordinator } from "./clockify/workspace-mutation-coordinator.js";
import {
  resolveClockifyApiBase,
  resolveClockifyAuditBase,
  resolveClockifyReportsBase,
} from "./clockify/api-base.js";
import { selectModelClient } from "./assistant/select-model-client.js";
import {
  apiRouter,
  defaultAssistantPipelineFactories,
  type AssistantPipelineFactories,
} from "./routes/api.js";
import { componentRouter } from "./routes/component.js";
import { lifecycleRouter } from "./routes/lifecycle.js";
import { installAttestationRouter } from "./routes/install-attestation.js";
import { finishNdjsonWithServerError } from "./routes/ndjson.js";
import type { AppDeps } from "./routes/deps.js";
import { runProductionStartupReconciliation } from "./harness/startup-reconciliation-registry.js";
import { completeInterruptedDeletionTombstones } from "./db/deletion-tombstones.js";
import { assertFreshDatabaseBoundary, writeFreshCutoverMarker } from "./db/fresh-boundary.js";
import { renderPublicDocument, type PublicDocumentKind } from "./public-documents.js";
import { verifyRuntimeReleaseArtifact } from "./release-artifact.js";
import { buildApiOperationIndex } from "./assistant-v2/discovery/api-index.js";
import { MODEL_API_ACTION_CATALOG } from "./harness/api-catalog.js";

/**
 * Compose the Express app from injected dependencies (server-as-a-function, so
 * tests drive it via Supertest with fakes). server.start() builds the real
 * dependencies from config and listens.
 */
export function createApp(
  deps: AppDeps,
  pipelineFactories: AssistantPipelineFactories = defaultAssistantPipelineFactories,
): Express {
  const apiOperationIndex = deps.apiOperationIndex ?? buildApiOperationIndex(MODEL_API_ACTION_CATALOG);
  const runtimeDeps: AppDeps = {
    ...deps,
    apiOperationIndex,
    mutationCoordinator: deps.mutationCoordinator ?? createWorkspaceMutationCoordinator(),
  };
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
  //
  // D3 alerts 1 and 4: a 503 used to be completely silent, so a container could
  // be rotated out again and again — for a read-only or full volume — with no
  // evidence anywhere. Both the readiness state change and the classified
  // storage cause are now emitted, at the CROSSING only: the platform polls this
  // route on a seconds-scale interval, so per-probe lines would flood the log
  // exactly when it needs to be readable. Draining is separated from a store
  // failure structurally rather than by re-reading a sentinel message.
  const readinessAlerts = createReadinessAlertMonitor();
  app.get("/health", (_req, res) => {
    if (deps.readiness && !deps.readiness.isReady()) {
      readinessAlerts.notReady("draining");
      res.status(503).json({ ok: false });
      return;
    }
    try {
      deps.store.healthCheck();
    } catch (error) {
      const kind = classifySqliteFailure(error);
      const changed = readinessAlerts.notReady(kind ? `sqlite_${kind}` : "storage_error");
      if (changed && kind) logSqliteUnavailable({ kind, site: "readiness" });
      res.status(503).json({ ok: false });
      return;
    }
    readinessAlerts.ready();
    res.json({ ok: true });
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
  app.use("/api", apiRouter(runtimeDeps, pipelineFactories));

  // Built UI assets (present after `npm run build`); harmless if absent.
  app.use("/ui", express.static(resolve("dist/ui")));

  // Terminal error handler: async route rejections (e.g. a store write that
  // throws SQLITE_BUSY mid-turn) are routed here by the route asyncHandler.
  // Without it Express 4 leaves the request hanging AND the rejection becomes a
  // fatal unhandledRejection — one bad turn would take down every session. We
  // log a BOUNDED CLASSIFICATION and return a calm response so the server stays
  // up. If an NDJSON stream already started, emit a terminal error line instead
  // of trying to set a status on sent headers.
  //
  // D5: this used to log `err.message`, described as "no secrets — the error
  // message only". That was false, and the very next comment said so. The
  // request body reaches this handler THROUGH the message: body-parser's
  // `entity.parse.failed` wraps V8's JSON.parse text, which quotes the
  // offending bytes verbatim (`Unexpected token 'd', "delete eve"...`), and a
  // ZodError message echoes rejected values and submitted key names. Both
  // sinks — this log and the response body below — now carry the same thing:
  // the classification and the status, never the message.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // Read the status BEFORE logging: a 400 and a 413 are the two cases an
    // operator most needs to tell apart here, and both live only on the error.
    const status = (err as { status?: unknown; statusCode?: unknown })?.status ?? (err as { statusCode?: unknown })?.statusCode;
    console.error(
      `request error: ${classifyLoggableError(err)} status=${typeof status === "number" ? status : "none"}`,
    );
    // D3 alert 4: the prose line above is not alertable — a SQLITE_BUSY, a 413,
    // and any other route rejection all produce the identical prefix. Classify
    // the storage failures the runbook names and emit the CLASSIFICATION beside
    // it, so an operator can alert on a locked/full/read-only volume without
    // pattern-matching driver text.
    const sqliteFailure = classifySqliteFailure(err);
    if (sqliteFailure) logSqliteUnavailable({ kind: sqliteFailure, site: "request" });
    if (res.headersSent) {
      finishNdjsonWithServerError(res);
      return;
    }
    // Body-parser client errors (oversized payload → 413, malformed JSON → 400)
    // carry their own 4xx status — honor it so the caller learns it was a client
    // mistake, not a server fault. A bare server error (e.g. a SQLITE_BUSY thrown
    // mid-turn, no .status) stays a calm 500. Never echo err.message (it carries
    // request data, as above); the status is enough.
    if (typeof status === "number" && status >= 400 && status < 500) {
      res.status(status).json({ ok: false, code: "invalid_request", message: "The request was rejected (too large or malformed)." });
      return;
    }
    res.status(500).json({ ok: false, code: "server_error", message: "Something went wrong on our side. Please try again." });
  });

  return app;
}

export interface LiveClockifyFactoryDeps {
  commitTimeoutMs?: number;
  requestGovernorFor: (workspaceId: string) => WorkspaceRequestGovernor;
  /**
   * REQUIRED, both of them. These carry the ONLY production wiring for two
   * documented alerts (`DEPLOYMENT.md` rows 6 and 9), and `start()` is not
   * reachable from a test, so an optional monitor could be dropped at the call
   * site with a green suite — an alert that can never fire. The type refuses
   * that instead, and the composition below is covered by injecting
   * `createClient`.
   */
  tokenRejectionMonitor: TokenRejectionMonitor;
  hostThrottleMonitor: HostThrottleMonitor;
  /** Injectable adapter constructor so the wiring is testable without a host. */
  createClient?: (options: RestWorkspaceOptions) => WorkspaceClient;
}

/**
 * Default production Clockify client factory: the REST adapter over the
 * WorkspaceClient port, authenticated with the installation's add-on token
 * (X-Addon-Token). The base URL is resolved from the install context
 * (apiUrl/backendUrl + /v1) so dev and regional environments work — see
 * resolveClockifyApiBase. No token is logged.
 */
export function createLiveClockifyFactory(
  deps: LiveClockifyFactoryDeps,
): (installation: Installation, options?: { signal?: AbortSignal }) => WorkspaceClient {
  const createClient = deps.createClient ?? createRestWorkspaceClient;
  return (installation, options) => createClient({
    baseUrl: resolveClockifyApiBase(installation),
    reportsBase: resolveClockifyReportsBase(installation),
    auditBase: resolveClockifyAuditBase(installation),
    workspaceId: installation.workspaceId,
    auth: { addonToken: installation.addonToken },
    commitTimeoutMs: deps.commitTimeoutMs,
    requestGovernor: deps.requestGovernorFor(installation.workspaceId),
    ...(options?.signal ? { signal: options.signal } : {}),
    onAuthRejected: () => deps.tokenRejectionMonitor.rejected(installation.workspaceId),
    onAuthAccepted: () => deps.tokenRejectionMonitor.accepted(installation.workspaceId),
    onHostThrottled: (status: number) => deps.hostThrottleMonitor.throttled(installation.workspaceId, status),
    onHostHealthy: () => deps.hostThrottleMonitor.healthy(installation.workspaceId),
  });
}

/** Operational-table retention sweep cadence (see Store.pruneExpired). */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export interface RetentionPruneLoopDeps {
  store: Pick<Store, "pruneExpired">;
  /**
   * REQUIRED for the same reason as the client factory's monitors: this is the
   * only production wiring for `DEPLOYMENT.md` alert row 3, and `start()` is
   * not reachable from a test, so an optional monitor could be silently dropped.
   */
  alerts: RetentionAlertMonitor;
  /** The informational sweep record. Injectable so a test can read it. */
  log?: (line: string) => void;
  /** Injectable so a test drives the backlog continuation deterministically. */
  scheduleContinuation?: (run: () => void) => void;
}

/**
 * Retention: prune expired operational rows + chat transcripts/audit log past
 * the retention window at startup (catches backlog after long-idle deploys) and
 * hourly. chat_messages/audit_events age out on RETENTION_DAYS (default 90).
 *
 * D3 alert 3: the sweep logged a line per failure with no counter anywhere, so
 * nothing distinguished one transient lock from a sweep that had not completed
 * in a day, and a backlog was only ever a field inside a prose line. Extracted
 * from `start()` so that wiring is provable — inside `start()` it was not.
 */
export function createRetentionPruneLoop(deps: RetentionPruneLoopDeps): () => Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const schedule = deps.scheduleContinuation ?? ((run: () => void) => { setImmediate(run); });
  let pruning = false;
  const prune = async (): Promise<void> => {
    if (pruning) return;
    pruning = true;
    let continueBacklog = false;
    try {
      const counts = await deps.store.pruneExpired(new Date().toISOString());
      continueBacklog = counts.backlog;
      deps.alerts.swept({ backlog: counts.backlog, batches: counts.batches });
      if (counts.total > 0 || counts.backlog) {
        log(
          `retention prune: total=${counts.total} deleted=${counts.deletedTotal} expired=${counts.expiredTotal} batches=${counts.batches} durationMs=${counts.durationMs} backlog=${counts.backlog} confirmationsDeleted=${counts.pendingConfirmations} confirmationsExpired=${counts.expiredConfirmations} idempotency=${counts.idempotencyKeys} undoDeleted=${counts.undoRecords} undoExpired=${counts.expiredUndoRecords} telemetry=${counts.turnTelemetry} chat=${counts.chatMessages} audit=${counts.auditEvents} operations=${counts.operationRuns} results=${counts.actionResults} artifacts=${counts.artifacts} sessions=${counts.chatSessions} walBusy=${counts.walCheckpoint.busy} walLog=${counts.walCheckpoint.log} walCheckpointed=${counts.walCheckpoint.checkpointed}`,
        );
      }
    } catch (error) {
      deps.alerts.failed();
      // D5: the sweep runs raw SQL over chat/audit/operation tables, so a
      // driver message here is exactly the class of text that can quote schema
      // and row context. The counted alert above is the operator signal; this
      // line only says which KIND of failure produced it.
      console.warn(`retention prune failed: ${classifyLoggableError(error)}`);
    } finally {
      pruning = false;
      if (continueBacklog) schedule(() => { void prune(); });
    }
  };
  return prune;
}

export interface OperatorHealthSnapshotLoopDeps {
  store: Pick<Store, "operatorHealthCounts">;
  /**
   * REQUIRED for the same reason as the prune loop's monitor: this loop exists
   * only to feed the emitter, `start()` is not reachable from a test, and an
   * optional field could be dropped at the call site with a green suite —
   * leaving a heartbeat that never beats and reads as a dead process.
   */
  snapshot: OperatorHealthSnapshotEmitter;
  /** Injectable so a test drives the window without waiting on a real clock. */
  now?: () => Date;
  windowMs?: number;
}

/**
 * D4 alert 10: one fleet-wide health line per interval. Extracted from
 * `start()` for the same reason the prune loop was — inside `start()` the
 * wiring is unprovable.
 *
 * The whole body is guarded. This runs from a bare `setInterval`, and `start()`
 * installs `process.once("uncaughtException", …)` → shutdown(1), so a
 * `SQLITE_BUSY` during a snapshot query — or a snapshot racing `store.close()`
 * during teardown — would take the container down. An observability feature
 * must never be able to cause the outage it is there to report, so a failed
 * read degrades to one fixed line carrying no error detail.
 */
export function createOperatorHealthSnapshotLoop(deps: OperatorHealthSnapshotLoopDeps): () => void {
  const now = deps.now ?? ((): Date => new Date());
  const windowMs = deps.windowMs ?? OPERATOR_HEALTH_SNAPSHOT_INTERVAL_MS;
  return () => {
    try {
      const since = new Date(now().getTime() - windowMs).toISOString();
      deps.snapshot.emit({ windowMs, counts: deps.store.operatorHealthCounts({ since }) });
    } catch {
      deps.snapshot.unavailable();
    }
  };
}

/** Drain budget before force-exit — Railway SIGKILLs shortly after SIGTERM. */
const FORCE_EXIT_AFTER_MS = 10_000;
const RESTORE_PROBE_CHILD_ARG = "--restore-readiness-probe-child";
const RESTORE_PROBE_HOST = "127.0.0.1";

export interface ShutdownDeps {
  server: { close(cb: (err?: Error) => void): void; closeIdleConnections?: () => void };
  store: { close(): void };
  /** Cleared first so the retention sweep can't fire mid-teardown. */
  pruneTimer?: NodeJS.Timeout;
  /** Same: a snapshot read must not race the store close (D4). */
  snapshotTimer?: NodeJS.Timeout;
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
    if (deps.snapshotTimer) clearInterval(deps.snapshotTimer);
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
  // F24: a `new_unused` boundary claim is PROVEN before the database opens —
  // a nonempty unmarked file (e.g. the retained v1 database) refuses to boot.
  const freshBoundary = assertFreshDatabaseBoundary(
    config.databasePath,
    config.databasePathDisposition,
  );
  const store = createStore(config.databasePath, {
    encryptionKey: config.dataEncryptionKey,
    previousEncryptionKey: config.dataEncryptionKeyPrevious,
    retentionDays: config.retentionDays,
  });
  if (freshBoundary.firstBoot) {
    writeFreshCutoverMarker(config.databasePath, {
      ...(config.releaseSha ? { releaseSha: config.releaseSha } : {}),
      createdAt: new Date().toISOString(),
    });
  }
  const parser = createSignatureParser(config.clockifyAddonKey, config.clockifyAddonPublicKeyPem);
  const modelClient = selectModelClient(config);

  const readiness = { ready: true };
  // F15: repeated authenticated 401s mark the installation `suspect` in the
  // operator log (aliased); authority is never changed from a wire signal.
  const tokenRejectionMonitor = createTokenRejectionMonitor({
    aliasFor: (workspaceId) => logAlias(config.sessionSecret, "workspace", workspaceId),
  });
  // D3 alert 6: a sustained run of Clockify 429/5xx answers is an operator
  // signal, not a per-request one — the streak resets on the first healthy
  // response, so only a real storm alerts.
  const hostThrottleMonitor = createHostThrottleMonitor({
    aliasFor: (workspaceId) => logAlias(config.sessionSecret, "workspace", workspaceId),
  });
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
  const clockifyForWorkspace = createLiveClockifyFactory({
    commitTimeoutMs: config.commitTimeoutMs,
    requestGovernorFor,
    tokenRejectionMonitor,
    hostThrottleMonitor,
  });
  try {
    await runProductionStartupReconciliation({
      store,
      clockifyForWorkspace: (installation) => clockifyForWorkspace(installation),
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
    apiOperationIndex: buildApiOperationIndex(MODEL_API_ACTION_CATALOG),
    clockifyForWorkspace,
    readiness: { isReady: () => readiness.ready },
    ...(releaseArtifactIdentity ? { releaseArtifactIdentity } : {}),
  });

  const prune = createRetentionPruneLoop({ store, alerts: createRetentionAlertMonitor() });
  const pruneTimer = setInterval(() => { void prune(); }, PRUNE_INTERVAL_MS);
  pruneTimer.unref();

  const healthSnapshot = createOperatorHealthSnapshotLoop({
    store,
    snapshot: createOperatorHealthSnapshotEmitter(),
  });
  const snapshotTimer = setInterval(healthSnapshot, OPERATOR_HEALTH_SNAPSHOT_INTERVAL_MS);
  snapshotTimer.unref();

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
    // One baseline snapshot at boot rather than a quarter hour of silence:
    // startup recovery has just settled crash-orphaned steps, so this is the
    // line that reports how much ambiguity the restart left behind.
    healthSnapshot();
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
    snapshotTimer,
    onDraining: () => {
      readiness.ready = false;
    },
  });
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
  // Both crash handlers receive a value from an ARBITRARY call site — including
  // a rejected Clockify request, whose message embeds the workspace-scoped path
  // and up to 200 bytes of host response body (`clockify/rest/core.ts`). The
  // classification is what the runbook alerts on; the stack is not recoverable
  // from either form, so nothing operable is lost by refusing the message.
  process.once("unhandledRejection", (reason) => {
    console.error(`unhandledRejection: ${classifyLoggableError(reason)}`);
    shutdown("unhandledRejection", 1);
  });
  process.once("uncaughtException", (error) => {
    console.error(`uncaughtException: ${classifyLoggableError(error)}`);
    shutdown("uncaughtException", 1);
  });
}

// Run only when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void start().catch((error: unknown) => {
    // Uniform with every other sink, but NOT at the cost of the boot
    // diagnostic. Measured against the real schema (zod 3.25): a missing or
    // too-short variable reports only `path` and a bound, while an
    // `invalid_enum_value` issue echoes the rejected value verbatim — and this
    // schema reads `SESSION_SECRET`, `DATA_ENCRYPTION_KEY` and `LLM_API_KEY`
    // out of the same object. So the message stays refused, and `config.ts`
    // instead publishes the issue PATHS on the declared-safe channel: this
    // line reads `startup failed: name=ZodError issues=SESSION_SECRET`, which
    // names the variable without quoting one byte of its value.
    console.error(`startup failed: ${classifyLoggableError(error)}`);
    process.exitCode = 1;
  });
}
