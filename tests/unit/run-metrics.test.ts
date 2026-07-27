import { describe, expect, it } from "vitest";
import { buildRunMetrics, type RunMetricsEvent } from "../../src/metrics/run-metrics.js";
import type { RunEventPayloadMap, RunEventType } from "../../src/assistant-v2/events.js";

/**
 * T17-E: every formula lives in `run-metrics.ts`, so every formula is proven
 * here with literal, hand-checked expectations. The privacy contract is proven
 * structurally too: no output field can carry request text, arguments, or entity
 * names because the module never receives them.
 */

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

let sequence = 0;
function event<K extends RunEventType>(
  eventType: K,
  payload: RunEventPayloadMap[K],
  overrides: Partial<Pick<RunMetricsEvent, "sessionId" | "runId" | "createdAt">> = {},
): RunMetricsEvent {
  sequence += 1;
  return {
    sessionId: overrides.sessionId ?? "s1",
    runId: overrides.runId ?? "r1",
    sequence,
    eventType,
    payload: payload as RunMetricsEvent["payload"],
    createdAt: overrides.createdAt ?? "2026-07-26T00:00:00.000Z",
  };
}

function modelStarted(modelCall: number, providerAttempt: 1 | 2, cacheSeeded = false, run = "r1"): RunMetricsEvent {
  return event("model.started", { modelCall, providerAttempt, loadedOperationIds: [], cacheSeeded }, { runId: run });
}

function modelCompleted(
  modelCall: number,
  latencyMs: number,
  usage: RunEventPayloadMap["model.completed"]["usage"] = {},
  run = "r1",
): RunMetricsEvent {
  return event("model.completed", { modelCall, providerAttempts: 1, usage, latencyMs }, { runId: run });
}

describe("T17-E: model-call accounting groups by (session, run, modelCall)", () => {
  it("counts attempt 2 as the SAME logical call but a separate provider attempt", () => {
    const metrics = buildRunMetrics([
      modelStarted(1, 1),
      modelStarted(1, 2), // provider retry of the same logical call
      modelCompleted(1, 120),
      event("run.completed", { actionResultIds: [] }),
    ]);
    expect(metrics.modelCalls).toBe(1);
    expect(metrics.providerAttempts).toBe(2);
    expect(metrics.incompleteModelCalls).toBe(0);
  });

  it("counts distinct model calls in one run separately", () => {
    const metrics = buildRunMetrics([
      modelStarted(1, 1),
      modelCompleted(1, 10),
      modelStarted(2, 1),
      modelCompleted(2, 20),
      event("run.completed", { actionResultIds: [] }),
    ]);
    expect(metrics.modelCalls).toBe(2);
    expect(metrics.providerAttempts).toBe(2);
  });

  it("reports an incomplete call separately instead of dropping it", () => {
    const metrics = buildRunMetrics([
      modelStarted(1, 1),
      modelCompleted(1, 30),
      modelStarted(2, 1), // never completed
      event("run.failed", { code: "provider_error" }),
    ]);
    expect(metrics.modelCalls).toBe(2);
    expect(metrics.incompleteModelCalls).toBe(1);
    expect(metrics.anomalies).toEqual([{ code: "model_call_never_completed", groups: 1 }]);
  });

  it("reports a duplicate attempt for the same call as a corrupt group, never normalized away", () => {
    const metrics = buildRunMetrics([
      modelStarted(1, 1),
      modelStarted(1, 1),
      modelCompleted(1, 5),
      event("run.completed", { actionResultIds: [] }),
    ]);
    expect(metrics.anomalies).toEqual([{ code: "duplicate_attempt_for_model_call", groups: 1 }]);
  });

  it("reports attempt 2 without attempt 1 as a corrupt group", () => {
    const metrics = buildRunMetrics([
      modelStarted(1, 2),
      modelCompleted(1, 5),
      event("run.completed", { actionResultIds: [] }),
    ]);
    expect(metrics.modelCalls).toBe(0);
    expect(metrics.anomalies.map((a) => a.code)).toContain("attempt_two_without_attempt_one");
  });

  it("reports a completion with no matching start", () => {
    const metrics = buildRunMetrics([
      modelCompleted(1, 5),
      event("run.completed", { actionResultIds: [] }),
    ]);
    expect(metrics.anomalies.map((a) => a.code)).toContain("model_call_without_start");
  });
});

