import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createStore } from "../../src/db/store.js";
import { computeRequestHash, createEmptyRunBudget } from "../../src/assistant-v2/state.js";

const directories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "run-events-tx-"));
  directories.push(directory);
  return join(directory, "db.sqlite");
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("run events transactionality", () => {
  it("rolls back neither state nor event when event insert fails mid-transaction", () => {
    const path = databasePath();
    const store = createStore(path, { encryptionKey: "k" });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    store.startRunWithEvent({
      scope: {
        sessionId: session.id,
        runId: "run-1",
        workspaceId: "ws-1",
        adminUserId: "admin-1",
        installationGeneration: 1,
        authClass: "addon",
      },
      originalRequest: "hello",
      requestHash: computeRequestHash("hello"),
      catalogHash: "a".repeat(64),
      loadedToolNames: [],
      intentHash: "run-1",
    });
    store.close();

    const db = new Database(path);
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS run_events_fail_second_insert
      BEFORE INSERT ON run_events
      WHEN NEW.sequence = 2
      BEGIN
        SELECT RAISE(ABORT, 'injected_event_failure');
      END;
    `);
    const reopen = createStore(path, { encryptionKey: "k" });
    const state = reopen.getRun({
      sessionId: session.id,
      runId: "run-1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      installationGeneration: 1,
      authClass: "addon",
    });
    expect(state).toBeDefined();
    expect(() => reopen.reserveModelCallWithEvent(
      {
        sessionId: session.id,
        runId: "run-1",
        workspaceId: "ws-1",
        adminUserId: "admin-1",
        installationGeneration: 1,
        authClass: "addon",
      },
      { ...state!, budget: createEmptyRunBudget() },
      {
        modelCall: 1,
        providerAttempt: 1,
        loadedOperationIds: [],
        cacheSeeded: false,
      },
    )).toThrow();
    const after = reopen.getRun({
      sessionId: session.id,
      runId: "run-1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      installationGeneration: 1,
      authClass: "addon",
    });
    expect(after?.budget.modelCallsUsed).toBe(0);
    expect(reopen.getLastRunEventSequence({
      sessionId: session.id,
      runId: "run-1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      installationGeneration: 1,
      authClass: "addon",
    })).toBe(1);
    reopen.close();
    db.close();
  });
});
