import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildPrivateProductionEvidence } from "../../scripts/performance/private-production-contract.js";
import {
  assertPrivateProductionEvidenceOnlyDescendant,
  isPrivateProductionEvidencePath,
  validatePrivateProductionReleaseEvidence,
} from "../../scripts/evidence/private-production-release-evidence.js";

const CANDIDATE_SHA = "a".repeat(40);
const BUILD_HASH = "b".repeat(64);
const ARTIFACT_HASH = "c".repeat(64);

const samples = (value: number): number[] => Array.from({ length: 20 }, () => value);

function evidence() {
  return buildPrivateProductionEvidence({
    measurementStartedAt: "2026-07-17T23:50:00.000Z",
    generatedAt: "2026-07-18T00:00:00.000Z",
    commitSha: CANDIDATE_SHA,
    deployed: {
      releaseBuildHash: BUILD_HASH,
      serverArtifactSha256: ARTIFACT_HASH,
      sourceRelationship: "exact_head",
      sourceBindingSha256: null,
    },
    node: "v22.21.0",
    browserVersion: "140.0.0.0",
    samples: {
      warmIframeInteractiveMs: samples(900),
      coldFast4gInteractiveMs: samples(1_900),
      historyApiMs: samples(240),
      localStatusMs: samples(90),
      confirmationFirstReceiptMs: samples(7_900),
    },
    cleanup: { created: 20, deletionProven: 20, pendingPreviews: 0 },
  });
}

function deployedVersion() {
  return {
    version: "1.0.0",
    releaseSha: CANDIDATE_SHA,
    buildHash: BUILD_HASH,
    serverArtifactSha256: ARTIFACT_HASH,
    sourceRelationship: "exact_head",
    sourceBindingSha256: null,
  };
}

