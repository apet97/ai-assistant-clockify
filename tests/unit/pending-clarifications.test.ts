import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "../../src/db/store.js";
import { computeRequestHash } from "../../src/assistant-v2/state.js";
import {
  CLARIFICATION_TTL_MS,
  PendingClarificationStoreError,
  type ClarificationCandidate,
} from "../../src/db/store/pending-clarifications.js";

function baseScope(sessionId: string, runId: string) {
  return {
    sessionId,
    runId,
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    installationGeneration: 1,
    authClass: "addon" as const,
  };
}

const CANDIDATES: ClarificationCandidate[] = [
  { optionId: "opt-1", externalId: "64abc1", label: "Marketing Site" },
  { optionId: "opt-2", externalId: "64abc2", label: "Marketing App" },
];

function startRun(store: ReturnType<typeof createStore>, sessionId: string, runId: string) {
  return store.startRunWithEvent({
    scope: baseScope(sessionId, runId),
    originalRequest: "hello",
    requestHash: computeRequestHash("hello"),
    catalogHash: "a".repeat(64),
    loadedToolNames: [],
    intentHash: runId,
  });
}

function databasePath(directories: string[]): string {
  const directory = mkdtempSync(join(tmpdir(), "pending-clarifications-"));
  directories.push(directory);
  return join(directory, "db.sqlite");
}

