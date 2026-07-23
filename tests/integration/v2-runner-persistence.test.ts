import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStore } from "../../src/db/store.js";
import { computeRequestHash } from "../../src/assistant-v2/state.js";

const directories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "assistant-v2-run-"));
  directories.push(directory);
  return join(directory, "db.sqlite");
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("v2 assistant run persistence", () => {
  it("persists scoped run state with initial request link and no provider reasoning fields", () => {
    const store = createStore(databasePath(), { encryptionKey: "k" });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    const originalRequest = "List active projects";
    store.startRunWithTurn({
      scope: {
        sessionId: session.id,
        runId: "run-1",
        workspaceId: "ws-1",
        adminUserId: "admin-1",
        installationGeneration: 1,
        authClass: "addon",
      },
      originalRequest,
      requestHash: computeRequestHash(originalRequest),
      catalogHash: "a".repeat(64),
      loadedToolNames: ["assistant_find_api_operations"],
      intentHash: "intent-1",
    });
    const run = store.getRun({
      sessionId: session.id,
      runId: "run-1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      installationGeneration: 1,
      authClass: "addon",
    });
    expect(run?.originalRequest).toBe(originalRequest);
    expect(run?.phase).toBe("model");
    expect(run?.registryId).toBe("v2-api");
    expect(run?.loadedToolNames).toEqual(["assistant_find_api_operations"]);
    expect(run?.budget.modelCallsUsed).toBe(0);
    expect(run).not.toHaveProperty("reasoningContent");
    expect(run).not.toHaveProperty("providerTranscript");
    store.close();
  });

  it("returns undefined for a foreign session scope (404 semantics)", () => {
    const store = createStore(databasePath(), { encryptionKey: "k" });
    const sessionA = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    const sessionB = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-2" });
    store.startRunWithTurn({
      scope: {
        sessionId: sessionA.id,
        runId: "shared-run-id",
        workspaceId: "ws-1",
        adminUserId: "admin-1",
        installationGeneration: 1,
        authClass: "addon",
      },
      originalRequest: "hello",
      requestHash: computeRequestHash("hello"),
      catalogHash: "b".repeat(64),
      loadedToolNames: [],
      intentHash: "intent-a",
    });
    store.startRunWithTurn({
      scope: {
        sessionId: sessionB.id,
        runId: "shared-run-id",
        workspaceId: "ws-1",
        adminUserId: "admin-2",
        installationGeneration: 1,
        authClass: "addon",
      },
      originalRequest: "hello",
      requestHash: computeRequestHash("hello"),
      catalogHash: "b".repeat(64),
      loadedToolNames: [],
      intentHash: "intent-b",
    });
    expect(store.getRun({
      sessionId: sessionA.id,
      runId: "shared-run-id",
      workspaceId: "ws-1",
      adminUserId: "admin-2",
      installationGeneration: 1,
      authClass: "addon",
    })).toBeUndefined();
    store.close();
  });

  it("enforces one active nonterminal run per session", () => {
    const store = createStore(databasePath(), { encryptionKey: "k" });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    const scope = {
      sessionId: session.id,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      installationGeneration: 1,
      authClass: "addon" as const,
    };
    store.startRunWithTurn({
      scope: { ...scope, runId: "run-a" },
      originalRequest: "first",
      requestHash: computeRequestHash("first"),
      catalogHash: "c".repeat(64),
      loadedToolNames: [],
      intentHash: "i-a",
    });
    store.saveRun({
      version: 2,
      runId: "run-a",
      sessionId: session.id,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      installationGeneration: 1,
      authClass: "addon",
      originalRequest: "first",
      requestHash: computeRequestHash("first"),
      phase: "completed",
      registryId: "v2-api",
      catalogHash: "c".repeat(64),
      loadedToolNames: [],
      usedToolNames: [],
      completedResults: [],
      pendingOperationIds: [],
      unfinishedOperations: [],
      continuation: { kind: "none" },
      budget: {
        modelCallsUsed: 1,
        discoveryCallsUsed: 0,
        apiCallsUsed: 0,
        hostCallsUsed: 0,
        hostCallsReserved: 0,
        promptTokensUsed: 0,
        completionTokensUsed: 0,
        estimatedTokensUsed: 0,
        activeWallMsUsed: 0,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(() => store.startRunWithTurn({
      scope: { ...scope, runId: "run-b" },
      originalRequest: "second",
      requestHash: computeRequestHash("second"),
      catalogHash: "c".repeat(64),
      loadedToolNames: [],
      intentHash: "i-b",
    })).not.toThrow();
    store.close();
  });
});
