import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import * as releaseEvidenceModule from "../../scripts/evidence/release-evidence.js";
import type { ReviewedPullRequestValidationInput } from "../../scripts/evidence/reviewed-pr-evidence.js";

const { buildReleaseEvidence } = releaseEvidenceModule;
const CANDIDATE_SHA = "a".repeat(40);
const EVIDENCE_SHA = "b".repeat(40);

function reviewedPullRequestInput(): ReviewedPullRequestValidationInput {
  return {
    repository: "cake/ai-assistant-addon",
    sourceCandidateSha: CANDIDATE_SHA,
    evidenceCommitSha: EVIDENCE_SHA,
    pullRequestNumber: 42,
    ciRunId: 1001,
    codeqlRunId: 1002,
    pullRequest: {
      number: 42,
      url: "https://github.com/cake/ai-assistant-addon/pull/42",
      state: "OPEN",
      isDraft: false,
      merged: false,
      baseRefName: "main",
      headRefOid: EVIDENCE_SHA,
      reviewDecision: "APPROVED",
      reviewThreads: {
        nodes: [{ isResolved: true }, { isResolved: true }],
        pageInfo: { hasNextPage: false },
      },
    },
    ciRun: {
      id: 1001,
      html_url: "https://github.com/cake/ai-assistant-addon/actions/runs/1001",
      name: "CI",
      path: ".github/workflows/ci.yml",
      event: "pull_request",
      status: "completed",
      conclusion: "success",
      head_sha: EVIDENCE_SHA,
      run_attempt: 1,
    },
    ciJobs: {
      total_count: 4,
      jobs: [
        { name: "verify", conclusion: "success" },
        { name: "browser-e2e", conclusion: "success" },
        { name: "dependency-review", conclusion: "success" },
        { name: "secret-scan", conclusion: "success" },
      ],
    },
    codeqlRun: {
      id: 1002,
      html_url: "https://github.com/cake/ai-assistant-addon/actions/runs/1002",
      name: "CodeQL",
      path: ".github/workflows/codeql.yml",
      event: "pull_request",
      status: "completed",
      conclusion: "success",
      head_sha: EVIDENCE_SHA,
      run_attempt: 1,
    },
    codeqlJobs: {
      total_count: 1,
      jobs: [{ name: "analyze", conclusion: "success" }],
    },
  };
}

function vitestReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    numTotalTestSuites: 410,
    numPassedTestSuites: 410,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numTotalTests: 2400,
    numPassedTests: 2400,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    success: true,
    ...overrides,
  };
}

function validReleaseAttachments(): Pick<
  Parameters<typeof buildReleaseEvidence>[0],
  "reviewedPullRequest" | "coldVerifies"
> {
  return {
    reviewedPullRequest: releaseEvidenceModule.validateReviewedPullRequestEvidence(reviewedPullRequestInput()),
    coldVerifies: releaseEvidenceModule.buildColdVerifyEvidence({
      sourceCandidateSha: CANDIDATE_SHA,
      evidenceCommitSha: EVIDENCE_SHA,
      nodeVersion: "v22.17.1",
      retries: 0,
      reports: [vitestReport(), vitestReport(), vitestReport()],
      reportBytes: [Buffer.from("pass-1"), Buffer.from("pass-2"), Buffer.from("pass-3")],
    }),
  };
}

