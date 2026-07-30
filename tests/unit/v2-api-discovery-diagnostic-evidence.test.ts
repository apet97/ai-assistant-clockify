import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ARTIFACT_PATH = resolve("evidence/eval/v2-api-discovery-diagnostic-ad06c08.json");
const PROVENANCE_PATH = resolve("evidence/eval/v2-api-discovery-diagnostic-ad06c08.provenance.json");
const ARTIFACT_SHA256 = "15798b8720c4ab1cece182618415088e98210420ae56f57a23772dd49fd129e9";
const VOID_STATUS = "diagnostic_void_as_model_evidence";

interface DiagnosticArtifact {
  schemaVersion: number;
  kind: string;
  status: string;
  identity: {
    candidateSha: string;
    catalogHash: string;
    registryId: string;
    modelConfiguration: string;
    cohortOrder: string[];
    corpusVersion?: string;
  };
  caseCount: number;
  numerator: number;
  denominator: number;
  failures: unknown[];
  scoredCaseIds: string[];
}

interface DiagnosticProvenance {
  schemaVersion: number;
  kind: string;
  generatedAt: string;
  secretFree: boolean;
  contentInspection: {
    redactionApplied: boolean;
    credentialOrHeaderFieldsFound: boolean;
    rawPromptsOrProviderResponsesFound: boolean;
  };
  status: string;
  historicalStatus: {
    status: string;
    validForModelEvidence: boolean;
    validForReleaseEvidence: boolean;
    reason: string;
    replacement: string;
  };
  source: {
    pathAtBinding: string;
    headAtRun: string;
    createdAt: string;
    modifiedAt: string;
  };
  boundArtifact: {
    path: string;
    bytes: number;
    sha256: string;
    bytePreserved: boolean;
  };
  runIdentity: {
    candidateSha: string;
    catalogHash: string;
    registryId: string;
    modelConfiguration: string;
    corpusVersion: string;
    sourceIdentityIncludedCorpusVersion: boolean;
  };
  diagnosticSummary: {
    rootCauseId: string;
    reportedScore: { numerator: number; denominator: number; validAsModelEvidence: boolean };
    apportionedFailures: Array<{ category: string; attempts: number; confidence: string }>;
  };
}

describe("M7 historical API-discovery diagnostic evidence", () => {
  it("binds the original bytes to immutable source provenance", () => {
    const artifactBytes = readFileSync(ARTIFACT_PATH);
    const artifact = JSON.parse(artifactBytes.toString("utf8")) as DiagnosticArtifact;
    const provenance = JSON.parse(readFileSync(PROVENANCE_PATH, "utf8")) as DiagnosticProvenance;

    expect(artifactBytes.byteLength).toBe(182_840);
    expect(createHash("sha256").update(artifactBytes).digest("hex")).toBe(ARTIFACT_SHA256);
    expect(artifact).toMatchObject({
      schemaVersion: 1,
      kind: "v2_api_discovery",
      status: "failed",
      identity: {
        candidateSha: "ad06c083d3e1fc6194dd2fa7b1c6710cc190736e",
        catalogHash: "3872950503ac629de4629009b7548fbbc1cd509893d0ad2d7c7b34359246cbd7",
        registryId: "v2-api",
        modelConfiguration: "provider=http model=deepseek-v4-pro",
        cohortOrder: ["canonical", "paraphrase", "typo"],
      },
      caseCount: 127,
      numerator: 239,
      denominator: 1_143,
    });
    expect(artifact.identity).not.toHaveProperty("corpusVersion");
    expect(artifact.failures).toHaveLength(904);
    expect(artifact.scoredCaseIds).toHaveLength(127);

    expect(provenance.source).toEqual({
      pathAtBinding: "/Users/15x/Downloads/eval-api-discovery-ad06c08-2026-07-30.json",
      headAtRun: "ad06c083d3e1fc6194dd2fa7b1c6710cc190736e",
      createdAt: "2026-07-30T05:06:02.359Z",
      modifiedAt: "2026-07-30T05:06:02.360Z",
    });
    expect(provenance.boundArtifact).toEqual({
      path: "evidence/eval/v2-api-discovery-diagnostic-ad06c08.json",
      bytes: 182_840,
      sha256: ARTIFACT_SHA256,
      bytePreserved: true,
    });
    expect(provenance.runIdentity).toEqual({
      candidateSha: artifact.identity.candidateSha,
      catalogHash: artifact.identity.catalogHash,
      registryId: artifact.identity.registryId,
      modelConfiguration: artifact.identity.modelConfiguration,
      corpusVersion: "v2-discovery-pre-m-unversioned-v0",
      sourceIdentityIncludedCorpusVersion: false,
    });
  });

  it("makes the diagnostic score void as model and release evidence", () => {
    const provenance = JSON.parse(readFileSync(PROVENANCE_PATH, "utf8")) as DiagnosticProvenance;

    expect(provenance).toMatchObject({
      schemaVersion: 1,
      kind: "v2_api_discovery_diagnostic_provenance",
      generatedAt: "2026-07-30T21:59:58.000Z",
      secretFree: true,
      contentInspection: {
        redactionApplied: false,
        credentialOrHeaderFieldsFound: false,
        rawPromptsOrProviderResponsesFound: false,
      },
      status: VOID_STATUS,
      historicalStatus: {
        status: VOID_STATUS,
        validForModelEvidence: false,
        validForReleaseEvidence: false,
      },
      diagnosticSummary: {
        rootCauseId: "D-5",
        reportedScore: { numerator: 239, denominator: 1_143, validAsModelEvidence: false },
      },
    });
    expect(provenance.historicalStatus.reason).toContain("D-5");
    expect(provenance.historicalStatus.replacement).toContain("post-M E2");
    expect(provenance.diagnosticSummary.apportionedFailures).toEqual([
      { category: "harness_detection_artifact", attempts: 612, confidence: "proven" },
      { category: "scoring_rule_and_ranking_fill", attempts: 84, confidence: "high" },
      { category: "corpus_auth_defect", attempts: 63, confidence: "proven" },
      { category: "argument_free_corpus", attempts: 36, confidence: "high" },
      { category: "same_argument_free_bind_stochastic", attempts: 80, confidence: "medium" },
      { category: "genuine_model_or_ranking_signal", attempts: 29, confidence: "medium" },
    ]);
    expect(provenance.diagnosticSummary.apportionedFailures
      .reduce((sum, entry) => sum + entry.attempts, 0)).toBe(904);
  });
});
