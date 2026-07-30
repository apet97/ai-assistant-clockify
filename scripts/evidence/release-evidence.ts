import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { writeDeterministicJson } from "./write-json.js";
import type { ColdVerifyEvidence } from "./cold-verify-evidence.js";
import type { ReviewedPullRequestEvidence } from "./reviewed-pr-evidence.js";
import { V2_AUTHORITY_NOT_EVALUATED_SENTINEL, type V2AuthorityEvidenceReport } from "./v2-authority-evidence.js";

export { buildColdVerifyEvidence } from "./cold-verify-evidence.js";
export { validateReviewedPullRequestEvidence } from "./reviewed-pr-evidence.js";
export {
  buildV2AuthorityEvidenceReport,
  deriveV2AuthorityConclusions,
  validateV2AuthorityEvidence,
  V2_AUTHORITY_CONCLUSIONS,
  V2_AUTHORITY_NOT_EVALUATED_SENTINEL,
  type V2AuthorityConclusion,
  type V2AuthorityEvidence,
  type V2AuthorityEvidenceReport,
} from "./v2-authority-evidence.js";

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

export interface ReleaseEvidenceV2Input {
  sourceCandidateSha: string;
  evidenceCommitSha: string;
  machineConclusions: Partial<Record<MachineGate, unknown>>;
  v2Authority: V2AuthorityEvidenceReport;
  /** T17-G: the three v2 evaluation reports, when they exist. */
  evaluations?: {
    apiDiscovery?: V2EvaluationInput;
    assistantTerminal?: V2EvaluationInput;
    writeSafety?: V2EvaluationInput;
  };
}

/** The bounded shape a v2 evaluation report contributes to release evidence. */
export interface V2EvaluationInput {
  status: unknown;
  numerator: unknown;
  denominator: unknown;
  caseCount: unknown;
  /** Distinct case ids with at least one attempt — the completeness proof (B5). */
  scoredCaseIds?: unknown;
  identity?: { candidateSha?: unknown; catalogHash?: unknown };
}

export type V2EvaluationStatus = "passed" | "not_evaluated_missing_credentials" | "rejected";

/**
 * T17-G: classify ONE v2 evaluation report for release evidence. A report is
 * `passed` only when it is complete, fully scored, non-empty, and bound to the
 * exact candidate SHA; an explicit missing-credential sentinel stays
 * `not_evaluated_missing_credentials`; anything else — a partial score, a zero
 * denominator, a stale SHA, a malformed shape — is `rejected`. There is no path
 * from a partial or sentinel report to a passing v2 release conclusion.
 *
 * Completeness (B5): the attempt count must cover the report's own case set
 * (`denominator >= caseCount`) and the distinct scored cases must cover it
 * exactly — a SHORT report scored fewer cases than it claims, and a DUPLICATED
 * scored-case entry can only mask a case that never ran. Both are rejected.
 */
export function classifyV2Evaluation(
  report: V2EvaluationInput | undefined,
  expected: { candidateSha: string; catalogHash?: string },
): V2EvaluationStatus {
  if (!report || typeof report !== "object") return "rejected";
  if (report.status === "not_evaluated_missing_credentials") return "not_evaluated_missing_credentials";
  if (report.status !== "passed") return "rejected";
  const { numerator, denominator, caseCount, scoredCaseIds } = report;
  if (typeof numerator !== "number" || typeof denominator !== "number" || typeof caseCount !== "number") {
    return "rejected";
  }
  if (denominator <= 0 || caseCount <= 0 || numerator !== denominator) return "rejected";
  if (denominator < caseCount) return "rejected";
  if (!Array.isArray(scoredCaseIds) || !scoredCaseIds.every((id) => typeof id === "string")) {
    return "rejected";
  }
  if (new Set(scoredCaseIds).size !== scoredCaseIds.length) return "rejected";
  if (scoredCaseIds.length !== caseCount) return "rejected";
  if (report.identity?.candidateSha !== expected.candidateSha) return "rejected";
  if (expected.catalogHash !== undefined && report.identity?.catalogHash !== expected.catalogHash) {
    return "rejected";
  }
  return "passed";
}

export interface ReleaseEvidenceV2 {
  assistantEngine: "v2";
  sourceCandidateSha: string;
  evidenceCommitSha: string;
  machineGates: Record<MachineGate, MachineStatus>;
  v2Authority: V2AuthorityEvidenceReport;
  /** Per-evaluation classification; every entry must be `passed` for a v2 release. */
  evaluations: Record<"apiDiscovery" | "assistantTerminal" | "writeSafety", V2EvaluationStatus>;
  /** True only when authority evidence is complete AND all three evaluations passed. */
  v2EvaluationComplete: boolean;
}