describe("release evidence", () => {
  it("classifies existing conclusions as historical v1 evidence and rejects v2 reuse without changing hashes", () => {
    const attachments = validReleaseAttachments();
    const input = {
      sourceCandidateSha: CANDIDATE_SHA,
      evidenceCommitSha: EVIDENCE_SHA,
      machineConclusions: {},
      ...attachments,
    };
    const reportHashes = attachments.coldVerifies.passes.map(({ reportSha256 }) => reportSha256);

    expect(buildReleaseEvidence(input, "v1")).toMatchObject({
      assistantEngine: "v1",
      evidenceStatus: "historical",
      validForV2: false,
    });
    expect(() => buildReleaseEvidence(input, "v2")).toThrow(
      /historical v1 evidence is not valid for v2/iu,
    );
    expect(attachments.coldVerifies.passes.map(({ reportSha256 }) => reportSha256)).toEqual(reportHashes);
  });

  it("records machine conclusions while keeping every human gate unevaluated", () => {
    const evidence = buildReleaseEvidence({
      sourceCandidateSha: CANDIDATE_SHA,
      evidenceCommitSha: EVIDENCE_SHA,
      machineConclusions: {
        verify: "success",
        reviewedPullRequest: "success",
        pullRequestCi: "success",
        dependencyReview: "success",
        pullRequestCodeql: "success",
        pullRequestSecretScan: "success",
        engineeringReview: "success",
        localUiPerformance: "success",
        actionlint: "success",
        marketplaceMediaBinding: "success",
        audit: "failure",
        license: "cancelled",
        codeql: "skipped",
        secretScan: "success",
        scriptedSafetyCorpus: "success",
        browserE2e: "success",
        sbom: "success",
        liveSmoke: "success",
        backupRestoreDrill: "success",
        deterministicSafetyEvaluation: "success",
        privateProductionPerformance: "success",
        liveBrowserAcceptance: "success",
        productionAuditHostClearance: "skipped",
      },
      reviewedPullRequest: {
        schemaVersion: 1,
        conclusion: "passed",
        repository: "cake/ai-assistant-addon",
        sourceCandidateSha: CANDIDATE_SHA,
        evidenceCommitSha: EVIDENCE_SHA,
        pullRequest: {
          number: 42,
          url: "https://github.com/cake/ai-assistant-addon/pull/42",
          baseRefName: "main",
          headSha: EVIDENCE_SHA,
          state: "OPEN",
          reviewDecision: "APPROVED",
          unresolvedReviewThreads: 0,
        },
        ciRun: {
          id: 1001,
          url: "https://github.com/cake/ai-assistant-addon/actions/runs/1001",
          headSha: EVIDENCE_SHA,
          attempt: 1,
          requiredJobs: ["browser-e2e", "dependency-review", "secret-scan", "verify"],
        },
        codeqlRun: {
          id: 1002,
          url: "https://github.com/cake/ai-assistant-addon/actions/runs/1002",
          headSha: EVIDENCE_SHA,
          attempt: 1,
          requiredJobs: ["analyze"],
        },
      },
      coldVerifies: {
        schemaVersion: 1,
        conclusion: "passed",
        sourceCandidateSha: CANDIDATE_SHA,
        evidenceCommitSha: EVIDENCE_SHA,
        node: "v22.17.1",
        minimumPassedTests: 2366,
        consecutiveColdPasses: 3,
        retries: 0,
        passes: [1, 2, 3].map((pass) => ({
          pass,
          reportSha256: String(pass).repeat(64),
          totalTests: 2400,
          passedTests: 2400,
          failedTests: 0,
          pendingTests: 0,
          todoTests: 0,
        })),
      },
      humanConclusions: {
        ownershipAndHumanSignoff: "passed",
        marketplaceSubmission: "passed",
      },
      token: "RELEASE_TOKEN_MUST_NOT_APPEAR",
    } as never);

    expect(evidence.sourceCandidateSha).toBe(CANDIDATE_SHA);
    expect(evidence.evidenceCommitSha).toBe(EVIDENCE_SHA);
    expect(evidence).not.toHaveProperty("commitSha");
    expect(evidence.machineGates).toEqual({
      verify: "passed",
      reviewedPullRequest: "passed",
      pullRequestCi: "passed",
      dependencyReview: "passed",
      pullRequestCodeql: "passed",
      pullRequestSecretScan: "passed",
      engineeringReview: "passed",
      localUiPerformance: "passed",
      actionlint: "passed",
      marketplaceMediaBinding: "passed",
      audit: "failed",
      license: "cancelled",
      codeql: "skipped",
      secretScan: "passed",
      scriptedSafetyCorpus: "passed",
      browserE2e: "passed",
      sbom: "passed",
      liveSmoke: "passed",
      backupRestoreDrill: "passed",
      deterministicSafetyEvaluation: "passed",
      privateProductionPerformance: "passed",
      liveBrowserAcceptance: "passed",
      productionAuditHostClearance: "skipped",
    });
    expect(evidence.reviewedPullRequest.pullRequest).toMatchObject({ number: 42, headSha: EVIDENCE_SHA });
    expect(evidence.coldVerifies.passes).toHaveLength(3);
    expect(evidence.humanGates).toEqual({
      providerAndCredentialsGovernance: "not_evaluated",
      ownershipAndHumanSignoff: "not_evaluated",
      marketplaceSubmission: "not_evaluated",
    });
    expect(new Set(Object.values(evidence.humanGates))).toEqual(new Set(["not_evaluated"]));
    expect(JSON.stringify(evidence)).not.toContain("RELEASE_TOKEN_MUST_NOT_APPEAR");
  });

  it("accepts only a reviewed exact-head PR with complete green CI, dependency, CodeQL, and gitleaks jobs", () => {
    const validator = Reflect.get(releaseEvidenceModule, "validateReviewedPullRequestEvidence");
    expect(validator).toBeTypeOf("function");
    if (typeof validator !== "function") return;

    const validated = validator(reviewedPullRequestInput()) as {
      conclusion: string;
      pullRequest: { number: number; unresolvedReviewThreads: number };
      ciRun: { requiredJobs: readonly string[] };
      codeqlRun: { requiredJobs: readonly string[] };
    };
    expect(validated).toMatchObject({
      conclusion: "passed",
      pullRequest: { number: 42, unresolvedReviewThreads: 0 },
    });
    expect(validated.ciRun.requiredJobs).toEqual(["browser-e2e", "dependency-review", "secret-scan", "verify"]);
    expect(validated.codeqlRun.requiredJobs).toEqual(["analyze"]);

    for (const mutate of [
      (input: Record<string, any>) => { input.pullRequest.reviewDecision = "CHANGES_REQUESTED"; },
      (input: Record<string, any>) => { input.pullRequest.reviewThreads.nodes[0].isResolved = false; },
      (input: Record<string, any>) => { input.pullRequest.headRefOid = "c".repeat(40); },
      (input: Record<string, any>) => { input.ciRun.head_sha = "c".repeat(40); },
      (input: Record<string, any>) => { input.ciRun.run_attempt = 2; },
      (input: Record<string, any>) => { input.ciJobs.jobs[2].conclusion = "failure"; },
      (input: Record<string, any>) => { input.ciJobs.jobs[3].conclusion = "skipped"; },
      (input: Record<string, any>) => { input.codeqlJobs.jobs[0].conclusion = "failure"; },
      (input: Record<string, any>) => { input.ciJobs.total_count = 5; },
    ]) {
      const input = structuredClone(reviewedPullRequestInput());
      mutate(input as unknown as Record<string, any>);
      expect(() => validator(input)).toThrow();
    }
  });

  it("records three machine-readable cold reports and rejects reduced, skipped, todo, failed, retried, or non-Node-22 runs", () => {
    const builder = Reflect.get(releaseEvidenceModule, "buildColdVerifyEvidence");
    expect(builder).toBeTypeOf("function");
    if (typeof builder !== "function") return;

    const base = {
      sourceCandidateSha: CANDIDATE_SHA,
      evidenceCommitSha: EVIDENCE_SHA,
      nodeVersion: "v22.17.1",
      retries: 0,
      reports: [vitestReport(), vitestReport(), vitestReport()],
      reportBytes: [Buffer.from("pass-1"), Buffer.from("pass-2"), Buffer.from("pass-3")],
    };
    const evidence = builder(base) as {
      minimumPassedTests: number;
      consecutiveColdPasses: number;
      passes: Array<{ pass: number; passedTests: number; reportSha256: string }>;
    };
    expect(evidence.minimumPassedTests).toBe(2366);
    expect(evidence.consecutiveColdPasses).toBe(3);
    expect(evidence.passes.map(({ pass, passedTests }) => ({ pass, passedTests }))).toEqual([
      { pass: 1, passedTests: 2400 },
      { pass: 2, passedTests: 2400 },
      { pass: 3, passedTests: 2400 },
    ]);
    expect(evidence.passes.every(({ reportSha256 }) => /^[a-f0-9]{64}$/.test(reportSha256))).toBe(true);

    for (const bad of [
      { ...base, reports: [vitestReport({ numTotalTests: 2365, numPassedTests: 2365 }), vitestReport(), vitestReport()] },
      { ...base, reports: [vitestReport({ numTotalTests: 2401, numPendingTests: 1 }), vitestReport(), vitestReport()] },
      { ...base, reports: [vitestReport({ numTotalTests: 2401, numTodoTests: 1 }), vitestReport(), vitestReport()] },
      { ...base, reports: [vitestReport({ numPassedTests: 2399, numFailedTests: 1 }), vitestReport(), vitestReport()] },
      { ...base, reports: [vitestReport({ success: undefined }), vitestReport(), vitestReport()] },
      { ...base, reports: [vitestReport(), vitestReport()] },
      { ...base, retries: 1 },
      { ...base, nodeVersion: "v26.0.0" },
    ]) expect(() => builder(bad)).toThrow();
  });

  it("rejects an invalid commit SHA and maps unknown machine results safely", () => {
    expect(() => buildReleaseEvidence({
      sourceCandidateSha: "not-a-commit",
      evidenceCommitSha: "b".repeat(40),
      machineConclusions: {},
    } as never)).toThrow(/source candidate SHA/);

    expect(() => buildReleaseEvidence({
      sourceCandidateSha: "a".repeat(40),
      evidenceCommitSha: "not-a-commit",
      machineConclusions: {},
    } as never)).toThrow(/evidence commit SHA/);

    const evidence = buildReleaseEvidence({
      sourceCandidateSha: "a".repeat(40),
      evidenceCommitSha: "b".repeat(40),
      machineConclusions: { verify: "passed" },
      ...validReleaseAttachments(),
    });
    expect(evidence.machineGates.verify).toBe("unknown");
  });

  it("rejects tampered reviewed-PR and cold-count attachments in the final record", () => {
    const build = (attachments: ReturnType<typeof validReleaseAttachments>) => buildReleaseEvidence({
      sourceCandidateSha: CANDIDATE_SHA,
      evidenceCommitSha: EVIDENCE_SHA,
      machineConclusions: {},
      ...attachments,
    });

    const missingDependencyReview = structuredClone(validReleaseAttachments());
    missingDependencyReview.reviewedPullRequest.ciRun.requiredJobs = ["browser-e2e", "secret-scan", "verify"];
    expect(() => build(missingDependencyReview)).toThrow(/reviewed pull request evidence/);

    const unapproved = structuredClone(validReleaseAttachments());
    unapproved.reviewedPullRequest.pullRequest.reviewDecision = "CHANGES_REQUESTED" as "APPROVED";
    expect(() => build(unapproved)).toThrow(/reviewed pull request evidence/);

    const skipped = structuredClone(validReleaseAttachments());
    skipped.coldVerifies.passes[1].pendingTests = 1 as 0;
    expect(() => build(skipped)).toThrow(/cold verify evidence/);

    const forgedDigest = structuredClone(validReleaseAttachments());
    forgedDigest.coldVerifies.passes[2].reportSha256 = "not-a-digest";
    expect(() => build(forgedDigest)).toThrow(/cold verify evidence/);
  });

  it("makes checked-in DeepSeek evidence a machine gate in CI and release evidence", () => {
    const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { scripts?: Record<string, string> };
    const ci = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");
    const release = readFileSync(resolve(".github/workflows/release-evidence.yml"), "utf8");

    expect(pkg.scripts?.["check:deepseek-evidence"]).toContain("deepseek-release-evidence.ts");
    expect(pkg.scripts?.["check:operational-evidence"]).toContain("operational-release-evidence.ts");
    expect(pkg.scripts?.["check:private-production-evidence"]).toContain("private-production-release-evidence.ts");
    expect(pkg.scripts?.["check:live-browser-evidence"]).toContain("live-browser-acceptance.ts");
    expect(pkg.scripts?.["probe:member-denial"]).toContain("live-member-denial-probe.ts");
    expect(ci).toContain("npm run check:deepseek-evidence -- --benchmark-only");
    expect(release).toContain("deepseek-evidence:");
    expect(release).toContain("DEEPSEEK_DEPLOYED_VERSION_PATH");
    expect(release).toContain("/version");
    expect(release).toContain("needs.deepseek-evidence.result");
    expect(release).toContain("private-production-evidence:");
    expect(release).toContain("needs.private-production-evidence.result");
    expect(release).toContain("live-browser-evidence:");
    expect(release).toContain("LIVE_BROWSER_DEPLOYED_VERSION_PATH");
    expect(release).toContain("needs.live-browser-evidence.result");
    expect(release).not.toContain("deterministic_safety_evaluation_conclusion:");
    expect(release).not.toContain("backup_restore_drill_conclusion:");
    expect(release).not.toContain("production_audit_host_clearance_conclusion:");
    expect(release).toContain("needs.operational-evidence.result");
    expect(release).toContain("RELEASE_SOURCE_CANDIDATE_SHA: ${{ inputs.tested_candidate_sha }}");
    expect(release).toContain("RELEASE_EVIDENCE_COMMIT_SHA: ${{ github.sha }}");
    expect(release).not.toContain("RELEASE_COMMIT_SHA:");
  });

  it("documents the corpus and focused clean-candidate DeepSeek reproduction commands", () => {
    const benchmark = readFileSync(resolve("evidence/performance/deepseek-v4-pro-2026-07-18.md"), "utf8");
    expect(benchmark).toContain("EVAL_RELEASE_CANDIDATE_SHA");
    expect(benchmark.match(/--repeat=5/g)).toHaveLength(2);
    expect(benchmark.match(/--repeat=20/g)).toHaveLength(2);
    expect(benchmark).toContain("--only=agentic.count_projects");
    expect(benchmark).toContain("--only=agentic.delete_tag_by_name");
    expect(benchmark.match(/--preview-only/g)).toHaveLength(1);
    expect(benchmark).toContain("DEEPSEEK_FOCUSED_READ_RAW_PATH");
    expect(benchmark).toContain("DEEPSEEK_FOCUSED_RISKY_PREVIEW_RAW_PATH");
    expect(benchmark).not.toContain("--repeat=1");
  });

  it("keeps the release action and preference journeys genuinely keyboard-only", () => {
    const actions = readFileSync(resolve("tests/e2e/action-journeys.spec.ts"), "utf8");
    const onboarding = readFileSync(resolve("tests/e2e/onboarding-keyboard.spec.ts"), "utf8");
    for (const source of [actions, onboarding]) {
      expect(source).not.toContain(".click()");
      expect(source).not.toContain(".selectOption(");
      expect(source).toContain("tabTo(");
    }
    expect(onboarding).toContain("Permission level for Time tracking");
    expect(actions).toContain("page.waitForEvent(\"download\")");
  });
});
