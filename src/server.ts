import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import express, { type Express } from "express";
import { buildAddon } from "./addon/manifest.js";
import { createSignatureParser } from "./addon/verify.js";
import { loadConfig } from "./config.js";
import { createStore, type Installation } from "./db/store.js";
import type { WorkspaceClient } from "./clockify/client.js";
import { createRestWorkspaceClient } from "./clockify/rest-workspace.js";
import { createModelClient } from "./assistant/model-client.js";
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
  app.use(express.json());

  app.get("/manifest", (_req, res) => {
    res.json(buildAddon(deps.config.baseUrl).getManifest());
  });

  app.use(lifecycleRouter(deps));
  app.use(componentRouter(deps));
  app.use("/api", apiRouter(deps));

  // Built UI assets (present after `npm run build`); harmless if absent.
  app.use("/ui", express.static(resolve("dist/ui")));

  return app;
}

/**
 * Default production Clockify client: the REST adapter over the WorkspaceClient
 * port, authenticated with the installation's add-on token (X-Addon-Token). The
 * base URL comes from the installation's verified backendUrl claim (falling back
 * to the public API host) plus the /api/v1 prefix. No token is logged.
 */
function liveClockifyForWorkspace(installation: Installation): WorkspaceClient {
  const root = (installation.backendUrl ?? "https://api.clockify.me").replace(/\/$/, "");
  const baseUrl = root.endsWith("/api/v1") ? root : `${root}/api/v1`;
  return createRestWorkspaceClient({
    baseUrl,
    workspaceId: installation.workspaceId,
    auth: { addonToken: installation.addonToken },
  });
}

export function start(): void {
  const config = loadConfig();
  const store = createStore(config.databasePath, { encryptionKey: config.dataEncryptionKey });
  const parser = createSignatureParser(config.clockifyAddonKey, config.clockifyAddonPublicKeyPem);
  const modelClient = createModelClient({
    baseUrl: config.llmBaseUrl,
    apiKey: config.llmApiKey,
    model: config.llmModel,
  });

  const app = createApp({
    config,
    store,
    parser,
    modelClient,
    clockifyForWorkspace: liveClockifyForWorkspace,
  });

  app.listen(config.port, () => {
    // Intentionally minimal, non-secret startup log.
    console.log(`AI Assistant add-on listening on port ${config.port}`);
  });
}

// Run only when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start();
}
