import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { testing } from "@apet97/clockify-addon-sdk";
import { createApp } from "../../../src/server.js";
import { createStore } from "../../../src/db/store.js";
import { createSignatureParser } from "../../../src/addon/verify.js";
import { defaultAdminPolicy } from "../../../src/harness/permissions.js";
import type {
  ModelClient,
  ModelMessage,
  ToolCompletion,
  ToolDefinition,
} from "../../../src/assistant/model-client.js";
import type { AppConfig } from "../../../src/config.js";
import type { WorkspaceClient } from "../../../src/clockify/client.js";
import {
  createFakeWorkspace,
  FAKE_MUTATION_METHOD_PATTERN,
  type FakeWorkspace,
} from "../../helpers/fake-clockify.js";
import { SCENARIOS } from "./scenarios.js";

/**
 * Closure-plan PR 12 (F05): the REAL-server browser mode. This process is the
 * production composition compiled by tsc (tsconfig.e2e-real.json) — the real
 * `createApp` with every router/pipeline, a real temp-file SQLite store with
 * real migrations, the real component auth flow over signed add-on JWTs, and
 * the BUILT `dist/ui` bundle served to the browser. Exactly the two production
 * injection seams are substituted: the model client (ordered scripted
 * completions per scenario) and the Clockify port (the shared fake workspace).
 * No response frame is hand-authored anywhere.
 *
 * A small control plane (mounted OUTSIDE the product app, `/e2e/*`) lets the
 * Playwright specs select a scenario, mint component URLs through the real
 * signed-JWT entry, advance the shared clock (expiry journeys), and read the
 * provider/host/mutation counters for zero-mutation assertions.
 */
const PORT = Number(process.env.E2E_REAL_PORT ?? 4175);
const ADDON_KEY = "ai-assistant";
const WORKSPACE_ID = "64ad1305c701cc5be7c26fe4";
const ADMIN_USER_ID = "admin-user-1";

interface ScriptedModel extends ModelClient {
  completeWithTools: NonNullable<ModelClient["completeWithTools"]>;
  calls: () => number;
}

function scriptedModel(completions: ToolCompletion[]): ScriptedModel {
  let index = 0;
  let calls = 0;
  return {
    complete: async () => "{}",
    completeWithTools: async (_messages: ModelMessage[], _tools: ToolDefinition[]) => {
      calls += 1;
      const completion = completions[Math.min(index, completions.length - 1)]!;
      index += 1;
      return completion;
    },
    calls: () => calls,
  };
}

