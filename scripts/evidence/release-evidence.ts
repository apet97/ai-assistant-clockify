import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { writeDeterministicJson } from "./write-json.js";
import type { ColdVerifyEvidence } from "./cold-verify-evidence.js";
import type { ReviewedPullRequestEvidence } from "./reviewed-pr-evidence.js";

export { buildColdVerifyEvidence } from "./cold-verify-evidence.js";
export { validateReviewedPullRequestEvidence } from "./reviewed-pr-evidence.js";

export type EvidenceTargetAssistantEngine = "v1" | "v2";

export interface HistoricalV1EvidenceClassification {
  assistantEngine: "v1";
  evidenceStatus: "historical";
  validForV2: false;
}

export function classifyHistoricalV1Evidence(
  targetAssistantEngine: EvidenceTargetAssistantEngine,
): HistoricalV1EvidenceClassification {
  if (targetAssistantEngine !== "v1") {
    throw new Error("historical v1 evidence is not valid for v2");
  }
  return {
    assistantEngine: "v1",
    evidenceStatus: "historical",
    validForV2: false,
  };
}

const MACHINE_GATE_KEYS = [
  "verify",
  "reviewedPullRequest",
  "pullRequestCi",
  "dependencyReview",
  "pullRequestCodeql",
  "pullRequestSecretScan",
  "engineeringReview",
  "localUiPerformance",
  "actionlint",
  "marketplaceMediaBinding",
  "audit",
  "license",
  "codeql",
  "secretScan",
  "scriptedSafetyCorpus",
  "browserE2e",
  "sbom",
  "liveSmoke",
  "backupRestoreDrill",
  "deterministicSafetyEvaluation",
  "privateProductionPerformance",
  "liveBrowserAcceptance",
  "productionAuditHostClearance",
] as const;

const HUMAN_GATE_KEYS = [
  "providerAndCredentialsGovernance",
  "ownershipAndHumanSignoff",
  "marketplaceSubmission",
] as const;

type MachineGate = (typeof MACHINE_GATE_KEYS)[number];
type MachineStatus = "passed" | "failed" | "cancelled" | "skipped" | "unknown";

interface ReleaseEvidenceInput {
  sourceCandidateSha: string;
  evidenceCommitSha: string;
  machineConclusions: Partial<Record<MachineGate, unknown>>;
  reviewedPullRequest: ReviewedPullRequestEvidence;
  coldVerifies: ColdVerifyEvidence;
}

export interface ReleaseEvidence extends HistoricalV1EvidenceClassification {
  sourceCandidateSha: string;
  evidenceCommitSha: string;
  machineGates: Record<MachineGate, MachineStatus>;
  reviewedPullRequest: ReviewedPullRequestEvidence;
  coldVerifies: ColdVerifyEvidence;
  humanGates: Record<(typeof HUMAN_GATE_KEYS)[number], "not_evaluated">;
}

function machineStatus(value: unknown): MachineStatus {
  switch (value) {
    case "success": return "passed";
    case "failure": return "failed";
    case "cancelled": return "cancelled";
    case "skipped": return "skipped";
    default: return "unknown";
  }
}

export function buildReleaseEvidence(
  input: ReleaseEvidenceInput,
  targetAssistantEngine: EvidenceTargetAssistantEngine = "v1",
): ReleaseEvidence {
  const classification = classifyHistoricalV1Evidence(targetAssistantEngine);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.sourceCandidateSha)) {
    throw new Error("release evidence requires a full lowercase source candidate SHA");
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.evidenceCommitSha)) {
    throw new Error("release evidence requires a full lowercase evidence commit SHA");
  }
  const reviewed = input.reviewedPullRequest;
  const requiredCiJobs = ["browser-e2e", "dependency-review", "secret-scan", "verify"];
  if (
    reviewed?.schemaVersion !== 1
    || reviewed.conclusion !== "passed"
    || reviewed.sourceCandidateSha !== input.sourceCandidateSha
    || reviewed.evidenceCommitSha !== input.evidenceCommitSha
    || reviewed.pullRequest?.baseRefName !== "main"
    || reviewed.pullRequest.headSha !== input.evidenceCommitSha
    || reviewed.pullRequest.reviewDecision !== "APPROVED"
    || reviewed.pullRequest.unresolvedReviewThreads !== 0
    || (reviewed.pullRequest.state !== "OPEN" && reviewed.pullRequest.state !== "MERGED")
    || reviewed.ciRun?.headSha !== input.evidenceCommitSha
    || reviewed.ciRun.attempt !== 1
    || JSON.stringify(reviewed.ciRun.requiredJobs) !== JSON.stringify(requiredCiJobs)
    || reviewed.codeqlRun?.headSha !== input.evidenceCommitSha
    || reviewed.codeqlRun.attempt !== 1
    || JSON.stringify(reviewed.codeqlRun.requiredJobs) !== JSON.stringify(["analyze"])
  ) throw new Error("reviewed pull request evidence is not bound to the release");
  const cold = input.coldVerifies;
  if (
    cold?.schemaVersion !== 1
    || cold.conclusion !== "passed"
    || cold.sourceCandidateSha !== input.sourceCandidateSha
    || cold.evidenceCommitSha !== input.evidenceCommitSha
    || !/^v22\.[0-9]+\.[0-9]+$/.test(cold.node)
    || cold.minimumPassedTests !== 2_366
    || cold.consecutiveColdPasses !== 3
    || cold.retries !== 0
    || cold.passes?.length !== 3
    || !cold.passes.every((pass, index) =>
      pass.pass === index + 1
      && /^[a-f0-9]{64}$/.test(pass.reportSha256)
      && pass.totalTests >= 2_366
      && pass.passedTests === pass.totalTests
      && pass.failedTests === 0
      && pass.pendingTests === 0
      && pass.todoTests === 0)
  ) throw new Error("cold verify evidence is not bound to the release");

  const machineGates = Object.fromEntries(MACHINE_GATE_KEYS.map((gate) => [
    gate,
    machineStatus(input.machineConclusions[gate]),
  ])) as ReleaseEvidence["machineGates"];
  const humanGates = Object.fromEntries(HUMAN_GATE_KEYS.map((gate) => [
    gate,
    "not_evaluated",
  ])) as ReleaseEvidence["humanGates"];

  return {
    ...classification,
    sourceCandidateSha: input.sourceCandidateSha,
    evidenceCommitSha: input.evidenceCommitSha,
    machineGates,
    reviewedPullRequest: input.reviewedPullRequest,
    coldVerifies: input.coldVerifies,
    humanGates,
  };
}

