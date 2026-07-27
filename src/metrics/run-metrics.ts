import type { RunEventPayloadMap, RunEventType } from "../assistant-v2/events.js";

/**
 * T17-E: EVERY v2 run-metrics formula lives in this one module. The store
 * exposes bounded, scoped primitives only (`listRunEventsForMetrics`) and
 * computes nothing.
 *
 * Privacy contract, enforced by the input type itself: this module receives
 * event type, timestamps, and the strictly-typed bounded payloads — it never
 * receives request text, tool arguments, entity names, or any Clockify data, and
 * every output is an aggregate count, ratio, or latency percentile. `argumentsHash`
 * is a hash, and the only identifiers that appear in output are counts of
 * distinct sessions/runs, never the ids themselves.
 */

/** One bounded run-event row as the store hands it over. */
export interface RunMetricsEvent {
  sessionId: string;
  runId: string;
  sequence: number;
  eventType: RunEventType;
  payload: RunEventPayloadMap[RunEventType];
  createdAt: string;
}

/** A group whose events contradict the protocol. Reported, never normalized away. */
export interface RunMetricsAnomaly {
  code:
    | "model_call_without_start"
    | "duplicate_attempt_for_model_call"
    | "attempt_two_without_attempt_one"
    | "model_call_never_completed"
    | "run_terminal_event_missing"
    | "multiple_terminal_events";
  /** Count of affected groups; never the ids themselves. */
  groups: number;
}

export interface RunMetrics {
  /** Distinct v2 runs in scope. */
  runs: number;
  /** Distinct chat sessions those runs belong to. */
  sessions: number;
  /** Discovery searches started. */
  searches: number;
  /** Searches beyond the first in the same run — the refinement count. */
  refinements: number;
  /** Operation-load events sourced from a seeded cache rather than a search. */
  cacheHits: number;
  /** Total operations loaded across all load events. */
  loadedTools: number;
  /** Largest number of operations offered in one load event. */
  maxLoadedTools: number;
  /** Tool calls the harness denied, by denial code. */
  validationFailures: number;
  validationFailuresByCode: Record<string, number>;
  /** Tool requests whose arguments hash repeated within the same run. */
  repeatedRequestHashes: number;
  /** Runs that never reached a terminal event and are not awaiting anything. */
  abandonedRuns: number;
  /** Unique logical model calls (attempt 1 only — the honest denominator). */
  modelCalls: number;
  /** Provider attempts, including retried attempt 2 of the SAME logical call. */
  providerAttempts: number;
  /** Logical model calls that started but never completed. */
  incompleteModelCalls: number;
  /** Completed-call latency, milliseconds. */
  latencyMs: { p50: number; p95: number; max: number } | undefined;
  /** Token totals from the `model.completed` usage payload; a field stays absent
   * when the provider reported none (absence is not zero). */
  tokens: { prompt?: number; completion?: number; estimated?: number };
  clarificationsRequired: number;
  operationsPrepared: number;
  operationsConfirmed: number;
  operationsCompleted: number;
  runsCompleted: number;
  runsFailed: number;
  /** completed / (completed + failed), or `undefined` when neither happened. */
  completionRatio: number | undefined;
  anomalies: RunMetricsAnomaly[];
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index]!;
}

