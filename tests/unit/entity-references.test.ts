import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createStore } from "../../src/db/store.js";
import { computeRequestHash } from "../../src/assistant-v2/state.js";
import { EntityReferenceStoreError, type EntityReferenceRecord } from "../../src/db/store/entity-references.js";
import { resolveEntityReference } from "../../src/assistant-v2/references/entity-reference.js";
import type { ReferenceSelectorMetadata } from "../../src/harness/api-operation.js";
import { normalizeRegistryAction } from "../../src/harness/action-registry.js";
import { getAction } from "../../src/harness/catalog.js";
import type { RiskLabel } from "../../src/harness/risk.js";

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
      bindings: [{ field: "scope.projectId", value: "64parent1" }],
      bindingFingerprint: "a".repeat(64),
      sourceRunId: "run-1",
    });

    expect(record.status).toBe("active");
    expect(record.entityType).toBe("project");
    expect(record.bindings).toEqual([{ field: "scope.projectId", value: "64parent1" }]);

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
      bindings: [{ field: "scope.projectId", value: "64parent1" }],
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

const TASK_SELECTOR: ReferenceSelectorMetadata = {
  entityType: "task",
  bindings: [
    { referenceField: "externalId", argumentPath: "/taskId" },
    { referenceField: "scope.projectId", argumentPath: "/projectId" },
  ],
};

function fixtureRecord(overrides: Partial<EntityReferenceRecord> = {}): EntityReferenceRecord {
  return {
    id: "ref-1",
    sessionId: "session-1",
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    entityType: "task",
    externalId: "64task1",
    displayName: "Fix bug",
    bindings: [{ field: "scope.projectId", value: "64project1" }],
    bindingFingerprint: "a".repeat(64),
    sourceRunId: "run-1",
    status: "active",
    verifiedAt: "2026-07-26T00:00:00.000Z",
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
    ...overrides,
  };
}

describe("resolveEntityReference", () => {
  it("injects the reviewed binding values and strips referenceId", () => {
    const record = fixtureRecord();
    const result = resolveEntityReference({
      rawArgs: { referenceId: "ref-1", description: "Fixed the login bug" },
      selector: TASK_SELECTOR,
      lookup: (entityType, referenceId) =>
        entityType === "task" && referenceId === "ref-1" ? record : undefined,
    });
    expect(result).toEqual({
      ok: true,
      reference: record,
      args: { description: "Fixed the login bug", taskId: "64task1", projectId: "64project1" },
    });
  });

  it("fails when referenceId is absent, empty, or not a string", () => {
    for (const rawArgs of [{}, { referenceId: "" }, { referenceId: 42 }]) {
      const result = resolveEntityReference({
        rawArgs,
        selector: TASK_SELECTOR,
        lookup: () => fixtureRecord(),
      });
      expect(result).toEqual({ ok: false, code: "reference_not_supplied" });
    }
  });

  it("fails closed on a foreign/unknown reference id", () => {
    const result = resolveEntityReference({
      rawArgs: { referenceId: "does-not-exist" },
      selector: TASK_SELECTOR,
      lookup: () => undefined,
    });
    expect(result).toEqual({ ok: false, code: "reference_not_found" });
  });

  it.each(["stale", "deleted"] as const)("fails closed on a %s reference", (status) => {
    const record = fixtureRecord({ status });
    const result = resolveEntityReference({
      rawArgs: { referenceId: "ref-1" },
      selector: TASK_SELECTOR,
      lookup: () => record,
    });
    expect(result).toEqual({ ok: false, code: "reference_not_active" });
  });

  it("fails closed when the reference's entity type does not match the selector", () => {
    const record = fixtureRecord({ entityType: "project", bindings: [] });
    const result = resolveEntityReference({
      rawArgs: { referenceId: "ref-1" },
      selector: TASK_SELECTOR,
      lookup: () => record,
    });
    expect(result).toEqual({ ok: false, code: "reference_wrong_entity_type" });
  });

  it("fails closed when a required scope binding is missing on the reference", () => {
    const record = fixtureRecord({ bindings: [] });
    const result = resolveEntityReference({
      rawArgs: { referenceId: "ref-1" },
      selector: TASK_SELECTOR,
      lookup: () => record,
    });
    expect(result).toEqual({ ok: false, code: "reference_wrong_entity_type" });
  });

  it("resolves when an explicit id already present agrees with the reference", () => {
    const record = fixtureRecord();
    const result = resolveEntityReference({
      rawArgs: { referenceId: "ref-1", taskId: "64task1" },
      selector: TASK_SELECTOR,
      lookup: () => record,
    });
    expect(result.ok).toBe(true);
  });

  it("fails closed on a conflicting explicit id (never silently overwrites)", () => {
    const record = fixtureRecord();
    const result = resolveEntityReference({
      rawArgs: { referenceId: "ref-1", taskId: "some-other-task-id" },
      selector: TASK_SELECTOR,
      lookup: () => record,
    });
    expect(result).toEqual({ ok: false, code: "reference_conflicts_with_explicit_id" });
  });

  it("does not guess a reference from an arbitrary 'id'-shaped property", () => {
    // Only `referenceId` is ever consulted; a raw `id` field must pass through
    // untouched (no recursive/implicit reference guessing, per the plan).
    const record = fixtureRecord();
    const result = resolveEntityReference({
      rawArgs: { id: "ref-1", taskId: "explicit-task-id" },
      selector: TASK_SELECTOR,
      lookup: () => record,
    });
    expect(result).toEqual({ ok: false, code: "reference_not_supplied" });
  });

  it("does not mutate the caller's rawArgs object", () => {
    const record = fixtureRecord();
    const rawArgs = { referenceId: "ref-1" };
    resolveEntityReference({ rawArgs, selector: TASK_SELECTOR, lookup: () => record });
    expect(rawArgs).toEqual({ referenceId: "ref-1" });
  });
});

