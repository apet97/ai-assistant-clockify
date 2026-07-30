import { describe, expect, it } from "vitest";

import {
  validateV2PrivateProductionReleaseEvidence,
  validateV2PrivateProductionReleaseEvidenceFromEnvironment,
} from "../../scripts/evidence/v2-private-production-release-evidence.js";

const SHA = "a".repeat(40);

/** The subset of the real `/version` payload (src/server.ts) the v2 check binds. */
function deployedVersion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "1.0.0",
    releaseSha: SHA,
    buildHash: "c".repeat(64),
    serverArtifactSha256: "d".repeat(64),
    sourceRelationship: "source_bound_builder",
    sourceBindingSha256: "e".repeat(64),
    modelConfiguration: { assistantEngine: "v2" },
    ...overrides,
  };
}

function deploymentEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "v2_private_production_deployment",
    conclusion: "passed",
    candidateSha: SHA,
    observedAt: "2026-07-30T10:00:00.000Z",
    probes: { live: 200, health: 200, manifest: 200 },
    ...overrides,
  };
}

function validate(
  evidence: unknown,
  deployed: unknown = deployedVersion(),
  target: "v1" | "v2" = "v2",
): ReturnType<typeof validateV2PrivateProductionReleaseEvidence> {
  return validateV2PrivateProductionReleaseEvidence({
    evidence,
    deployedVersion: deployed,
    expectedCandidateSha: SHA,
  }, target);
}

describe("B6: the v2 private-production release evidence sibling", () => {
  it("accepts a deployed v2 candidate with all three probes at 200", () => {
    const validation = validate(deploymentEvidence());
    expect(validation).toEqual({
      assistantEngine: "v2",
      evidenceStatus: "current",
      validForV2: true,
      schemaVersion: 1,
      kind: "v2-private-production-release-validation",
      conclusion: "passed",
      sourceCandidateSha: SHA,
      releaseBuildHash: "c".repeat(64),
      serverArtifactSha256: "d".repeat(64),
      observedAt: "2026-07-30T10:00:00.000Z",
      probesPassed: 3,
    });
  });

  it("rejects a v1 target before any artifact is parsed", () => {
    expect(() => validate("not even parsed", deployedVersion(), "v1")).toThrow(
      /current v2 evidence is not valid for v1/iu,
    );
  });

  it("rejects a failing or missing probe", () => {
    expect(() => validate(deploymentEvidence({
      probes: { live: 200, health: 503, manifest: 200 },
    }))).toThrow(/health/u);
    expect(() => validate(deploymentEvidence({
      probes: { live: 200, manifest: 200 },
    }))).toThrow(/probes/iu);
  });

  it("rejects a candidate mismatch and a deployed v1 engine", () => {
    expect(() => validate(deploymentEvidence({ candidateSha: "b".repeat(40) }))).toThrow(/candidate/iu);
    expect(() => validate(
      deploymentEvidence(),
      deployedVersion({ modelConfiguration: { assistantEngine: "v1" } }),
    )).toThrow(/deployed assistant engine is not v2/u);
  });

  it("rejects a deployment of a different release SHA", () => {
    expect(() => validate(deploymentEvidence(), deployedVersion({ releaseSha: "b".repeat(40) })))
      .toThrow(/deployed release/u);
  });

  it("rejects unknown keys and malformed timestamps", () => {
    expect(() => validate(deploymentEvidence({ extra: true }))).toThrow(/malformed/iu);
    expect(() => validate(deploymentEvidence({ observedAt: "yesterday" }))).toThrow(/observedAt/u);
  });

  it("validates end to end from environment paths with injected reads", () => {
    const files: Record<string, unknown> = {
      "deployment.json": deploymentEvidence(),
      "deployed-version.json": deployedVersion(),
    };
    const { outputPath, validation } = validateV2PrivateProductionReleaseEvidenceFromEnvironment({
      V2_PRIVATE_PRODUCTION_VALIDATION_PATH: "/tmp/out/v2-private-production.json",
      V2_PRIVATE_PRODUCTION_EVIDENCE_PATH: "deployment.json",
      V2_PRIVATE_PRODUCTION_DEPLOYED_VERSION_PATH: "deployed-version.json",
      V2_PRIVATE_PRODUCTION_EXPECTED_CANDIDATE_SHA: SHA,
    }, (path) => {
      if (!(path in files)) throw new Error(`fixture file not found: ${path}`);
      return JSON.stringify(files[path]);
    });
    expect(outputPath).toBe("/tmp/out/v2-private-production.json");
    expect(validation.probesPassed).toBe(3);
  });

  it("requires every environment path", () => {
    expect(() => validateV2PrivateProductionReleaseEvidenceFromEnvironment({}, () => "{}")).toThrow(
      /V2_PRIVATE_PRODUCTION_VALIDATION_PATH/u,
    );
  });
});