describe("private-production release evidence", () => {
  it("classifies existing conclusions as historical v1 evidence and rejects v2 reuse without changing hashes", () => {
    const artifact = evidence();
    const measurementHash = artifact.measurements.sha256;

    expect(validatePrivateProductionReleaseEvidence({
      evidence: artifact,
      deployedVersion: deployedVersion(),
      expectedCandidateSha: CANDIDATE_SHA,
    }, "v1")).toMatchObject({
      assistantEngine: "v1",
      evidenceStatus: "historical",
      validForV2: false,
    });
    expect(() => validatePrivateProductionReleaseEvidence({
      evidence: artifact,
      deployedVersion: deployedVersion(),
      expectedCandidateSha: CANDIDATE_SHA,
    }, "v2")).toThrow(/historical v1 evidence is not valid for v2/iu);
    expect(artifact.measurements.sha256).toBe(measurementHash);
  });

  it("binds every passing aggregate to the exact deployed candidate", () => {
    expect(validatePrivateProductionReleaseEvidence({
      evidence: evidence(),
      deployedVersion: deployedVersion(),
      expectedCandidateSha: CANDIDATE_SHA,
    })).toMatchObject({
      schemaVersion: 1,
      conclusion: "passed",
      sourceCandidateSha: CANDIDATE_SHA,
      releaseBuildHash: BUILD_HASH,
      serverArtifactSha256: ARTIFACT_HASH,
      metricsPassed: 5,
      cleanup: { created: 20, deletionProven: 20, pendingPreviews: 0 },
    });
  });

  it("rejects threshold, cleanup, runtime, and deployed-identity tampering", () => {
    const badMetric = structuredClone(evidence());
    badMetric.metrics.historyApi.passed = false;
    expect(() => validatePrivateProductionReleaseEvidence({
      evidence: badMetric,
      deployedVersion: deployedVersion(),
      expectedCandidateSha: CANDIDATE_SHA,
    })).toThrow(/metric/);

    const badCleanup = structuredClone(evidence());
    badCleanup.cleanup.pendingPreviews = 1;
    expect(() => validatePrivateProductionReleaseEvidence({
      evidence: badCleanup,
      deployedVersion: deployedVersion(),
      expectedCandidateSha: CANDIDATE_SHA,
    })).toThrow(/cleanup/);

    const badNode = structuredClone(evidence());
    badNode.runtime.node = "v20.0.0";
    expect(() => validatePrivateProductionReleaseEvidence({
      evidence: badNode,
      deployedVersion: deployedVersion(),
      expectedCandidateSha: CANDIDATE_SHA,
    })).toThrow(/Node 22/);

    expect(() => validatePrivateProductionReleaseEvidence({
      evidence: evidence(),
      deployedVersion: { ...deployedVersion(), serverArtifactSha256: "d".repeat(64) },
      expectedCandidateSha: CANDIDATE_SHA,
    })).toThrow(/artifact/);
  });

  it("recomputes all five strict metric verdicts instead of trusting persisted flags", () => {
    const boundaryCases = [
      ["warmIframeInteractive", "p95Ms", 1_000],
      ["coldFast4gInteractive", "p95Ms", 2_000],
      ["historyApi", "p95Ms", 250],
      ["localStatus", "maxMs", 100],
      ["confirmationFirstReceipt", "p95Ms", 8_000],
    ] as const;

    for (const [metricName, observedField, boundary] of boundaryCases) {
      const tampered = structuredClone(evidence());
      tampered.metrics[metricName][observedField] = boundary;
      tampered.metrics[metricName].passed = true;
      expect(() => validatePrivateProductionReleaseEvidence({
        evidence: tampered,
        deployedVersion: deployedVersion(),
        expectedCandidateSha: CANDIDATE_SHA,
      })).toThrow(/metric/);
    }

    const wrongThreshold = structuredClone(evidence());
    (wrongThreshold.thresholds as unknown as Record<string, number>).historyApiP95Ms = 251;
    wrongThreshold.metrics.historyApi.thresholdP95Ms = 251;
    expect(() => validatePrivateProductionReleaseEvidence({
      evidence: wrongThreshold,
      deployedVersion: deployedVersion(),
      expectedCandidateSha: CANDIDATE_SHA,
    })).toThrow(/threshold/);
  });

  it("requires the persisted source relationship and binding to equal deployed version metadata", () => {
    const sourceBound = buildPrivateProductionEvidence({
      measurementStartedAt: "2026-07-17T23:50:00.000Z",
      generatedAt: "2026-07-18T00:00:00.000Z",
      commitSha: CANDIDATE_SHA,
      deployed: {
        releaseBuildHash: BUILD_HASH,
        serverArtifactSha256: ARTIFACT_HASH,
        sourceRelationship: "source_bound_builder",
        sourceBindingSha256: "d".repeat(64),
      },
      node: "v22.21.0",
      browserVersion: "140.0.0.0",
      samples: {
        warmIframeInteractiveMs: samples(900),
        coldFast4gInteractiveMs: samples(1_900),
        historyApiMs: samples(240),
        localStatusMs: samples(90),
        confirmationFirstReceiptMs: samples(7_900),
      },
      cleanup: { created: 20, deletionProven: 20, pendingPreviews: 0 },
    });
    expect(validatePrivateProductionReleaseEvidence({
      evidence: sourceBound,
      deployedVersion: {
        ...deployedVersion(),
        sourceRelationship: "source_bound_builder",
        sourceBindingSha256: "d".repeat(64),
      },
      expectedCandidateSha: CANDIDATE_SHA,
    }).sourceBindingSha256).toBe("d".repeat(64));

    expect(() => validatePrivateProductionReleaseEvidence({
      evidence: sourceBound,
      deployedVersion: deployedVersion(),
      expectedCandidateSha: CANDIDATE_SHA,
    })).toThrow(/source relationship/);
  });

  it("recomputes distributions from the exact measurement arrays and binds their time window", () => {
    const fabricatedAggregate = structuredClone(evidence());
    fabricatedAggregate.metrics.historyApi.minMs = 1;
    fabricatedAggregate.metrics.historyApi.p50Ms = 1;
    fabricatedAggregate.metrics.historyApi.p95Ms = 1;
    fabricatedAggregate.metrics.historyApi.maxMs = 1;
    expect(() => validatePrivateProductionReleaseEvidence({
      evidence: fabricatedAggregate,
      deployedVersion: deployedVersion(),
      expectedCandidateSha: CANDIDATE_SHA,
    })).toThrow(/aggregate/);

    const failingRawMeasurements = structuredClone(evidence());
    failingRawMeasurements.measurements.samples.historyApiMs.fill(250);
    expect(() => validatePrivateProductionReleaseEvidence({
      evidence: failingRawMeasurements,
      deployedVersion: deployedVersion(),
      expectedCandidateSha: CANDIDATE_SHA,
    })).toThrow(/measurement|metric/);

    const reboundTimestamp = structuredClone(evidence());
    reboundTimestamp.generatedAt = "2026-07-18T00:00:01.000Z";
    expect(() => validatePrivateProductionReleaseEvidence({
      evidence: reboundTimestamp,
      deployedVersion: deployedVersion(),
      expectedCandidateSha: CANDIDATE_SHA,
    })).toThrow(/measurement time/);
  });

  it("permits only aggregate performance artifacts after the source candidate", () => {
    expect(isPrivateProductionEvidencePath("evidence/performance/private-production.json")).toBe(true);
    expect(isPrivateProductionEvidencePath("evidence/performance/private-production.md")).toBe(true);
    expect(isPrivateProductionEvidencePath("src/server.ts")).toBe(false);
  });

  it("requires a clean checked-out evidence-only descendant", () => {
    const repository = mkdtempSync(join(tmpdir(), "private-production-evidence-"));
    const git = (...args: string[]): string => execFileSync("git", args, {
      cwd: repository,
      encoding: "utf8",
    }).trim();
    try {
      git("init", "--quiet");
      git("config", "user.email", "release-evidence@example.invalid");
      git("config", "user.name", "Release Evidence Test");
      writeFileSync(join(repository, "package.json"), "{}\n");
      git("add", "package.json");
      git("commit", "--quiet", "-m", "candidate");
      const candidate = git("rev-parse", "HEAD");

      mkdirSync(join(repository, "evidence/performance"), { recursive: true });
      writeFileSync(join(repository, "evidence/performance/private-production.json"), "{}\n");
      writeFileSync(join(repository, "evidence/performance/private-production.md"), "# Evidence\n");
      git("add", "evidence");
      git("commit", "--quiet", "-m", "private production evidence");
      const evidenceHead = git("rev-parse", "HEAD");
      expect(() => assertPrivateProductionEvidenceOnlyDescendant(candidate, evidenceHead, repository)).not.toThrow();

      writeFileSync(join(repository, "untracked.txt"), "dirty\n");
      expect(() => assertPrivateProductionEvidenceOnlyDescendant(candidate, evidenceHead, repository)).toThrow(/clean checkout/);
      rmSync(join(repository, "untracked.txt"));

      writeFileSync(join(repository, "package.json"), "{\"private\":true}\n");
      git("add", "package.json");
      git("commit", "--quiet", "-m", "source mutation");
      const mutatedHead = git("rev-parse", "HEAD");
      expect(() => assertPrivateProductionEvidenceOnlyDescendant(candidate, mutatedHead, repository)).toThrow(/non-evidence/);
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });
});
