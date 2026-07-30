import { describe, expect, it } from "vitest";

import { buildV2ReleaseEvidenceFromEnvironment } from "../../scripts/evidence/v2-release-evidence.js";
import {
  buildDiscoveryEvalCorpus,
  DISCOVERY_CORPUS_VERSION,
} from "../../scripts/eval-v2/api-discovery-cases.js";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";

const SHA = "a".repeat(40);
const EVIDENCE_SHA = "b".repeat(40);
const CATALOG_HASH = MODEL_API_ACTION_CATALOG.hash();
const DISCOVERY_CORPUS = buildDiscoveryEvalCorpus();

/** The exact artifact shape `scripts/evidence/v2-authority-evidence.ts` writes. */
function authorityReport(evidenceOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "complete",
    evidence: {
      schemaVersion: 1,
      engine: "v2",
      candidateSha: SHA,
      registryId: "v2-api",
      catalogHash: CATALOG_HASH,
      assistantWriteCases: 84,
      assistantWritesPreviewOnly: true,
      exactOperationBindingMismatches: 0,
      preparationMutationCount: 0,
      typedConsentDispatchCount: 0,
      promptInjectionDispatchCount: 0,
      intentDeclarationCallCount: 0,
      intentCapabilityRecordCount: 0,
      intentCapabilityClaimCount: 0,
      duplicateConfirmationDispatchViolations: 0,
      ...evidenceOverrides,
    },
    conclusions: {
      all_assistant_writes_preview_only: "passed",
      exact_operation_binding: "passed",
      zero_mutation_before_confirmation: "passed",
      prompt_injection_drafts_cannot_execute: "passed",
    },
  };
}

/** A complete, fully-scored eval report in the `scripts/eval-v2/report.ts` shape. */
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

function discoveryReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const caseIds = DISCOVERY_CORPUS.cases.map((entry) => entry.actionName);
  const attempts = caseIds.flatMap((caseId) => ["canonical", "paraphrase", "typo"].flatMap((cohort) =>
    Array.from({ length: 3 }, (_, repeat) => ({ caseId, cohort, repeat, passed: true }))));
  return {
    schemaVersion: 1,
    kind: "v2_api_discovery",
    status: "passed",
    identity: {
      candidateSha: SHA,
      catalogHash: CATALOG_HASH,
      registryId: "v2-api",
      modelConfiguration: "provider=http model=fixture-model",
      cohortOrder: ["canonical", "paraphrase", "typo"],
      corpusVersion: DISCOVERY_CORPUS_VERSION,
      caseSelection: DISCOVERY_CORPUS.caseSelection,
    },
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

function environment(
  files: Record<string, unknown>,
  overrides: Record<string, string | undefined> = {},
): { env: Record<string, string | undefined>; readFile: (path: string) => string } {
  const env: Record<string, string | undefined> = {
    V2_RELEASE_EVIDENCE_PATH: "/tmp/out/v2-release-evidence.json",
    RELEASE_SOURCE_CANDIDATE_SHA: SHA,
    RELEASE_EVIDENCE_COMMIT_SHA: EVIDENCE_SHA,
    V2_AUTHORITY_REPORT_PATH: "authority.json",
    V2_EVAL_API_DISCOVERY_REPORT_PATH: "api-discovery.json",
    V2_EVAL_ASSISTANT_TERMINAL_REPORT_PATH: "assistant-terminal.json",
    V2_EVAL_WRITE_SAFETY_REPORT_PATH: "write-safety.json",
    RELEASE_GATE_VERIFY: "success",
    ...overrides,
  };
  const readFile = (path: string): string => {
    if (!(path in files)) throw new Error(`fixture file not found: ${path}`);
    return JSON.stringify(files[path]);
  };
  return { env, readFile };
}

function completeFixtureFiles(): Record<string, unknown> {
  return {
    "authority.json": authorityReport(),
    "api-discovery.json": discoveryReport(),
    "assistant-terminal.json": evalReport("v2_assistant_terminal"),
    "write-safety.json": evalReport("v2_write_safety"),
  };
}

describe("B5: the v2 release-evidence CLI entry", () => {
  it("produces a complete v2 conclusion end to end from fixture artifacts, zero credentials", () => {
    const { env, readFile } = environment(completeFixtureFiles());
    const { outputPath, evidence } = buildV2ReleaseEvidenceFromEnvironment(env, readFile);

    expect(outputPath).toBe("/tmp/out/v2-release-evidence.json");
    expect(evidence.assistantEngine).toBe("v2");
    expect(evidence.sourceCandidateSha).toBe(SHA);
    expect(evidence.evidenceCommitSha).toBe(EVIDENCE_SHA);
    expect(evidence.machineGates.verify).toBe("passed");
    expect(evidence.v2Authority.status).toBe("complete");
    expect(evidence.evaluations).toEqual({
      apiDiscovery: "passed",
      assistantTerminal: "passed",
      writeSafety: "passed",
    });
    expect(evidence.v2EvaluationComplete).toBe(true);
  });

  it("requires the output path", () => {
    const { env, readFile } = environment(completeFixtureFiles(), { V2_RELEASE_EVIDENCE_PATH: undefined });
    expect(() => buildV2ReleaseEvidenceFromEnvironment(env, readFile)).toThrow(/V2_RELEASE_EVIDENCE_PATH/);
  });

  it("requires the authority report path", () => {
    const { env, readFile } = environment(completeFixtureFiles(), { V2_AUTHORITY_REPORT_PATH: undefined });
    expect(() => buildV2ReleaseEvidenceFromEnvironment(env, readFile)).toThrow(/V2_AUTHORITY_REPORT_PATH/);
  });

  it("passes a sentinel authority report through and stays incomplete", () => {
    const files = { ...completeFixtureFiles(), "authority.json": { status: "not_evaluated_until_pr15" } };
    const { env, readFile } = environment(files);
    const { evidence } = buildV2ReleaseEvidenceFromEnvironment(env, readFile);
    expect(evidence.v2Authority).toEqual({ status: "not_evaluated_until_pr15" });
    expect(evidence.v2EvaluationComplete).toBe(false);
  });

  it("re-validates a complete authority report instead of trusting the file's own conclusions", () => {
    const files = {
      ...completeFixtureFiles(),
      // The doctored file still CLAIMS every conclusion passed.
      "authority.json": authorityReport({ preparationMutationCount: 1 }),
    };
    const { env, readFile } = environment(files);
    expect(() => buildV2ReleaseEvidenceFromEnvironment(env, readFile)).toThrow(/preparationMutationCount/);
  });

  it("rejects an authority report with an unknown status", () => {
    const files = { ...completeFixtureFiles(), "authority.json": { status: "passed" } };
    const { env, readFile } = environment(files);
    expect(() => buildV2ReleaseEvidenceFromEnvironment(env, readFile)).toThrow(/status/);
  });

  it("leaves an evaluation with no report path rejected, keeping the release incomplete", () => {
    const { env, readFile } = environment(completeFixtureFiles(), {
      V2_EVAL_WRITE_SAFETY_REPORT_PATH: undefined,
    });
    const { evidence } = buildV2ReleaseEvidenceFromEnvironment(env, readFile);
    expect(evidence.evaluations.writeSafety).toBe("rejected");
    expect(evidence.v2EvaluationComplete).toBe(false);
  });

  it("rejects an evaluation report bound to a different catalog hash than the authority evidence", () => {
    const files = {
      ...completeFixtureFiles(),
      "api-discovery.json": discoveryReport({
        identity: {
          candidateSha: SHA,
          catalogHash: "4".repeat(64),
          registryId: "v2-api",
          modelConfiguration: "provider=http model=fixture-model",
          cohortOrder: ["canonical", "paraphrase", "typo"],
          corpusVersion: DISCOVERY_CORPUS_VERSION,
          caseSelection: DISCOVERY_CORPUS.caseSelection,
        },
      }),
    };
    const { env, readFile } = environment(files);
    const { evidence } = buildV2ReleaseEvidenceFromEnvironment(env, readFile);
    expect(evidence.evaluations.apiDiscovery).toBe("rejected");
    expect(evidence.v2EvaluationComplete).toBe(false);
  });

  it("rejects an evaluation file that does not parse to an object", () => {
    const files = { ...completeFixtureFiles(), "write-safety.json": null };
    const { env, readFile } = environment(files);
    expect(() => buildV2ReleaseEvidenceFromEnvironment(env, readFile)).toThrow(/write-safety\.json/);
  });
});
