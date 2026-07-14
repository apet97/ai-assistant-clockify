import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { createStore } from "../../src/db/store.js";
import {
  buildAllowIntentCapabilityV1,
  buildDenyAllWritesIntentCapabilityV1,
  hashIntentCapability,
  validateUtf8SourceSpan,
  type IntentCapabilityV1,
  type Utf8SourceSpan,
} from "../../src/harness/intent-capability.js";
import { createPendingConfirmation } from "../../src/harness/confirmations.js";

function spanFor(source: string, text: string): Utf8SourceSpan {
  const start = source.indexOf(text);
  if (start < 0) throw new Error("test_span_missing");
  return {
    startByte: Buffer.byteLength(source.slice(0, start), "utf8"),
    endByte: Buffer.byteLength(source.slice(0, start + text.length), "utf8"),
    text,
  };
}

function allowCapability(source: string, maxExecutions = 1): IntentCapabilityV1 {
  const nameSpan = spanFor(source, "Acme");
  return buildAllowIntentCapabilityV1({
    authoredSource: source,
    catalogHash: "catalog-1",
    writeActions: [{
      actionName: "clockify_clients_create",
      sourceSpans: [nameSpan],
      literalConstraints: [{ path: "name", value: "Acme", sourceSpan: nameSpan }],
      maxExecutions,
    }],
  });
}

function scope() {
  return {
    workspaceId: "workspace-1",
    adminUserId: "admin-1",
    sessionId: "session-1",
    requestId: "request-1",
  };
}

describe("IntentCapabilityV1 contract", () => {
  it.each([
    ["Serbian Latin", "Kreiraj klijenta Acme danas"],
    ["Serbian Latin with diacritics", "Kreiraj klijenta Acme za Željka"],
    ["Serbian Cyrillic", "Креирај клијента Acme данас"],
  ])("uses UTF-8 byte spans for %s authored text", (_label, source) => {
    const capability = allowCapability(source);
    const span = capability.writeActions[0]?.sourceSpans[0];
    expect(span && validateUtf8SourceSpan(source, span)).toBe("Acme");
    expect(capability.writeActions[0]?.maxExecutions).toBe(1);
    expect(hashIntentCapability(capability)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashIntentCapability(capability)).toBe(hashIntentCapability(capability));
  });

  it("rejects UTF-8 spans that split a Serbian multibyte code point", () => {
    const source = "Promeni ime u Željko";
    const startByte = Buffer.byteLength("Promeni ime u ", "utf8");
    expect(() => validateUtf8SourceSpan(source, {
      startByte: startByte + 1,
      endByte: startByte + 2,
      text: "Ž",
    })).toThrow("intent_capability_span_boundary");
  });

  it("defaults each exact write action to one execution and supports durable deny-all", () => {
    const source = "Kreiraj klijenta Acme";
    expect(allowCapability(source).writeActions[0]?.maxExecutions).toBe(1);

    const denied = buildDenyAllWritesIntentCapabilityV1({
      authoredSource: source,
      catalogHash: "catalog-1",
      reason: "provider_unavailable",
    });
    expect(denied).toMatchObject({ mode: "deny_all_writes", reason: "provider_unavailable", writeActions: [] });
  });

  it("rejects sensitive literal paths and oversized capability JSON", () => {
    const source = "Kreiraj klijenta Acme";
    const sourceSpan = spanFor(source, "Acme");
    expect(() => buildAllowIntentCapabilityV1({
      authoredSource: source,
      catalogHash: "catalog-1",
      writeActions: [{
        actionName: "clockify_clients_create",
        sourceSpans: [sourceSpan],
        literalConstraints: [{ path: "apiToken", value: "Acme", sourceSpan }],
      }],
    })).toThrow("intent_capability_sensitive_path");

    const huge = "x".repeat(70_000);
    expect(() => buildAllowIntentCapabilityV1({
      authoredSource: huge,
      catalogHash: "catalog-1",
      writeActions: [{
        actionName: "clockify_clients_create",
        sourceSpans: [{ startByte: 0, endByte: 70_000, text: huge }],
        literalConstraints: [],
      }],
    })).toThrow("durable_evidence_too_large");
  });
});

