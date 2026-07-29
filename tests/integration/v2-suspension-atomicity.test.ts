import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { computeRequestHash } from "../../src/assistant-v2/state.js";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import { createStore, type Store } from "../../src/db/store.js";
import { createPendingConfirmation } from "../../src/harness/confirmations.js";
import { WRITE_PREVIEW_FIXTURES } from "../helpers/v2-write-preview-fixtures.js";

/**
 * Closure-plan PR 3a (F23): a suspension-producing control row and the run's
 * suspension commit TOGETHER. A crash (injected here as a RAISE(ABORT) trigger
 * on the `run.suspended` event insert) is all-or-nothing: either no
 * operation/confirmation/reservation exists, or one complete suspended run
 * with its full event sequence exists. Never a live confirmable control whose
 * run does not know it exists.
 */

const SESSION_SECRET = "test-session-secret";
const NOW = new Date("2026-07-26T12:00:00.000Z");
const directories: string[] = [];
const stores: Store[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "v2-suspension-atomicity-"));
  directories.push(directory);
  return join(directory, "db.sqlite");
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const SCOPE = {
  workspaceId: "ws-1",
  adminUserId: "admin-1",
  installationGeneration: 1,
  authClass: "addon" as const,
};

function openStore(path: string): Store {
  const store = createStore(path, { encryptionKey: "k", now: () => NOW });
  stores.push(store);
  return store;
}

function startRun(store: Store, sessionId: string, runId: string): void {
  store.startRunWithEvent({
    scope: { sessionId, runId, ...SCOPE },
    originalRequest: "create tags",
    requestHash: computeRequestHash("create tags"),
    catalogHash: MODEL_API_ACTION_CATALOG.hash(),
    loadedToolNames: [],
    intentHash: runId,
  });
}

function preparedWrites(sessionId: string, runId: string, ids: string[]) {
  return ids.map((id, index) => {
    const operationId = `op-${id}`;
    const created = createPendingConfirmation({
      id,
      sessionId,
      workspaceId: SCOPE.workspaceId,
      adminUserId: SCOPE.adminUserId,
      risk: ["safe_write"],
      preview: { summary: id },
      operation: {
        operationId,
        actionName: "clockify_tags_create",
        payload: WRITE_PREVIEW_FIXTURES.clockify_tags_create.args,
        mutationPlan: {
          mode: "single",
          maxHostCalls: 1,
          steps: [{ id: "create-tag", kind: "primary", reconciliationStrategy: "create" }],
        },
      },
      installationGeneration: 1,
      sessionSecret: SESSION_SECRET,
      now: NOW,
      ttlMs: 300_000 + index,
      origin: "assistant",
      registryId: "v2-api",
      authorityModel: "preview_confirmation_v2",
      executorKind: "prepared_safe_write",
      runId,
    });
    return {
      hostCalls: 1,
      event: { operationId, confirmationId: created.record.id },
      operationRun: {
        id: operationId,
        confirmationId: created.record.id,
        sessionId,
        workspaceId: SCOPE.workspaceId,
        adminUserId: SCOPE.adminUserId,
        actionName: "clockify_tags_create",
        actionFingerprint: "fp",
        catalogHash: MODEL_API_ACTION_CATALOG.hash(),
        operationHash: created.record.operationHash,
        operation: WRITE_PREVIEW_FIXTURES.clockify_tags_create.args,
        mutationPlan: {
          mode: "single" as const,
          maxHostCalls: 1,
          steps: [{ id: "create-tag", kind: "primary" as const, reconciliationStrategy: "create" as const }],
        },
        discriminator: {
          origin: "assistant" as const,
          registryId: "v2-api" as const,
          authorityModel: "preview_confirmation_v2" as const,
          executorKind: "prepared_safe_write" as const,
          runId,
          fieldProvenanceJson: "{}",
          fieldProvenanceHash: "a".repeat(64),
        },
      },
      confirmation: created.record,
    };
  });
}

