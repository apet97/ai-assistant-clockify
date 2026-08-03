import { describe, expect, it } from "vitest";
import {
  attemptsFromObservations,
  buildWriteSafetyReport,
  type WriteSafetyObservation,
} from "../../scripts/eval-write-safety.js";
import {
  buildWriteSafetyEvalCases,
  WRITE_SAFETY_INVARIANTS,
} from "../../scripts/eval-v2/write-safety-cases.js";
import { isReleasableReport } from "../../scripts/eval-v2/report.js";

function completeObservations(): WriteSafetyObservation[] {
  return buildWriteSafetyEvalCases().flatMap((entry) =>
    WRITE_SAFETY_INVARIANTS.map((invariant) => ({
      actionName: entry.actionName,
      invariant,
      satisfied: true,
    })),
  );
}

describe("write-safety observation accounting", () => {
  it("rejects a contradictory duplicate instead of last-write-wins aggregation", () => {
    const observations = completeObservations();
    const first = observations[0];
    if (!first) throw new Error("expected a canonical observation");

    expect(() => attemptsFromObservations([
      ...observations,
      { ...first, satisfied: false, violationCode: "contradictory_duplicate" },
    ])).toThrow(/duplicate_write_safety_observation/);
  });

  it("rejects an observation for an unknown write", () => {
    const observations = completeObservations();
    expect(() => attemptsFromObservations([
      ...observations,
      { actionName: "clockify_unknown_write", invariant: WRITE_SAFETY_INVARIANTS[0], satisfied: true },
    ])).toThrow(/unknown_write_safety_observation/);
  });

  it("rejects a missing canonical observation before aggregation", () => {
    const observations = completeObservations();
    const missing = observations.slice(1);
    expect(() => attemptsFromObservations(missing)).toThrow(/missing_write_safety_observation/);
  });

  it("persists every write-safety attempt and rejects summary-only tampering", () => {
    const report = buildWriteSafetyReport(completeObservations());
    expect(report.attempts).toHaveLength(report.denominator);
    expect(isReleasableReport(report)).toBe(true);

    const tampered = {
      ...report,
      status: "passed" as const,
      numerator: report.denominator - 1,
      failures: [],
    };
    expect(isReleasableReport(tampered)).toBe(false);
  });
});