describe("T17-E: discovery, tool and operation aggregates", () => {
  it("counts searches, refinements, cache hits, loaded tools and the per-completion maximum", () => {
    const metrics = buildRunMetrics([
      modelStarted(1, 1, true),
      event("api.search_started", { searchIndex: 1, access: "read", groups: [] }),
      event("api.operations_loaded", { operationIds: ["a", "b", "c"], source: "discovery" }),
      event("api.search_started", { searchIndex: 2, access: "read", groups: [] }),
      event("api.operations_loaded", { operationIds: ["a", "b"], source: "cache" }),
      event("run.completed", { actionResultIds: [] }),
    ]);
    expect(metrics.searches).toBe(2);
    // The second search in the same run is the refinement.
    expect(metrics.refinements).toBe(1);
    expect(metrics.cacheHits).toBe(1);
    expect(metrics.loadedTools).toBe(5);
    expect(metrics.maxLoadedTools).toBe(3);
  });

  it("counts refinements per run, never across runs", () => {
    const metrics = buildRunMetrics([
      event("api.search_started", { searchIndex: 1, access: "any", groups: [] }, { runId: "r1" }),
      event("api.search_started", { searchIndex: 1, access: "any", groups: [] }, { runId: "r2" }),
      event("run.completed", { actionResultIds: [] }, { runId: "r1" }),
      event("run.completed", { actionResultIds: [] }, { runId: "r2" }),
    ]);
    expect(metrics.searches).toBe(2);
    expect(metrics.refinements).toBe(0);
    expect(metrics.runs).toBe(2);
  });

  it("counts validation failures by code", () => {
    const metrics = buildRunMetrics([
      event("tool.denied", { toolCallId: "t1", actionName: "clockify_tags_create", code: "policy_denied" }),
      event("tool.denied", { toolCallId: "t2", actionName: "clockify_tags_create", code: "policy_denied" }),
      event("tool.denied", { toolCallId: "t3", actionName: "clockify_tags_update", code: "budget_exhausted" }),
      event("run.failed", { code: "denied" }),
    ]);
    expect(metrics.validationFailures).toBe(3);
    expect(metrics.validationFailuresByCode).toEqual({ budget_exhausted: 1, policy_denied: 2 });
  });

  it("counts a repeated argument hash within a run, but not the same hash in another run", () => {
    const metrics = buildRunMetrics([
      event("tool.requested", { toolCallId: "t1", actionName: "x", argumentsHash: HASH_A }, { runId: "r1" }),
      event("tool.requested", { toolCallId: "t2", actionName: "x", argumentsHash: HASH_A }, { runId: "r1" }),
      event("tool.requested", { toolCallId: "t3", actionName: "x", argumentsHash: HASH_B }, { runId: "r1" }),
      event("tool.requested", { toolCallId: "t4", actionName: "x", argumentsHash: HASH_A }, { runId: "r2" }),
      event("run.completed", { actionResultIds: [] }, { runId: "r1" }),
      event("run.completed", { actionResultIds: [] }, { runId: "r2" }),
    ]);
    expect(metrics.repeatedRequestHashes).toBe(1);
  });

  it("counts clarifications and each operation lifecycle stage", () => {
    const metrics = buildRunMetrics([
      event("clarification.required", { clarificationId: "c1", actionResultId: "ar1" }),
      event("operation.prepared", { operationId: "o1", confirmationId: "cf1" }),
      event("operation.confirmed", { operationId: "o1", confirmationId: "cf1" }),
      event("operation.completed", { operationId: "o1", actionResultId: "ar2" }),
      event("run.completed", { actionResultIds: [] }),
    ]);
    expect(metrics.clarificationsRequired).toBe(1);
    expect(metrics.operationsPrepared).toBe(1);
    expect(metrics.operationsConfirmed).toBe(1);
    expect(metrics.operationsCompleted).toBe(1);
  });
});