function main(): void {
  const outputPath = process.env.RELEASE_EVIDENCE_PATH;
  if (!outputPath) throw new Error("RELEASE_EVIDENCE_PATH is required");

  const evidence = buildReleaseEvidence({
    sourceCandidateSha: process.env.RELEASE_SOURCE_CANDIDATE_SHA ?? "",
    evidenceCommitSha: process.env.RELEASE_EVIDENCE_COMMIT_SHA ?? "",
    reviewedPullRequest: JSON.parse(process.env.RELEASE_REVIEWED_PR_EVIDENCE ?? "null") as ReviewedPullRequestEvidence,
    coldVerifies: JSON.parse(process.env.RELEASE_COLD_VERIFY_EVIDENCE ?? "null") as ColdVerifyEvidence,
    machineConclusions: {
      verify: process.env.RELEASE_GATE_VERIFY,
      reviewedPullRequest: process.env.RELEASE_GATE_REVIEWED_PULL_REQUEST,
      pullRequestCi: process.env.RELEASE_GATE_PULL_REQUEST_CI,
      dependencyReview: process.env.RELEASE_GATE_DEPENDENCY_REVIEW,
      pullRequestCodeql: process.env.RELEASE_GATE_PULL_REQUEST_CODEQL,
      pullRequestSecretScan: process.env.RELEASE_GATE_PULL_REQUEST_SECRET_SCAN,
      engineeringReview: process.env.RELEASE_GATE_ENGINEERING_REVIEW,
      localUiPerformance: process.env.RELEASE_GATE_LOCAL_UI_PERFORMANCE,
      actionlint: process.env.RELEASE_GATE_ACTIONLINT,
      marketplaceMediaBinding: process.env.RELEASE_GATE_MARKETPLACE_MEDIA_BINDING,
      audit: process.env.RELEASE_GATE_AUDIT,
      license: process.env.RELEASE_GATE_LICENSE,
      codeql: process.env.RELEASE_GATE_CODEQL,
      secretScan: process.env.RELEASE_GATE_SECRET_SCAN,
      scriptedSafetyCorpus: process.env.RELEASE_GATE_SCRIPTED_SAFETY_CORPUS,
      browserE2e: process.env.RELEASE_GATE_BROWSER_E2E,
      sbom: process.env.RELEASE_GATE_SBOM,
      liveSmoke: process.env.RELEASE_GATE_LIVE_SMOKE,
      backupRestoreDrill: process.env.RELEASE_GATE_BACKUP_RESTORE_DRILL,
      deterministicSafetyEvaluation: process.env.RELEASE_GATE_DETERMINISTIC_SAFETY_EVALUATION,
      privateProductionPerformance: process.env.RELEASE_GATE_PRIVATE_PRODUCTION_PERFORMANCE,
      liveBrowserAcceptance: process.env.RELEASE_GATE_LIVE_BROWSER_ACCEPTANCE,
      productionAuditHostClearance: process.env.RELEASE_GATE_PRODUCTION_AUDIT_HOST_CLEARANCE,
    },
  }, "v1");
  writeDeterministicJson(outputPath, evidence);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch {
    process.stderr.write("release evidence generation failed\n");
    process.exitCode = 1;
  }
}
