import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createStore } from "../../src/db/store.js";
import { computeRequestHash } from "../../src/assistant-v2/state.js";
import { parseRunEventPayload } from "../../src/assistant-v2/events.js";
import { LATEST_SCHEMA_VERSION } from "../../src/db/schema.js";

const directories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "run-events-"));
  directories.push(directory);
  return join(directory, "db.sqlite");
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

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

describe("run events store", () => {
  it("migrates to schema v10 with run_events table and cascade foreign key", () => {
    const path = databasePath();
    const store = createStore(path, { encryptionKey: "k" });
    const db = new Database(path);
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(tables).toContain("run_events");
    const fk = db.prepare("PRAGMA foreign_key_list(run_events)").all() as Array<{ table: string; on_delete: string }>;
    expect(fk.some((row) => row.table === "assistant_runs" && row.on_delete === "CASCADE")).toBe(true);
    db.close();
    store.close();
  });

  it("allocates monotonic sequences and rejects closed payload extras", () => {
    const store = createStore(databasePath(), { encryptionKey: "k" });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    const requestHash = computeRequestHash("hello");
    const started = store.startRunWithEvent({
      scope: baseScope(session.id, "run-1"),
      originalRequest: "hello",
      requestHash,
      catalogHash: "a".repeat(64),
      loadedToolNames: ["assistant_find_api_operations"],
      intentHash: "run-1",
    });
    expect(started.sequence).toBe(1);
    expect(started.event.eventType).toBe("run.started");
    const run = store.getRun(baseScope(session.id, "run-1"));
    expect(run?.phase).toBe("model");
    expect(() => parseRunEventPayload("run.started", { requestHash, extra: true })).toThrow();
    store.close();
  });

  it("deletes child run_events when assistant_runs row is removed", () => {
    const path = databasePath();
    const store = createStore(path, { encryptionKey: "k" });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    store.startRunWithEvent({
      scope: baseScope(session.id, "run-1"),
      originalRequest: "hello",
      requestHash: computeRequestHash("hello"),
      catalogHash: "a".repeat(64),
      loadedToolNames: [],
      intentHash: "run-1",
    });
    store.close();
    const raw = new Database(path);
    raw.prepare("DELETE FROM assistant_runs WHERE run_id = ?").run("run-1");
    expect(raw.prepare("SELECT COUNT(*) AS n FROM run_events WHERE run_id = ?").get("run-1")).toEqual({ n: 0 });
    raw.close();
  });
});