describe("T17-E: latency, tokens, abandonment and completion", () => {
  it("computes p50, p95 and max from completed calls only", () => {
    const metrics = buildRunMetrics([
      modelStarted(1, 1), modelCompleted(1, 100),
      modelStarted(2, 1), modelCompleted(2, 200),
      modelStarted(3, 1), modelCompleted(3, 300),
      modelStarted(4, 1), modelCompleted(4, 400),
      event("run.completed", { actionResultIds: [] }),
    ]);
    expect(metrics.latencyMs).toEqual({ p50: 200, p95: 400, max: 400 });
  });

  it("leaves latency undefined when no call completed", () => {
    const metrics = buildRunMetrics([modelStarted(1, 1), event("run.failed", { code: "timeout" })]);
    expect(metrics.latencyMs).toBeUndefined();
  });

  it("treats absent token usage as ABSENT, never as zero", () => {
    const none = buildRunMetrics([
      modelStarted(1, 1), modelCompleted(1, 10, {}),
      event("run.completed", { actionResultIds: [] }),
    ]);
    expect(none.tokens).toEqual({});
    expect(none.tokens.prompt).toBeUndefined();

    const some = buildRunMetrics([
      modelStarted(1, 1), modelCompleted(1, 10, { promptTokens: 100, completionTokens: 20 }),
      modelStarted(2, 1), modelCompleted(2, 10, { promptTokens: 50 }),
      event("run.completed", { actionResultIds: [] }),
    ]);
    expect(some.tokens).toEqual({ prompt: 150, completion: 20 });
  });

  it("counts a run with no terminal event as abandoned and reports it", () => {
    const metrics = buildRunMetrics([
      modelStarted(1, 1), modelCompleted(1, 10),
      event("api.search_started", { searchIndex: 1, access: "any", groups: [] }, { runId: "r2" }),
    ]);
    expect(metrics.runs).toBe(2);
    expect(metrics.abandonedRuns).toBe(2);
    expect(metrics.anomalies.some((a) => a.code === "run_terminal_event_missing" && a.groups === 2)).toBe(true);
  });

  it("reports two terminal events for one run as a corrupt group", () => {
    const metrics = buildRunMetrics([
      event("run.completed", { actionResultIds: [] }),
      event("run.failed", { code: "late" }),
    ]);
    expect(metrics.anomalies.some((a) => a.code === "multiple_terminal_events")).toBe(true);
  });

  it("computes the completion ratio, and leaves it undefined with no terminal run", () => {
    const mixed = buildRunMetrics([
      event("run.completed", { actionResultIds: [] }, { runId: "r1" }),
      event("run.completed", { actionResultIds: [] }, { runId: "r2" }),
      event("run.failed", { code: "x" }, { runId: "r3" }),
      event("run.failed", { code: "x" }, { runId: "r4" }),
    ]);
    expect(mixed.runsCompleted).toBe(2);
    expect(mixed.runsFailed).toBe(2);
    expect(mixed.completionRatio).toBe(0.5);

    expect(buildRunMetrics([]).completionRatio).toBeUndefined();
  });

  it("counts distinct sessions and runs, never emitting the identifiers themselves", () => {
    const metrics = buildRunMetrics([
      event("run.completed", { actionResultIds: [] }, { sessionId: "s1", runId: "r1" }),
      event("run.completed", { actionResultIds: [] }, { sessionId: "s1", runId: "r2" }),
      event("run.completed", { actionResultIds: [] }, { sessionId: "s2", runId: "r3" }),
    ]);
    expect(metrics.sessions).toBe(2);
    expect(metrics.runs).toBe(3);
    const serialized = JSON.stringify(metrics);
    for (const identifier of ["s1", "s2", "r1", "r2", "r3"]) {
      expect(serialized.includes(`"${identifier}"`), identifier).toBe(false);
    }
  });

  it("returns an all-zero, anomaly-free report for an empty scope", () => {
    const metrics = buildRunMetrics([]);
    expect(metrics.runs).toBe(0);
    expect(metrics.modelCalls).toBe(0);
    expect(metrics.anomalies).toEqual([]);
    expect(metrics.latencyMs).toBeUndefined();
  });
});
