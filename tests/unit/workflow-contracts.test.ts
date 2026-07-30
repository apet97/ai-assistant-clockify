import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const readWorkflow = (name: string): string => readFileSync(
  fileURLToPath(new URL(`../../.github/workflows/${name}`, import.meta.url)),
  "utf8",
);

const readRepoFile = (name: string): string => readFileSync(
  fileURLToPath(new URL(`../../${name}`, import.meta.url)),
  "utf8",
);

const expectRemoteActionsPinned = (workflow: string): void => {
  const uses = [...workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1]);
  expect(uses.length).toBeGreaterThan(0);
  for (const action of uses) {
    if (action.startsWith("./")) continue;
    expect(action, `${action} must be pinned to a full commit SHA`).toMatch(/@[0-9a-f]{40}$/);
  }
};

describe("GitHub Actions workflow contracts", () => {
  it("keeps CI security gates and uploads the license report beside the SBOM", () => {
    const workflow = readWorkflow("ci.yml");
    const verifyJob = workflow.slice(
      workflow.indexOf("\n  verify:"),
      workflow.indexOf("\n  browser-e2e:"),
    );

    expect(workflow).toContain("npm run verify");
    expect(workflow).toContain("npm run perf:local-ui");
    expect(verifyJob).toContain("npx playwright install --with-deps chromium");
    expect(verifyJob.indexOf("npx playwright install --with-deps chromium"))
      .toBeLessThan(verifyJob.indexOf("npm run perf:local-ui"));
    // The two candidate-bound evidence gates bind to the FROZEN v1 release
    // candidate and require every change since it to be evidence-only, so they
    // are structurally inapplicable to a build that is not that candidate. They
    // run only when the applicability probe says so -- and BOTH must carry the
    // condition, because leaving either unconditional re-blocks every branch.
    const probeIndex = verifyJob.indexOf("npm run --silent evidence:v1-candidate-build");
    expect(probeIndex).toBeGreaterThan(0);
    for (const gate of [
      "npm run evidence:marketplace-media-binding",
      "npm run check:deepseek-evidence -- --benchmark-only",
    ]) {
      const gateIndex = verifyJob.indexOf(gate);
      expect(gateIndex, `${gate} must still exist`).toBeGreaterThan(0);
      expect(probeIndex, `${gate} must run after the probe`).toBeLessThan(gateIndex);
      const stepStart = verifyJob.lastIndexOf("\n      - name:", gateIndex);
      expect(
        verifyJob.slice(stepStart, gateIndex),
        `${gate} must be gated on the probe output`,
      ).toContain("if: steps.v1-candidate.outputs.is_v1_candidate == 'true'");
    }
    // A probe value other than the two allowed literals must fail the job rather
    // than reach $GITHUB_OUTPUT, which also stops a multi-line value from
    // injecting extra step outputs.
    expect(verifyJob).toContain('[ "$IS_V1_CANDIDATE" != "false" ]');
    expect(workflow).toContain("raven-actions/actionlint@3d39aea434753780c3b3d4a1a31c854b4dbf49d7");
    expect(workflow).toContain("version: 1.7.7");
    expect(workflow).toContain("npx playwright install --with-deps chromium firefox webkit");
    expect(workflow).toContain("npm run test:e2e");
    expect(workflow).toContain("npm run audit:prod");
    expect(workflow).toContain("npm run license:prod");
    expect(workflow).not.toMatch(/npm audit --omit=dev/);
    expect(workflow).toContain("actions/dependency-review-action@");
    expect(workflow).toContain("gitleaks/gitleaks-action@");
    expect(workflow).toContain("npm sbom --sbom-format cyclonedx");
    expect(workflow).toMatch(
      /uses:\s*actions\/upload-artifact@[\s\S]*?path:\s*\|[\s\S]*?sbom\.cdx\.json[\s\S]*?evidence\/dependency-gates\/production-licenses\.json/,
    );
    expectRemoteActionsPinned(workflow);
  });

  it("keeps secret-scan exceptions line-and-path scoped while extending default rules", () => {
    const config = readRepoFile(".gitleaks.toml");

    expect(config).toMatch(/\[extend\]\s+useDefault = true/);
    expect(config).toContain('id = "generic-api-key"');
    // Every exception stays AND-scoped to one path AND one exact line shape, so
    // a real credential in an allowlisted file is still caught. Proven directly:
    // planting a secret into either file below is still reported.
    expect(config.match(/condition = "AND"/g)).toHaveLength(6);
    expect(config.match(/regexTarget = "line"/g)).toHaveLength(6);
    expect(config).toContain("^\\.env\\.example$");
    expect(config).toContain("^tests/unit/config\\.test\\.ts$");
    expect(config).toContain("^tests/unit/workflow-contracts\\.test\\.ts$");
    // Historical prose blobs that quoted the fake negative-test input verbatim;
    // scoped to that one exact sentence in those two paths only.
    expect(config).toContain("^CLAUDE\\.md$");
    expect(config).toContain("^docs/V2_BUILD_LOG\\.md$");
    // The generated catalog digest is a public content hash, published in the
    // inventory evidence — not a credential. Pinned to that exact declaration.
    expect(config).toContain("^src/harness/api-catalog\\.generated\\.ts$");
    expect(config).toContain(
      'regexes = [\'\'\'^\\n?export const API_ACTION_CATALOG_HASH = "[0-9a-f]{64}" as const;$\'\'\']',
    );
    // A deliberately fake credential-shaped string that the supervisor's own
    // secret detector is asserted to FIRE on.
    expect(config).toContain("^tests/scripts/test_codex_v2_supervisor\\.py$");
    expect(config).toContain("abcdefghijklmnop123");
    expect(config).toContain("Historical workflow-contract assertions");
    expect(config).toContain("regexes = ['''^\\n?    expect\\(config\\)\\.toContain");
    expect(config).toContain("DATA_ENCRYPTION_KEY=replace-with-64-hex-chars");
    expect(config).toContain("DATA_ENCRYPTION_KEY=replace-with-a-strong-secret-min-32-chars");
    expect(config).toContain("replace-with-the-previous-secret-min-32-chars");
    expect(config).toContain("0123456789abcdef0123456789abcdef");
    expect(config).toContain("fedcba9876543210fedcba9876543210");
    expect(config).not.toMatch(/commits\s*=/);
  });

  it("serializes scheduled/manual live smoke in a protected sacrificial environment", () => {
    const workflow = readWorkflow("live-smoke.yml");
    const jobsStart = workflow.indexOf("\njobs:");
    const smokeStart = workflow.indexOf("\n  smoke:", jobsStart);
    const cleanupStart = workflow.indexOf("\n  cleanup:", smokeStart);
    const topLevel = workflow.slice(0, jobsStart);
    const smokeJob = workflow.slice(smokeStart, cleanupStart);
    const cleanupJob = workflow.slice(cleanupStart);

    expect(workflow).toMatch(/workflow_dispatch:/);
    expect(workflow).toMatch(/workflow_call:/);
    expect(workflow).toMatch(/schedule:\s*\n\s*- cron:/);
    expect(jobsStart).toBeGreaterThan(0);
    expect(smokeStart).toBeGreaterThan(jobsStart);
    expect(cleanupStart).toBeGreaterThan(smokeStart);
    expect(topLevel).toContain("group: clockify-live-smoke-sacrificial");
    expect(topLevel).toContain("cancel-in-progress: false");
    expect(workflow.match(/group: clockify-live-smoke-sacrificial/g)).toHaveLength(1);

    expect(smokeJob).toContain("environment: clockify-live-smoke-sacrificial");
    expect(smokeJob).toMatch(/timeout-minutes:\s*[1-9][0-9]*/);
    expect(smokeJob).toMatch(/timeout --signal=TERM --kill-after=30s 12m npx tsx scripts\/live-smoke\.ts/);
    expect(smokeJob).toMatch(
      /name:\s*Upload live-smoke evidence[\s\S]*?if:\s*\$\{\{\s*always\(\)\s*\}\}/,
    );

    expect(cleanupJob).toContain("needs: smoke");
    expect(cleanupJob).toMatch(/if:\s*\$\{\{\s*always\(\)\s*\}\}/);
    expect(cleanupJob).toContain("environment: clockify-live-smoke-sacrificial");
    expect(cleanupJob).toMatch(/timeout-minutes:\s*[1-9][0-9]*/);
    expect(cleanupJob).toContain("Initialize fail-closed cleanup evidence");
    expect(cleanupJob).toContain("actions/checkout@");
    expect(cleanupJob).toContain("actions/setup-node@");
    expect(cleanupJob).toContain("npm ci");
    expect(cleanupJob).toMatch(/timeout --signal=TERM --kill-after=30s 7m npx tsx scripts\/live-sweep\.ts/);
    expect(cleanupJob).toMatch(
      /name:\s*Upload cleanup evidence[\s\S]*?if:\s*\$\{\{\s*always\(\)\s*\}\}/,
    );
    expect(smokeJob).toContain("LIVE_SMOKE_EVIDENCE_PATH");
    expect(cleanupJob).toContain("LIVE_SWEEP_EVIDENCE_PATH");
    expectRemoteActionsPinned(workflow);
  });

  it("selects the qualified DeepSeek setting before running focused release cohorts", () => {
    const workflow = readWorkflow("release-evidence.yml");
    const deepSeekStart = workflow.indexOf("\n  deepseek-evidence:");
    const nextJobStart = workflow.indexOf("\n  private-production-evidence:", deepSeekStart);
    const deepSeekJob = workflow.slice(deepSeekStart, nextJobStart);

    expect(deepSeekStart).toBeGreaterThan(0);
    expect(nextJobStart).toBeGreaterThan(deepSeekStart);
    expect(deepSeekJob).not.toContain("|| true");
    expect(deepSeekJob).toMatch(
      /set \+e[\s\S]*?DEEPSEEK_CANDIDATE_RAW_PATH[\s\S]*?lower_effort_status="\$\?"[\s\S]*?set -e/,
    );
    expect(deepSeekJob).toContain('test -s "${DEEPSEEK_CANDIDATE_RAW_PATH}"');
    expect(deepSeekJob).toContain('export DEEPSEEK_CANDIDATE_EXIT_STATUS="${lower_effort_status}"');
    expect(deepSeekJob).toContain(
      'npx tsx scripts/evidence/deepseek-release-evidence.ts --select-setting',
    );
    expect(deepSeekJob).toMatch(/case "\$\{selected_setting\}" in[\s\S]*?production-default\)[\s\S]*?thinking-disabled\)[\s\S]*?\*\)/);
    expect(deepSeekJob).toMatch(
      /if \[\[ "\$\{lower_effort_status\}" -eq 1 && "\$\{selected_setting\}" != "production-default" \]\]/,
    );
    expect(deepSeekJob).toMatch(
      /production-default\)[\s\S]*?env -u LLM_THINKING_MODE -u EVAL_DEEPSEEK_THINKING_MODE[\s\S]*?--only=agentic\.count_projects[\s\S]*?env -u LLM_THINKING_MODE -u EVAL_DEEPSEEK_THINKING_MODE[\s\S]*?--only=agentic\.delete_tag_by_name/,
    );
    expect(deepSeekJob).toMatch(
      /thinking-disabled\)[\s\S]*?env LLM_THINKING_MODE=disabled EVAL_DEEPSEEK_THINKING_MODE=disabled[\s\S]*?--only=agentic\.count_projects[\s\S]*?env LLM_THINKING_MODE=disabled EVAL_DEEPSEEK_THINKING_MODE=disabled[\s\S]*?--only=agentic\.delete_tag_by_name/,
    );
    expect(deepSeekJob.indexOf("--select-setting"))
      .toBeLessThan(deepSeekJob.indexOf("--only=agentic.count_projects"));
    expect(deepSeekJob.lastIndexOf("--only=agentic.delete_tag_by_name"))
      .toBeLessThan(deepSeekJob.indexOf("npm run --silent bind:deepseek-evidence"));
  });

  it("records every machine release gate without asserting human completion", () => {
    const workflow = readWorkflow("release-evidence.yml");
    const coldVerifyEvidence = readRepoFile("scripts/evidence/cold-verify-evidence.ts");
    const jobsStart = workflow.indexOf("\njobs:");
    const smokeStart = workflow.indexOf("\n  live-smoke:", jobsStart);
    const cleanupStart = workflow.indexOf("\n  live-smoke-cleanup:", smokeStart);
    const recordStart = workflow.indexOf("\n  record:", cleanupStart);
    const topLevel = workflow.slice(0, jobsStart);
    const smokeJob = workflow.slice(smokeStart, cleanupStart);
    const cleanupJob = workflow.slice(cleanupStart, recordStart);
    const recordJob = workflow.slice(workflow.indexOf("\n  record:"));

    expect(workflow).toMatch(/workflow_dispatch:/);
    expect(workflow).not.toContain("backup_restore_drill_conclusion:");
    expect(workflow).not.toContain("production_audit_host_clearance_conclusion:");
    expect(workflow).not.toContain("deterministic_safety_evaluation_conclusion:");
    expect(workflow).toContain("tested_candidate_sha:");
    expect(workflow).toContain("deployed_base_url:");
    expect(workflow).toContain("reviewed_pr_number:");
    expect(workflow).toContain("reviewed_pr_ci_run_id:");
    expect(workflow).toContain("reviewed_pr_codeql_run_id:");
    expect(workflow).toContain("REVIEWED_PR_NUMBER: ${{ inputs.reviewed_pr_number }}");
    expect(workflow).toContain("REVIEWED_PR_CI_RUN_ID: ${{ inputs.reviewed_pr_ci_run_id }}");
    expect(workflow).toContain("REVIEWED_PR_CODEQL_RUN_ID: ${{ inputs.reviewed_pr_codeql_run_id }}");
    expect(workflow).toContain("npm run check:reviewed-pr-evidence");
    expect(workflow).toContain("reviewed-pr.json");
    expect(workflow).toContain("deepseek-evidence:");
    expect(workflow).toContain("npm run check:deepseek-evidence");
    expect(workflow).toContain("operational-evidence:");
    expect(workflow).toContain("npm run check:operational-evidence");
    expect(workflow).toContain("private-production-evidence:");
    expect(workflow).toContain("npm run check:private-production-evidence");
    expect(workflow).toContain("live-browser-evidence:");
    expect(workflow).toContain("npm run check:live-browser-evidence");
    expect(workflow).toContain("production-browser.json");
    expect(workflow).toContain("production-browser-trace.json");
    expect(workflow).toContain("production-member-denial.json");
    expect(workflow).toContain("evidence/performance/private-production.json");
    expect(workflow).toContain("PRIVATE_PRODUCTION_DEPLOYED_VERSION_PATH");
    expect(workflow).toContain("production-restore.json");
    expect(workflow).toContain("production-scope-probe.json");
    expect(workflow).toContain("/release/install-attestation/verify");
    expect(workflow).toContain("npm run verify");
    expect(workflow).toContain("for pass in 1 2 3");
    expect(workflow).toContain("rm -rf -- dist");
    expect(workflow).toContain("git checkout --detach");
    expect(workflow).toContain("cold-verifies.json");
    expect(workflow).toContain("VITEST_RELEASE_REPORT_PATH");
    expect(workflow).toContain("vitest-pass-${pass}.json");
    expect(workflow).toContain("npm run record:cold-verifies");
    // The release test-count floor: BOTH inline workflow gates must carry the
    // exact derived value floor(5,461 × 0.98) = 5,351, and the constant's
    // module must record the baseline + explicit shrink it derives from.
    expect(workflow.split("minimumPassedTests !== 5351").length - 1).toBe(2);
    expect(workflow.split("pass.passedTests < 5351").length - 1).toBe(2);
    expect(coldVerifyEvidence).toContain("RECORDED_SUITE_BASELINE = 5_461");
    expect(coldVerifyEvidence).toContain("ALLOWED_SUITE_SHRINK_PERCENT = 2");
    expect(coldVerifyEvidence).toContain("numPendingTests");
    expect(coldVerifyEvidence).toContain("numTodoTests");
    expect(workflow).toContain("npm run perf:local-ui");
    expect(workflow).toContain("local-ui-performance");
    expect(workflow).toContain("raven-actions/actionlint@3d39aea434753780c3b3d4a1a31c854b4dbf49d7");
    expect(workflow).toContain("RELEASE_GATE_ACTIONLINT");
    expect(workflow).toContain("RELEASE_GATE_LOCAL_UI_PERFORMANCE");
    expect(workflow).toContain("npm run audit:prod");
    expect(workflow).toContain("npm run license:prod");
    expect(workflow).toContain("npm run eval:smoke");
    expect(workflow).toContain("npx playwright install --with-deps chromium firefox webkit");
    expect(workflow).toContain("npm run test:e2e");
    expect(workflow).toContain("npm sbom --sbom-format cyclonedx");
    expect(workflow).toContain("github/codeql-action/init@");
    expect(workflow).toContain("github/codeql-action/analyze@");
    expect(workflow).toContain("gitleaks/gitleaks-action@");
    expect(workflow).not.toContain("uses: ./.github/workflows/live-smoke.yml");
    expect(topLevel).toContain("group: clockify-live-smoke-sacrificial");
    expect(topLevel).toContain("cancel-in-progress: false");
    expect(smokeStart).toBeGreaterThan(jobsStart);
    expect(cleanupStart).toBeGreaterThan(smokeStart);
    expect(recordStart).toBeGreaterThan(cleanupStart);
    expect(smokeJob).toContain("environment: clockify-live-smoke-sacrificial");
    expect(smokeJob).toContain("Initialize fail-closed smoke evidence");
    expect(smokeJob).toMatch(/timeout-minutes:\s*20/);
    expect(smokeJob).toMatch(/timeout --signal=TERM --kill-after=30s 12m npx tsx scripts\/live-smoke\.ts/);
    expect(smokeJob).toMatch(
      /name:\s*Upload live-smoke evidence[\s\S]*?if:\s*\$\{\{\s*always\(\)\s*\}\}/,
    );
    expect(cleanupJob).toContain("needs: live-smoke");
    expect(cleanupJob).toMatch(/if:\s*\$\{\{\s*always\(\)\s*\}\}/);
    expect(cleanupJob).toContain("environment: clockify-live-smoke-sacrificial");
    expect(cleanupJob).toContain("Initialize fail-closed cleanup evidence");
    expect(cleanupJob).toMatch(/timeout-minutes:\s*15/);
    expect(cleanupJob).toMatch(/timeout --signal=TERM --kill-after=30s 7m npx tsx scripts\/live-sweep\.ts/);
    expect(cleanupJob).toMatch(
      /name:\s*Upload cleanup evidence[\s\S]*?if:\s*\$\{\{\s*always\(\)\s*\}\}/,
    );
    expect(workflow).toContain("RELEASE_SOURCE_CANDIDATE_SHA: ${{ inputs.tested_candidate_sha }}");
    expect(workflow).toContain("RELEASE_EVIDENCE_COMMIT_SHA: ${{ github.sha }}");
    expect(workflow).not.toContain("RELEASE_COMMIT_SHA:");
    expect(recordJob).toContain("needs: [machine-gates, codeql, secret-scan, deepseek-evidence, private-production-evidence, live-browser-evidence, operational-evidence, live-smoke, live-smoke-cleanup]");
    expect(recordJob).toContain(
      "RELEASE_GATE_LIVE_SMOKE: ${{ needs.live-smoke.result == 'success' && needs.live-smoke-cleanup.result == 'success' && 'success' || 'failure' }}",
    );
    // B5 (deliberate flip of the former checkout-free pin): the record job now
    // checks out the evidence tree and installs dependencies so the REAL v2
    // authority generator runs — the inline not_evaluated_until_pr15 sentinel
    // heredoc is gone. The checkout comes AFTER the machine-conclusion heredoc
    // so a dependency-install failure cannot lose the v1 record.
    expect(recordJob).toContain("actions/checkout@");
    expect(recordJob).toContain("actions/setup-node@");
    expect(recordJob).toContain("npm ci");
    expect(recordJob.indexOf("node <<'NODE'")).toBeLessThan(recordJob.indexOf("actions/checkout@"));
    expect(recordJob).toContain("npx tsx scripts/evidence/v2-authority-evidence.ts");
    expect(recordJob).toContain("V2_AUTHORITY_CANDIDATE_SHA: ${{ inputs.tested_candidate_sha }}");
    // The catalog hash is the v2 MODEL-API REGISTRY hash (the 127 actions the
    // v2 model can see) — never the 171-action inventory hash.
    expect(recordJob).toContain(
      "V2_AUTHORITY_CATALOG_HASH: 3872950503ac629de4629009b7548fbbc1cd509893d0ad2d7c7b34359246cbd7",
    );
    expect(recordJob).not.toContain("fb3c3b5c4787767e6cde921f735f8d5eab55aadde7e5a166aefe0db2a1c75bce");
    expect(recordJob).toContain('V2_AUTHORITY_ASSISTANT_WRITE_CASES: "84"');
    expect(recordJob).toContain("node <<'NODE'");
    expect(recordJob).toContain('"not_evaluated"');
    expect(recordJob).toContain("RELEASE_GATE_LIVE_SMOKE");
    expect(recordJob).toContain("RELEASE_GATE_BROWSER_E2E");
    expect(recordJob).toContain("RELEASE_GATE_BACKUP_RESTORE_DRILL: ${{ needs.operational-evidence.result }}");
    expect(recordJob).toContain("RELEASE_GATE_DETERMINISTIC_SAFETY_EVALUATION: ${{ needs.deepseek-evidence.result }}");
    expect(recordJob).toContain("RELEASE_GATE_PRODUCTION_AUDIT_HOST_CLEARANCE: ${{ needs.operational-evidence.result }}");
    expect(recordJob).toContain("RELEASE_GATE_PRIVATE_PRODUCTION_PERFORMANCE: ${{ needs.private-production-evidence.result }}");
    expect(recordJob).toContain("RELEASE_GATE_LIVE_BROWSER_ACCEPTANCE: ${{ needs.live-browser-evidence.result }}");
    expect(recordJob).toContain("RELEASE_GATE_REVIEWED_PULL_REQUEST");
    expect(recordJob).toContain("RELEASE_GATE_PULL_REQUEST_CI");
    expect(recordJob).toContain("RELEASE_GATE_DEPENDENCY_REVIEW");
    expect(recordJob).toContain("RELEASE_GATE_PULL_REQUEST_CODEQL");
    expect(recordJob).toContain("RELEASE_GATE_PULL_REQUEST_SECRET_SCAN");
    expect(recordJob).toContain("RELEASE_GATE_ENGINEERING_REVIEW");
    expect(recordJob).toContain("RELEASE_REVIEWED_PR_EVIDENCE");
    expect(recordJob).toContain("RELEASE_COLD_VERIFY_EVIDENCE");
    expect(recordJob).toContain("backupRestoreDrill: status(process.env.RELEASE_GATE_BACKUP_RESTORE_DRILL)");
    expect(recordJob).toContain("deterministicSafetyEvaluation: status(process.env.RELEASE_GATE_DETERMINISTIC_SAFETY_EVALUATION)");
    expect(recordJob).toContain("productionAuditHostClearance: status(process.env.RELEASE_GATE_PRODUCTION_AUDIT_HOST_CLEARANCE)");
    expect(recordJob).toContain("privateProductionPerformance: status(process.env.RELEASE_GATE_PRIVATE_PRODUCTION_PERFORMANCE)");
    expect(recordJob).toContain("liveBrowserAcceptance: status(process.env.RELEASE_GATE_LIVE_BROWSER_ACCEPTANCE)");
    expect(recordJob).toContain("browserE2e: status(process.env.RELEASE_GATE_BROWSER_E2E)");
    expect(recordJob).toContain('providerAndCredentialsGovernance: "not_evaluated"');
    expect(recordJob).toContain('ownershipAndHumanSignoff: "not_evaluated"');
    expect(recordJob).toContain('marketplaceSubmission: "not_evaluated"');
    expect(recordJob).toContain("Enforce release-ready engineering gates");
    expect(recordJob).toContain("requiredEngineeringGates");
    expect(recordJob).not.toContain('backupRestoreDrill: "not_evaluated"');
    expect(recordJob).not.toContain('deterministicSafetyEvaluation: "not_evaluated"');
    expect(recordJob).not.toContain('productionAuditHostClearance: "not_evaluated"');
    expect(recordJob).toMatch(
      /name:\s*Upload release evidence[\s\S]*?if:\s*\$\{\{\s*always\(\)\s*\}\}/,
    );
    expectRemoteActionsPinned(workflow);
  });

  it("keeps the credentialed v2 evals dispatch-only and threads their reports to the B5 CLI", () => {
    const workflow = readWorkflow("v2-model-evals.yml");

    // Dispatch-only: one run spends real provider money. Never on push,
    // pull_request, schedule, or workflow_call — normal CI stays fakes-only.
    expect(workflow).toMatch(/\non:\s*\n  workflow_dispatch:\s*\n/);
    for (const trigger of ["push:", "pull_request:", "schedule:", "workflow_call:"]) {
      expect(workflow, `${trigger} must never trigger the credentialed evals`)
        .not.toMatch(new RegExp(`^\\s{0,4}${trigger.replace(":", "\\:")}\\s*$`, "m"));
    }
    // One dispatch at a time, and never cancel a paid run midway.
    expect(workflow).toContain("group: v2-model-evals");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow.match(/group: v2-model-evals/g)).toHaveLength(1);

    // The Phase M guard (defect D-5): the header prose AND an enforced typed
    // attestation input. A pre-M run is VOID as model evidence.
    expect(workflow).toContain("MUST NOT be dispatched until Phase M");
    expect(workflow).toContain("D-5");
    expect(workflow).toContain("confirm_void_until_phase_m:");
    expect(workflow).toMatch(/if \[ "\$CONFIRMATION" != "phase-m-landed" \]/);
    for (const job of ["api-discovery", "assistant-terminal", "write-safety"]) {
      expect(workflow, `${job} must not start without the guard`).toContain(`\n  ${job}:\n    needs: guard`);
    }

    // The three evals run by their npm-script NAMES so the post-M scripts flow
    // through this file unchanged, each capturing its report through the B4
    // evidence-path contract.
    expect(workflow).toContain("npm run eval:api-discovery");
    expect(workflow).toContain("npm run eval:assistant-terminal");
    expect(workflow).toContain("npm run eval:write-safety");
    expect(workflow).toContain("EVAL_API_DISCOVERY_EVIDENCE_PATH");
    expect(workflow).toContain("EVAL_ASSISTANT_TERMINAL_EVIDENCE_PATH");
    expect(workflow).toContain("EVAL_WRITE_SAFETY_EVIDENCE_PATH");
    // The write-safety OBSERVATIONS producer (real prepare/confirm flows) runs
    // before the accountant script; the accountant alone proves nothing.
    expect(workflow.indexOf("npx vitest run tests/integration/v2-write-safety-matrix.test.ts"))
      .toBeGreaterThan(0);
    expect(workflow.indexOf("npx vitest run tests/integration/v2-write-safety-matrix.test.ts"))
      .toBeLessThan(workflow.indexOf("npm run eval:write-safety"));

    // Honest sizing prose and the hosted-runner ceiling on both credentialed jobs.
    expect(workflow).toContain("1,143 real agent turns");
    expect(workflow).toContain("897");
    expect(workflow.match(/timeout-minutes: 360/g)).toHaveLength(2);

    // Credentials come ONLY from the shared eval secrets, mapped as per-step
    // env — never echoed, never interpolated into a run script.
    const secretLines = [...workflow.matchAll(/^.*\$\{\{\s*secrets\..*$/gm)].map((match) => match[0]);
    expect(secretLines).toHaveLength(6);
    for (const line of secretLines) {
      expect(line).toMatch(
        /^\s+LLM_(BASE_URL|API_KEY|MODEL): \$\{\{ secrets\.EVAL_LLM_(BASE_URL|API_KEY|MODEL) \}\}$/,
      );
    }

    // Every report uploads even for a non-passing run (3 evals + the aggregate),
    // and the record job still aggregates honestly after an eval failure.
    expect(workflow.match(/uses:\s*actions\/upload-artifact@/g)).toHaveLength(4);
    expect(workflow.match(/if:\s*\$\{\{\s*always\(\)\s*\}\}/g)).toHaveLength(4);
    const recordStart = workflow.indexOf("\n  record:");
    expect(recordStart).toBeGreaterThan(0);
    const recordJob = workflow.slice(recordStart);
    expect(recordJob).toContain("needs: [guard, api-discovery, assistant-terminal, write-safety]");
    expect(recordJob).toMatch(/if:\s*\$\{\{\s*always\(\)\s*&&\s*needs\.guard\.result == 'success'\s*\}\}/);

    // The handoff: the real v2 authority generator plus the B5 CLI thread the
    // three reports into ReleaseEvidenceV2Input.evaluations on THIS commit.
    expect(recordJob).toContain("npx tsx scripts/evidence/v2-authority-evidence.ts");
    expect(recordJob).toContain("npm run record:v2-release-evidence");
    expect(recordJob).toContain("V2_EVAL_API_DISCOVERY_REPORT_PATH");
    expect(recordJob).toContain("V2_EVAL_ASSISTANT_TERMINAL_REPORT_PATH");
    expect(recordJob).toContain("V2_EVAL_WRITE_SAFETY_REPORT_PATH");
    expect(recordJob).toContain("V2_AUTHORITY_CANDIDATE_SHA: ${{ github.sha }}");
    expect(recordJob).toContain("RELEASE_SOURCE_CANDIDATE_SHA: ${{ github.sha }}");
    expect(recordJob).toContain("RELEASE_EVIDENCE_COMMIT_SHA: ${{ github.sha }}");
    // The catalog hash is the v2 MODEL-API REGISTRY hash (the 127 actions the
    // v2 model can see) — never the 171-action inventory hash.
    expect(recordJob).toContain(
      "V2_AUTHORITY_CATALOG_HASH: 3872950503ac629de4629009b7548fbbc1cd509893d0ad2d7c7b34359246cbd7",
    );
    expect(workflow).not.toContain("fb3c3b5c4787767e6cde921f735f8d5eab55aadde7e5a166aefe0db2a1c75bce");
    expect(recordJob).toContain('V2_AUTHORITY_ASSISTANT_WRITE_CASES: "84"');

    expectRemoteActionsPinned(workflow);
  });
});
