import { describe, expect, it } from "vitest";
import {
  buildV2WriteSafetyObservationArtifact,
} from "../../scripts/evidence/v2-write-safety-observation.js";
import {
  buildWriteSafetyEvalCases,
  WRITE_SAFETY_INVARIANTS,
} from "../../scripts/eval-v2/write-safety-cases.js";
import type { WriteSafetyObservation } from "../../scripts/eval-write-safety.js";

function observationsWithAll(satisfied: boolean): WriteSafetyObservation[] {
  return buildWriteSafetyEvalCases().flatMap((entry) =>
    WRITE_SAFETY_INVARIANTS.map((invariant) => ({
      actionName: entry.actionName,
      invariant,
      satisfied,
      ...(satisfied ? {} : { violationCode: "fixture_violation" }),
    })),
  );
}

describe("v2 write-safety observation artifact", () => {
  it("derives evaluated counts from a clean observer result", () => {
    const artifact = buildV2WriteSafetyObservationArtifact(observationsWithAll(true));

    expect(artifact.status).toBe("evaluated");
    expect(artifact.assistantWritesPreviewOnly).toBe(true);
    expect(artifact.exactOperationBindingMismatches).toBe(0);
    expect(artifact.preparationMutationCount).toBe(0);
    expect(artifact.typedConsentDispatchCount).toBe(0);
    expect(artifact.promptInjectionDispatchCount).toBe(0);
    expect(artifact.intentDeclarationCallCount).toBe(0);
    expect(artifact.intentCapabilityRecordCount).toBe(0);
    expect(artifact.intentCapabilityClaimCount).toBe(0);
    expect(artifact.duplicateConfirmationDispatchViolations).toBe(0);
    expect(artifact.binding.observationCount).toBe(artifact.binding.expectedChecks);
  });

  it("preserves a real preparation violation as a nonzero count", () => {
    const observations = observationsWithAll(true);
    const target = observations.find((entry) => entry.invariant === "zero_preparation_mutation");
    if (!target) throw new Error("expected a preparation observation");
    target.satisfied = false;
    target.violationCode = "mutation_during_preparation";

    const artifact = buildV2WriteSafetyObservationArtifact(observations);

    expect(artifact.status).toBe("evaluated");
    expect(artifact.preparationMutationCount).toBe(1);
    expect(artifact.preparationMutationCount).not.toBe(0);
  });
});
