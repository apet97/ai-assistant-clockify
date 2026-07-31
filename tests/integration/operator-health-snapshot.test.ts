import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStore, type Store } from "../../src/db/store.js";
import { computeRequestHash, type RunPhase } from "../../src/assistant-v2/state.js";
import {
  OPERATOR_HEALTH_PHASES,
  OPERATOR_HEALTH_SNAPSHOT_INTERVAL_MS,
  createOperatorHealthSnapshotEmitter,
  type OperatorHealthPhase,
} from "../../src/operator-health.js";
import { createOperatorHealthSnapshotLoop } from "../../src/server.js";

/**
 * D4 (`DEPLOYMENT.md` "Required alerts" row 10). Two questions this file has to
 * answer, and neither can be answered by a unit test over a fake store:
 *
 *  1. PRIVACY. The snapshot aggregates across EVERY workspace, so it is the one
 *     operator line whose inputs are not scoped to one admin. It is driven here
 *     through the real store with attacker-shaped ids, an attacker-shaped
 *     project name inside a real admin prompt, and a JWT-looking token, then
 *     asserted on identifier SHAPES the way
 *     `tests/integration/alert-log-privacy.test.ts` does — so a different
 *     leaked identifier still fails. A counts-only line passes that assertion
 *     trivially, so every privacy case ALSO asserts the hostile workspace's
 *     work actually reached the counts; otherwise the test would pass against
 *     an empty snapshot and prove nothing.
 *  2. TRUTH. A snapshot of structural zeroes reads exactly like a healthy
 *     fleet, so every field is driven to a known non-zero value through the
 *     real store and the exact number asserted — including all FIVE phase
 *     fields. That last part is not cosmetic: `operator-health.ts`'s
 *     `emitted.has(row.phase)` is the ONLY thing binding the
 *     `OPERATOR_HEALTH_PHASES` literals to the strings the database really
 *     stores, and a field never driven non-zero would read 0 forever if one
 *     drifted. The `in_flight === Σ phase_*` net cannot catch that on its own,
 *     because a phase no seeded run ever reaches contributes 0 to both sides.
 */
const WORKSPACE_ID = "64ad1305c701cc5be7c26fe4";
const OTHER_WORKSPACE_ID = "71cd2410f802dd6cf8d37ba5";
const ADMIN_ID = "5f0a1305c701cc5be7c26aa1";
const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJ3b3Jrc3BhY2VJZCI6IngifQ.sig";
/** A workspace names its own projects; a hostile one names them like this. */
const PROJECT = `Ana ${WORKSPACE_ID} ${JWT}`;
const PROMPT = `delete every time entry on project "${PROJECT}" before Friday`;

const MINUTE_MS = 60_000;
const NOW = new Date("2026-07-31T12:00:00.000Z");

const directories: string[] = [];
function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "operator-health-"));
  directories.push(directory);
  return join(directory, "db.sqlite");
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function assertClean(line: string): void {
  expect(line).not.toContain(WORKSPACE_ID);
  expect(line).not.toContain(OTHER_WORKSPACE_ID);
  expect(line).not.toContain(ADMIN_ID);
  expect(line).not.toContain(JWT);
  expect(line).not.toContain("eyJ");
  expect(line).not.toContain(PROJECT);
  expect(line).not.toContain("Ana");
  expect(line).not.toMatch(/[0-9a-f]{24}/);
}

/** The emitted line as `key=value` pairs; the `[operator]` tag carries no `=`. */
function fields(line: string): Record<string, string> {
  return Object.fromEntries(
    line.split(" ")
      .filter((token) => token.includes("="))
      .map((token) => {
        const index = token.indexOf("=");
        return [token.slice(0, index), token.slice(index + 1)] as const;
      }),
  );
}

/** The production loop, driven off an injected clock instead of a real timer. */
function snapshotOnce(store: Store, at: Date): { line: string; fields: Record<string, string> } {
  const lines: string[] = [];
  createOperatorHealthSnapshotLoop({
    store,
    snapshot: createOperatorHealthSnapshotEmitter({ log: (line) => lines.push(line) }),
    now: () => at,
  })();
  expect(lines).toHaveLength(1);
  return { line: lines[0]!, fields: fields(lines[0]!) };
}