async function main(): Promise<void> {
  const keys = await testing.generateTestKeys();

  // Monotonic offset clock: journeys only ever advance time (expiry), and the
  // signed-JWT auth path validates against the real wall clock, so the shared
  // app/store clock is real time plus the accumulated offset.
  let clockOffsetMs = 0;
  const now = (): Date => new Date(Date.now() + clockOffsetMs);

  const tempDir = mkdtempSync(join(tmpdir(), "e2e-real-"));
  // Real HTTPS with a throwaway self-signed cert: production serves the iframe
  // over HTTPS, /api/me links must be HTTPS (a pinned UI invariant), and the
  // session cookie is Secure + SameSite=None + Partitioned — all three browser
  // engines accept that only over TLS. Playwright trusts the cert via
  // `ignoreHTTPSErrors`.
  const keyPath = join(tempDir, "key.pem");
  const certPath = join(tempDir, "cert.pem");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-keyout", keyPath, "-out", certPath,
    "-days", "2", "-nodes", "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1",
  ], { stdio: "ignore" });
  const store = createStore(join(tempDir, "db.sqlite"), {
    encryptionKey: "e2e-real-encryption-key",
    now,
  });
  store.saveInstallation({
    workspaceId: WORKSPACE_ID,
    addonId: "addon-e2e",
    addonUserId: "addon-user-e2e",
    addonToken: "addon-token-e2e",
  });
  store.upsertAdminPolicy(WORKSPACE_ID, ADMIN_USER_ID, defaultAdminPolicy());

  let workspace: FakeWorkspace = createFakeWorkspace(SCENARIOS["read-grounded"]!.seed);
  let activeModel: ScriptedModel = scriptedModel(SCENARIOS["read-grounded"]!.script);
  let pendingFailures: Array<{ method: string; message: string }> = [];

  // One-shot host-failure injection over the CURRENT fake workspace client.
  const clientProxy = new Proxy({} as WorkspaceClient, {
    get(_target, property: string) {
      const value = (workspace.client as unknown as Record<string, unknown>)[property];
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const failureIndex = pendingFailures.findIndex((f) => f.method === property);
        if (failureIndex !== -1) {
          const [failure] = pendingFailures.splice(failureIndex, 1);
          throw new Error(failure!.message);
        }
        return (value as (...callArgs: unknown[]) => unknown).apply(workspace.client, args);
      };
    },
  });

  const modelDelegate: ModelClient = {
    complete: (...args: Parameters<ModelClient["complete"]>) => activeModel.complete(...args),
    completeWithTools: (messages, tools) => activeModel.completeWithTools(messages, tools),
  };

  const config: AppConfig = {
    nodeEnv: "test",
    port: PORT,
    baseUrl: `https://127.0.0.1:${PORT}`,
    clockifyAddonPublicKeyPem: keys.pem,
    clockifyAddonKey: ADDON_KEY,
    sessionSecret: "e2e-real-session-secret-with-length",
    sessionTtlMs: 2 * 60 * 60 * 1000,
    databasePath: join(tempDir, "db.sqlite"),
    llmProvider: "http",
    assistantEngine: "v2",
    llmMode: "tool",
    llmAgentic: true,
    llmToolSelect: true,
    llmBaseUrl: "https://model.invalid",
    llmApiKey: "unused-scripted",
    llmModel: "scripted",
  } as AppConfig;

  const app = createApp({
    config,
    store,
    parser: createSignatureParser(ADDON_KEY, keys.pem),
    modelClient: modelDelegate,
    clockifyForWorkspace: () => clientProxy,
    now,
  });

  const outer = express();
  // Body parsing scoped to the control plane only — the product app owns its own.
  outer.use("/e2e", express.json({ limit: "256kb" }));

  outer.get("/e2e/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  outer.post("/e2e/scenario", async (req, res) => {
    const name = String((req.body as { name?: unknown })?.name ?? "");
    const scenario = SCENARIOS[name];
    if (!scenario) {
      res.status(400).json({ ok: false, code: "unknown_scenario" });
      return;
    }
    workspace = createFakeWorkspace({
      ...scenario.seed,
      ...(scenario.memberRoles ? { memberRoles: scenario.memberRoles } : {}),
    });
    activeModel = scriptedModel(scenario.script);
    pendingFailures = [...(scenario.failures ?? [])];

    const adminToken = await testing.signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: WORKSPACE_ID,
      user: ADMIN_USER_ID,
      workspaceRole: "ADMIN",
    });
    const memberToken = await testing.signTestToken(keys.privateKey, ADDON_KEY, {
      workspaceId: WORKSPACE_ID,
      user: "member-user-1",
      workspaceRole: "USER",
    });
    res.json({
      ok: true,
      componentUrl: `/component/assistant?auth_token=${encodeURIComponent(adminToken)}`,
      memberComponentUrl: `/component/assistant?auth_token=${encodeURIComponent(memberToken)}`,
      workspaceId: WORKSPACE_ID,
      adminUserId: ADMIN_USER_ID,
    });
  });

  outer.get("/e2e/state", (_req, res) => {
    res.json({
      ok: true,
      providerCalls: activeModel.calls(),
      clockifyCalls: Object.values(workspace.counts).reduce((total, count) => total + count, 0),
      clockifyMutations: Object.entries(workspace.counts)
        .filter(([method]) => FAKE_MUTATION_METHOD_PATTERN.test(method))
        .reduce((total, [, count]) => total + count, 0),
    });
  });

  outer.post("/e2e/clock", (req, res) => {
    const advanceMs = Number((req.body as { advanceMs?: unknown })?.advanceMs);
    if (!Number.isSafeInteger(advanceMs) || advanceMs < 0) {
      res.status(400).json({ ok: false, code: "invalid_advance" });
      return;
    }
    clockOffsetMs += advanceMs;
    res.json({ ok: true, now: now().toISOString() });
  });

  outer.use(app);

  const server = createHttpsServer(
    { key: readFileSync(keyPath), cert: readFileSync(certPath) },
    outer,
  ).listen(PORT, "127.0.0.1", () => {
    console.log(`[e2e-real] listening on https://127.0.0.1:${PORT}`);
  });

  const shutdown = (): void => {
    server.close(() => {
      try {
        store.close();
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error: unknown) => {
  console.error("[e2e-real] failed to start", error);
  process.exit(1);
});
