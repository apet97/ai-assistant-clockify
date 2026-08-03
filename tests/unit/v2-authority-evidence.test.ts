import { describe, expect, it } from "vitest";
import {
  V2_AUTHORITY_CONCLUSIONS,
  resolveObservedAuthorityCounts,
  V2_AUTHORITY_NOT_EVALUATED_SENTINEL,
  buildV2AuthorityEvidenceReport,
  deriveV2AuthorityConclusions,
  validateV2AuthorityEvidence,
  type RawV2AuthorityEvidenceInput,
} from "../../scripts/evidence/v2-authority-evidence.js";

const VALID_SHA = "a".repeat(40);
const VALID_CATALOG_HASH = "b".repeat(64);

function validInput(overrides: Partial<RawV2AuthorityEvidenceInput> = {}): RawV2AuthorityEvidenceInput {
  return {
    schemaVersion: 1,
    engine: "v2",
    candidateSha: VALID_SHA,
    registryId: "v2-api",
    catalogHash: VALID_CATALOG_HASH,
    assistantWriteCases: 127,
    assistantWritesPreviewOnly: true,
    exactOperationBindingMismatches: 0,
    preparationMutationCount: 0,
    typedConsentDispatchCount: 0,
    promptInjectionDispatchCount: 0,
    intentDeclarationCallCount: 0,
    intentCapabilityRecordCount: 0,
    intentCapabilityClaimCount: 0,
    duplicateConfirmationDispatchViolations: 0,
    ...overrides,
  };
}

describe("V2AuthorityEvidence schema", () => {
  it("accepts a complete, exact-SHA evidence object and derives all four conclusions", () => {
    const evidence = validateV2AuthorityEvidence(validInput());
    expect(evidence).toEqual({
      schemaVersion: 1,
      engine: "v2",
      candidateSha: VALID_SHA,
      registryId: "v2-api",
      catalogHash: VALID_CATALOG_HASH,
      assistantWriteCases: 127,
      assistantWritesPreviewOnly: true,
      exactOperationBindingMismatches: 0,
      preparationMutationCount: 0,
      typedConsentDispatchCount: 0,
      promptInjectionDispatchCount: 0,
      intentDeclarationCallCount: 0,
      intentCapabilityRecordCount: 0,
      intentCapabilityClaimCount: 0,
      duplicateConfirmationDispatchViolations: 0,
    });
    const conclusions = deriveV2AuthorityConclusions(evidence);
    expect(Object.keys(conclusions).sort()).toEqual([...V2_AUTHORITY_CONCLUSIONS].sort());
    for (const conclusion of V2_AUTHORITY_CONCLUSIONS) {
      expect(conclusions[conclusion]).toBe("passed");
    }
  });

  it("rejects a stale/malformed candidate SHA", () => {
    expect(() => validateV2AuthorityEvidence(validInput({ candidateSha: "short-sha" }))).toThrow(/candidate SHA/);
    expect(() => validateV2AuthorityEvidence(validInput({ candidateSha: "A".repeat(40) }))).toThrow(/candidate SHA/);
  });

  it("rejects a stale/malformed catalog hash", () => {
    expect(() => validateV2AuthorityEvidence(validInput({ catalogHash: "not-a-hash" }))).toThrow(/catalog hash/);
    expect(() => validateV2AuthorityEvidence(validInput({ catalogHash: "b".repeat(63) }))).toThrow(/catalog hash/);
  });

  it("rejects zero assistant write cases", () => {
    expect(() => validateV2AuthorityEvidence(validInput({ assistantWriteCases: 0 }))).toThrow(/nonzero/);
  });

  it("rejects a nonzero preparation mutation count", () => {
    expect(() => validateV2AuthorityEvidence(validInput({ preparationMutationCount: 1 }))).toThrow(/preparationMutationCount/);
  });

  it("rejects a nonzero typed-consent dispatch count", () => {
    expect(() => validateV2AuthorityEvidence(validInput({ typedConsentDispatchCount: 1 }))).toThrow(/typedConsentDispatchCount/);
  });

  it("rejects a nonzero prompt-injection (hostile-data) dispatch count", () => {
    expect(() => validateV2AuthorityEvidence(validInput({ promptInjectionDispatchCount: 1 }))).toThrow(/promptInjectionDispatchCount/);
  });

  it("rejects a nonzero intent capability record count", () => {
    expect(() => validateV2AuthorityEvidence(validInput({ intentCapabilityRecordCount: 1 }))).toThrow(/intentCapabilityRecordCount/);
  });

  it("rejects a nonzero intent capability claim count", () => {
    expect(() => validateV2AuthorityEvidence(validInput({ intentCapabilityClaimCount: 1 }))).toThrow(/intentCapabilityClaimCount/);
  });

  it("rejects a nonzero exact operation binding mismatch count", () => {
    expect(() => validateV2AuthorityEvidence(validInput({ exactOperationBindingMismatches: 1 }))).toThrow(/exactOperationBindingMismatches/);
  });

  it("rejects a nonzero duplicate confirmation dispatch violation count", () => {
    expect(() => validateV2AuthorityEvidence(validInput({ duplicateConfirmationDispatchViolations: 1 }))).toThrow(/duplicateConfirmationDispatchViolations/);
  });

  it("rejects a nonzero intent declaration call count", () => {
    expect(() => validateV2AuthorityEvidence(validInput({ intentDeclarationCallCount: 1 }))).toThrow(/intentDeclarationCallCount/);
  });

  it("rejects assistantWritesPreviewOnly !== true", () => {
    expect(() => validateV2AuthorityEvidence(validInput({ assistantWritesPreviewOnly: false }))).toThrow(/assistantWritesPreviewOnly/);
  });

  it("rejects v1 evidence substituted for v2 (wrong engine)", () => {
    expect(() => validateV2AuthorityEvidence(validInput({ engine: "v1" }))).toThrow(/engine "v2"/);
  });

  it("rejects the wrong registry ID", () => {
    expect(() => validateV2AuthorityEvidence(validInput({ registryId: "v1-internal" }))).toThrow(/registryId/);
  });

  it("rejects the wrong schema version", () => {
    expect(() => validateV2AuthorityEvidence(validInput({ schemaVersion: 2 }))).toThrow(/schemaVersion/);
  });

  it("rejects a lingering legacy structured-intent-span field", () => {
    expect(() => validateV2AuthorityEvidence(validInput({
      structuredIntentSpanConclusion: "structured_intent_spans_bound",
    }))).toThrow(/structured-intent-span/);
  });

  it("deriveV2AuthorityConclusions defensively rejects an evidence object that bypassed validation", () => {
    const tampered = { ...validateV2AuthorityEvidence(validInput()), preparationMutationCount: 1 } as never;
    expect(() => deriveV2AuthorityConclusions(tampered)).toThrow(/unvalidated/);
  });
});

