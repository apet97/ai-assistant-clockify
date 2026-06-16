import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import express, { type Express } from "express";
import { buildAddon, ADDON_ICON_SVG, ICON_PATH } from "./addon/manifest.js";
import { createSignatureParser } from "./addon/verify.js";
import { loadConfig } from "./config.js";
import { createStore, type Installation } from "./db/store.js";
import type { WorkspaceClient } from "./clockify/client.js";
import { createRestWorkspaceClient } from "./clockify/rest-workspace.js";
import {
  resolveClockifyApiBase,
  resolveClockifyAuditBase,
  resolveClockifyReportsBase,
} from "./clockify/api-base.js";
import { selectModelClient } from "./assistant/select-model-client.js";
import { apiRouter } from "./routes/api.js";
import { componentRouter } from "./routes/component.js";
import { lifecycleRouter } from "./routes/lifecycle.js";
import type { AppDeps } from "./routes/deps.js";

/**
 * Compose the Express app from injected dependencies (server-as-a-function, so
 * tests drive it via Supertest with fakes). server.start() builds the real
 * dependencies from config and listens.
 */
export function createApp(deps: AppDeps): Express {
  const app = express();
  // Cap the request body: a hostile multi-MB JSON payload must never be parsed
  // into memory or persisted. Oversized bodies are rejected by body-parser before
  // any route runs (it raises a 413 PayloadTooLargeError, mapped below). The chat
  // message/nonce field caps (routes/api.ts) are the second, finer layer.
  app.use(express.json({ limit: "32kb" }));

  app.get("/manifest", (_req, res) => {
    res.json(buildAddon(deps.config.baseUrl).getManifest());
  });

  // Readiness probe (the platform healthcheck). Unlike the static /manifest, this
  // touches the DB handle, so a hung/locked SQLite instance reports 503 and gets
  // rotated out instead of silently failing live traffic. Public, no auth, no secrets.
  app.get("/health", (_req, res) => {
    try {
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

  app.use(lifecycleRouter(deps));
  app.use(componentRouter(deps));
  app.use("/api", apiRouter(deps));

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
      try {
        res.write(`${JSON.stringify({ type: "error", code: "server_error", message: "Something went wrong." })}\n`);
      } catch {
        // Socket may already be torn down — nothing more to do.
      }
      try {
        res.end();
      } catch {
        // Same — best-effort terminal flush.
      }
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
function liveClockifyForWorkspace(installation: Installation, commitTimeoutMs?: number): WorkspaceClient {
  return createRestWorkspaceClient({
    baseUrl: resolveClockifyApiBase(installation),
    reportsBase: resolveClockifyReportsBase(installation),
    auditBase: resolveClockifyAuditBase(installation),
    workspaceId: installation.workspaceId,
    auth: { addonToken: installation.addonToken },
    commitTimeoutMs,
  });
}

/** Operational-table retention sweep cadence (see Store.pruneExpired). */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/** Drain budget before force-exit — Railway SIGKILLs shortly after SIGTERM. */
const FORCE_EXIT_AFTER_MS = 10_000;

export interface ShutdownDeps {
  server: { close(cb: (err?: Error) => void): void; closeIdleConnections?: () => void };
  store: { close(): void };
  /** Cleared first so the retention sweep can't fire mid-teardown. */
  pruneTimer?: NodeJS.Timeout;
  exit?: (code: number) => void;
  forceExitAfterMs?: number;
  log?: (message: string) => void;
}

/**
 * Graceful SIGTERM/SIGINT teardown: stop the prune loop, drop keep-alive
 * sockets, drain in-flight requests, close the store, exit 0. A hung drain
 * (e.g. an in-flight 120s model call) force-exits 1 before Railway's SIGKILL —
 * WAL keeps the DB crash-safe either way. Idempotent: the second signal is a
 * no-op while the first teardown runs.
 */
export function createShutdownHandler(deps: ShutdownDeps): (signal: string) => void {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const log = deps.log ?? ((message: string) => console.log(message));
  let shuttingDown = false;
  return (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} received — draining`);
    if (deps.pruneTimer) clearInterval(deps.pruneTimer);
    // Close the store then exit. The store close may throw if the drain still
    // holds a statement open — exit regardless (so a throw never hangs teardown).
    const finish = (code: number): void => {
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
    deps.server.close(() => {
      // clearTimeout BEFORE finish: the force timer must be dead before the store
      // close runs, so a throw there can't be raced by a force-exit (and finish
      // never double-exits).
      clearTimeout(force);
      finish(0);
    });
  };
}

export function start(): void {
  // Last-resort process net: the route asyncHandler + terminal error middleware
  // catch route-scoped rejections, but a stray floating promise anywhere (e.g. a
  // best-effort telemetry write) must not crash the whole server and drop every
  // in-flight turn. Log and keep serving; a truly wedged process is restarted by
  // the platform health check. Never log secrets — the reason/message only.
  process.on("unhandledRejection", (reason) => {
    console.error("unhandledRejection:", reason instanceof Error ? reason.message : String(reason));
  });
  process.on("uncaughtException", (error) => {
    console.error("uncaughtException:", error instanceof Error ? error.message : String(error));
  });

  const config = loadConfig();
  const store = createStore(config.databasePath, {
    encryptionKey: config.dataEncryptionKey,
    retentionDays: config.retentionDays,
  });
  const parser = createSignatureParser(config.clockifyAddonKey, config.clockifyAddonPublicKeyPem);
  const modelClient = selectModelClient(config);

  const app = createApp({
    config,
    store,
    parser,
    modelClient,
    clockifyForWorkspace: (installation) => liveClockifyForWorkspace(installation, config.commitTimeoutMs),
  });

  // Retention: prune expired operational rows + chat transcripts/audit log past
  // the retention window at startup (catches backlog after long-idle deploys) and
  // hourly. chat_messages/audit_events age out on RETENTION_DAYS (default 90).
  const prune = (): void => {
    try {
      const counts = store.pruneExpired(new Date().toISOString());
      const total =
        counts.pendingConfirmations +
        counts.idempotencyKeys +
        counts.undoRecords +
        counts.turnTelemetry +
        counts.chatMessages +
        counts.auditEvents;
      if (total > 0) {
        console.log(
          `retention prune: confirmations=${counts.pendingConfirmations} idempotency=${counts.idempotencyKeys} undo=${counts.undoRecords} telemetry=${counts.turnTelemetry} chat=${counts.chatMessages} audit=${counts.auditEvents}`,
        );
      }
    } catch (error) {
      console.warn("retention prune failed:", error instanceof Error ? error.message : String(error));
    }
  };
  const pruneTimer = setInterval(prune, PRUNE_INTERVAL_MS);
  pruneTimer.unref();

  const server = app.listen(config.port, () => {
    // Intentionally minimal, non-secret startup log.
    console.log(`AI Assistant add-on listening on port ${config.port}`);
    // Run the at-startup backlog sweep AFTER listen so readiness isn't gated by
    // it — the prune now seeks narrow retention indexes, but on a long-lived
    // instance the first sweep should never delay accepting connections.
    prune();
  });

  // Railway redeploys SIGTERM the container — drain instead of dropping
  // in-flight turns, and close the store cleanly.
  const shutdown = createShutdownHandler({ server, store, pruneTimer });
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

// Run only when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