describe("pending clarifications store", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates a pending clarification scoped to session/run/workspace/admin", () => {
    const store = createStore(":memory:", { encryptionKey: "k" });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    startRun(store, session.id, "run-1");

    const record = store.createPendingClarification({
      sessionId: session.id,
      runId: "run-1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      originalToolName: "clockify_tasks_delete",
      partialArguments: { taskName: "Fix bug" },
      missingField: "taskId",
      candidates: CANDIDATES,
    });

    expect(record.status).toBe("pending");
    expect(record.candidates).toEqual(CANDIDATES);
    expect(new Date(record.expiresAt).getTime() - new Date(record.createdAt).getTime()).toBe(CLARIFICATION_TTL_MS);

    const fetched = store.getPendingClarification(record.id, {
      sessionId: session.id,
      runId: "run-1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
    });
    expect(fetched).toEqual(record);
    store.close();
  });

  it("rejects a lookup under a mismatched composite scope", () => {
    const store = createStore(":memory:", { encryptionKey: "k" });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    startRun(store, session.id, "run-1");
    const record = store.createPendingClarification({
      sessionId: session.id,
      runId: "run-1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      originalToolName: "clockify_tasks_delete",
      partialArguments: {},
      missingField: "taskId",
      candidates: CANDIDATES,
    });

    for (const badScope of [
      { sessionId: "other-session", runId: "run-1", workspaceId: "ws-1", adminUserId: "admin-1" },
      { sessionId: session.id, runId: "other-run", workspaceId: "ws-1", adminUserId: "admin-1" },
      { sessionId: session.id, runId: "run-1", workspaceId: "other-ws", adminUserId: "admin-1" },
      { sessionId: session.id, runId: "run-1", workspaceId: "ws-1", adminUserId: "other-admin" },
    ]) {
      expect(() => store.getPendingClarification(record.id, badScope)).toThrow(PendingClarificationStoreError);
    }
    store.close();
  });

  it("enforces exactly one active clarification per run", () => {
    const store = createStore(":memory:", { encryptionKey: "k" });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    startRun(store, session.id, "run-1");
    const scope = { sessionId: session.id, runId: "run-1", workspaceId: "ws-1", adminUserId: "admin-1" };
    store.createPendingClarification({
      ...scope,
      originalToolName: "clockify_tasks_delete",
      partialArguments: {},
      missingField: "taskId",
      candidates: CANDIDATES,
    });

    expect(() => store.createPendingClarification({
      ...scope,
      originalToolName: "clockify_tasks_delete",
      partialArguments: {},
      missingField: "taskId",
      candidates: CANDIDATES,
    })).toThrow("clarification_already_active");

    expect(store.getActiveClarificationForRun(scope)?.status).toBe("pending");
    store.close();
  });

  it("allows two different sessions to each have their own active clarification", () => {
    // Only one nonterminal run can exist per session at a time
    // (idx_assistant_runs_one_active_per_session), so two independently active
    // clarifications can only coexist across sessions, matching the plan's
    // "different sessions may each have one" invariant.
    const store = createStore(":memory:", { encryptionKey: "k" });
    const sessionA = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    const sessionB = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    startRun(store, sessionA.id, "run-1");
    startRun(store, sessionB.id, "run-2");
    store.createPendingClarification({
      sessionId: sessionA.id,
      runId: "run-1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      originalToolName: "clockify_tasks_delete",
      partialArguments: {},
      missingField: "taskId",
      candidates: CANDIDATES,
    });
    const second = store.createPendingClarification({
      sessionId: sessionB.id,
      runId: "run-2",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      originalToolName: "clockify_tasks_delete",
      partialArguments: {},
      missingField: "taskId",
      candidates: CANDIDATES,
    });
    expect(second.status).toBe("pending");
    store.close();
  });

  it("transitions pending -> resolving and rejects a second concurrent claim", () => {
    const store = createStore(":memory:", { encryptionKey: "k" });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    startRun(store, session.id, "run-1");
    const scope = { sessionId: session.id, runId: "run-1", workspaceId: "ws-1", adminUserId: "admin-1" };
    const created = store.createPendingClarification({
      ...scope,
      originalToolName: "clockify_tasks_delete",
      partialArguments: {},
      missingField: "taskId",
      candidates: CANDIDATES,
    });

    const claimed = store.claimClarificationResolving(created.id, scope);
    expect(claimed.status).toBe("resolving");

    expect(() => store.claimClarificationResolving(created.id, scope)).toThrow("clarification_not_pending");
    store.close();
  });

  it("rejects claiming an expired clarification", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T00:00:00.000Z"));
    const store = createStore(":memory:", { encryptionKey: "k" });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    startRun(store, session.id, "run-1");
    const scope = { sessionId: session.id, runId: "run-1", workspaceId: "ws-1", adminUserId: "admin-1" };
    const created = store.createPendingClarification({
      ...scope,
      originalToolName: "clockify_tasks_delete",
      partialArguments: {},
      missingField: "taskId",
      candidates: CANDIDATES,
    });

    vi.setSystemTime(new Date(Date.parse(created.expiresAt) + 1));
    expect(() => store.claimClarificationResolving(created.id, scope)).toThrow("clarification_expired");
    store.close();
  });

  it("resets an orphaned resolving clarification back to pending on crash recovery", () => {
    const store = createStore(":memory:", { encryptionKey: "k" });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    startRun(store, session.id, "run-1");
    const scope = { sessionId: session.id, runId: "run-1", workspaceId: "ws-1", adminUserId: "admin-1" };
    const created = store.createPendingClarification({
      ...scope,
      originalToolName: "clockify_tasks_delete",
      partialArguments: {},
      missingField: "taskId",
      candidates: CANDIDATES,
    });
    store.claimClarificationResolving(created.id, scope);

    const reset = store.resetClarificationToPending(created.id, scope);
    expect(reset.status).toBe("pending");
    expect(() => store.resetClarificationToPending(created.id, scope)).toThrow("clarification_not_resolving");
    store.close();
  });

  it("resolves a claimed clarification with a selected option and links its operation/result", () => {
    const store = createStore(":memory:", { encryptionKey: "k" });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    startRun(store, session.id, "run-1");
    const scope = { sessionId: session.id, runId: "run-1", workspaceId: "ws-1", adminUserId: "admin-1" };
    const created = store.createPendingClarification({
      ...scope,
      originalToolName: "clockify_tasks_delete",
      partialArguments: { taskName: "Fix bug" },
      missingField: "taskId",
      candidates: CANDIDATES,
    });
    store.claimClarificationResolving(created.id, scope);

    const operationId = store.prepareOperationRun({
      id: "op-resolve-1",
      sessionId: session.id,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      actionName: "clockify_tasks_delete",
      actionFingerprint: "fp",
      catalogHash: "a".repeat(64),
      operationHash: "oh-1",
      operation: { body: {} },
      discriminator: {
        origin: "assistant",
        registryId: "v2-api",
        authorityModel: "preview_confirmation_v2",
        executorKind: "risky_commit",
        runId: "run-1",
        fieldProvenanceJson: JSON.stringify({ "/taskId": { source: "model_inference" } }),
        fieldProvenanceHash: "b".repeat(64),
      },
    });
    store.markOperationExecuting(operationId);
    const resultRef = store.settleOperationResult(operationId, "succeeded", { ok: true });

    const resolved = store.resolveClarificationWithOption({
      id: created.id,
      scope,
      selectedOptionId: "opt-1",
      actionResultId: resultRef.id,
      operationId,
    });

    expect(resolved.status).toBe("resolved");
    expect(resolved.selectedOptionId).toBe("opt-1");
    expect(resolved.terminalReason).toBe("selected_option");
    expect(resolved.actionResultId).toBe(resultRef.id);
    expect(resolved.operationId).toBe(operationId);
    expect(resolved.resolvedAt).toBeDefined();
    expect(resolved.partialArguments).toEqual({});
    expect(resolved.candidates).toEqual([]);
    store.close();
  });

  it("rejects resolving a clarification that was never claimed", () => {
    const store = createStore(":memory:", { encryptionKey: "k" });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    startRun(store, session.id, "run-1");
    const scope = { sessionId: session.id, runId: "run-1", workspaceId: "ws-1", adminUserId: "admin-1" };
    const created = store.createPendingClarification({
      ...scope,
      originalToolName: "clockify_tasks_delete",
      partialArguments: {},
      missingField: "taskId",
      candidates: CANDIDATES,
    });

    expect(() => store.resolveClarificationWithOption({
      id: created.id,
      scope,
      selectedOptionId: "opt-1",
      actionResultId: "does-not-exist",
    })).toThrow("clarification_not_resolving");
    store.close();
  });

  it("continues a pending clarification with free text, scrubbing executable JSON", () => {
    const store = createStore(":memory:", { encryptionKey: "k" });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    startRun(store, session.id, "run-1");
    const scope = { sessionId: session.id, runId: "run-1", workspaceId: "ws-1", adminUserId: "admin-1" };
    const created = store.createPendingClarification({
      ...scope,
      originalToolName: "clockify_tasks_delete",
      partialArguments: { taskName: "Fix bug" },
      missingField: "taskId",
      candidates: CANDIDATES,
    });

    const continued = store.continueClarificationWithFreeText(created.id, scope);
    expect(continued.status).toBe("continued");
    expect(continued.terminalReason).toBe("free_text_continuation");
    expect(continued.partialArguments).toEqual({});
    expect(continued.candidates).toEqual([]);
    expect(continued.actionResultId).toBeUndefined();
    expect(continued.operationId).toBeUndefined();

    expect(() => store.continueClarificationWithFreeText(created.id, scope)).toThrow("clarification_not_pending");
    store.close();
  });

  it.each([
    ["superseded"] as const,
    ["stale_replaced"] as const,
    ["user_cancelled"] as const,
  ])("cancels a pending clarification with reason %s", (reason) => {
    const store = createStore(":memory:", { encryptionKey: "k" });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    startRun(store, session.id, "run-1");
    const scope = { sessionId: session.id, runId: "run-1", workspaceId: "ws-1", adminUserId: "admin-1" };
    const created = store.createPendingClarification({
      ...scope,
      originalToolName: "clockify_tasks_delete",
      partialArguments: {},
      missingField: "taskId",
      candidates: CANDIDATES,
    });

    const cancelled = store.cancelClarification({ id: created.id, scope, reason });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.terminalReason).toBe(reason);
    expect(cancelled.partialArguments).toEqual({});
    expect(cancelled.candidates).toEqual([]);
    store.close();
  });

  it("cancels a resolving clarification too", () => {
    const store = createStore(":memory:", { encryptionKey: "k" });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    startRun(store, session.id, "run-1");
    const scope = { sessionId: session.id, runId: "run-1", workspaceId: "ws-1", adminUserId: "admin-1" };
    const created = store.createPendingClarification({
      ...scope,
      originalToolName: "clockify_tasks_delete",
      partialArguments: {},
      missingField: "taskId",
      candidates: CANDIDATES,
    });
    store.claimClarificationResolving(created.id, scope);

    const cancelled = store.cancelClarification({ id: created.id, scope, reason: "superseded" });
    expect(cancelled.status).toBe("cancelled");
    store.close();
  });

  it("rejects cancelling an already-terminal clarification", () => {
    const store = createStore(":memory:", { encryptionKey: "k" });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    startRun(store, session.id, "run-1");
    const scope = { sessionId: session.id, runId: "run-1", workspaceId: "ws-1", adminUserId: "admin-1" };
    const created = store.createPendingClarification({
      ...scope,
      originalToolName: "clockify_tasks_delete",
      partialArguments: {},
      missingField: "taskId",
      candidates: CANDIDATES,
    });
    store.cancelClarification({ id: created.id, scope, reason: "user_cancelled" });

    expect(() => store.cancelClarification({ id: created.id, scope, reason: "superseded" }))
      .toThrow("clarification_not_active");
    store.close();
  });

  it("blocks a raw UPDATE that leaves a terminal row unscrubbed (defense in depth)", () => {
    const path = databasePath(directories);
    const store = createStore(path, { encryptionKey: "k" });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    startRun(store, session.id, "run-1");
    const scope = { sessionId: session.id, runId: "run-1", workspaceId: "ws-1", adminUserId: "admin-1" };
    const created = store.createPendingClarification({
      ...scope,
      originalToolName: "clockify_tasks_delete",
      partialArguments: { taskName: "Fix bug" },
      missingField: "taskId",
      candidates: CANDIDATES,
    });
    store.close();

    const raw = new Database(path);
    expect(() => raw.prepare(
      `UPDATE pending_clarifications SET
         status = 'cancelled', terminal_reason = 'user_cancelled', resolved_at = ?
       WHERE id = ?`,
    ).run(new Date().toISOString(), created.id)).toThrow(/terminal_clarification_not_scrubbed/);
    raw.close();
  });

  it("cascades deletion when the parent assistant run is removed", () => {
    const store = createStore(":memory:", { encryptionKey: "k" });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    startRun(store, session.id, "run-1");
    const scope = { sessionId: session.id, runId: "run-1", workspaceId: "ws-1", adminUserId: "admin-1" };
    const created = store.createPendingClarification({
      ...scope,
      originalToolName: "clockify_tasks_delete",
      partialArguments: {},
      missingField: "taskId",
      candidates: CANDIDATES,
    });

    store.eraseWorkspace("ws-1");
    expect(store.getPendingClarification(created.id, scope)).toBeUndefined();
    store.close();
  });
});
