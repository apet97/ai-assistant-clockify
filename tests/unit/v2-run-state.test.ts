import { describe, expect, it } from "vitest";
import {
  ACTIVE_RUN_PHASES,
  TERMINAL_RUN_PHASES,
  computeRequestHash,
  createEmptyRunBudget,
  isTerminalPhase,
  totalChargedTokens,
  type RunPhase,
} from "../../src/assistant-v2/state.js";

describe("computeRequestHash", () => {
  it("normalizes NFKC, lowercases, trims, and collapses whitespace before SHA-256", () => {
    const a = computeRequestHash("  List   Projects  ");
    const b = computeRequestHash("list projects");
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces distinct hashes for distinct normalized requests", () => {
    expect(computeRequestHash("list projects")).not.toBe(computeRequestHash("list clients"));
  });
});

describe("RunPhase classification", () => {
  it("treats completed and failed as terminal", () => {
    for (const phase of ["completed", "failed"] as RunPhase[]) {
      expect(TERMINAL_RUN_PHASES.has(phase)).toBe(true);
      expect(isTerminalPhase(phase)).toBe(true);
    }
  });

  it("includes awaiting_clarification as a non-terminal suspended phase", () => {
    expect(TERMINAL_RUN_PHASES.has("awaiting_clarification")).toBe(false);
    expect(ACTIVE_RUN_PHASES.has("awaiting_clarification")).toBe(false);
  });

  it("covers every active execution phase", () => {
    for (const phase of ["model", "discovering", "executing_reads", "preparing_writes"] as RunPhase[]) {
      expect(ACTIVE_RUN_PHASES.has(phase)).toBe(true);
    }
  });
});

describe("RunBudget helpers", () => {
  it("starts at zero for every counter", () => {
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

  it("sums all charged token buckets", () => {
    const budget = {
      ...createEmptyRunBudget(),
      promptTokensUsed: 10,
      completionTokensUsed: 5,
      estimatedTokensUsed: 3,
    };
    expect(totalChargedTokens(budget)).toBe(18);
  });

  // C9: `hostCallsCommitted` is deleted — it had no production caller. The
  // used+reserved sum that matters is computed where it is enforced: in TS at
  // budgets.ts (canReserveHostCalls) and in SQL at store.ts:967-968,:1008-1009,
  // which is the authority for the durable 60-call ledger.
});
