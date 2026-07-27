import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/server.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import { computeRequestHash } from "../../src/assistant-v2/state.js";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import { DISCOVERY_META_TOOL_NAME } from "../../src/harness/api-operation.js";
import { RUN_EVENT_METRICS_LIMIT } from "../../src/services/metrics-service.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";
import { makeTestConfig } from "../helpers/config.js";
import { testKeys } from "../helpers/test-keys.js";
import { mintAdminCookie } from "../helpers/session.js";
import type { ModelClient } from "../../src/assistant/model-client.js";

/**
 * T17-E: the v2 run-metrics block reaches `GET /api/metrics` as an ADDITIVE
 * field, scoped to the caller's own workspace+admin, carrying aggregates only.
 * The route stays transport-only (pinned separately by `v2-layer-boundaries`).
 */

const ADDON_KEY = "ai-assistant";
const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

const modelClient: ModelClient = { async complete() { return "{}"; } };

async function makeApp(): Promise<{ app: Express; store: Store; cookie: string }> {
  const keys = await testKeys();
  const config = makeTestConfig({ clockifyAddonPublicKeyPem: keys.pem, clockifyAddonKey: ADDON_KEY });
  const store = createStore(":memory:", { encryptionKey: "test-key" });
  stores.push(store);
  store.saveInstallation({ workspaceId: "ws-1", addonId: "addon-1", addonUserId: "addon-user-1", addonToken: "addon-token" });
  const app = createApp({
    config,
    store,
    parser: createSignatureParser(ADDON_KEY, keys.pem),
    modelClient,
    clockifyForWorkspace: () => createFakeWorkspace({ tags: [] }).client,
  });
  return { app, store, cookie: mintAdminCookie(store, config.sessionSecret) };
}

/** Journal a real v2 run through the store's own named transitions. */
function seedRun(
  store: Store,
  input: { sessionId: string; runId: string; workspaceId?: string; adminUserId?: string },
): void {
  const scope = {
    sessionId: input.sessionId,
    runId: input.runId,
    workspaceId: input.workspaceId ?? "ws-1",
    adminUserId: input.adminUserId ?? "admin-1",
    installationGeneration: 1,
    authClass: "addon" as const,
  };
  store.startRunWithTurn({
    scope,
    originalRequest: "list projects",
    requestHash: computeRequestHash("list projects"),
    catalogHash: MODEL_API_ACTION_CATALOG.hash(),
    loadedToolNames: [DISCOVERY_META_TOOL_NAME],
    intentHash: input.runId,
  });
  const state = () => store.getRun(scope)!;
  store.reserveModelCallWithEvent(scope, state(), {
    modelCall: 1,
    providerAttempt: 1,
    loadedOperationIds: [],
    cacheSeeded: false,
  });
  store.completeModelCallWithEvent(scope, state(), {
    modelCall: 1,
    providerAttempts: 1,
    usage: { promptTokens: 120, completionTokens: 30 },
    latencyMs: 250,
  });
  store.reserveDiscoveryCallWithEvent(scope, state(), { searchIndex: 1, access: "read", groups: [] });
  store.loadOperationsWithEvent(scope, state(), {
    operationIds: ["clockify_projects_list", "clockify_tags_list"],
    source: "discovery",
  });
  store.denyToolWithEvent(scope, state(), {
    toolCallId: "tc-1",
    actionName: "clockify_tags_create",
    code: "policy_denied",
  });
  store.completeRunWithEvent(scope, state(), { actionResultIds: [] });
}

describe("T17-E: GET /api/metrics carries the additive v2 run block", () => {
  it("reports real aggregates from the journaled run", async () => {
    const { app, store, cookie } = await makeApp();
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    seedRun(store, { sessionId: session.id, runId: "11111111-1111-4111-8111-111111111111" });

    const res = await request(app).get("/api/metrics").set("Cookie", cookie);
    expect(res.status).toBe(200);
    const runs = res.body.metrics.runs;
    expect(runs.runs).toBe(1);
    expect(runs.sessions).toBe(1);
    expect(runs.modelCalls).toBe(1);
    expect(runs.providerAttempts).toBe(1);
    expect(runs.incompleteModelCalls).toBe(0);
    expect(runs.searches).toBe(1);
    expect(runs.refinements).toBe(0);
    expect(runs.loadedTools).toBe(2);
    expect(runs.maxLoadedTools).toBe(2);
    expect(runs.validationFailures).toBe(1);
    expect(runs.validationFailuresByCode).toEqual({ policy_denied: 1 });
    expect(runs.runsCompleted).toBe(1);
    expect(runs.runsFailed).toBe(0);
    expect(runs.completionRatio).toBe(1);
    expect(runs.abandonedRuns).toBe(0);
    expect(runs.latencyMs).toEqual({ p50: 250, p95: 250, max: 250 });
    expect(runs.tokens).toEqual({ prompt: 120, completion: 30 });
    expect(runs.anomalies).toEqual([]);
  });

  it("keeps the v1 metrics fields untouched alongside the new block", async () => {
    const { app, cookie } = await makeApp();
    const res = await request(app).get("/api/metrics").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.metrics).toHaveProperty("usage");
    expect(res.body.metrics).toHaveProperty("runs");
    expect(res.body.metrics.runs.runs).toBe(0);
  });

  it("never leaks request text, arguments, entity names, or identifiers", async () => {
    const { app, store, cookie } = await makeApp();
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    const runId = "22222222-2222-4222-8222-222222222222";
    seedRun(store, { sessionId: session.id, runId });

    const res = await request(app).get("/api/metrics").set("Cookie", cookie);
    const serialized = JSON.stringify(res.body.metrics.runs);
    expect(serialized).not.toContain("list projects");
    expect(serialized).not.toContain(runId);
    expect(serialized).not.toContain(session.id);
    // Only the aggregate counts survive — no action names outside the denial-code map.
    expect(serialized).not.toContain("clockify_projects_list");
    expect(serialized).not.toContain("clockify_tags_create");
  });

  it("scopes to the caller: another admin's runs are invisible", async () => {
    const { app, store, cookie } = await makeApp();
    const mine = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    const theirs = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-2" });
    seedRun(store, { sessionId: mine.id, runId: "33333333-3333-4333-8333-333333333333" });
    seedRun(store, {
      sessionId: theirs.id,
      runId: "44444444-4444-4444-8444-444444444444",
      adminUserId: "admin-2",
    });

    const res = await request(app).get("/api/metrics").set("Cookie", cookie);
    expect(res.status).toBe(200);
    // Two runs exist; only the caller's own is aggregated.
    expect(res.body.metrics.runs.runs).toBe(1);
    expect(res.body.metrics.runs.sessions).toBe(1);
  });

  it("requires a session", async () => {
    const { app } = await makeApp();
    const res = await request(app).get("/api/metrics");
    expect(res.status).toBe(401);
  });

  it("bounds one metrics read", () => {
    expect(RUN_EVENT_METRICS_LIMIT).toBe(10_000);
  });
});
