import { describe, expect, it } from "vitest";
import {
  emptyIntentCapabilityPathTelemetry,
  scoreIntentCapabilityPath,
  serializeIntentCapabilityPath,
  type IntentCapabilityPathTelemetry,
} from "../../scripts/eval/intent-capability-path.js";

const passing: IntentCapabilityPathTelemetry = {
  intentDeclarationCalls: 1,
  intentDeclarationContract: "quote_refs_v1",
  intentCapabilityMode: "allow",
  intentCapabilityActionBound: true,
  intentCapabilityLiteralsExact: true,
  intentWriteArgumentsExact: true,
  intentHostMutationCount: 1,
  intentAuthorityChecks: 1,
  intentAuthorityDenials: 0,
  intentCapabilityBindCount: 1,
  intentCapabilityConsumeCount: 1,
  intentCapabilityConsumeDenials: 0,
};

describe("intent-capability release-eval telemetry", () => {
  it("provides one typed not-evaluated baseline for the legacy single-turn path", () => {
    expect(emptyIntentCapabilityPathTelemetry()).toEqual({
      intentDeclarationCalls: 0,
      intentDeclarationContract: "not_evaluated",
      intentCapabilityMode: "not_evaluated",
      intentCapabilityActionBound: false,
      intentCapabilityLiteralsExact: false,
      intentWriteArgumentsExact: false,
      intentHostMutationCount: 0,
      intentAuthorityChecks: 0,
      intentAuthorityDenials: 0,
      intentCapabilityBindCount: 0,
      intentCapabilityConsumeCount: 0,
      intentCapabilityConsumeDenials: 0,
    });
  });

  it("scores a complete exact write path without changing established failure text", () => {
    expect(scoreIntentCapabilityPath({
      telemetry: passing,
      writeActionCount: 1,
      previewCount: 0,
      confirmationAttemptCount: 0,
      expectsWriteCapability: true,
      requiresExactIntentPath: true,
    })).toEqual([]);

    expect(scoreIntentCapabilityPath({
      telemetry: {
        ...passing,
        intentDeclarationCalls: 0,
        intentAuthorityDenials: 1,
        intentCapabilityConsumeCount: 0,
      },
      writeActionCount: 1,
      previewCount: 0,
      confirmationAttemptCount: 0,
      expectsWriteCapability: true,
      requiresExactIntentPath: true,
    })).toEqual([
      "intent declaration did not run exactly once",
      "raw intent authority denied a configured write",
      "durable intent capability was not consumed exactly once per dispatched write",
    ]);
  });

  it("serializes exactly the stable secret-free release fields in their existing order", () => {
    const serialized = serializeIntentCapabilityPath(passing);
    expect(serialized).toEqual(passing);
    expect(Object.keys(serialized)).toEqual([
      "intentDeclarationCalls",
      "intentDeclarationContract",
      "intentCapabilityMode",
      "intentCapabilityActionBound",
      "intentCapabilityLiteralsExact",
      "intentWriteArgumentsExact",
      "intentHostMutationCount",
      "intentAuthorityChecks",
      "intentAuthorityDenials",
      "intentCapabilityBindCount",
      "intentCapabilityConsumeCount",
      "intentCapabilityConsumeDenials",
    ]);
  });
});