/**
 * The v2 counterpart to {@link buildReleaseEvidence}. Never accepts v1
 * evidence (the caller supplies an already-built {@link V2AuthorityEvidenceReport},
 * so a v1 `ReleaseEvidence`/`HistoricalV1EvidenceClassification` object cannot
 * type-check in its place). The CLI entry is
 * `scripts/evidence/v2-release-evidence.ts` (`npm run record:v2-release-evidence`);
 * without a complete, validated authority artifact plus all three passing
 * evaluations it stays honestly incomplete — never a fabricated pass.
 */
export function buildV2ReleaseEvidence(input: ReleaseEvidenceV2Input): ReleaseEvidenceV2 {
  if (!/^[0-9a-f]{40}$/.test(input.sourceCandidateSha)) {
    throw new Error("v2 release evidence requires a full lowercase source candidate SHA");
  }
  if (!/^[0-9a-f]{40}$/.test(input.evidenceCommitSha)) {
    throw new Error("v2 release evidence requires a full lowercase evidence commit SHA");
  }
  if (
    input.v2Authority?.status !== V2_AUTHORITY_NOT_EVALUATED_SENTINEL &&
    input.v2Authority?.status !== "complete"
  ) {
    throw new Error("v2 release evidence requires a valid V2AuthorityEvidenceReport");
  }
  const machineGates = Object.fromEntries(MACHINE_GATE_KEYS.map((gate) => [
    gate,
    machineStatus(input.machineConclusions[gate]),
  ])) as Record<MachineGate, MachineStatus>;
  // The catalog hash MUST be threaded, or `classifyV2Evaluation`'s hash check is
  // dead code at its only call site (pre-T18 review).
  const expected = {
    candidateSha: input.sourceCandidateSha,
    ...(input.v2Authority.status === "complete"
      ? { catalogHash: input.v2Authority.evidence.catalogHash }
      : {}),
  };
  const evaluations = {
    apiDiscovery: classifyV2Evaluation(input.evaluations?.apiDiscovery, expected),
    assistantTerminal: classifyV2Evaluation(input.evaluations?.assistantTerminal, expected),
    writeSafety: classifyV2Evaluation(input.evaluations?.writeSafety, expected),
  };
  return {
    assistantEngine: "v2",
    sourceCandidateSha: input.sourceCandidateSha,
    evidenceCommitSha: input.evidenceCommitSha,
    machineGates,
    v2Authority: input.v2Authority,
    evaluations,
    // Fail-closed: a missing, partial, or sentinel evaluation can never produce a
    // complete v2 release conclusion.
    v2EvaluationComplete: input.v2Authority.status === "complete"
      && Object.values(evaluations).every((status) => status === "passed"),
  };
}

/**
 * The one `RELEASE_GATE_*` environment → machine-conclusion mapping, shared by
 * the v1 entry below and the v2 CLI entry (`v2-release-evidence.ts`).
 */
export function releaseGateConclusionsFromEnvironment(
  env: Record<string, string | undefined>,
): Partial<Record<MachineGate, unknown>> {
  return {
    verify: env.RELEASE_GATE_VERIFY,
    reviewedPullRequest: env.RELEASE_GATE_REVIEWED_PULL_REQUEST,
    pullRequestCi: env.RELEASE_GATE_PULL_REQUEST_CI,
    dependencyReview: env.RELEASE_GATE_DEPENDENCY_REVIEW,
    pullRequestCodeql: env.RELEASE_GATE_PULL_REQUEST_CODEQL,
    pullRequestSecretScan: env.RELEASE_GATE_PULL_REQUEST_SECRET_SCAN,
    engineeringReview: env.RELEASE_GATE_ENGINEERING_REVIEW,
    localUiPerformance: env.RELEASE_GATE_LOCAL_UI_PERFORMANCE,
    actionlint: env.RELEASE_GATE_ACTIONLINT,
    marketplaceMediaBinding: env.RELEASE_GATE_MARKETPLACE_MEDIA_BINDING,
    audit: env.RELEASE_GATE_AUDIT,
    license: env.RELEASE_GATE_LICENSE,
    codeql: env.RELEASE_GATE_CODEQL,
    secretScan: env.RELEASE_GATE_SECRET_SCAN,
    scriptedSafetyCorpus: env.RELEASE_GATE_SCRIPTED_SAFETY_CORPUS,
    browserE2e: env.RELEASE_GATE_BROWSER_E2E,
    sbom: env.RELEASE_GATE_SBOM,
    liveSmoke: env.RELEASE_GATE_LIVE_SMOKE,
    backupRestoreDrill: env.RELEASE_GATE_BACKUP_RESTORE_DRILL,
    deterministicSafetyEvaluation: env.RELEASE_GATE_DETERMINISTIC_SAFETY_EVALUATION,
    privateProductionPerformance: env.RELEASE_GATE_PRIVATE_PRODUCTION_PERFORMANCE,
    liveBrowserAcceptance: env.RELEASE_GATE_LIVE_BROWSER_ACCEPTANCE,
    productionAuditHostClearance: env.RELEASE_GATE_PRODUCTION_AUDIT_HOST_CLEARANCE,
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
    machineConclusions: releaseGateConclusionsFromEnvironment(process.env),
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
