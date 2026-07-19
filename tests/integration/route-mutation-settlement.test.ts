import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatPipeline } from "../../src/routes/chat-pipeline.js";
import { createStore, type Store } from "../../src/db/store.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";
import { makeTestConfig } from "../helpers/config.js";
import type { ModelClient } from "../../src/assistant/model-client.js";
import type {
  WorkspaceMutationCoordinator,
  WorkspaceMutationLease,
} from "../../src/clockify/workspace-mutation-coordinator.js";
import { createWorkspaceMutationCoordinator } from "../../src/clockify/workspace-mutation-coordinator.js";
import type { WorkspaceClient } from "../../src/clockify/client.js";
import { HostRequestCancelledError } from "../../src/clockify/request-governor.js";
import request from "supertest";
import { createApp } from "../../src/server.js";
import { signSessionCookie } from "../../src/auth/sessions.js";
import { buildSessionCookie } from "../../src/routes/deps.js";

const stores: Store[] = [];

afterEach(() => {
  for (const store of stores) store.close();
  stores.length = 0;
});

function setupStore(): { store: Store; installation: NonNullable<ReturnType<Store["getInstallation"]>>; sessionId: string } {
  const store = createStore(":memory:", { encryptionKey: "test-key" });
  stores.push(store);
  store.saveInstallation({
    workspaceId: "ws-1",
    addonId: "addon-1",
    addonUserId: "addon-user-1",
    addonToken: "addon-token",
  });
  const installation = store.getInstallation("ws-1");
  if (!installation) throw new Error("test installation missing");
  const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
  return { store, installation, sessionId: session.id };
}

function noopCoordinator(acquire: WorkspaceMutationCoordinator["acquire"]): WorkspaceMutationCoordinator {
  return {
    async runLifecycle<T>(_workspaceId: string, run: () => Promise<T>): Promise<T> {
      return run();
    },
    activate: vi.fn(),
    observe: vi.fn((_workspaceId, _generation, signal) => signal ?? new AbortController().signal),
    acquire,
    block: vi.fn(),
    blockAndDrain: vi.fn(async () => undefined),
    beginDeletion: vi.fn(() => ({
      owner: true,
      drained: Promise.resolve(),
      completed: Promise.resolve(),
      finish: vi.fn(),
    })),
    waitForDeletion: vi.fn(() => undefined),
  };
}

function cookieFor(store: Store, sessionId: string): string {
  const session = store.getSession(sessionId);
  if (!session) throw new Error("test session missing");
  return buildSessionCookie(signSessionCookie({
    sessionId,
    workspaceId: session.workspaceId,
    adminUserId: session.adminUserId,
    workspaceRole: "ADMIN",
    expiresAt: session.expiresAt,
  }, "test-session-secret"), false).split(";")[0]!;
}