function scope(sessionId: string, runId: string, workspaceId = WORKSPACE_ID) {
  return {
    sessionId,
    runId,
    workspaceId,
    adminUserId: ADMIN_ID,
    installationGeneration: 1,
    authClass: "addon" as const,
  };
}

/** One run in its own session — `assistant_runs` allows one non-terminal run per session. */
function startRun(store: Store, index: number, workspaceId = WORKSPACE_ID): ReturnType<typeof scope> {
  const session = store.createSession({ workspaceId, adminUserId: ADMIN_ID });
  const runScope = scope(session.id, `run-${workspaceId}-${index}`, workspaceId);
  store.startRunWithEvent({
    scope: runScope,
    // The admin's own words, carrying the hostile project name verbatim.
    originalRequest: PROMPT,
    requestHash: computeRequestHash(PROMPT),
    catalogHash: "a".repeat(64),
    loadedToolNames: [`clockify_projects_delete ${PROJECT}`.slice(0, 200)],
    intentHash: `intent-${index}`,
  });
  return runScope;
}

function state(store: Store, runScope: ReturnType<typeof scope>) {
  const run = store.getRun(runScope);
  if (!run) throw new Error("run_missing");
  return run;
}

/**
 * The fleet the count assertions are made against. Two workspaces, so an
 * aggregate that silently scoped itself to one of them would be visible, and
 * EVERY emitted phase reached by the real transition that writes it:
 *
 * - one stale run parked an hour ago in `model` (in flight AND stalled),
 * - one run denied on budget and then failed on budget,
 * - one completed run,
 * - one run still in `model`,
 * - one in `discovering`, one in `executing_reads`,
 * - one suspended `awaiting_confirmation`, one `awaiting_clarification`,
 * - one failed by the EVENTLESS `failActiveRunsForSession` path, which emits no
 *   `run.failed` and is what makes an event-based `runs_failed` undercount.
 */
function seedFleet(store: Store, clock: { value: Date }): void {
  clock.value = new Date(NOW.getTime() - 60 * MINUTE_MS);
  startRun(store, 0, OTHER_WORKSPACE_ID);

  clock.value = NOW;
  const denied = startRun(store, 1);
  store.denyToolWithEvent(denied, state(store, denied), {
    toolCallId: "call-1",
    actionName: `clockify_projects_delete ${PROJECT}`.slice(0, 200),
    code: "budget_exhausted",
  });
  store.failRunWithEvent(denied, state(store, denied), { code: "budget_exhausted" });

  const completed = startRun(store, 2, OTHER_WORKSPACE_ID);
  store.completeRunWithEvent(completed, state(store, completed), { actionResultIds: [] });

  startRun(store, 3);

  const confirming = startRun(store, 4);
  store.suspendRunWithEvent(confirming, state(store, confirming), { reason: "awaiting_confirmation" });

  const discovering = startRun(store, 5);
  store.reserveDiscoveryCallWithEvent(discovering, state(store, discovering), {
    searchIndex: 1,
    access: "read",
    groups: [],
  });

  const reading = startRun(store, 6, OTHER_WORKSPACE_ID);
  store.startToolWithEvent(reading, state(store, reading), {
    toolCallId: "call-read-1",
    actionName: "clockify_projects_list",
  });

  const clarifying = startRun(store, 7);
  store.suspendRunWithEvent(clarifying, state(store, clarifying), { reason: "awaiting_clarification" });

  // The eventless terminal path: a bare UPDATE to phase='failed' with no
  // `run.failed` event, exactly as `confirmation_lapsed` reaches it.
  const lapsed = startRun(store, 8);
  expect(store.failActiveRunsForSession(
    lapsed.sessionId, lapsed.workspaceId, lapsed.adminUserId, "confirmation_lapsed",
  )).toBe(1);
}

