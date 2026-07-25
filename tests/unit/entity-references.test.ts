import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createStore } from "../../src/db/store.js";
import { computeRequestHash } from "../../src/assistant-v2/state.js";
import { EntityReferenceStoreError } from "../../src/db/store/entity-references.js";

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
  const directory = mkdtempSync(join(tmpdir(), "entity-references-"));
  directories.push(directory);
  return join(directory, "db.sqlite");
}

describe("entity references store", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("upserts a new active reference scoped to session/workspace/admin", () => {
    const store = createStore(":memory:", { encryptionKey: "k" });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    startRun(store, session.id, "run-1");

    const record = store.upsertEntityReference({
      sessionId: session.id,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      entityType: "project",
      externalId: "64abc1",
      displayName: "Marketing Site",
      bindings: [{ referenceField: "externalId", argumentPath: "/projectId" }],
      bindingFingerprint: "a".repeat(64),
      sourceRunId: "run-1",
    });

    expect(record.status).toBe("active");
    expect(record.entityType).toBe("project");
    expect(record.bindings).toEqual([{ referenceField: "externalId", argumentPath: "/projectId" }]);

    const fetched = store.getEntityReference(record.id, {
      sessionId: session.id,
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
    const record = store.upsertEntityReference({
      sessionId: session.id,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      entityType: "project",
      externalId: "64abc1",
      displayName: "Marketing Site",
      bindings: [],
      bindingFingerprint: "a".repeat(64),
      sourceRunId: "run-1",
    });

    for (const badScope of [
      { sessionId: "other-session", workspaceId: "ws-1", adminUserId: "admin-1" },
      { sessionId: session.id, workspaceId: "other-ws", adminUserId: "admin-1" },
      { sessionId: session.id, workspaceId: "ws-1", adminUserId: "other-admin" },
    ]) {
      expect(() => store.getEntityReference(record.id, badScope)).toThrow(EntityReferenceStoreError);
    }
    store.close();
  });

  it("refreshes an existing reference in place on a later sighting of the same entity", () => {
    const store = createStore(":memory:", { encryptionKey: "k" });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    startRun(store, session.id, "run-1");
    // Only one nonterminal run per session is allowed
    // (idx_assistant_runs_one_active_per_session); terminate run-1 before
    // starting run-2 so both remain valid FK parents for their references.
    const runState = store.getRun(baseScope(session.id, "run-1"))!;
    store.failRunWithEvent(baseScope(session.id, "run-1"), runState, { code: "test_teardown" });
    startRun(store, session.id, "run-2");
    const scope = { sessionId: session.id, workspaceId: "ws-1", adminUserId: "admin-1" };

    const first = store.upsertEntityReference({
      ...scope,
      entityType: "project",
      externalId: "64abc1",
      displayName: "Marketing Site",
      bindings: [],
      bindingFingerprint: "a".repeat(64),
      sourceRunId: "run-1",
    });

    const second = store.upsertEntityReference({
      ...scope,
      entityType: "project",
      externalId: "64abc1",
      displayName: "Marketing Site (renamed)",
      bindings: [{ referenceField: "externalId", argumentPath: "/projectId" }],
      bindingFingerprint: "b".repeat(64),
      sourceRunId: "run-2",
    });

    expect(second.id).toBe(first.id);
    expect(second.displayName).toBe("Marketing Site (renamed)");
    expect(second.sourceRunId).toBe("run-2");
    expect(Date.parse(second.verifiedAt)).toBeGreaterThanOrEqual(Date.parse(first.verifiedAt));

    const all = store.listRecentActiveEntityReferences(scope);
    expect(all).toHaveLength(1);
    store.close();
  });

  it("keeps distinct entity types with the same externalId as separate rows", () => {
    const store = createStore(":memory:", { encryptionKey: "k" });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    startRun(store, session.id, "run-1");
    const scope = { sessionId: session.id, workspaceId: "ws-1", adminUserId: "admin-1" };

    store.upsertEntityReference({
      ...scope,
      entityType: "project",
      externalId: "64abc1",
      displayName: "Marketing Site",
      bindings: [],
      bindingFingerprint: "a".repeat(64),
      sourceRunId: "run-1",
    });
    store.upsertEntityReference({
      ...scope,
      entityType: "task",
      externalId: "64abc1",
      displayName: "Same id, different entity",
      bindings: [],
      bindingFingerprint: "a".repeat(64),
      sourceRunId: "run-1",
    });

    expect(store.listRecentActiveEntityReferences(scope)).toHaveLength(2);
    store.close();
  });

  it("lists only active references, most recently verified first, bounded by limit", () => {
    const store = createStore(":memory:", { encryptionKey: "k" });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    startRun(store, session.id, "run-1");
    const scope = { sessionId: session.id, workspaceId: "ws-1", adminUserId: "admin-1" };

    const refs = [];
    for (let index = 0; index < 5; index += 1) {
      refs.push(store.upsertEntityReference({
        ...scope,
        entityType: "project",
        externalId: `64abc${index}`,
        displayName: `Project ${index}`,
        bindings: [],
        bindingFingerprint: "a".repeat(64),
        sourceRunId: "run-1",
      }));
    }
    const stale = store.markEntityReferenceStatus(refs[0]!.id, scope, "stale");
    expect(stale.status).toBe("stale");

    const listed = store.listRecentActiveEntityReferences(scope, 3);
    expect(listed).toHaveLength(3);
    expect(listed.every((r) => r.status === "active")).toBe(true);
    expect(listed.map((r) => r.id)).not.toContain(refs[0]!.id);
    store.close();
  });

  it.each(["stale", "deleted"] as const)("transitions status to %s", (status) => {
    const store = createStore(":memory:", { encryptionKey: "k" });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    startRun(store, session.id, "run-1");
    const scope = { sessionId: session.id, workspaceId: "ws-1", adminUserId: "admin-1" };
    const record = store.upsertEntityReference({
      ...scope,
      entityType: "project",
      externalId: "64abc1",
      displayName: "Marketing Site",
      bindings: [],
      bindingFingerprint: "a".repeat(64),
      sourceRunId: "run-1",
    });

    const updated = store.markEntityReferenceStatus(record.id, scope, status);
    expect(updated.status).toBe(status);
    store.close();
  });

  it("rejects marking status on an unknown reference", () => {
    const store = createStore(":memory:", { encryptionKey: "k" });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    const scope = { sessionId: session.id, workspaceId: "ws-1", adminUserId: "admin-1" };
    expect(() => store.markEntityReferenceStatus("missing-id", scope, "stale"))
      .toThrow("entity_reference_not_found");
    store.close();
  });

  it("cascades deletion when the parent assistant run is removed", () => {
    const path = databasePath(directories);
    const store = createStore(path, { encryptionKey: "k" });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    startRun(store, session.id, "run-1");
    const record = store.upsertEntityReference({
      sessionId: session.id,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      entityType: "project",
      externalId: "64abc1",
      displayName: "Marketing Site",
      bindings: [],
      bindingFingerprint: "a".repeat(64),
      sourceRunId: "run-1",
    });
    store.close();

    const raw = new Database(path);
    raw.prepare("DELETE FROM assistant_runs WHERE run_id = ?").run("run-1");
    expect(raw.prepare("SELECT COUNT(*) AS n FROM entity_references WHERE id = ?").get(record.id))
      .toEqual({ n: 0 });
    raw.close();
  });

  it("is erased on workspace erasure", () => {
    const store = createStore(":memory:", { encryptionKey: "k" });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    startRun(store, session.id, "run-1");
    const scope = { sessionId: session.id, workspaceId: "ws-1", adminUserId: "admin-1" };
    const record = store.upsertEntityReference({
      ...scope,
      entityType: "project",
      externalId: "64abc1",
      displayName: "Marketing Site",
      bindings: [],
      bindingFingerprint: "a".repeat(64),
      sourceRunId: "run-1",
    });

    const counts = store.eraseWorkspace("ws-1");
    expect(counts.entityReferences).toBe(1);
    expect(store.getEntityReference(record.id, scope)).toBeUndefined();
    store.close();
  });
});