function installSuspendFailpoint(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS fail_run_suspended_insert
    BEFORE INSERT ON run_events
    WHEN NEW.event_type = 'run.suspended'
    BEGIN
      SELECT RAISE(ABORT, 'injected_suspension_failure');
    END;
  `);
  db.close();
}

describe("v2 suspension atomicity (F23)", () => {
  it("commits write preparation and run suspension in ONE transaction", () => {
    const path = databasePath();
    const store = openStore(path);
    const session = store.createSession({ workspaceId: SCOPE.workspaceId, adminUserId: SCOPE.adminUserId });
    startRun(store, session.id, "run-1");
    const scope = { sessionId: session.id, runId: "run-1", ...SCOPE };
    const state = store.getRun(scope)!;

    const persisted = store.prepareAssistantWriteBatchWithEvents({
      scope,
      state,
      writes: preparedWrites(session.id, "run-1", ["conf-a", "conf-b"]),
      batch: {
        sessionId: session.id,
        runId: "run-1",
        workspaceId: SCOPE.workspaceId,
        adminUserId: SCOPE.adminUserId,
        orderedTupleHash: store.computeOrderedTupleHash([
          { confirmationId: "conf-a", operationId: "op-conf-a" },
          { confirmationId: "conf-b", operationId: "op-conf-b" },
        ]),
        expiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
      },
    });

    // The ONE call left a fully suspended run: phase, continuation with the
    // real batch id, and the run.suspended event after both prepared events.
    const after = store.getRun(scope)!;
    expect(after.phase).toBe("awaiting_confirmation");
    expect(after.continuation).toEqual({
      kind: "awaiting_operations",
      operationIds: ["op-conf-a", "op-conf-b"],
      batchId: persisted.batchId,
    });
    expect(persisted.batchId).toBeDefined();
    const events = store.listRunEvents({ scope, after: 0, limit: 50 }).events
      .map((e) => e.event.eventType);
    expect(events.filter((t) => t === "operation.prepared")).toHaveLength(2);
    expect(events.at(-1)).toBe("run.suspended");
  });

  it("rolls back EVERY prepared row when the suspension event cannot commit", () => {
    const path = databasePath();
    const store = openStore(path);
    const session = store.createSession({ workspaceId: SCOPE.workspaceId, adminUserId: SCOPE.adminUserId });
    startRun(store, session.id, "run-1");
    const scope = { sessionId: session.id, runId: "run-1", ...SCOPE };
    const state = store.getRun(scope)!;

    // Inject the failpoint from a side connection while the store stays open
    // (a close/reopen would run open-time orphan recovery and fail the run
    // before the call under test).
    installSuspendFailpoint(path);

    expect(() => store.prepareAssistantWriteBatchWithEvents({
      scope,
      state,
      writes: preparedWrites(session.id, "run-1", ["conf-a"]),
    })).toThrow(/injected_suspension_failure/);

    // All-or-nothing: no confirmation, no operation, no prepared event, no
    // reservation — and the run is still an ordinary active 'model' run.
    const db = new Database(path, { readonly: true });
    try {
      expect(db.prepare("SELECT COUNT(*) FROM pending_confirmations").pluck().get()).toBe(0);
      expect(db.prepare("SELECT COUNT(*) FROM operation_runs").pluck().get()).toBe(0);
      expect(db.prepare(
        "SELECT COUNT(*) FROM run_events WHERE event_type IN ('operation.prepared', 'run.suspended')",
      ).pluck().get()).toBe(0);
    } finally {
      db.close();
    }
    const after = store.getRun(scope)!;
    expect(after.phase).toBe("model");
    expect(after.budget.hostCallsReserved).toBe(0);
    expect(after.continuation).toEqual({ kind: "none" });
  });

  it("commits clarification.required and run.suspended together or not at all", () => {
    const path = databasePath();
    const store = openStore(path);
    const session = store.createSession({ workspaceId: SCOPE.workspaceId, adminUserId: SCOPE.adminUserId });
    startRun(store, session.id, "run-1");
    const scope = { sessionId: session.id, runId: "run-1", ...SCOPE };

    // Positive: one call yields BOTH events and the suspended phase.
    const state = store.getRun(scope)!;
    state.continuation = { kind: "awaiting_clarification", clarificationId: "clar-1" };
    store.requireClarificationAndSuspendWithEvents(scope, state, {
      clarificationId: "clar-1",
      actionResultId: "result-1",
    });
    const after = store.getRun(scope)!;
    expect(after.phase).toBe("awaiting_clarification");
    expect(after.continuation).toEqual({ kind: "awaiting_clarification", clarificationId: "clar-1" });
    const events = store.listRunEvents({ scope, after: 0, limit: 50 }).events
      .map((e) => e.event.eventType);
    expect(events.indexOf("clarification.required")).toBeGreaterThan(-1);
    expect(events.at(-1)).toBe("run.suspended");

    // Failpoint on a SECOND database: neither event lands, phase intact.
    const path2 = databasePath();
    const second = openStore(path2);
    const session2 = second.createSession({ workspaceId: SCOPE.workspaceId, adminUserId: SCOPE.adminUserId });
    startRun(second, session2.id, "run-2");
    const scope2 = { sessionId: session2.id, runId: "run-2", ...SCOPE };
    const state2 = second.getRun(scope2)!;
    state2.continuation = { kind: "awaiting_clarification", clarificationId: "clar-2" };
    installSuspendFailpoint(path2);
    expect(() => second.requireClarificationAndSuspendWithEvents(scope2, state2, {
      clarificationId: "clar-2",
      actionResultId: "result-2",
    })).toThrow(/injected_suspension_failure/);
    const db = new Database(path2, { readonly: true });
    try {
      expect(db.prepare(
        "SELECT COUNT(*) FROM run_events WHERE event_type IN ('clarification.required', 'run.suspended')",
      ).pluck().get()).toBe(0);
    } finally {
      db.close();
    }
    expect(second.getRun(scope2)!.phase).toBe("model");
  });
});
