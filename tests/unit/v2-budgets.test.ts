import { describe, expect, it } from "vitest";
import {
  V2_LIMITS,
  canReserveApiCall,
  canReserveDiscoveryCall,
  canReserveHostCalls,
  canReserveModelCall,
  chargeFailedModelAttempt,
  chargeSuccessfulModelAttempt,
  incrementApiCallsUsed,
  incrementDiscoveryCallsUsed,
  incrementModelCallsUsed,
  isActiveWallBudgetExceeded,
  isTokenBudgetExceeded,
  preflightModelRequest,
  reserveHostCalls,
  resolveHostCallCeiling,
} from "../../src/assistant-v2/budgets.js";
import { createEmptyRunBudget, totalChargedTokens } from "../../src/assistant-v2/state.js";

describe("V2_LIMITS", () => {
  it("freezes the exact safety ceilings from the v2 plan", () => {
    expect(V2_LIMITS).toEqual({
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
  });
});

describe("resolveHostCallCeiling (plan B1: eval-only NARROWING override)", () => {
  it("resolves the exact production ceiling when no override is present", () => {
    expect(resolveHostCallCeiling(undefined)).toBe(V2_LIMITS.maxHostCalls);
    expect(resolveHostCallCeiling({})).toBe(V2_LIMITS.maxHostCalls);
  });

  it("accepts any integer from zero up to the production default", () => {
    expect(resolveHostCallCeiling({ maxHostCalls: 0 })).toBe(0);
    expect(resolveHostCallCeiling({ maxHostCalls: 1 })).toBe(1);
    expect(resolveHostCallCeiling({ maxHostCalls: V2_LIMITS.maxHostCalls })).toBe(V2_LIMITS.maxHostCalls);
  });

  it("rejects negatives, non-integers, and anything ABOVE the production default", () => {
    for (const invalid of [-1, 0.5, V2_LIMITS.maxHostCalls + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveHostCallCeiling({ maxHostCalls: invalid }))
        .toThrow(/invalid_budget_override:maxHostCalls/);
    }
  });
});

describe("counter ceilings", () => {
  it("allows exactly six model calls and rejects the seventh", () => {
    let budget = createEmptyRunBudget();
    for (let i = 0; i < 6; i += 1) {
      expect(canReserveModelCall(budget)).toBe(true);
      budget = incrementModelCallsUsed(budget);
    }
    expect(canReserveModelCall(budget)).toBe(false);
    expect(budget.modelCallsUsed).toBe(6);
  });

  it("allows exactly two discovery calls and rejects the third", () => {
    let budget = createEmptyRunBudget();
    for (let i = 0; i < 2; i += 1) {
      expect(canReserveDiscoveryCall(budget)).toBe(true);
      budget = incrementDiscoveryCallsUsed(budget);
    }
    expect(canReserveDiscoveryCall(budget)).toBe(false);
  });

  it("allows exactly twelve API calls and rejects the thirteenth", () => {
    let budget = createEmptyRunBudget();
    for (let i = 0; i < 12; i += 1) {
      expect(canReserveApiCall(budget)).toBe(true);
      budget = incrementApiCallsUsed(budget);
    }
    expect(canReserveApiCall(budget)).toBe(false);
  });

  it("enforces host-call used + reserved <= 60", () => {
    let budget = createEmptyRunBudget();
    expect(canReserveHostCalls(budget, 60)).toBe(true);
    budget = reserveHostCalls(budget, 60);
    expect(canReserveHostCalls(budget, 1)).toBe(false);
    expect(budget.hostCallsUsed + budget.hostCallsReserved).toBe(60);
  });
});

describe("token preflight and charging", () => {
  it("reserves worst-case budget for two provider attempts", () => {
    const budget = createEmptyRunBudget();
    const result = preflightModelRequest(budget, 10_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.perAttemptAllowance).toBe(Math.floor(V2_LIMITS.maxTotalTokens / 2));
    expect(result.maxOutputTokens).toBe(Math.min(V2_LIMITS.maxOutputTokensPerCall, result.perAttemptAllowance - 10_000));
  });

  it("fails preflight when the serialized request alone exceeds half the remaining token budget", () => {
    const budget = createEmptyRunBudget();
    const half = Math.floor(V2_LIMITS.maxTotalTokens / 2);
    expect(preflightModelRequest(budget, half).ok).toBe(false);
    expect(preflightModelRequest(budget, half - 1).ok).toBe(true);
  });

  it("caps maxOutputTokens at 8192 even when more allowance remains", () => {
    const budget = createEmptyRunBudget();
    const result = preflightModelRequest(budget, 100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.maxOutputTokens).toBe(V2_LIMITS.maxOutputTokensPerCall);
  });

  it("charges provider-reported usage when present", () => {
    const budget = createEmptyRunBudget();
    const next = chargeSuccessfulModelAttempt(budget, { promptTokens: 100, completionTokens: 50 }, 9_999, 9_999);
    expect(next.promptTokensUsed).toBe(100);
    expect(next.completionTokensUsed).toBe(50);
    expect(next.estimatedTokensUsed).toBe(0);
    expect(totalChargedTokens(next)).toBe(150);
  });

  it("falls back to one estimated token per UTF-8 byte when usage is absent", () => {
    const budget = createEmptyRunBudget();
    const next = chargeSuccessfulModelAttempt(budget, undefined, 500, 300);
    expect(next.estimatedTokensUsed).toBe(800);
    expect(next.promptTokensUsed).toBe(0);
    expect(next.completionTokensUsed).toBe(0);
  });

  it("charges inputReserve + maxOutputTokens for a failed transient attempt", () => {
    const budget = createEmptyRunBudget();
    const preflight = preflightModelRequest(budget, 1_000);
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;
    const next = chargeFailedModelAttempt(budget, preflight.inputReserve, preflight.maxOutputTokens);
    expect(next.estimatedTokensUsed).toBe(preflight.inputReserve + preflight.maxOutputTokens);
  });

  it("never treats missing usage as zero when estimating from bytes", () => {
    const budget = createEmptyRunBudget();
    const next = chargeSuccessfulModelAttempt(budget, undefined, 0, 0);
    expect(totalChargedTokens(next)).toBe(0);
    const withBytes = chargeSuccessfulModelAttempt(budget, undefined, 1, 1);
    expect(withBytes.estimatedTokensUsed).toBe(2);
  });

  it("detects token budget exhaustion after cumulative charges", () => {
    let budget = createEmptyRunBudget();
    budget = chargeSuccessfulModelAttempt(budget, { promptTokens: 32_000, completionTokens: 32_000 }, 0, 0);
    expect(isTokenBudgetExceeded(budget)).toBe(true);
  });

  it("accounts for prior charges when computing the next preflight allowance", () => {
    let budget = createEmptyRunBudget();
    budget = chargeSuccessfulModelAttempt(budget, { promptTokens: 20_000, completionTokens: 10_000 }, 0, 0);
    const remaining = V2_LIMITS.maxTotalTokens - 30_000;
    const result = preflightModelRequest(budget, 100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.perAttemptAllowance).toBe(Math.floor(remaining / 2));
  });
});

describe("active wall clock budget", () => {
  it("flags exhaustion at exactly 300_000 ms", () => {
    const budget = { ...createEmptyRunBudget(), activeWallMsUsed: 299_999 };
    expect(isActiveWallBudgetExceeded(budget)).toBe(false);
    expect(isActiveWallBudgetExceeded({ ...budget, activeWallMsUsed: 300_000 })).toBe(true);
  });
});

describe("createEmptyRunBudget", () => {
  it("starts every counter at zero", () => {
    expect(createEmptyRunBudget()).toEqual({
      modelCallsUsed: 0,
      discoveryCallsUsed: 0,
      apiCallsUsed: 0,
      hostCallsUsed: 0,
      hostCallsReserved: 0,
      promptTokensUsed: 0,
      completionTokensUsed: 0,
      estimatedTokensUsed: 0,
      activeWallMsUsed: 0,
    });
  });
});
