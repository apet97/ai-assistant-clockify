import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/server.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import { computeRequestHash } from "../../src/assistant-v2/state.js";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import { DISCOVERY_META_TOOL_NAME } from "../../src/harness/api-operation.js";
import { createOperationPreparationService } from "../../src/services/operation-preparation-service.js";
import { createReadExecutionPort } from "../../src/assistant-v2/read-execution.js";
import { runAssistantV2 } from "../../src/assistant-v2/runner.js";
import { createRunEventService } from "../../src/services/run-event-service.js";
import { createRunEventViewService } from "../../src/services/run-event-view-service.js";
import { createClarificationService, type ClarificationServiceDeps } from "../../src/services/clarification-service.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";
import { makeTestConfig } from "../helpers/config.js";
import { testKeys } from "../helpers/test-keys.js";
import { mintAdminCookie } from "../helpers/session.js";
import type { ToolCompletion } from "../../src/assistant/model-client.js";
import { scriptedToolModel } from "../helpers/scripted-model.js";

const NOW = new Date("2026-07-26T00:00:00.000Z");
const stores: Store[] = [];
const directories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "v2-clarification-route-"));
  directories.push(directory);
  return join(directory, "db.sqlite");
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const SCOPE = {
  sessionId: "session-1",
  runId: "run-1",
  workspaceId: "ws-1",
  adminUserId: "admin-1",
  installationGeneration: 1,
  authClass: "addon" as const,
};

function seedRunAndClarification(
  store: Store,
  overrides: Partial<Parameters<Store["createPendingClarification"]>[0]> = {},
) {
  const session = store.createSession({ workspaceId: SCOPE.workspaceId, adminUserId: SCOPE.adminUserId });
  const scope = { ...SCOPE, sessionId: session.id };
  const originalRequest = "create the tag urgent";
  store.startRunWithTurn({
    scope,
    originalRequest,
    requestHash: computeRequestHash(originalRequest),
    catalogHash: MODEL_API_ACTION_CATALOG.hash(),
    loadedToolNames: [DISCOVERY_META_TOOL_NAME, "clockify_tags_create"],
    intentHash: scope.runId,
  });
  store.suspendRunWithEvent(scope, store.getRun(scope)!, { reason: "awaiting_clarification" });
  const clarification = store.createPendingClarification({
    sessionId: scope.sessionId,
    runId: scope.runId,
    workspaceId: scope.workspaceId,
    adminUserId: scope.adminUserId,
    originalToolName: "clockify_tags_create",
    partialArguments: {},
    missingField: "name",
    candidates: [
      { optionId: "opt-urgent", externalId: "urgent", label: "urgent" },
      { optionId: "opt-billable", externalId: "billable", label: "billable" },
    ],
    ...overrides,
  });
  return { session, scope, clarification };
}

function harness(): {
  store: Store;
  deps: ClarificationServiceDeps;
  resumeSpy: ReturnType<typeof vi.fn>;
  advanceClock: (ms: number) => void;
} {
  const fake = createFakeWorkspace({ tags: [] });
  let currentTime = NOW;
  const store = createStore(databasePath(), { encryptionKey: "k", now: () => currentTime });
  stores.push(store);
  store.saveInstallation({ workspaceId: SCOPE.workspaceId, addonId: "addon-1", addonUserId: "u1", addonToken: "token-1" });

  const preparations = createOperationPreparationService({
    store,
    registry: MODEL_API_ACTION_CATALOG,
    sessionSecret: "s".repeat(32),
    clockifyForScope: () => fake.client,
    now: () => NOW,
    loadCalendarContext: async () => ({ timeZone: "UTC", weekStartsOn: 1 }),
  });
  const reads = createReadExecutionPort({
    registry: MODEL_API_ACTION_CATALOG,
    store,
    clockifyForScope: () => fake.client,
    now: () => NOW,
  });
  const eventService = createRunEventService(store);
  const eventViews = createRunEventViewService(store, { sessionSecret: "s".repeat(32), now: () => NOW });
  const resumeSpy = vi.fn(async (input: { runId: string; scope: typeof SCOPE }) =>
    runAssistantV2({ runId: input.runId, scope: input.scope }, {
      modelClient: { complete: vi.fn(), completeWithTools: vi.fn(async () => ({ text: "done", toolCalls: [] })) },
      runStore: store,
      eventStore: store,
      eventService,
      eventViews,
      actionRegistry: MODEL_API_ACTION_CATALOG,
      discovery: { search: vi.fn(async () => ({ kind: "matches" as const, query: "", access: "any" as const, operations: [] })) },
      reads,
      preparations,
      installationGuard: { assertCurrent: () => undefined },
      requestGovernor: {
        runRead: async (_s, op) => op(),
        remainingHostCalls: () => 60,
        persistHostCallAllowance: () => undefined,
      },
      clock: { now: () => NOW, monotonicMs: () => 0 },
    }));
  return {
    store,
    resumeSpy,
    advanceClock: (ms: number) => {
      currentTime = new Date(currentTime.getTime() + ms);
    },
    deps: { store, registry: MODEL_API_ACTION_CATALOG, reads, preparations, runner: { resume: resumeSpy } },
  };
}

