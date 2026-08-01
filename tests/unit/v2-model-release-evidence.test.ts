import { describe, expect, it } from "vitest";

import {
  validateV2ModelBenchmarkEvidence,
  validateV2ModelReleaseEvidence,
  validateV2ModelReleaseEvidenceFromEnvironment,
} from "../../scripts/evidence/v2-model-release-evidence.js";
import { DISCOVERY_EXPECTED_CASE_COUNT } from "../../scripts/eval-v2/api-discovery-policy.js";
import {
  buildDiscoveryEvalCorpus,
  DISCOVERY_CORPUS_VERSION,
} from "../../scripts/eval-v2/api-discovery-cases.js";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";

const SHA = "a".repeat(40);
const CATALOG_HASH = MODEL_API_ACTION_CATALOG.hash();
const DISCOVERY_CORPUS = buildDiscoveryEvalCorpus();

function discoveryIdentity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    candidateSha: SHA,
    catalogHash: CATALOG_HASH,
    registryId: "v2-api",
    modelConfiguration: "provider=http model=fixture-model",
    cohortOrder: ["canonical", "paraphrase", "typo"],
    corpusVersion: DISCOVERY_CORPUS_VERSION,
    caseSelection: DISCOVERY_CORPUS.caseSelection,
    ...overrides,
  };
}

/** The exact strict-report shape `scripts/eval-v2/report.ts` emits. */
function evalReport(
  kind: "v2_assistant_terminal" | "v2_write_safety",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind,
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

/** A complete API-discovery attempt grid, including the persisted M6 proof. */
function discoveryReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const caseIds = DISCOVERY_CORPUS.cases.map((entry) => entry.actionName);
  const attempts = caseIds.flatMap((caseId) => ["canonical", "paraphrase", "typo"].flatMap((cohort) =>
    Array.from({ length: 3 }, (_, repeat) => ({ caseId, cohort, repeat, passed: true }))));
  return {
    schemaVersion: 1,
    kind: "v2_api_discovery",
    status: "passed",
    identity: discoveryIdentity(),
    caseCount: caseIds.length,
    numerator: attempts.length,
    denominator: attempts.length,
    cohorts: ["canonical", "paraphrase", "typo"].map((cohort) => ({
      cohort,
      numerator: caseIds.length * 3,
      denominator: caseIds.length * 3,
      failedCaseIds: [],
    })),
    failures: [],
    scoredCaseIds: caseIds,
    caseIds,
    attempts,
    thresholdViolations: [],
    ...overrides,
  };
}

function exactFloorDiscoveryReport(): Record<string, unknown> {
  const caseIds = DISCOVERY_CORPUS.cases.map((entry) => entry.actionName);
  const failedCaseIds = [...caseIds].sort();
  const attempts = caseIds.flatMap((caseId) => ["canonical", "paraphrase", "typo"].flatMap((cohort) =>
    Array.from({ length: 3 }, (_, repeat) => {
      const passed = cohort === "canonical" || repeat < 2;
      return {
        caseId,
        cohort,
        repeat,
        passed,
        ...(passed ? {} : { failureCode: "operation_not_loaded" }),
      };
    })));
  return discoveryReport({
    numerator: DISCOVERY_EXPECTED_CASE_COUNT * 7,
    denominator: DISCOVERY_EXPECTED_CASE_COUNT * 9,
    caseCount: DISCOVERY_EXPECTED_CASE_COUNT,
    caseIds,
    scoredCaseIds: caseIds,
    attempts,
    cohorts: [
      {
        cohort: "canonical",
        numerator: DISCOVERY_EXPECTED_CASE_COUNT * 3,
        denominator: DISCOVERY_EXPECTED_CASE_COUNT * 3,
        failedCaseIds: [],
      },
      {
        cohort: "paraphrase",
        numerator: DISCOVERY_EXPECTED_CASE_COUNT * 2,
        denominator: DISCOVERY_EXPECTED_CASE_COUNT * 3,
        failedCaseIds,
      },
      {
        cohort: "typo",
        numerator: DISCOVERY_EXPECTED_CASE_COUNT * 2,
        denominator: DISCOVERY_EXPECTED_CASE_COUNT * 3,
        failedCaseIds,
      },
    ],
    failures: attempts.filter((attempt) => !attempt.passed).map((attempt) => ({
      caseId: attempt.caseId,
      cohort: attempt.cohort,
      repeat: attempt.repeat,
      failureCode: attempt.failureCode,
    })),
  });
}