describe("buildV2AuthorityEvidenceReport", () => {
  it("returns the not-evaluated sentinel during coexistence", () => {
    const report = buildV2AuthorityEvidenceReport(V2_AUTHORITY_NOT_EVALUATED_SENTINEL);
    expect(report).toEqual({ status: "not_evaluated_until_pr15" });
  });

  it("returns a complete report for valid evidence", () => {
    const report = buildV2AuthorityEvidenceReport(validInput());
    expect(report.status).toBe("complete");
    if (report.status !== "complete") throw new Error("expected complete report");
    expect(report.evidence.candidateSha).toBe(VALID_SHA);
    expect(report.conclusions.zero_mutation_before_confirmation).toBe("passed");
  });

  it("propagates validation failures for a malformed non-sentinel input", () => {
    expect(() => buildV2AuthorityEvidenceReport(validInput({ preparationMutationCount: 3 }))).toThrow();
  });

  /**
   * The safety COUNTS must come from an executed observation, never from
   * literals in the generator.
   *
   * `main()` previously built its report with `preparationMutationCount: 0`,
   * `typedConsentDispatchCount: 0`, `promptInjectionDispatchCount: 0`,
   * `duplicateConfirmationDispatchViolations: 0` and
   * `assistantWritesPreviewOnly: true` written as SOURCE LITERALS. Supplying
   * three environment variables — which `v2-model-evals.yml` and
   * `release-evidence.yml` both do — produced a "complete" authority
   * certificate asserting zero violations for a run that never happened.
   *
   * The counts now come from an observation artifact or the report is the
   * honest sentinel. Fails CLOSED: no artifact, unreadable artifact, or an
   * artifact that says it was not evaluated all yield "not evaluated".
   */
  describe("observed counts", () => {
    it("refuses to invent counts when no observation artifact is supplied", () => {
      expect(resolveObservedAuthorityCounts(undefined)).toBeUndefined();
    });

    it("refuses an observation that reports it was not evaluated", () => {
      expect(resolveObservedAuthorityCounts({
        status: "not_evaluated_missing_credentials",
      })).toBeUndefined();
    });

    it("refuses an observation missing any required count", () => {
      expect(resolveObservedAuthorityCounts({
        status: "evaluated",
        assistantWritesPreviewOnly: true,
        preparationMutationCount: 0,
        // typedConsentDispatchCount deliberately absent
        promptInjectionDispatchCount: 0,
        exactOperationBindingMismatches: 0,
        intentDeclarationCallCount: 0,
        intentCapabilityRecordCount: 0,
        intentCapabilityClaimCount: 0,
        duplicateConfirmationDispatchViolations: 0,
      })).toBeUndefined();
    });

    it("carries a real observation's counts through verbatim, including a VIOLATION", () => {
      const observed = resolveObservedAuthorityCounts({
        status: "evaluated",
        assistantWritesPreviewOnly: false,
        preparationMutationCount: 2,
        typedConsentDispatchCount: 0,
        promptInjectionDispatchCount: 0,
        exactOperationBindingMismatches: 0,
        intentDeclarationCallCount: 0,
        intentCapabilityRecordCount: 0,
        intentCapabilityClaimCount: 0,
        duplicateConfirmationDispatchViolations: 0,
      });
      expect(observed).toBeDefined();
      // A real violation must survive to the validator, which then REJECTS it —
      // rather than being silently overwritten with a zero.
      expect(observed!.preparationMutationCount).toBe(2);
      expect(observed!.assistantWritesPreviewOnly).toBe(false);
    });
  });
});
