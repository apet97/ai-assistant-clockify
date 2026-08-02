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
import { createPendingConfirmation } from "../../src/harness/confirmations.js";
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
import { signSessionCookie } from "../../src/auth/sessions.js";
import { buildSessionCookie } from "../../src/routes/deps.js";
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
      eventService,
      eventViews,
      actionRegistry: MODEL_API_ACTION_CATALOG,
      discovery: { search: vi.fn(async () => ({ kind: "matches" as const, query: "", access: "any" as const, operations: [] })) },
      reads,
      preparations,
      installationGuard: { assertCurrent: () => undefined },
      requestGovernor: {
        runRead: async (_s, op) => op(),
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
  it("resolves an exact optionId into a prepared write and suspends for CONFIRMATION — no resume, no synthetic success (F19)", async () => {
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
    if (!result.ok) throw new Error("expected ok");
    // A resolved WRITE never calls the model again: only the button moves it.
    expect(resumeSpy).not.toHaveBeenCalled();
    expect(result.outcome.kind).toBe("suspended");
    if (result.outcome.kind !== "suspended") throw new Error("expected suspension");
    expect(result.outcome.reason).toBe("awaiting_confirmation");

    const resolved = store.getPendingClarification(clarification.id, scope);
    expect(resolved?.status).toBe("resolved");
    expect(resolved?.selectedOptionId).toBe("opt-urgent");
    expect(resolved?.terminalReason).toBe("selected_option");
    expect(resolved?.actionResultId).toBeTruthy();
    // The row binds the EXACT prepared operation.
    expect(resolved?.operationId).toBeTruthy();
    // Terminal rows scrub executable JSON immediately.
    expect(resolved?.partialArguments).toEqual({});
    expect(resolved?.candidates).toEqual([]);

    // The run moved DIRECTLY to awaiting_confirmation with the prepared
    // operation bound — never back to the model loop, and no fabricated
    // completed-write entry.
    const run = store.getRun(scope);
    expect(run?.phase).toBe("awaiting_confirmation");
    expect(run?.continuation.kind).toBe("awaiting_operations");
    if (run?.continuation.kind === "awaiting_operations") {
      expect(run.continuation.operationIds).toEqual([resolved!.operationId]);
    }
    expect(run?.completedResults.some((r) => r.actionName === "clockify_tags_create")).toBe(false);
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

  it("a resolved WRITE never invokes the model even when the runner would fail (F19: no resume path exists)", async () => {
    const { store, deps } = harness();
    const { scope, clarification } = seedRunAndClarification(store);
    const failingResume = vi.fn(async () => {
      throw new Error("provider_unavailable");
    });
    const service = createClarificationService({ ...deps, runner: { resume: failingResume } });

    // The write resolution completes WITHOUT touching the (broken) runner:
    // there is no post-resolution model call to fail.
    const result = await service.resolveOption({
      clarificationId: clarification.id, scope, runId: scope.runId, optionId: "opt-urgent",
    });
    expect(result.ok).toBe(true);
    expect(failingResume).not.toHaveBeenCalled();

    const resolved = store.getPendingClarification(clarification.id, scope);
    expect(resolved?.status).toBe("resolved");
    expect(resolved?.selectedOptionId).toBe("opt-urgent");
    expect(store.getRun(scope)?.phase).toBe("awaiting_confirmation");
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

describe("T14-E: free-text continuation and new-run supersession (HTTP)", () => {
  const ADDON_KEY = "ai-assistant";

  function cookieForSession(session: { id: string; expiresAt: string }, sessionSecret: string): string {
    // `verifySessionCookie` checks this expiry against the REAL wall clock
    // (src/auth/sessions.ts), while `session.expiresAt` is computed from this
    // suite's fixed `now: () => NOW` (midnight of "today") plus an 8h TTL —
    // real time keeps advancing past that fixed instant, so the cookie goes
    // stale hours after it was written regardless of the store's own clock.
    // Sign a safely-far-future expiry for the COOKIE only; the store's own
    // `session.expiresAt` (used for session-store bookkeeping, not auth) is
    // unaffected.
    const value = signSessionCookie(
      { sessionId: session.id, workspaceId: "ws-1", adminUserId: "admin-1", workspaceRole: "ADMIN", expiresAt: "2099-01-01T00:00:00.000Z" },
      sessionSecret,
    );
    return buildSessionCookie(value, false).split(";")[0]!;
  }

  async function makeV2App(script: ToolCompletion[] = []): Promise<{ app: Express; store: Store; config: ReturnType<typeof makeTestConfig> }> {
    const keys = await testKeys();
    const config = makeTestConfig({ clockifyAddonPublicKeyPem: keys.pem, clockifyAddonKey: ADDON_KEY, assistantEngine: "v2" });
    const store = createStore(":memory:", { encryptionKey: "test-key", now: () => NOW });
    stores.push(store);
    store.saveInstallation({ workspaceId: "ws-1", addonId: "addon-1", addonUserId: "addon-user-1", addonToken: "addon-token" });
    const app = createApp({
      config,
      store,
      parser: createSignatureParser(ADDON_KEY, keys.pem),
      modelClient: scriptedToolModel(script),
      clockifyForWorkspace: () => createFakeWorkspace({ tags: [] }).client,
    });
    return { app, store, config };
  }

  function seedAwaitingClarification(store: Store, sessionId: string, runId: string, phase: "awaiting_clarification" | "awaiting_confirmation" = "awaiting_clarification") {
    const scope = { sessionId, runId, workspaceId: "ws-1", adminUserId: "admin-1", installationGeneration: 1, authClass: "addon" as const };
    const originalRequest = "create the tag urgent";
    store.startRunWithTurn({
      scope, originalRequest, requestHash: computeRequestHash(originalRequest),
      catalogHash: MODEL_API_ACTION_CATALOG.hash(), loadedToolNames: [DISCOVERY_META_TOOL_NAME, "clockify_tags_create"], intentHash: runId,
    });
    store.suspendRunWithEvent(scope, store.getRun(scope)!, { reason: phase === "awaiting_clarification" ? "awaiting_clarification" : "awaiting_confirmation" });
    if (phase === "awaiting_clarification") {
      const clarification = store.createPendingClarification({
        sessionId, runId, workspaceId: "ws-1", adminUserId: "admin-1",
        originalToolName: "clockify_tags_create", partialArguments: {}, missingField: "name",
        candidates: [{ optionId: "opt-urgent", externalId: "urgent", label: "urgent" }],
      });
      return { scope, clarification };
    }
    // PR 4 (F02): the refusal now protects a LIVE preview — a run awaiting
    // confirmation with no pending row is a lapsed wedge and gets reconciled
    // instead. Seed the real pending confirmation this run is waiting on.
    const created = createPendingConfirmation({
      id: `conf-${runId.slice(0, 8)}`,
      sessionId, workspaceId: "ws-1", adminUserId: "admin-1",
      risk: ["safe_write"],
      preview: { summary: "create tag urgent" },
      operation: {
        operationId: `op-${runId.slice(0, 8)}`,
        actionName: "clockify_tags_create",
        payload: { name: "urgent" },
        mutationPlan: {
          mode: "single",
          maxHostCalls: 1,
          steps: [{ id: "create-tag", kind: "primary", reconciliationStrategy: "create" }],
        },
      },
      installationGeneration: 1,
      sessionSecret: "test-session-secret",
      now: new Date(),
      ttlMs: 300_000,
      origin: "assistant",
      registryId: "v2-api",
      authorityModel: "preview_confirmation_v2",
      executorKind: "prepared_safe_write",
      runId,
    });
    store.savePendingConfirmation(created.record);
    return { scope, clarification: undefined };
  }

  it("resumes the same run from free-text continuation, never creating a second run", async () => {
    const { app, store, config } = await makeV2App([{ text: "Done.", toolCalls: [] }]);
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    const { scope, clarification } = seedAwaitingClarification(store, session.id, "11111111-1111-4111-8111-111111111111");
    const cookie = cookieForSession(session, config.sessionSecret);

    const res = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "use the urgent one instead", continuationRunId: "11111111-1111-4111-8111-111111111111" });

    expect(res.status).toBe(200);
    const resolved = store.getPendingClarification(clarification!.id, scope);
    expect(resolved?.status).toBe("continued");
    expect(resolved?.terminalReason).toBe("free_text_continuation");
    // Same run resumed — no second nonterminal run exists for the session.
    const active = store.getActiveRunForSession(session.id, "ws-1", "admin-1");
    expect(active).toBeUndefined(); // the run completed (scripted model returned no tool calls)
  });

  it("rejects continuation for a clarification that is no longer pending", async () => {
    const { app, store, config } = await makeV2App();
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    const { scope, clarification } = seedAwaitingClarification(store, session.id, "11111111-1111-4111-8111-111111111111");
    store.claimClarificationResolving(clarification!.id, scope);
    const cookie = cookieForSession(session, config.sessionSecret);

    const res = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "urgent", continuationRunId: "11111111-1111-4111-8111-111111111111" });

    expect(res.status).toBe(502);
    expect(res.body.code).toBe("clarification_not_pending");
  });

  it("never picks an implicit latest clarification: continuationRunId scoped to a foreign session is rejected", async () => {
    const { app, store, config } = await makeV2App();
    const sessionA = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    const sessionB = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    seedAwaitingClarification(store, sessionB.id, "22222222-2222-4222-8222-222222222222");
    const cookieForA = cookieForSession(sessionA, config.sessionSecret);

    const res = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookieForA)
      .send({ message: "urgent", continuationRunId: "22222222-2222-4222-8222-222222222222" });

    expect(res.status).toBe(502);
    expect(res.body.code).toBe("clarification_not_pending");
  });

  it("duplicate requestId replay for a continuation does not consume the clarification twice", async () => {
    const { app, store, config } = await makeV2App([{ text: "Done.", toolCalls: [] }]);
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    const { clarification } = seedAwaitingClarification(store, session.id, "11111111-1111-4111-8111-111111111111");
    const cookie = cookieForSession(session, config.sessionSecret);
    const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    const first = await request(app).post("/api/chat/messages").set("Cookie", cookie)
      .send({ message: "urgent please", continuationRunId: "11111111-1111-4111-8111-111111111111", requestId });
    expect(first.status).toBe(200);

    const replay = await request(app).post("/api/chat/messages").set("Cookie", cookie)
      .send({ message: "urgent please", continuationRunId: "11111111-1111-4111-8111-111111111111", requestId });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);

    const resolved = store.getPendingClarification(clarification!.id, {
      sessionId: session.id, runId: "11111111-1111-4111-8111-111111111111", workspaceId: "ws-1", adminUserId: "admin-1",
    });
    expect(resolved?.status).toBe("continued");
  });

  it("a mismatched replay (same requestId, different text) is rejected as a conflict", async () => {
    const { app, store, config } = await makeV2App([{ text: "Done.", toolCalls: [] }]);
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    seedAwaitingClarification(store, session.id, "11111111-1111-4111-8111-111111111111");
    const cookie = cookieForSession(session, config.sessionSecret);
    const requestId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    const first = await request(app).post("/api/chat/messages").set("Cookie", cookie)
      .send({ message: "urgent please", continuationRunId: "11111111-1111-4111-8111-111111111111", requestId });
    expect(first.status).toBe(200);

    const mismatched = await request(app).post("/api/chat/messages").set("Cookie", cookie)
      .send({ message: "a totally different message", continuationRunId: "11111111-1111-4111-8111-111111111111", requestId });
    expect(mismatched.status).toBe(409);
    expect(mismatched.body.code).toBe("operation_id_conflict");
  });

  // `assistant_run_request_links` CHECKs that a `free_text_continuation` row has
  // `request_id <> run_id`, and both values are client-supplied uuids here — so
  // sending the request id AS the continuation run id looks like a way to make
  // the INSERT throw a raw better-sqlite3 message inside the route's `try`.
  //
  // MEASURED: it is not. `chatPreconditions` claims the `turn_runs` row for
  // `requestId` first, and that request id is already claimed by the ORIGINAL
  // turn of this run (the `initial` link is written with request_id = run_id),
  // so the durable-request-identity guard rejects the turn with a bounded code
  // long before any link INSERT. This test exists to keep that pre-emption
  // true: if the ordering ever changes, the constraint error becomes reachable.
  it("a request id equal to the continuation run id is pre-empted by the identity guard", async () => {
    const { app, store, config } = await makeV2App([{ text: "Done.", toolCalls: [] }]);
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    const runId = "11111111-1111-4111-8111-111111111111";
    seedAwaitingClarification(store, session.id, runId);
    const cookie = cookieForSession(session, config.sessionSecret);

    const res = await request(app).post("/api/chat/messages").set("Cookie", cookie)
      .send({ message: "urgent please", continuationRunId: runId, requestId: runId });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("operation_id_conflict");
    expect(res.body.code).not.toMatch(/constraint|SQLITE|assistant_run_request_links/i);
  });

  // The catch around `continueClarificationWithFreeTextAndLink` is the fifth
  // site of the class this branch exists to close: an arbitrary caught
  // `error.message` in the API `code` field. No route-driven input reaches it
  // today (see the pre-emption test above), so the property is pinned where it
  // actually lives — at the exact dependency boundary the `try` wraps. The
  // store method performs raw SQL; anything it throws is an internal string.
  it("never puts a caught store error message into the API code field", async () => {
    const { app, store, config } = await makeV2App([{ text: "Done.", toolCalls: [] }]);
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    const runId = "11111111-1111-4111-8111-111111111111";
    seedAwaitingClarification(store, session.id, runId);
    const cookie = cookieForSession(session, config.sessionSecret);
    vi.spyOn(store, "continueClarificationWithFreeTextAndLink").mockImplementation(() => {
      throw new Error(
        "UNIQUE constraint failed: assistant_run_request_links.session_id, assistant_run_request_links.request_id",
      );
    });

    const res = await request(app).post("/api/chat/messages").set("Cookie", cookie)
      .send({ message: "urgent please", continuationRunId: runId });

    expect(res.body.code).toBe("clarification_continuation_failed");
    expect(res.body.message).toBe("That clarification could not be continued.");
    expect(JSON.stringify(res.body)).not.toMatch(/constraint|assistant_run_request_links/i);
  });

  // ...but the two sentinels the store raises deliberately keep their own
  // codes. Flattening them too would trade one truthfulness loss for another:
  // a clarification resolved concurrently is a different fact from an
  // unexplained failure, and the admin-facing route already has copy for it.
  it("keeps the store's two declared sentinels as their own codes", async () => {
    const { app, store, config } = await makeV2App([{ text: "Done.", toolCalls: [] }]);
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    const runId = "11111111-1111-4111-8111-111111111111";
    seedAwaitingClarification(store, session.id, runId);
    const cookie = cookieForSession(session, config.sessionSecret);
    vi.spyOn(store, "continueClarificationWithFreeTextAndLink").mockImplementation(() => {
      throw new Error("clarification_not_pending");
    });

    const res = await request(app).post("/api/chat/messages").set("Cookie", cookie)
      .send({ message: "urgent please", continuationRunId: runId });

    // Same code AND same status as the route's own pending guard above, so a
    // client branching on `code` never sees one condition under two statuses.
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("clarification_not_pending");
  });

  it("an ordinary new message while a run awaits clarification supersedes it (cancelled, run failed)", async () => {
    const { app, store, config } = await makeV2App([{ text: "Done.", toolCalls: [] }]);
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    const { scope, clarification } = seedAwaitingClarification(store, session.id, "11111111-1111-4111-8111-111111111111");
    const cookie = cookieForSession(session, config.sessionSecret);

    const res = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "actually, list my projects instead" });

    expect(res.status).toBe(200);
    const resolved = store.getPendingClarification(clarification!.id, scope);
    expect(resolved?.status).toBe("cancelled");
    expect(resolved?.terminalReason).toBe("superseded");
    const oldRun = store.getRun(scope);
    expect(oldRun?.phase).toBe("failed");
  });

  it("an ordinary new message recovers a run stuck awaiting_clarification with NO clarification row (review-gate HIGH-1)", async () => {
    const { app, store, config } = await makeV2App([{ text: "Done.", toolCalls: [] }]);
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    // Orphaned suspension: the run is durably awaiting_clarification but no
    // pending_clarifications row was ever created (the read-execution producer
    // gap). Without the recovery arm, the next turn would violate
    // idx_assistant_runs_one_active_per_session and 500 forever.
    const runId = "33333333-3333-4333-8333-333333333333";
    const scope = { sessionId: session.id, runId, workspaceId: "ws-1", adminUserId: "admin-1", installationGeneration: 1, authClass: "addon" as const };
    const originalRequest = "list entries for Alice";
    store.startRunWithTurn({
      scope, originalRequest, requestHash: computeRequestHash(originalRequest),
      catalogHash: MODEL_API_ACTION_CATALOG.hash(), loadedToolNames: [DISCOVERY_META_TOOL_NAME], intentHash: runId,
    });
    store.suspendRunWithEvent(scope, store.getRun(scope)!, { reason: "awaiting_clarification" });
    expect(store.getRun(scope)?.phase).toBe("awaiting_clarification");
    const cookie = cookieForSession(session, config.sessionSecret);

    const res = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "never mind, just say hello" });

    // The session recovered: the orphaned run failed, the new turn succeeded.
    expect(res.status).toBe(200);
    const oldRun = store.getRun(scope);
    expect(oldRun?.phase).toBe("failed");
    expect(store.getActiveRunForSession(session.id, "ws-1", "admin-1")).toBeUndefined();
  });

  it("an ordinary new message while a run awaits confirmation is refused, leaving the pending preview untouched", async () => {
    const { app, store, config } = await makeV2App();
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    const { scope } = seedAwaitingClarification(store, session.id, "11111111-1111-4111-8111-111111111111", "awaiting_confirmation");
    const cookie = cookieForSession(session, config.sessionSecret);

    const res = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "actually, list my projects instead" });

    expect(res.status).toBe(502);
    expect(res.body.code).toBe("run_awaiting_confirmation");
    const untouched = store.getRun(scope);
    expect(untouched?.phase).toBe("awaiting_confirmation");
  });
});