function fabricatedDiscoveryReport(): Record<string, unknown> {
  const caseIds = Array.from(
    { length: DISCOVERY_EXPECTED_CASE_COUNT },
    (_, index) => `fabricated-${index}`,
  );
  const attempts = caseIds.flatMap((caseId) => ["canonical", "paraphrase", "typo"].flatMap((cohort) =>
    Array.from({ length: 3 }, (_, repeat) => {
      const passed = cohort === "canonical" || repeat < 2;
      return {
        caseId,
        cohort,
        repeat,
        passed,
        ...(passed ? {} : { failureCode: "operation_not_loaded" }),
      };
    })));
  const failedCaseIds = [...caseIds].sort();
  return discoveryReport({
    caseIds,
    scoredCaseIds: caseIds,
    caseCount: caseIds.length,
    attempts,
    numerator: caseIds.length * 7,
    denominator: caseIds.length * 9,
    cohorts: [
      { cohort: "canonical", numerator: caseIds.length * 3, denominator: caseIds.length * 3, failedCaseIds: [] },
      {
        cohort: "paraphrase",
        numerator: caseIds.length * 2,
        denominator: caseIds.length * 3,
        failedCaseIds,
      },
      {
        cohort: "typo",
        numerator: caseIds.length * 2,
        denominator: caseIds.length * 3,
        failedCaseIds,
      },
    ],
    failures: attempts.filter((attempt) => !attempt.passed).map((attempt) => ({
      caseId: attempt.caseId,
      cohort: attempt.cohort,
      repeat: attempt.repeat,
      failureCode: attempt.failureCode,
    })),
    identity: {
      candidateSha: SHA,
      catalogHash: CATALOG_HASH,
      registryId: "v2-api",
      modelConfiguration: "provider=http model=fixture-model",
      cohortOrder: ["canonical", "paraphrase", "typo"],
    },
  });
}

/** The subset of the real `/version` payload (src/server.ts) the v2 check binds.
 * `version` is deliberately NOT in that bound subset (see `v2-deployed-engine.ts`);
 * it is carried here only so the fixture matches what a v2 deployment serves. */
function deployedVersion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: "2.0.0",
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
    apiDiscovery: discoveryReport(),
    assistantTerminal: evalReport("v2_assistant_terminal"),
    writeSafety: evalReport("v2_write_safety"),
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

  it("rejects a fabricated 120-case replacement corpus at the model-evidence boundary", () => {
    const { deployedVersion: _unused, ...benchmarkInput } = releaseInput({
      apiDiscovery: fabricatedDiscoveryReport(),
    });
    expect(() => validateV2ModelBenchmarkEvidence(benchmarkInput)).toThrow(
      /apiDiscovery evaluation is rejected/u,
    );
  });

  it("accepts a benchmark validation without a deployment, marked unverified", () => {
    const { deployedVersion: _unused, ...benchmarkInput } = releaseInput();
    const evidence = validateV2ModelBenchmarkEvidence(benchmarkInput);
    expect(evidence.deployedConfigurationVerified).toBe(false);
    expect(evidence.conclusion).toBe("passed");
    expect(evidence.validForV2).toBe(true);
  });

  it("accepts the exact discovery floor without relaxing a strict sibling evaluation", () => {
    const { deployedVersion: _unused, ...benchmarkInput } = releaseInput({
      apiDiscovery: exactFloorDiscoveryReport(),
    });
    expect(validateV2ModelBenchmarkEvidence(benchmarkInput).evaluations.apiDiscovery).toBe("passed");

    expect(() => validateV2ModelBenchmarkEvidence({
      ...benchmarkInput,
      assistantTerminal: evalReport("v2_assistant_terminal", {
        numerator: 2,
        denominator: 3,
        failures: [{ caseId: "case-c", cohort: "canonical", repeat: 0, failureCode: "failed" }],
      }),
    })).toThrow(/assistantTerminal evaluation is rejected/u);
  });

  it("rejects a v1 target before any artifact is parsed", () => {
    expect(() => validateV2ModelReleaseEvidence(
      { ...releaseInput(), apiDiscovery: "not even parsed" },
      "v1",
    )).toThrow(/current v2 evidence is not valid for v1/iu);
  });

  it("rejects a missing-credential sentinel evaluation instead of passing it", () => {
    const input = releaseInput({
      assistantTerminal: {
        kind: "v2_assistant_terminal",
        status: "not_evaluated_missing_credentials",
      },
    });
    expect(() => validateV2ModelReleaseEvidence(input)).toThrow(
      /assistantTerminal evaluation is not_evaluated_missing_credentials/u,
    );
  });

  it("rejects an evaluation bound to a different catalog hash", () => {
    const input = releaseInput({
      writeSafety: evalReport("v2_write_safety", {
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
      apiDiscovery: discoveryReport({
        identity: discoveryIdentity({ candidateSha: "b".repeat(40) }),
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
      "api-discovery.json": discoveryReport(),
      "assistant-terminal.json": evalReport("v2_assistant_terminal"),
      "write-safety.json": evalReport("v2_write_safety"),
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
