import { describe, expect, it } from "vitest";

import {
  validateV2ModelBenchmarkEvidence,
  validateV2ModelReleaseEvidence,
  validateV2ModelReleaseEvidenceFromEnvironment,
} from "../../scripts/evidence/v2-model-release-evidence.js";

const SHA = "a".repeat(40);
const CATALOG_HASH = "3".repeat(64);

/** The exact deterministic report shape `scripts/eval-v2/report.ts` emits. */
function evalReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "v2_fixture",
    status: "passed",
    identity: {
      candidateSha: SHA,
      catalogHash: CATALOG_HASH,
      registryId: "v2-api",
      modelConfiguration: "scripted",
      cohortOrder: ["canonical"],
    },
    caseCount: 3,
    numerator: 3,
    denominator: 3,
    cohorts: [{ cohort: "canonical", numerator: 3, denominator: 3, failedCaseIds: [] }],
    failures: [],
    scoredCaseIds: ["case-a", "case-b", "case-c"],
    ...overrides,
  };
}

/** The subset of the real `/version` payload (src/server.ts) the v2 check binds. */
function deployedVersion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "1.0.0",
    releaseSha: SHA,
    buildHash: "c".repeat(64),
    serverArtifactSha256: "d".repeat(64),
    sourceRelationship: "source_bound_builder",
    sourceBindingSha256: "e".repeat(64),
    modelConfiguration: {
      provider: "http",
      model: "deepseek-v4-pro",
      endpointSha256: "f".repeat(64),
      assistantEngine: "v2",
      mode: "tool",
      agentic: true,
      toolSelect: true,
      reasoningEffort: null,
      thinkingMode: null,
    },
    ...overrides,
  };
}

function releaseInput(overrides: Record<string, unknown> = {}): Parameters<typeof validateV2ModelReleaseEvidence>[0] {
  return {
    apiDiscovery: evalReport(),
    assistantTerminal: evalReport(),
    writeSafety: evalReport(),
    deployedVersion: deployedVersion(),
    expectedCandidateSha: SHA,
    expectedCatalogHash: CATALOG_HASH,
    ...overrides,
  };
}

describe("B6: the v2 model release evidence sibling", () => {
  it("accepts three passing candidate-bound evaluations plus a deployed v2 engine", () => {
    const evidence = validateV2ModelReleaseEvidence(releaseInput());
    expect(evidence).toEqual({
      assistantEngine: "v2",
      evidenceStatus: "current",
      validForV2: true,
      schemaVersion: 1,
      kind: "v2-model-release-validation",
      conclusion: "passed",
      testedCandidateSha: SHA,
      catalogHash: CATALOG_HASH,
      evaluations: {
        apiDiscovery: "passed",
        assistantTerminal: "passed",
        writeSafety: "passed",
      },
      deployedConfigurationVerified: true,
    });
  });

  it("accepts a benchmark validation without a deployment, marked unverified", () => {
    const { deployedVersion: _unused, ...benchmarkInput } = releaseInput();
    const evidence = validateV2ModelBenchmarkEvidence(benchmarkInput);
    expect(evidence.deployedConfigurationVerified).toBe(false);
    expect(evidence.conclusion).toBe("passed");
    expect(evidence.validForV2).toBe(true);
  });

  it("rejects a v1 target before any artifact is parsed", () => {
    expect(() => validateV2ModelReleaseEvidence(
      { ...releaseInput(), apiDiscovery: "not even parsed" },
      "v1",
    )).toThrow(/current v2 evidence is not valid for v1/iu);
  });

  it("rejects a missing-credential sentinel evaluation instead of passing it", () => {
    const input = releaseInput({
      assistantTerminal: { status: "not_evaluated_missing_credentials" },
    });
    expect(() => validateV2ModelReleaseEvidence(input)).toThrow(
      /assistantTerminal evaluation is not_evaluated_missing_credentials/u,
    );
  });

  it("rejects an evaluation bound to a different catalog hash", () => {
    const input = releaseInput({
      writeSafety: evalReport({
        identity: {
          candidateSha: SHA,
          catalogHash: "4".repeat(64),
          registryId: "v2-api",
          modelConfiguration: "scripted",
          cohortOrder: ["canonical"],
        },
      }),
    });
    expect(() => validateV2ModelReleaseEvidence(input)).toThrow(/writeSafety evaluation is rejected/u);
  });

  it("rejects an evaluation bound to a different candidate SHA", () => {
    const input = releaseInput({
      apiDiscovery: evalReport({
        identity: {
          candidateSha: "b".repeat(40),
          catalogHash: CATALOG_HASH,
          registryId: "v2-api",
          modelConfiguration: "scripted",
          cohortOrder: ["canonical"],
        },
      }),
    });
    expect(() => validateV2ModelReleaseEvidence(input)).toThrow(/apiDiscovery evaluation is rejected/u);
  });

  it("rejects a deployment serving the v1 engine", () => {
    const input = releaseInput({
      deployedVersion: deployedVersion({
        modelConfiguration: { assistantEngine: "v1" },
      }),
    });
    expect(() => validateV2ModelReleaseEvidence(input)).toThrow(/deployed assistant engine is not v2/u);
  });

  it("rejects a deployment of a different release SHA", () => {
    const input = releaseInput({ deployedVersion: deployedVersion({ releaseSha: "b".repeat(40) }) });
    expect(() => validateV2ModelReleaseEvidence(input)).toThrow(/deployed release/u);
  });

  it("rejects a malformed expected candidate SHA or catalog hash", () => {
    expect(() => validateV2ModelReleaseEvidence(releaseInput({ expectedCandidateSha: "abc" })))
      .toThrow(/candidate SHA/u);
    expect(() => validateV2ModelReleaseEvidence(releaseInput({ expectedCatalogHash: "abc" })))
      .toThrow(/catalog hash/u);
  });

  it("validates end to end from environment paths with injected reads", () => {
    const files: Record<string, unknown> = {
      "api-discovery.json": evalReport(),
      "assistant-terminal.json": evalReport(),
      "write-safety.json": evalReport(),
      "deployed-version.json": deployedVersion(),
    };
    const { outputPath, evidence } = validateV2ModelReleaseEvidenceFromEnvironment({
      V2_MODEL_VALIDATION_PATH: "/tmp/out/v2-model.json",
      V2_MODEL_EXPECTED_CANDIDATE_SHA: SHA,
      V2_MODEL_EXPECTED_CATALOG_HASH: CATALOG_HASH,
      V2_EVAL_API_DISCOVERY_REPORT_PATH: "api-discovery.json",
      V2_EVAL_ASSISTANT_TERMINAL_REPORT_PATH: "assistant-terminal.json",
      V2_EVAL_WRITE_SAFETY_REPORT_PATH: "write-safety.json",
      V2_MODEL_DEPLOYED_VERSION_PATH: "deployed-version.json",
    }, (path) => {
      if (!(path in files)) throw new Error(`fixture file not found: ${path}`);
      return JSON.stringify(files[path]);
    });
    expect(outputPath).toBe("/tmp/out/v2-model.json");
    expect(evidence.deployedConfigurationVerified).toBe(true);
  });

  it("requires every environment path", () => {
    expect(() => validateV2ModelReleaseEvidenceFromEnvironment({}, () => "{}")).toThrow(
      /V2_MODEL_VALIDATION_PATH/u,
    );
  });
});