describe("operator health snapshot", () => {
  it("reports flow and level counts that match the runs actually driven, across workspaces", () => {
    const clock = { value: NOW };
    const store = createStore(databasePath(), { encryptionKey: "k", now: () => clock.value });
    seedFleet(store, clock);

    const snapshot = snapshotOnce(store, NOW);
    store.close();

    expect(snapshot.fields).toMatchObject({
      window_min: String(OPERATOR_HEALTH_SNAPSHOT_INTERVAL_MS / MINUTE_MS),
      // FLOW, inside the window. The run parked an hour ago started outside it
      // and is deliberately absent from `runs_started`.
      runs_started: "8",
      runs_completed: "1",
      // TWO: the budget failure (which emits `run.failed`) AND the eventless
      // `failActiveRunsForSession` one. An event-based count would say 1.
      runs_failed: "2",
      budget_denied_tools: "1",
      budget_denied_runs: "1",
      // LEVEL, right now. Terminal runs are NOT a level — they are the flow
      // above. Every one of the five emitted phases is non-zero here.
      in_flight: "6",
      phase_model: "2",
      phase_discovering: "1",
      phase_executing_reads: "1",
      phase_awaiting_confirmation: "1",
      phase_awaiting_clarification: "1",
      // Only the run that is neither progressing nor waiting on a human.
      stalled: "1",
    });
  });

  it("counts a run failed with no run.failed event, which an event-based count would miss", () => {
    // Isolated so the number is unambiguous: ONE run, terminalized only by the
    // bare `UPDATE assistant_runs SET phase='failed'` that
    // `failActiveRunsForSession` performs — it does not even persist the code.
    const store = createStore(databasePath(), { encryptionKey: "k", now: () => NOW });
    const lapsed = startRun(store, 0);
    expect(snapshotOnce(store, NOW).fields).toMatchObject({ runs_failed: "0", in_flight: "1" });
    expect(store.failActiveRunsForSession(
      lapsed.sessionId, lapsed.workspaceId, lapsed.adminUserId, "confirmation_lapsed",
    )).toBe(1);
    const after = snapshotOnce(store, NOW);
    store.close();
    expect(after.fields).toMatchObject({
      runs_failed: "1",
      // …while the event journal still holds zero `run.failed` rows for it, so
      // `budget_denied_runs` (which IS event-based) stays 0.
      budget_denied_runs: "0",
      in_flight: "0",
    });
  });

  it("counts the ambiguous operation the real restart-recovery path produces", () => {
    const path = databasePath();
    const store = createStore(path, { encryptionKey: "k", now: () => NOW });
    const operationId = store.prepareOperationRun({
      id: `op-${WORKSPACE_ID}`,
      requestId: "request-1",
      sessionId: "session-1",
      workspaceId: WORKSPACE_ID,
      adminUserId: ADMIN_ID,
      actionName: "clockify_tags_create",
      actionFingerprint: "fingerprint",
      catalogHash: "catalog",
      operationHash: "operation",
    });
    expect(store.markOperationExecuting(operationId)).toBe(true);
    const stepId = store.prepareOperationStep({
      operationId,
      planStepId: "create-tag",
      index: 0,
      name: "Create tag",
      kind: "primary",
    });
    expect(store.markOperationStepExecuting(stepId)).toBe(true);
    expect(store.markOperationStepDispatched(stepId)).toBe(true);
    expect(snapshotOnce(store, NOW).fields).toMatchObject({
      outcome_unknown: "0",
      outcome_unknown_unreconciled: "0",
    });
    // Crash: the step was dispatched and never settled.
    store.close();

    // Store construction runs the orphan recovery that marks it unknown.
    const recovered = createStore(path, { encryptionKey: "k", now: () => NOW });
    const stranded = snapshotOnce(recovered, NOW);
    expect(stranded.fields).toMatchObject({
      outcome_unknown: "1",
      // Not yet examined, so it is still a reconciliation candidate — the half
      // a restart can actually drain.
      outcome_unknown_unreconciled: "1",
    });
    assertClean(stranded.line);

    // Reconciliation examined it and could NOT settle it: `reconciled_at` is
    // stamped, the status stays ambiguous, and it will never be a candidate
    // again. This is the case that must not be a `> 0` page — the standing
    // total keeps it for 30 days, the actionable field goes quiet.
    recovered.recordOperationReconciliation(operationId, stepId, { reason: "non_unique_or_missing" }, false);
    const examined = snapshotOnce(recovered, NOW);
    recovered.close();
    expect(examined.fields).toMatchObject({
      outcome_unknown: "1",
      outcome_unknown_unreconciled: "0",
    });
  });

  it("reports the backlog flag the real retention sweep recorded, in both directions", async () => {
    const store = createStore(databasePath(), { encryptionKey: "k", now: () => NOW });
    // Before any sweep has recorded a row there is nothing to read, and the
    // field reads 0 — "no prune has ever run" is row 3's job, not this line's.
    expect(snapshotOnce(store, NOW).fields.retention_backlog).toBe("0");

    // One row past the 10,000-row pass cap, so the real sweep cannot finish.
    for (let index = 0; index < 10_001; index += 1) {
      store.claimIdempotency(`key-${index}`, WORKSPACE_ID, ADMIN_ID, 1_000, 0, 0);
    }
    const first = await store.pruneExpired(NOW.toISOString());
    expect(first.backlog).toBe(true);
    const backlogged = snapshotOnce(store, NOW);
    expect(backlogged.fields.retention_backlog).toBe("1");
    assertClean(backlogged.line);

    const second = await store.pruneExpired(NOW.toISOString());
    expect(second.backlog).toBe(false);
    expect(snapshotOnce(store, NOW).fields.retention_backlog).toBe("0");
    store.close();
  }, 30_000);

  it("carries no id, prompt, project name, or token out of a hostile fleet", () => {
    const clock = { value: NOW };
    const store = createStore(databasePath(), { encryptionKey: "k", now: () => clock.value });
    seedFleet(store, clock);
    const snapshot = snapshotOnce(store, NOW);
    store.close();

    // NOT VACUOUS: the hostile workspaces' work is really in these numbers.
    expect(Number(snapshot.fields.runs_started)).toBeGreaterThan(0);
    expect(Number(snapshot.fields.in_flight)).toBeGreaterThan(0);
    expect(Number(snapshot.fields.budget_denied_tools)).toBeGreaterThan(0);
    assertClean(snapshot.line);
    // Beyond the fixed event name every value is a bare integer, so no field
    // can carry workspace text at all — not merely "does not today".
    expect(snapshot.fields.event).toBe("health_snapshot");
    for (const [key, value] of Object.entries(snapshot.fields)) {
      if (key === "event") continue;
      expect(value, `field ${key}`).toMatch(/^\d+$/);
    }
  });

  it("degrades to a fixed line instead of taking the process down when the read throws", () => {
    const lines: string[] = [];
    const failing = {
      operatorHealthCounts: () => {
        throw Object.assign(new Error(`database is locked: SELECT '${PROMPT}'`), { code: "SQLITE_BUSY" });
      },
    } as unknown as Store;
    expect(() => createOperatorHealthSnapshotLoop({
      store: failing,
      snapshot: createOperatorHealthSnapshotEmitter({ log: (line) => lines.push(line) }),
      now: () => NOW,
    })()).not.toThrow();
    expect(lines).toEqual(["[operator] event=snapshot_unavailable"]);
    assertClean(lines[0]!);
  });

  it("emits every non-terminal phase a run can reach, and nothing that is always zero", () => {
    // `preparing_writes` is declared in the RunPhase union and in the schema
    // CHECK, but NO code ever writes it, so a `phase_preparing_writes` field
    // could only ever read 0. It is deliberately not emitted. If a new phase is
    // ever added to the union this stops compiling, so the decision is revisited
    // rather than silently dropping runs out of the histogram.
    type Uncovered = Exclude<RunPhase, OperatorHealthPhase | "preparing_writes" | "completed" | "failed">;
    const everyPhaseIsAccountedFor: [Uncovered] extends [never] ? true : false = true;
    expect(everyPhaseIsAccountedFor).toBe(true);

    const clock = { value: NOW };
    const store = createStore(databasePath(), { encryptionKey: "k", now: () => clock.value });
    seedFleet(store, clock);
    const snapshot = snapshotOnce(store, NOW);
    store.close();

    // `in_flight` is counted independently of the histogram, so a phase that
    // starts being written without a field here shows up as a mismatch instead
    // of vanishing.
    const histogram = OPERATOR_HEALTH_PHASES
      .reduce((total, phase) => total + Number(snapshot.fields[`phase_${phase}`]), 0);
    expect(histogram).toBe(Number(snapshot.fields.in_flight));
    expect(snapshot.fields.phase_preparing_writes).toBeUndefined();
    expect(snapshot.fields.phase_completed).toBeUndefined();
    expect(snapshot.fields.phase_failed).toBeUndefined();
  });
});
