import type { RunBudget } from "./state.js";
import { totalChargedTokens } from "./state.js";

export { createEmptyRunBudget } from "./state.js";

/** Hard-coded v2 safety ceilings — no environment flags. */
export const V2_LIMITS = Object.freeze({
  maxModelCalls: 6,
  maxDiscoveryCalls: 2,
  maxLoadedApiTools: 12,
  maxApiCalls: 12,
  maxConcurrentReads: 4,
  maxActiveWriteBatches: 1,
  maxHostCalls: 60,
  maxWallClockMs: 300_000,
  maxTotalTokens: 64_000,
  maxOutputTokensPerCall: 8_192,
});

/**
 * EVAL-ONLY (plan B1): a NARROWING per-run budget override.
 *
 * `runAssistantV2` validates it before any durable state exists and threads the
 * resolved host-call ceiling to the request-governor boundary. Absent — every
 * production caller — the ceiling is exactly `V2_LIMITS.maxHostCalls`. No
 * configuration or environment variable feeds it; the sole caller is the v2
 * eval harness (`scripts/eval-v2/runner-harness.ts`), pinned by
 * `tests/unit/v2-budget-override-pin.test.ts`. Because values above the
 * `V2_LIMITS` default are rejected, the override can never widen a ceiling.
 * Write-preparation RESERVATIONS keep the production `V2_LIMITS` math; the
 * override governs the physical host-call charge boundary.
 */
export interface RunBudgetOverrides {
  maxHostCalls?: number;
}

/** Fail-closed resolution of the per-run host-call ceiling: non-integers,
 * negatives, and values above the production default all throw. */
export function resolveHostCallCeiling(overrides: RunBudgetOverrides | undefined): number {
  if (overrides === undefined || overrides.maxHostCalls === undefined) {
    return V2_LIMITS.maxHostCalls;
  }
  const ceiling = overrides.maxHostCalls;
  if (!Number.isSafeInteger(ceiling) || ceiling < 0 || ceiling > V2_LIMITS.maxHostCalls) {
    throw new Error(`invalid_budget_override:maxHostCalls:${String(ceiling)}`);
  }
  return ceiling;
}

export type TokenBudgetFailure = "token_budget_exhausted";

export interface ModelPreflightSuccess {
  ok: true;
  maxOutputTokens: number;
  inputReserve: number;
  perAttemptAllowance: number;
}

export interface ModelPreflightFailure {
  ok: false;
  code: TokenBudgetFailure;
}

export type ModelPreflightResult = ModelPreflightSuccess | ModelPreflightFailure;

export interface ProviderUsageCharge {
  promptTokens: number;
  completionTokens: number;
}

/** Reserve output budget for one logical model call (two provider attempts). */
export function preflightModelRequest(
  budget: RunBudget,
  serializedRequestUtf8Bytes: number,
): ModelPreflightResult {
  const remainingTokens = V2_LIMITS.maxTotalTokens - totalChargedTokens(budget);
  const inputReserve = serializedRequestUtf8Bytes;
  const perAttemptAllowance = Math.floor(remainingTokens / 2);
  if (inputReserve >= perAttemptAllowance) {
    return { ok: false, code: "token_budget_exhausted" };
  }
  const maxOutputTokens = Math.min(
    V2_LIMITS.maxOutputTokensPerCall,
    perAttemptAllowance - inputReserve,
  );
  return { ok: true, maxOutputTokens, inputReserve, perAttemptAllowance };
}

/** Charge a successful provider attempt; reported usage takes precedence over byte estimate. */
export function chargeSuccessfulModelAttempt(
  budget: RunBudget,
  usage: ProviderUsageCharge | undefined,
  serializedRequestUtf8Bytes: number,
  serializedResponseUtf8Bytes: number,
): RunBudget {
  if (usage) {
    return {
      ...budget,
      promptTokensUsed: budget.promptTokensUsed + usage.promptTokens,
      completionTokensUsed: budget.completionTokensUsed + usage.completionTokens,
    };
  }
  const estimated = serializedRequestUtf8Bytes + serializedResponseUtf8Bytes;
  return {
    ...budget,
    estimatedTokensUsed: budget.estimatedTokensUsed + estimated,
  };
}

/** Charge the worst-case reservation for a transient failed attempt before retry. */
export function chargeFailedModelAttempt(
  budget: RunBudget,
  inputReserve: number,
  maxOutputTokens: number,
): RunBudget {
  return {
    ...budget,
    estimatedTokensUsed: budget.estimatedTokensUsed + inputReserve + maxOutputTokens,
  };
}

export function incrementModelCallsUsed(budget: RunBudget): RunBudget {
  return { ...budget, modelCallsUsed: budget.modelCallsUsed + 1 };
}

export function incrementDiscoveryCallsUsed(budget: RunBudget): RunBudget {
  return { ...budget, discoveryCallsUsed: budget.discoveryCallsUsed + 1 };
}

export function incrementApiCallsUsed(budget: RunBudget): RunBudget {
  return { ...budget, apiCallsUsed: budget.apiCallsUsed + 1 };
}

export function addActiveWallMs(budget: RunBudget, deltaMs: number): RunBudget {
  return { ...budget, activeWallMsUsed: budget.activeWallMsUsed + deltaMs };
}

export function canReserveModelCall(budget: RunBudget): boolean {
  return budget.modelCallsUsed < V2_LIMITS.maxModelCalls;
}

export function canReserveDiscoveryCall(budget: RunBudget): boolean {
  return budget.discoveryCallsUsed < V2_LIMITS.maxDiscoveryCalls;
}

export function canReserveApiCall(budget: RunBudget): boolean {
  return budget.apiCallsUsed < V2_LIMITS.maxApiCalls;
}

export function canReserveHostCalls(budget: RunBudget, count: number): boolean {
  return budget.hostCallsUsed + budget.hostCallsReserved + count <= V2_LIMITS.maxHostCalls;
}

export function reserveHostCalls(budget: RunBudget, count: number): RunBudget {
  return { ...budget, hostCallsReserved: budget.hostCallsReserved + count };
}

export function releaseHostCallReservation(budget: RunBudget, count: number): RunBudget {
  return { ...budget, hostCallsReserved: Math.max(0, budget.hostCallsReserved - count) };
}

export function dispatchHostCall(budget: RunBudget): RunBudget {
  return {
    ...budget,
    hostCallsUsed: budget.hostCallsUsed + 1,
    hostCallsReserved: Math.max(0, budget.hostCallsReserved - 1),
  };
}

export function isActiveWallBudgetExceeded(budget: RunBudget): boolean {
  return budget.activeWallMsUsed >= V2_LIMITS.maxWallClockMs;
}

export function isTokenBudgetExceeded(budget: RunBudget): boolean {
  return totalChargedTokens(budget) >= V2_LIMITS.maxTotalTokens;
}

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function serializeModelRequestForPreflight(
  messagesJson: string,
  toolsJson: string,
): number {
  return utf8ByteLength(messagesJson) + utf8ByteLength(toolsJson);
}
