import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStore } from "../../src/db/store.js";
import { RUN_SEED_RECENCY_WINDOW_MS } from "../../src/db/store/runs.js";
import { computeRequestHash, type RunPhase } from "../../src/assistant-v2/state.js";

/**
 * Readiness-plan A3 (defect D-1 hardening): `findLatestEligibleRunForCache` is
 * the seed source for every fresh turn's tool cache. Pinned here against the
 * REAL sqlite store (no mock — every prior fake for this query returned whole
 * RunStates unconditionally): only a run in the terminal SUCCESS phase
 * `completed` that settled within the bounded recency window may seed. A
 * `failed` run, an abandoned suspended run, and an out-of-window completed run
 * must all fall back to discovery-only seeding (`undefined`).
 *
 * Deliberate semantics: a CANCELLED preview also settles its run as
 * `completed` (settleV2ConfirmationRun), so a cancelled-preview run still
 * seeds — acceptable because post-A2 only READ tools cross the turn boundary.
 */

const T0 = new Date("2026-07-30T10:00:00.000Z");
const CATALOG_HASH = "a".repeat(64);
const WORKSPACE_ID = "ws-1";
const ADMIN_USER_ID = "admin-1";
const GENERATION = 1;
const AUTH_CLASS = "addon" as const;

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function makeStore(clock: { now: Date }) {
  const directory = mkdtempSync(join(tmpdir(), "seed-eligibility-"));
  directories.push(directory);
  return createStore(join(directory, "db.sqlite"), {
    encryptionKey: "k",
    now: () => clock.now,
  });
}

function runScope(sessionId: string, runId: string) {
  return {
    sessionId,
    runId,
    workspaceId: WORKSPACE_ID,
    adminUserId: ADMIN_USER_ID,
    installationGeneration: GENERATION,
    authClass: AUTH_CLASS,
  };
}

function startRun(store: ReturnType<typeof createStore>, sessionId: string, runId: string): void {
  store.startRunWithTurn({
    scope: runScope(sessionId, runId),
    originalRequest: "list projects",
    requestHash: computeRequestHash("list projects"),
    catalogHash: CATALOG_HASH,
    loadedToolNames: ["assistant_find_api_operations", "clockify_projects_list"],
    intentHash: runId,
  });
}

/** Settle via the real `saveRun`, which stamps `updated_at = nowIso()`. */
function settleRun(
  store: ReturnType<typeof createStore>,
  sessionId: string,
  runId: string,
  phase: RunPhase,
): void {
  const run = store.getRun(runScope(sessionId, runId));
  if (!run) throw new Error(`run ${runId} missing`);
  store.saveRun({ ...run, phase });
}

function findSeed(store: ReturnType<typeof createStore>, sessionId: string) {
  return store.findLatestEligibleRunForCache(
    sessionId,
    WORKSPACE_ID,
    ADMIN_USER_ID,
    GENERATION,
    AUTH_CLASS,
    CATALOG_HASH,
  );
}

describe("findLatestEligibleRunForCache eligibility (readiness A3)", () => {
  it("a failed run does not seed the next turn", () => {
    const clock = { now: T0 };
    const store = makeStore(clock);
    const session = store.createSession({ workspaceId: WORKSPACE_ID, adminUserId: ADMIN_USER_ID });

    startRun(store, session.id, "run-1");
    settleRun(store, session.id, "run-1", "failed");

    expect(findSeed(store, session.id)).toBeUndefined();
    store.close();
  });

  it("an abandoned suspended run (awaiting_clarification) does not seed", () => {
    const clock = { now: T0 };
    const store = makeStore(clock);
    const session = store.createSession({ workspaceId: WORKSPACE_ID, adminUserId: ADMIN_USER_ID });

    startRun(store, session.id, "run-1");
    settleRun(store, session.id, "run-1", "awaiting_clarification");

    expect(findSeed(store, session.id)).toBeUndefined();
    store.close();
  });

  it("a completed run older than the recency window does not seed", () => {
    const clock = { now: T0 };
    const store = makeStore(clock);
    const session = store.createSession({ workspaceId: WORKSPACE_ID, adminUserId: ADMIN_USER_ID });

    startRun(store, session.id, "run-1");
    settleRun(store, session.id, "run-1", "completed");

    clock.now = new Date(T0.getTime() + RUN_SEED_RECENCY_WINDOW_MS + 1_000);
    expect(findSeed(store, session.id)).toBeUndefined();
    store.close();
  });

  it("a recent completed run still seeds (completed includes cancelled-preview settlements)", () => {
    const clock = { now: T0 };
    const store = makeStore(clock);
    const session = store.createSession({ workspaceId: WORKSPACE_ID, adminUserId: ADMIN_USER_ID });

    startRun(store, session.id, "run-1");
    settleRun(store, session.id, "run-1", "completed");

    clock.now = new Date(T0.getTime() + RUN_SEED_RECENCY_WINDOW_MS - 60_000);
    const seed = findSeed(store, session.id);
    expect(seed?.runId).toBe("run-1");
    expect(seed?.phase).toBe("completed");
    expect(seed?.loadedToolNames).toContain("clockify_projects_list");
    store.close();
  });

  it("a newer failed run does not shadow an older recent completed run", () => {
    const clock = { now: T0 };
    const store = makeStore(clock);
    const session = store.createSession({ workspaceId: WORKSPACE_ID, adminUserId: ADMIN_USER_ID });

    startRun(store, session.id, "run-1");
    settleRun(store, session.id, "run-1", "completed");

    // The one-active-run-per-session index requires run-1 to be terminal
    // before run-2 starts; the failed run is strictly newer by updated_at.
    clock.now = new Date(T0.getTime() + 60_000);
    startRun(store, session.id, "run-2");
    settleRun(store, session.id, "run-2", "failed");

    clock.now = new Date(T0.getTime() + 120_000);
    const seed = findSeed(store, session.id);
    expect(seed?.runId).toBe("run-1");
    store.close();
  });
});