describe("route mutation settlement coordination", () => {
  it("threads the request signal through ActionContext and workspace client construction", () => {
    const { store, installation } = setupStore();
    const fake = createFakeWorkspace();
    const captured: Array<AbortSignal | undefined> = [];
    const pipeline = createChatPipeline({
      config: makeTestConfig({ llmAgentic: false, llmMode: "json", llmToolSelect: false }),
      store,
      parser: {} as never,
      modelClient: { async complete() { return JSON.stringify({ kind: "answer", text: "ok" }); } },
      clockifyForWorkspace: (_installation, options) => {
        captured.push(options?.signal);
        return fake.client;
      },
    });
    const controller = new AbortController();

    const context = pipeline.actionContext("ws-1", "admin-1", installation, undefined, controller.signal);

    expect(context.signal).toBe(controller.signal);
    expect(captured).toEqual([controller.signal]);
  });

  it("rejects a captured action context after installation generation changes", async () => {
    const { store, installation } = setupStore();
    const fake = createFakeWorkspace();
    const pipeline = createChatPipeline({
      config: makeTestConfig({ llmAgentic: false, llmMode: "json", llmToolSelect: false }),
      store,
      parser: {} as never,
      modelClient: { async complete() { return JSON.stringify({ kind: "answer", text: "ok" }); } },
      clockifyForWorkspace: () => fake.client,
    });
    const context = pipeline.actionContext("ws-1", "admin-1", installation);

    store.saveInstallation({
      workspaceId: "ws-1",
      addonId: "addon-1",
      addonUserId: "addon-user-1",
      addonToken: "replacement-token",
    });
    const denial = await context.authorizeWrite?.("clockify_tags_create");

    expect(denial).toMatchObject({ ok: false, code: "installation_changed" });
    expect(fake.counts.getWorkspaceMemberRole ?? 0).toBe(0);
  });

  it("holds a safe-write workspace lease through canonical operation settlement", async () => {
    const { store, installation, sessionId } = setupStore();
    const fake = createFakeWorkspace();
    let allowCreate!: () => void;
    const createGate = new Promise<void>((resolve) => { allowCreate = resolve; });
    let markCreateStarted!: () => void;
    const createStarted = new Promise<void>((resolve) => { markCreateStarted = resolve; });
    let releasedStatus: string | undefined;
    let released = false;
    const caller = new AbortController();
    const acquire = vi.fn((_workspaceId: string, _generation: number, callerSignal?: AbortSignal): WorkspaceMutationLease => ({
      signal: callerSignal ?? new AbortController().signal,
      release() {
        if (released) return;
        released = true;
        releasedStatus = store.listScopedOperationRuns("ws-1", "admin-1", sessionId, 10)
          .find((run) => run.actionName === "clockify_tags_create")?.status;
      },
    }));
    const coordinator = noopCoordinator(acquire);
    const client: WorkspaceClient = {
      ...fake.client,
      async createTag(input) {
        markCreateStarted();
        await createGate;
        return fake.client.createTag(input);
      },
    };
    const modelClient: ModelClient = {
      async complete() {
        return JSON.stringify({
          kind: "actions",
          text: "Creating the tag.",
          actions: [{ name: "clockify_tags_create", arguments: { name: "Coordinated" } }],
        });
      },
    };
    const pipeline = createChatPipeline({
      config: makeTestConfig({ llmAgentic: false, llmMode: "json", llmToolSelect: false }),
      store,
      parser: {} as never,
      modelClient,
      clockifyForWorkspace: () => client,
      mutationCoordinator: coordinator,
    });

    const pending = pipeline.executeChatTurn(
      { sessionId, workspaceId: "ws-1", adminUserId: "admin-1" },
      installation,
      "Create a tag named Coordinated",
      undefined,
      undefined,
      caller.signal,
      "6727f6ba-f23a-4e6a-83ef-ae8a9e13d308",
    );
    await createStarted;

    expect(acquire).toHaveBeenCalledWith("ws-1", installation.generation, caller.signal);
    expect(released).toBe(false);

    allowCreate();
    const outcome = await pending;

    expect(outcome.ok).toBe(true);
    expect(released).toBe(true);
    expect(releasedStatus).toBe("succeeded");
  });

  it("cancels a queued safe write definitively before external dispatch", async () => {
    const { store, installation, sessionId } = setupStore();
    const fake = createFakeWorkspace();
    const coordinator = createWorkspaceMutationCoordinator();
    coordinator.activate("ws-1", installation.generation);
    let markQueued!: () => void;
    const queued = new Promise<void>((resolve) => { markQueued = resolve; });
    let externalDispatches = 0;
    const caller = new AbortController();
    const modelClient: ModelClient = {
      async complete() {
        return JSON.stringify({
          kind: "actions",
          text: "Creating the tag.",
          actions: [{ name: "clockify_tags_create", arguments: { name: "Cancelled" } }],
        });
      },
    };
    const pipeline = createChatPipeline({
      config: makeTestConfig({ llmAgentic: false, llmMode: "json", llmToolSelect: false }),
      store,
      parser: {} as never,
      modelClient,
      clockifyForWorkspace: (_installed, options) => ({
        ...fake.client,
        async createTag(input) {
          markQueued();
          await new Promise<void>((resolve) => {
            if (options?.signal?.aborted) return resolve();
            options?.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          if (options?.signal?.aborted) throw new HostRequestCancelledError();
          externalDispatches += 1;
          return fake.client.createTag(input);
        },
      }),
      mutationCoordinator: coordinator,
    });

    const pending = pipeline.executeChatTurn(
      { sessionId, workspaceId: "ws-1", adminUserId: "admin-1" },
      installation,
      "Create a tag named Cancelled",
      undefined,
      undefined,
      caller.signal,
      "8195a849-81ee-4191-9cc9-a19f175f1f01",
    );
    await queued;
    caller.abort();
    const outcome = await pending;

    expect(outcome.ok).toBe(true);
    expect(externalDispatches).toBe(0);
    const run = store.listScopedOperationRuns("ws-1", "admin-1", sessionId, 10)
      .find((candidate) => candidate.actionName === "clockify_tags_create");
    expect(run).toMatchObject({
      status: "definitive_failed",
      steps: [{ status: "definitive_failed", queuedAt: expect.any(String) }],
    });
    expect(run?.steps[0]?.dispatchedAt).toBeUndefined();
  });

  it("holds the workspace lease through confirmed-write settlement", async () => {
    const { store, installation, sessionId } = setupStore();
    const fake = createFakeWorkspace({ tags: [{ id: "tag-1", name: "Before" }] });
    let previewId = "";
    let releasedStatus: string | undefined;
    const acquire = vi.fn((_workspaceId: string, _generation: number, callerSignal?: AbortSignal): WorkspaceMutationLease => ({
      signal: callerSignal ?? new AbortController().signal,
      release() {
        releasedStatus = previewId
          ? store.getPendingConfirmation(previewId)?.status
          : undefined;
      },
    }));
    const coordinator = noopCoordinator(acquire);
    const modelClient: ModelClient = {
      async complete() {
        return JSON.stringify({
          kind: "actions",
          text: "Preparing the rename.",
          actions: [{ name: "clockify_tags_update", arguments: { id: "tag-1", name: "After" } }],
        });
      },
    };
    const config = makeTestConfig({ llmAgentic: false, llmMode: "json", llmToolSelect: false });
    const deps = {
      config,
      store,
      parser: {} as never,
      modelClient,
      clockifyForWorkspace: () => fake.client,
      mutationCoordinator: coordinator,
    };
    const previewPipeline = createChatPipeline(deps);
    const preview = await previewPipeline.executeChatTurn(
      { sessionId, workspaceId: "ws-1", adminUserId: "admin-1" },
      installation,
      "Rename Before to After",
      undefined,
      undefined,
      undefined,
      "8e79742a-3079-49fc-90ea-795c76eb4048",
    );
    if (!preview.ok) throw new Error(preview.message);
    const card = preview.results.find((result) =>
      !!result && typeof result === "object" && (result as { kind?: unknown }).kind === "preview"
    ) as { previewId: string; nonce: string } | undefined;
    if (!card) throw new Error("preview card missing");
    previewId = card.previewId;
    acquire.mockClear();

    const response = await request(createApp(deps))
      .post(`/api/confirmations/${card.previewId}/confirm`)
      .set("Cookie", cookieFor(store, sessionId))
      .send({ nonce: card.nonce });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, receipt: { ok: true } });
    expect(fake.counts.updateTagAtomic).toBe(1);
    expect(acquire).toHaveBeenCalledWith("ws-1", installation.generation, expect.any(AbortSignal));
    expect(releasedStatus).toBe("succeeded");
  });

  it("rejects a risky preview after installation-token replacement without consuming it", async () => {
    const { store, installation, sessionId } = setupStore();
    const fake = createFakeWorkspace({ tags: [{ id: "tag-1", name: "Before" }] });
    const coordinator = createWorkspaceMutationCoordinator();
    coordinator.activate("ws-1", installation.generation);
    const modelClient: ModelClient = {
      async complete() {
        return JSON.stringify({
          kind: "actions",
          text: "Preparing the rename.",
          actions: [{ name: "clockify_tags_update", arguments: { id: "tag-1", name: "After" } }],
        });
      },
    };
    const deps = {
      config: makeTestConfig({ llmAgentic: false, llmMode: "json", llmToolSelect: false }),
      store,
      parser: {} as never,
      modelClient,
      clockifyForWorkspace: () => fake.client,
      mutationCoordinator: coordinator,
    };
    const pipeline = createChatPipeline(deps);
    const preview = await pipeline.executeChatTurn(
      { sessionId, workspaceId: "ws-1", adminUserId: "admin-1" },
      installation,
      "Rename Before to After",
      undefined,
      undefined,
      undefined,
      "a8709b0f-59c3-4ced-8851-40bbb1cc63f2",
    );
    if (!preview.ok) throw new Error(preview.message);
    const card = preview.results.find((result) =>
      !!result && typeof result === "object" && (result as { kind?: unknown }).kind === "preview"
    ) as { previewId: string; nonce: string } | undefined;
    if (!card) throw new Error("preview card missing");
    const recordBefore = store.getPendingConfirmation(card.previewId);
    expect(recordBefore).toMatchObject({ installationGeneration: installation.generation });
    expect(recordBefore?.operation).toMatchObject({ installationGeneration: installation.generation });

    store.saveInstallation({
      workspaceId: "ws-1",
      addonId: "addon-1",
      addonUserId: "addon-user-1",
      addonToken: "replacement-token",
    });
    const replacement = store.getInstallation("ws-1");
    if (!replacement) throw new Error("replacement installation missing");
    coordinator.activate("ws-1", replacement.generation);

    const response = await request(createApp(deps))
      .post(`/api/confirmations/${card.previewId}/confirm`)
      .set("Cookie", cookieFor(store, sessionId))
      .send({ nonce: card.nonce });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ ok: false, code: "installation_changed" });
    expect(fake.counts.updateTagAtomic ?? 0).toBe(0);
    expect(store.getPendingConfirmation(card.previewId)?.status).toBe("pending");
  });

  it("drains a risky preview before uninstall erases its workspace and never persists afterward", async () => {
    const { store, installation, sessionId } = setupStore();
    const fake = createFakeWorkspace({ tags: [{ id: "tag-1", name: "Before" }] });
    const coordinator = createWorkspaceMutationCoordinator();
    coordinator.activate("ws-1", installation.generation);
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const client: WorkspaceClient = {
      ...fake.client,
      async prepareTagUpdate(id, patch) {
        markReadStarted();
        await readGate;
        return fake.client.prepareTagUpdate(id, patch);
      },
    };
    const pipeline = createChatPipeline({
      config: makeTestConfig({ llmAgentic: false, llmMode: "json", llmToolSelect: false }),
      store,
      parser: {} as never,
      modelClient: {
        async complete() {
          return JSON.stringify({
            kind: "actions",
            text: "Preparing the rename.",
            actions: [{ name: "clockify_tags_update", arguments: { id: "tag-1", name: "After" } }],
          });
        },
      },
      clockifyForWorkspace: () => client,
      mutationCoordinator: coordinator,
    });

    const preview = pipeline.executeChatTurn(
      { sessionId, workspaceId: "ws-1", adminUserId: "admin-1" },
      installation,
      "Rename Before to After",
      undefined,
      undefined,
      undefined,
      "324079fd-4c0f-4187-af97-da9cf443809f",
    );
    await readStarted;

    const deletion = coordinator.beginDeletion("ws-1");
    const tombstone = store.tombstoneInstallation("ws-1");
    let drained = false;
    const erase = deletion.drained.then(() => {
      drained = true;
      if (tombstone) store.eraseWorkspaceForDeletion("ws-1", tombstone.generation);
    });
    await Promise.resolve();
    const observedEarlyDrain = drained;
    releaseRead();
    await Promise.allSettled([preview, erase]);
    deletion.finish();

    expect(observedEarlyDrain).toBe(false);
    expect(store.getInstallation("ws-1")).toBeUndefined();
    expect(store.listScopedOperationRuns("ws-1", "admin-1", sessionId, 10)).toEqual([]);
  });

  it("holds the workspace lease through undo settlement", async () => {
    const { store, installation, sessionId } = setupStore();
    const fake = createFakeWorkspace({ tags: [{ id: "tag-undo", name: "Undo me" }] });
    const undoId = store.recordUndoable({
      sessionId,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      actionName: "clockify_tags_create",
      installationGeneration: installation.generation,
      reversal: [{ type: "tag", id: "tag-undo", name: "Undo me" }],
    });
    let releasedStatus: string | undefined;
    const acquire = vi.fn((_workspaceId: string, _generation: number, callerSignal?: AbortSignal): WorkspaceMutationLease => ({
      signal: callerSignal ?? new AbortController().signal,
      release() {
        releasedStatus = store.listScopedOperationRuns("ws-1", "admin-1", sessionId, 10)
          .find((run) => run.actionName === "undo")?.status;
      },
    }));
    const coordinator = noopCoordinator(acquire);
    const app = createApp({
      config: makeTestConfig({ llmAgentic: false, llmMode: "json", llmToolSelect: false }),
      store,
      parser: {} as never,
      modelClient: { async complete() { return JSON.stringify({ kind: "answer", text: "ok" }); } },
      clockifyForWorkspace: () => fake.client,
      mutationCoordinator: coordinator,
    });

    const response = await request(app)
      .post(`/api/undo/${undoId}`)
      .set("Cookie", cookieFor(store, sessionId))
      .send({});

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, receipt: { ok: true } });
    expect(acquire).toHaveBeenCalledWith("ws-1", installation.generation, expect.any(AbortSignal));
    expect(releasedStatus).toBe("succeeded");
  });

  it("rejects an undo from an older installation generation without consuming it", async () => {
    const { store, installation, sessionId } = setupStore();
    const fake = createFakeWorkspace({ tags: [{ id: "tag-undo", name: "Undo me" }] });
    const coordinator = createWorkspaceMutationCoordinator();
    coordinator.activate("ws-1", installation.generation);
    const undoId = store.recordUndoable({
      sessionId,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      actionName: "clockify_tags_create",
      installationGeneration: installation.generation,
      reversal: [{ type: "tag", id: "tag-undo", name: "Undo me" }],
    });
    store.saveInstallation({
      workspaceId: "ws-1",
      addonId: "addon-1",
      addonUserId: "addon-user-1",
      addonToken: "replacement-token",
    });
    const replacement = store.getInstallation("ws-1");
    if (!replacement) throw new Error("replacement installation missing");
    coordinator.activate("ws-1", replacement.generation);
    const app = createApp({
      config: makeTestConfig({ llmAgentic: false, llmMode: "json", llmToolSelect: false }),
      store,
      parser: {} as never,
      modelClient: { async complete() { return JSON.stringify({ kind: "answer", text: "ok" }); } },
      clockifyForWorkspace: () => fake.client,
      mutationCoordinator: coordinator,
    });

    const response = await request(app)
      .post(`/api/undo/${undoId}`)
      .set("Cookie", cookieFor(store, sessionId))
      .send({});

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ ok: false, code: "installation_changed" });
    expect(fake.counts.deleteTagAtomic ?? 0).toBe(0);
    expect(store.getUndoRecord(undoId)?.status).toBe("available");
  });
});