describe("intent capability store", () => {
  it("creates and scoped-loads an immutable capability, replaying the same request", () => {
    const store = createStore(":memory:");
    const authoredSource = "Kreiraj klijenta Acme";
    const capability = allowCapability(authoredSource);
    const created = store.createIntentCapability({
      id: "capability-1",
      ...scope(),
      authoredSource,
      capability,
    });
    const replay = store.createIntentCapability({
      id: "ignored-on-replay",
      ...scope(),
      authoredSource,
      capability,
    });

    expect(replay.id).toBe(created.id);
    expect(store.getIntentCapability(created.id, {
      ...scope(),
      requestHash: capability.requestHash,
      catalogHash: capability.catalogHash,
    })).toEqual(created);
    store.close();
  });

  it("atomically binds an operation and confirmation, then replays the exact binding", () => {
    const store = createStore(":memory:");
    const bindingScope = {
      ...scope(),
      sessionId: store.createSession({ workspaceId: scope().workspaceId, adminUserId: scope().adminUserId }).id,
    };
    const authoredSource = "Kreiraj klijenta Acme";
    const capability = allowCapability(authoredSource);
    const record = store.createIntentCapability({ id: "capability-bind", ...bindingScope, authoredSource, capability });
    const operationId = store.prepareOperationRun({
      id: "operation-bind",
      requestId: bindingScope.requestId,
      sessionId: bindingScope.sessionId,
      workspaceId: bindingScope.workspaceId,
      adminUserId: bindingScope.adminUserId,
      actionName: "clockify_clients_create",
      actionFingerprint: "action-fingerprint",
      catalogHash: capability.catalogHash,
      operationHash: "operation-hash",
    });
    const confirmation = createPendingConfirmation({
      id: "confirmation-bind",
      nonce: "nonce",
      ...bindingScope,
      risk: ["safe_write"],
      preview: {},
      operation: { operationId, actionName: "clockify_clients_create" },
      sessionSecret: "session-secret",
      actionFingerprint: "action-fingerprint",
      catalogHash: capability.catalogHash,
    }).record;
    store.savePendingConfirmation(confirmation);
    const binding = {
      ...bindingScope,
      capabilityId: record.id,
      capabilityHash: record.capabilityHash,
      requestHash: capability.requestHash,
      catalogHash: capability.catalogHash,
      actionName: "clockify_clients_create",
      operationId,
      confirmationId: confirmation.id,
    };

    expect(store.bindIntentCapabilityOperation(binding)).toEqual({ state: "bound" });
    expect(store.bindIntentCapabilityOperation(binding)).toEqual({ state: "replay" });
    expect(store.getOperationRun(operationId)).toMatchObject({ capabilityId: record.id, capabilityHash: record.capabilityHash });
    expect(store.getPendingConfirmation(confirmation.id)).toMatchObject({ capabilityId: record.id, capabilityHash: record.capabilityHash });
    store.close();
  });

  it("rejects workspace, admin, session, request, catalog, hash, and action drift", () => {
    const store = createStore(":memory:");
    const authoredSource = "Kreiraj klijenta Acme";
    const capability = allowCapability(authoredSource);
    const record = store.createIntentCapability({ id: "capability-drift", ...scope(), authoredSource, capability });
    const operationId = store.prepareOperationRun({
      id: "operation-drift", requestId: scope().requestId, sessionId: scope().sessionId,
      workspaceId: scope().workspaceId, adminUserId: scope().adminUserId,
      actionName: "clockify_clients_create", actionFingerprint: "af",
      catalogHash: capability.catalogHash, operationHash: "oh",
    });
    const base = {
      ...scope(), capabilityId: record.id, capabilityHash: record.capabilityHash,
      requestHash: capability.requestHash, catalogHash: capability.catalogHash,
      actionName: "clockify_clients_create", operationId,
    };
    const drifts: Array<[Record<string, string>, string]> = [
      [{ workspaceId: "other" }, "intent_capability_workspace_drift"],
      [{ adminUserId: "other" }, "intent_capability_admin_drift"],
      [{ sessionId: "other" }, "intent_capability_session_drift"],
      [{ requestId: "other" }, "intent_capability_request_drift"],
      [{ catalogHash: "other" }, "intent_capability_catalog_drift"],
      [{ capabilityHash: "other" }, "intent_capability_hash_drift"],
      [{ actionName: "clockify_projects_delete" }, "intent_capability_action_drift"],
    ];
    for (const [change, code] of drifts) {
      expect(() => store.bindIntentCapabilityOperation({ ...base, ...change })).toThrow(code);
    }
    store.close();
  });

  it("consumes one execution atomically and does not charge a bound operation replay twice", () => {
    const path = join(tmpdir(), `intent-capability-${randomUUID()}.sqlite`);
    try {
      const first = createStore(path);
      const second = createStore(path);
      const authoredSource = "Kreiraj klijenta Acme";
      const capability = allowCapability(authoredSource);
      const record = first.createIntentCapability({ id: "capability-limit", ...scope(), authoredSource, capability });
      const binding = (store: ReturnType<typeof createStore>, operationId: string) => {
        store.prepareOperationRun({
          id: operationId, requestId: scope().requestId, sessionId: scope().sessionId,
          workspaceId: scope().workspaceId, adminUserId: scope().adminUserId,
          actionName: "clockify_clients_create", actionFingerprint: "af",
          catalogHash: capability.catalogHash, operationHash: `hash-${operationId}`,
        });
        const input = {
          ...scope(), capabilityId: record.id, capabilityHash: record.capabilityHash,
          requestHash: capability.requestHash, catalogHash: capability.catalogHash,
          actionName: "clockify_clients_create", operationId,
        };
        expect(store.bindIntentCapabilityOperation(input)).toEqual({ state: "bound" });
        return input;
      };
      const operationOne = binding(first, "operation-one");
      const operationTwo = binding(second, "operation-two");

      expect(first.consumeIntentCapabilityExecution(operationOne)).toEqual({ state: "consumed", execution: 1 });
      expect(second.consumeIntentCapabilityExecution(operationOne)).toEqual({ state: "replay", execution: 1 });
      expect(second.consumeIntentCapabilityExecution(operationTwo)).toEqual({ state: "denied", reason: "execution_limit" });
      first.close();
      second.close();
    } finally {
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });

  it("reloads a confirmation-bound capability after restart and consumes by operation without caller request hashes", () => {
    const path = join(tmpdir(), `intent-capability-resume-${randomUUID()}.sqlite`);
    try {
      const before = createStore(path);
      const persistedScope = {
        workspaceId: "workspace-resume",
        adminUserId: "admin-resume",
        sessionId: before.createSession({ workspaceId: "workspace-resume", adminUserId: "admin-resume" }).id,
        requestId: "request-resume",
      };
      const authoredSource = "Kreiraj klijenta Acme";
      const capability = allowCapability(authoredSource);
      const record = before.createIntentCapability({
        id: "capability-resume", ...persistedScope, authoredSource, capability,
      });
      const operationId = before.prepareOperationRun({
        id: "operation-resume", requestId: persistedScope.requestId,
        sessionId: persistedScope.sessionId, workspaceId: persistedScope.workspaceId,
        adminUserId: persistedScope.adminUserId, actionName: "clockify_clients_create",
        actionFingerprint: "action-resume", catalogHash: capability.catalogHash,
        operationHash: "operation-resume-hash",
      });
      const confirmation = createPendingConfirmation({
        id: "confirmation-resume", nonce: "nonce", ...persistedScope,
        risk: ["high_risk_write"], preview: {},
        operation: { operationId, actionName: "clockify_clients_create" },
        sessionSecret: "session-secret", actionFingerprint: "action-resume",
        catalogHash: capability.catalogHash,
      }).record;
      expect(confirmation.agentState).toBeUndefined();
      before.savePendingConfirmation(confirmation);
      before.bindIntentCapabilityOperation({
        ...persistedScope, requestHash: capability.requestHash,
        catalogHash: capability.catalogHash, actionName: "clockify_clients_create",
        capabilityId: record.id, capabilityHash: record.capabilityHash,
        operationId, confirmationId: confirmation.id,
      });
      before.close();

      const after = createStore(path);
      const operationScope = {
        operationId,
        workspaceId: persistedScope.workspaceId,
        adminUserId: persistedScope.adminUserId,
        sessionId: persistedScope.sessionId,
        capabilityId: record.id,
        capabilityHash: record.capabilityHash,
        expectedCatalogHash: capability.catalogHash,
        expectedActionName: "clockify_clients_create",
      };
      expect(after.getIntentCapabilityForOperation(operationScope)).toEqual(record);
      expect(after.consumeIntentCapabilityForOperation(operationScope)).toEqual({ state: "consumed", execution: 1 });
      expect(after.consumeIntentCapabilityForOperation(operationScope)).toEqual({ state: "replay", execution: 1 });
      after.close();
    } finally {
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });

  it("rejects operation-scoped IDOR and current catalog/action drift without caller request hashes", () => {
    const store = createStore(":memory:");
    const authoredSource = "Kreiraj klijenta Acme";
    const capability = allowCapability(authoredSource);
    const record = store.createIntentCapability({ id: "capability-idor", ...scope(), authoredSource, capability });
    const operationId = store.prepareOperationRun({
      id: "operation-idor", requestId: scope().requestId, sessionId: scope().sessionId,
      workspaceId: scope().workspaceId, adminUserId: scope().adminUserId,
      actionName: "clockify_clients_create", actionFingerprint: "af",
      catalogHash: capability.catalogHash, operationHash: "oh",
      capabilityId: record.id, capabilityHash: record.capabilityHash,
    });
    const base = {
      operationId, workspaceId: scope().workspaceId, adminUserId: scope().adminUserId,
      sessionId: scope().sessionId, capabilityId: record.id, capabilityHash: record.capabilityHash,
      expectedCatalogHash: capability.catalogHash, expectedActionName: "clockify_clients_create",
    };

    expect(() => store.getIntentCapabilityForOperation({ ...base, workspaceId: "other" }))
      .toThrow("intent_capability_workspace_drift");
    expect(() => store.getIntentCapabilityForOperation({ ...base, adminUserId: "other" }))
      .toThrow("intent_capability_admin_drift");
    expect(() => store.getIntentCapabilityForOperation({ ...base, sessionId: "other" }))
      .toThrow("intent_capability_session_drift");
    expect(() => store.getIntentCapabilityForOperation({ ...base, capabilityId: "other" }))
      .toThrow("intent_capability_binding_drift");
    expect(() => store.getIntentCapabilityForOperation({ ...base, capabilityHash: "other" }))
      .toThrow("intent_capability_hash_drift");
    expect(() => store.getIntentCapabilityForOperation({ ...base, expectedCatalogHash: "other" }))
      .toThrow("intent_capability_catalog_drift");
    expect(() => store.getIntentCapabilityForOperation({ ...base, expectedActionName: "clockify_projects_delete" }))
      .toThrow("intent_capability_action_drift");
    store.close();
  });

  it("detects persisted request, catalog, and capability-binding drift after restart", () => {
    const path = join(tmpdir(), `intent-capability-drift-${randomUUID()}.sqlite`);
    try {
      const before = createStore(path);
      const authoredSource = "Kreiraj klijenta Acme";
      const capability = allowCapability(authoredSource);
      const record = before.createIntentCapability({ id: "capability-persisted-drift", ...scope(), authoredSource, capability });
      const operationId = before.prepareOperationRun({
        id: "operation-persisted-drift", requestId: scope().requestId, sessionId: scope().sessionId,
        workspaceId: scope().workspaceId, adminUserId: scope().adminUserId,
        actionName: "clockify_clients_create", actionFingerprint: "af",
        catalogHash: capability.catalogHash, operationHash: "oh",
        capabilityId: record.id, capabilityHash: record.capabilityHash,
      });
      before.close();
      const operationScope = {
        operationId, workspaceId: scope().workspaceId, adminUserId: scope().adminUserId,
        sessionId: scope().sessionId, capabilityId: record.id, capabilityHash: record.capabilityHash,
      };

      const raw = new Database(path);
      raw.prepare("UPDATE operation_runs SET request_id = 'other-request' WHERE id = ?").run(operationId);
      raw.close();
      const afterRequestDrift = createStore(path);
      expect(() => afterRequestDrift.getIntentCapabilityForOperation(operationScope))
        .toThrow("intent_capability_request_drift");
      afterRequestDrift.close();

      const rawCatalog = new Database(path);
      rawCatalog.prepare(
        "UPDATE operation_runs SET request_id = ?, catalog_hash = 'other-catalog' WHERE id = ?",
      ).run(scope().requestId, operationId);
      rawCatalog.close();
      const afterCatalogDrift = createStore(path);
      expect(() => afterCatalogDrift.getIntentCapabilityForOperation(operationScope))
        .toThrow("intent_capability_catalog_drift");
      afterCatalogDrift.close();

      const rawBinding = new Database(path);
      rawBinding.prepare(
        "UPDATE operation_runs SET catalog_hash = ?, capability_hash = 'other-hash' WHERE id = ?",
      ).run(capability.catalogHash, operationId);
      rawBinding.close();
      const afterBindingDrift = createStore(path);
      expect(() => afterBindingDrift.getIntentCapabilityForOperation(operationScope))
        .toThrow("intent_capability_hash_drift");
      afterBindingDrift.close();
    } finally {
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });

  it("serializes a genuine two-handle consume race without leaking a raw SQLite error", async () => {
    const path = join(tmpdir(), `intent-capability-worker-race-${randomUUID()}.sqlite`);
    const workers: Worker[] = [];
    try {
      const setup = createStore(path);
      const authoredSource = "Kreiraj klijenta Acme";
      const capability = allowCapability(authoredSource);
      const record = setup.createIntentCapability({ id: "capability-worker-race", ...scope(), authoredSource, capability });
      const operationScope = (operationId: string) => {
        setup.prepareOperationRun({
          id: operationId, requestId: scope().requestId, sessionId: scope().sessionId,
          workspaceId: scope().workspaceId, adminUserId: scope().adminUserId,
          actionName: "clockify_clients_create", actionFingerprint: "af",
          catalogHash: capability.catalogHash, operationHash: `hash-${operationId}`,
          capabilityId: record.id, capabilityHash: record.capabilityHash,
        });
        return {
          operationId, workspaceId: scope().workspaceId, adminUserId: scope().adminUserId,
          sessionId: scope().sessionId, capabilityId: record.id, capabilityHash: record.capabilityHash,
          expectedCatalogHash: capability.catalogHash, expectedActionName: "clockify_clients_create",
        };
      };
      const scopes = [operationScope("operation-worker-one"), operationScope("operation-worker-two")];
      setup.close();

      const ready = scopes.map((workerScope) => new Promise<Worker>((resolve, reject) => {
        const worker = new Worker(new URL("../helpers/intent-capability-consume-worker.ts", import.meta.url), {
          execArgv: ["--import", "tsx"],
          workerData: {
            databasePath: path,
            scope: workerScope,
            storeModuleUrl: new URL("../../src/db/store.ts", import.meta.url).href,
          },
        });
        workers.push(worker);
        worker.once("error", reject);
        worker.once("message", (message: { state?: string }) => {
          if (message.state !== "ready") return reject(new Error("worker_not_ready"));
          resolve(worker);
        });
      }));
      await Promise.all(ready);
      const resultPromises = workers.map((worker) => new Promise<unknown>((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
      }));
      for (const worker of workers) worker.postMessage("go");
      const results = await Promise.all(resultPromises);

      expect(results).toEqual(expect.arrayContaining([
        { state: "result", result: { state: "consumed", execution: 1 } },
        { state: "result", result: { state: "denied", reason: "execution_limit" } },
      ]));
      expect(results).not.toEqual(expect.arrayContaining([expect.objectContaining({ state: "error" })]));
    } finally {
      await Promise.all(workers.map((worker) => worker.terminate()));
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  }, 15_000);
});
