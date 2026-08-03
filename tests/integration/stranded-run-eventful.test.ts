import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeRequestHash } from "../../src/assistant-v2/state.js";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import { DISCOVERY_META_TOOL_NAME } from "../../src/harness/api-operation.js";
import { createStore } from "../../src/db/store.js";

/**
 * A run that ends must SAY why, in its own journal.
 *
 * `failActiveRunsForSession` took a `code` and threw it away (`void code;`),
 * flipping `phase` with raw SQL and appending no event. The three v2 fallbacks
 * that use it — `confirmation_lapsed`, `stranded_active_run`,
 * `clarification_missing` — therefore terminalized runs silently: the durable
 * journal held no bounded reason, and operator health could not tell those
 * three apart or count them at all.
 *
 * Every other terminal transition in v2 goes through `failRunWithEvent`. This
 * one now does too, keyed on exact run identity.
 */

const NOW = new Date("2026-06-06T12:00:00.000Z");
const directories: string[] = [];
const stores: ReturnType<typeof createStore>[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "stranded-run-"));
  directories.push(directory);
  return join(directory, "db.sqlite");
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function seedActiveRun(code: string) {
  const store = createStore(databasePath(), { encryptionKey: "k", now: () => NOW });
  stores.push(store);
  const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
  const scope = {
    sessionId: session.id,
    runId: `run-${code}`,
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    installationGeneration: 1,
    authClass: "addon" as const,
  };
  store.startRunWithTurn({
    scope,
    originalRequest: "do something",
    requestHash: computeRequestHash("do something"),
    catalogHash: MODEL_API_ACTION_CATALOG.hash(),
    loadedToolNames: [DISCOVERY_META_TOOL_NAME],
    intentHash: scope.runId,
  });
  return { store, session, scope };
}

describe("a stranded active run is failed with its reason", () => {
  it.each(["stranded_active_run", "confirmation_lapsed", "clarification_missing"])(
    "appends run.failed carrying %s and terminalizes the run",
    (code) => {
      const { store, session, scope } = seedActiveRun(code);

      const failed = store.failActiveRunsForSession(session.id, "ws-1", "admin-1", code);
      expect(failed).toBe(1);

      expect(store.getRun(scope)?.phase).toBe("failed");
      expect(store.getActiveRunForSession(session.id, "ws-1", "admin-1")).toBeUndefined();

      const page = store.listRunEvents({ scope, after: 0, limit: 100 });
      const failure = page.events.find((entry) => entry.event.eventType === "run.failed");
      expect(failure, "a terminal run must journal run.failed").toBeDefined();
      // The reason the caller passed — not discarded, not a placeholder.
      expect(failure!.event.payload).toMatchObject({ code });
    },
  );

  it("leaves the session able to start a fresh run afterwards", () => {
    const { store, session } = seedActiveRun("stranded_active_run");
    store.failActiveRunsForSession(session.id, "ws-1", "admin-1", "stranded_active_run");

    const next = {
      sessionId: session.id,
      runId: "run-after",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      installationGeneration: 1,
      authClass: "addon" as const,
    };
    expect(() => store.startRunWithTurn({
      scope: next,
      originalRequest: "another request",
      requestHash: computeRequestHash("another request"),
      catalogHash: MODEL_API_ACTION_CATALOG.hash(),
      loadedToolNames: [DISCOVERY_META_TOOL_NAME],
      intentHash: next.runId,
    })).not.toThrow();
  });
});