describe("referenceSelector registry normalization", () => {
  it("rejects referenceSelector on a non-api-exposed action", () => {
    const carrier = {
      apiExposure: "local" as const,
      availabilityByAuthClass: {
        addon: { available: true as const },
        api_key: { available: true as const },
      },
      referenceSelector: TASK_SELECTOR,
    };
    const definition = {
      name: "metadata_reference_fixture",
      description: "fixture",
      featureGroup: "time_tracking" as const,
      risks: ["read"] as RiskLabel[],
      schema: {} as never,
      kind: "read" as const,
      async handler() {
        return { kind: "receipt" as const, receipt: { ok: true as const, action: "metadata_reference_fixture" } };
      },
      ...carrier,
    };
    expect(() => normalizeRegistryAction(definition, "v2-local"))
      .toThrow("unexpected_reference_selector:metadata_reference_fixture");
  });

  it("accepts a valid referenceSelector on a real api-exposed action and participates in its fingerprint", () => {
    const base = getAction("clockify_tags_create");
    if (!base) throw new Error("clockify_tags_create fixture missing");
    const withSelector = { ...base, referenceSelector: TASK_SELECTOR };
    const normalized = normalizeRegistryAction(withSelector, "v2-api");
    expect(normalized.referenceSelector).toEqual(TASK_SELECTOR);

    const withoutSelector = normalizeRegistryAction(base, "v2-api");
    expect(withoutSelector.referenceSelector).toBeUndefined();
  });

  it.each([
    ["missing entityType", { entityType: "", bindings: [{ referenceField: "externalId", argumentPath: "/taskId" }] }],
    ["empty bindings", { entityType: "task", bindings: [] }],
    ["unknown referenceField", { entityType: "task", bindings: [{ referenceField: "bogus", argumentPath: "/taskId" }] }],
    ["non-pointer argumentPath", { entityType: "task", bindings: [{ referenceField: "externalId", argumentPath: "taskId" }] }],
    ["duplicate referenceField", { entityType: "task", bindings: [
      { referenceField: "externalId", argumentPath: "/taskId" },
      { referenceField: "externalId", argumentPath: "/otherTaskId" },
    ] }],
  ] as const)("rejects an invalid referenceSelector: %s", (_label, badSelector) => {
    const base = getAction("clockify_tags_create");
    if (!base) throw new Error("clockify_tags_create fixture missing");
    const withSelector = { ...base, referenceSelector: badSelector as unknown as ReferenceSelectorMetadata };
    expect(() => normalizeRegistryAction(withSelector, "v2-api")).toThrow(/reference_selector/);
  });
});