function bump(counter: Map<string, number>, key: string): void {
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

/**
 * The one aggregation. Groups by `(sessionId, runId, modelCall)` for model
 * accounting: attempt 2 of a logical call is the SAME call (the store already
 * skips the budget increment for it), so the denominator counts distinct
 * attempt-1 groups while `providerAttempts` counts every attempt.
 */
export function buildRunMetrics(events: readonly RunMetricsEvent[]): RunMetrics {
  const runs = new Set<string>();
  const sessions = new Set<string>();
  const searchesPerRun = new Map<string, number>();
  const argumentHashesPerRun = new Map<string, Set<string>>();
  const terminalPerRun = new Map<string, number>();
  const startedAttempts = new Map<string, Set<1 | 2>>();
  const completedCalls = new Set<string>();
  const validationByCode = new Map<string, number>();

  let searches = 0;
  let cacheHits = 0;
  let loadedTools = 0;
  let maxLoadedTools = 0;
  let validationFailures = 0;
  let repeatedRequestHashes = 0;
  let providerAttempts = 0;
  let clarificationsRequired = 0;
  let operationsPrepared = 0;
  let operationsConfirmed = 0;
  let operationsCompleted = 0;
  let runsCompleted = 0;
  let runsFailed = 0;
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;
  let estimatedTokens: number | undefined;
  const latencies: number[] = [];
  const anomalyCounts = new Map<RunMetricsAnomaly["code"], number>();

  const runKey = (event: RunMetricsEvent): string => `${event.sessionId}\u0000${event.runId}`;
  const callKey = (event: RunMetricsEvent, modelCall: number): string => `${runKey(event)}\u0000${modelCall}`;

  for (const event of events) {
    runs.add(runKey(event));
    sessions.add(event.sessionId);

    switch (event.eventType) {
      case "model.started": {
        const payload = event.payload as RunMetricsEvent["payload"] & RunEventPayloadMap["model.started"];
        const key = callKey(event, payload.modelCall);
        const attempts = startedAttempts.get(key) ?? new Set<1 | 2>();
        if (attempts.has(payload.providerAttempt)) {
          anomalyCounts.set("duplicate_attempt_for_model_call", (anomalyCounts.get("duplicate_attempt_for_model_call") ?? 0) + 1);
        }
        attempts.add(payload.providerAttempt);
        startedAttempts.set(key, attempts);
        providerAttempts += 1;
        if (payload.cacheSeeded) cacheHits += 1;
        break;
      }
      case "model.completed": {
        const payload = event.payload as RunEventPayloadMap["model.completed"];
        const key = callKey(event, payload.modelCall);
        if (!startedAttempts.has(key)) {
          anomalyCounts.set("model_call_without_start", (anomalyCounts.get("model_call_without_start") ?? 0) + 1);
        }
        completedCalls.add(key);
        latencies.push(payload.latencyMs);
        const usage = payload.usage as {
          promptTokens?: number;
          completionTokens?: number;
          estimatedTokens?: number;
        } | undefined;
        // Absence is never zero: a provider that reports no usage leaves the
        // total `undefined` rather than dragging an average down.
        if (typeof usage?.promptTokens === "number") promptTokens = (promptTokens ?? 0) + usage.promptTokens;
        if (typeof usage?.completionTokens === "number") completionTokens = (completionTokens ?? 0) + usage.completionTokens;
        if (typeof usage?.estimatedTokens === "number") {
          estimatedTokens = (estimatedTokens ?? 0) + usage.estimatedTokens;
        }
        break;
      }
      case "api.search_started":
        searches += 1;
        searchesPerRun.set(runKey(event), (searchesPerRun.get(runKey(event)) ?? 0) + 1);
        break;
      case "api.operations_loaded": {
        const payload = event.payload as RunEventPayloadMap["api.operations_loaded"];
        loadedTools += payload.operationIds.length;
        maxLoadedTools = Math.max(maxLoadedTools, payload.operationIds.length);
        break;
      }
      case "tool.requested": {
        const payload = event.payload as RunEventPayloadMap["tool.requested"];
        const seen = argumentHashesPerRun.get(runKey(event)) ?? new Set<string>();
        if (seen.has(payload.argumentsHash)) repeatedRequestHashes += 1;
        seen.add(payload.argumentsHash);
        argumentHashesPerRun.set(runKey(event), seen);
        break;
      }
      case "tool.denied": {
        const payload = event.payload as RunEventPayloadMap["tool.denied"];
        validationFailures += 1;
        bump(validationByCode, payload.code);
        break;
      }
      case "clarification.required":
        clarificationsRequired += 1;
        break;
      case "operation.prepared":
        operationsPrepared += 1;
        break;
      case "operation.confirmed":
        operationsConfirmed += 1;
        break;
      case "operation.completed":
        operationsCompleted += 1;
        break;
      case "run.completed":
        runsCompleted += 1;
        terminalPerRun.set(runKey(event), (terminalPerRun.get(runKey(event)) ?? 0) + 1);
        break;
      case "run.failed":
        runsFailed += 1;
        terminalPerRun.set(runKey(event), (terminalPerRun.get(runKey(event)) ?? 0) + 1);
        break;
      default:
        break;
    }
  }

  let modelCalls = 0;
  let incompleteModelCalls = 0;
  for (const [key, attempts] of startedAttempts) {
    if (attempts.has(1)) modelCalls += 1;
    else {
      // Attempt 2 without attempt 1 cannot be grouped honestly.
      anomalyCounts.set("attempt_two_without_attempt_one", (anomalyCounts.get("attempt_two_without_attempt_one") ?? 0) + 1);
    }
    if (!completedCalls.has(key)) incompleteModelCalls += 1;
  }
  if (incompleteModelCalls > 0) {
    anomalyCounts.set("model_call_never_completed", incompleteModelCalls);
  }

  let abandonedRuns = 0;
  for (const key of runs) {
    const terminals = terminalPerRun.get(key) ?? 0;
    if (terminals === 0) abandonedRuns += 1;
    if (terminals > 1) {
      anomalyCounts.set("multiple_terminal_events", (anomalyCounts.get("multiple_terminal_events") ?? 0) + 1);
    }
  }
  if (abandonedRuns > 0) {
    anomalyCounts.set("run_terminal_event_missing", abandonedRuns);
  }

  let refinements = 0;
  for (const count of searchesPerRun.values()) refinements += Math.max(0, count - 1);

  const sortedLatencies = [...latencies].sort((left, right) => left - right);
  const terminalTotal = runsCompleted + runsFailed;

  return {
    runs: runs.size,
    sessions: sessions.size,
    searches,
    refinements,
    cacheHits,
    loadedTools,
    maxLoadedTools,
    validationFailures,
    validationFailuresByCode: Object.fromEntries([...validationByCode.entries()].sort()),
    repeatedRequestHashes,
    abandonedRuns,
    modelCalls,
    providerAttempts,
    incompleteModelCalls,
    latencyMs: sortedLatencies.length > 0
      ? {
          p50: percentile(sortedLatencies, 0.5),
          p95: percentile(sortedLatencies, 0.95),
          max: sortedLatencies[sortedLatencies.length - 1]!,
        }
      : undefined,
    tokens: {
      ...(promptTokens !== undefined ? { prompt: promptTokens } : {}),
      ...(completionTokens !== undefined ? { completion: completionTokens } : {}),
      ...(estimatedTokens !== undefined ? { estimated: estimatedTokens } : {}),
    },
    clarificationsRequired,
    operationsPrepared,
    operationsConfirmed,
    operationsCompleted,
    runsCompleted,
    runsFailed,
    completionRatio: terminalTotal > 0 ? runsCompleted / terminalTotal : undefined,
    anomalies: [...anomalyCounts.entries()]
      .map(([code, groups]) => ({ code, groups }))
      .sort((left, right) => left.code.localeCompare(right.code)),
  };
}