describe("clarification service (T14-D exact option resolution)", () => {
  it("resolves an exact optionId into a prepared write and resumes the same run", async () => {
    const { store, deps, resumeSpy } = harness();
    const { scope, clarification } = seedRunAndClarification(store);
    const service = createClarificationService(deps);

    const result = await service.resolveOption({
      clarificationId: clarification.id,
      scope,
      runId: scope.runId,
      optionId: "opt-urgent",
    });

    expect(result.ok).toBe(true);
    expect(resumeSpy).toHaveBeenCalledTimes(1);

    const resolved = store.getPendingClarification(clarification.id, scope);
    expect(resolved?.status).toBe("resolved");
    expect(resolved?.selectedOptionId).toBe("opt-urgent");
    expect(resolved?.terminalReason).toBe("selected_option");
    expect(resolved?.actionResultId).toBeTruthy();
    // Terminal rows scrub executable JSON immediately.
    expect(resolved?.partialArguments).toEqual({});
    expect(resolved?.candidates).toEqual([]);

    const run = store.getRun(scope);
    expect(run?.phase).not.toBe("awaiting_clarification");
    expect(run?.continuation).toEqual({ kind: "none" });
    expect(run?.completedResults.some((r) => r.actionName === "clockify_tags_create")).toBe(true);
  });

  it("rejects a foreign clarification id (different session)", async () => {
    const { store, deps } = harness();
    const { clarification } = seedRunAndClarification(store);
    const service = createClarificationService(deps);

    const result = await service.resolveOption({
      clarificationId: clarification.id,
      scope: { ...SCOPE, sessionId: "someone-elses-session" },
      runId: SCOPE.runId,
      optionId: "opt-urgent",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(403);
  });

  it("rejects an unknown clarification id", async () => {
    const { deps } = harness();
    const service = createClarificationService(deps);
    const result = await service.resolveOption({
      clarificationId: "does-not-exist",
      scope: SCOPE,
      runId: SCOPE.runId,
      optionId: "opt-urgent",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
    expect(result.code).toBe("clarification_not_found");
  });

  it("rejects an already-resolved (used) clarification id", async () => {
    const { store, deps } = harness();
    const { scope, clarification } = seedRunAndClarification(store);
    const service = createClarificationService(deps);

    const first = await service.resolveOption({
      clarificationId: clarification.id, scope, runId: scope.runId, optionId: "opt-urgent",
    });
    expect(first.ok).toBe(true);

    const second = await service.resolveOption({
      clarificationId: clarification.id, scope, runId: scope.runId, optionId: "opt-billable",
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.status).toBe(409);
    expect(second.code).toBe("clarification_not_pending");
    // The already-committed selection is untouched by the rejected replay.
    const resolved = store.getPendingClarification(clarification.id, scope);
    expect(resolved?.selectedOptionId).toBe("opt-urgent");
  });

  it("rejects a tampered/unknown optionId without trusting any label, and resets to pending (transient)", async () => {
    const { store, deps } = harness();
    const { scope, clarification } = seedRunAndClarification(store);
    const service = createClarificationService(deps);

    const result = await service.resolveOption({
      clarificationId: clarification.id, scope, runId: scope.runId, optionId: "urgent",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unknown_option");

    const after = store.getPendingClarification(clarification.id, scope);
    expect(after?.status).toBe("pending");

    // The clarification survives to accept a genuine option afterward.
    const retry = await service.resolveOption({
      clarificationId: clarification.id, scope, runId: scope.runId, optionId: "opt-billable",
    });
    expect(retry.ok).toBe(true);
  });

  it("rejects an expired clarification id", async () => {
    const { store, deps, advanceClock } = harness();
    const { scope, clarification } = seedRunAndClarification(store);
    advanceClock(6 * 60 * 1000); // past the 5-minute clarification TTL
    const service = createClarificationService(deps);
    const result = await service.resolveOption({
      clarificationId: clarification.id, scope, runId: scope.runId, optionId: "opt-urgent",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(410);
    expect(result.code).toBe("clarification_expired");
  });

  it("does not reopen the clarification when the resumed run fails after durable resolution", async () => {
    const { store, deps } = harness();
    const { scope, clarification } = seedRunAndClarification(store);
    const failingResume = vi.fn(async () => {
      throw new Error("provider_unavailable");
    });
    const service = createClarificationService({ ...deps, runner: { resume: failingResume } });

    await expect(service.resolveOption({
      clarificationId: clarification.id, scope, runId: scope.runId, optionId: "opt-urgent",
    })).rejects.toThrow("provider_unavailable");

    // The clarification and its result link are already durably committed
    // before the resume call — a later provider failure must not reopen it.
    const resolved = store.getPendingClarification(clarification.id, scope);
    expect(resolved?.status).toBe("resolved");
    expect(resolved?.selectedOptionId).toBe("opt-urgent");
  });

  it("resets to pending when the prepared write's live target lookup fails (stale candidate)", async () => {
    const { store, deps } = harness();
    const { scope, clarification } = seedRunAndClarification(store, {
      originalToolName: "clockify_tags_delete",
      missingField: "id",
      candidates: [{ optionId: "opt-gone", externalId: "tag-does-not-exist", label: "gone" }],
    });
    const service = createClarificationService(deps);
    const result = await service.resolveOption({
      clarificationId: clarification.id, scope, runId: scope.runId, optionId: "opt-gone",
    });
    expect(result.ok).toBe(false);
    const after = store.getPendingClarification(clarification.id, scope);
    expect(after?.status).toBe("pending");
  });

  it("two concurrent resolves of the same id: exactly one succeeds", async () => {
    const { store, deps } = harness();
    const { scope, clarification } = seedRunAndClarification(store);
    const service = createClarificationService(deps);

    const [a, b] = await Promise.all([
      service.resolveOption({ clarificationId: clarification.id, scope, runId: scope.runId, optionId: "opt-urgent" }),
      service.resolveOption({ clarificationId: clarification.id, scope, runId: scope.runId, optionId: "opt-billable" }),
    ]);
    const outcomes = [a, b];
    expect(outcomes.filter((r) => r.ok)).toHaveLength(1);
    const failed = outcomes.find((r) => !r.ok);
    expect(failed && !failed.ok ? failed.code : undefined).toBe("clarification_not_pending");
  });

  it("never dispatches a Clockify mutation from clarification resolution — only a prepared operation", async () => {
    const { store, deps } = harness();
    const { scope, clarification } = seedRunAndClarification(store);
    const service = createClarificationService(deps);
    const result = await service.resolveOption({
      clarificationId: clarification.id, scope, runId: scope.runId, optionId: "opt-urgent",
    });
    expect(result.ok).toBe(true);
    // A prepared write is a pending_confirmations row awaiting a button
    // confirm — no tag was actually created against the fake workspace.
    const resolved = store.getPendingClarification(clarification.id, scope);
    expect(resolved?.operationId).toBeTruthy();
  });
});

describe("POST /api/clarifications/:id/resolve (HTTP wiring)", () => {
  const ADDON_KEY = "ai-assistant";

  async function makeApp(script: ToolCompletion[] = []): Promise<{ app: Express; cookie: string; store: Store }> {
    const keys = await testKeys();
    const config = makeTestConfig({ clockifyAddonPublicKeyPem: keys.pem, clockifyAddonKey: ADDON_KEY });
    const store = createStore(":memory:", { encryptionKey: "test-key" });
    stores.push(store);
    store.saveInstallation({ workspaceId: "ws-1", addonId: "addon-1", addonUserId: "addon-user-1", addonToken: "addon-token" });
    const app = createApp({
      config,
      store,
      parser: createSignatureParser(ADDON_KEY, keys.pem),
      modelClient: scriptedToolModel(script),
      clockifyForWorkspace: () => createFakeWorkspace({ tags: [] }).client,
    });
    return { app, cookie: mintAdminCookie(store, config.sessionSecret), store };
  }

  it("requires a session", async () => {
    const { app } = await makeApp();
    const res = await request(app).post("/api/clarifications/some-id/resolve").send({ optionId: "opt-1" });
    expect(res.status).toBe(401);
  });

  it("rejects a malformed body", async () => {
    const { app, cookie } = await makeApp();
    const res = await request(app)
      .post("/api/clarifications/some-id/resolve")
      .set("Cookie", cookie)
      .send({ label: "urgent" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_args");
  });

  it("404s with no active run in the chat", async () => {
    const { app, cookie } = await makeApp();
    const res = await request(app)
      .post("/api/clarifications/some-id/resolve")
      .set("Cookie", cookie)
      .send({ optionId: "opt-1" });
    expect(res.status).toBe(404);
  });
});
