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

    expect(workflow).toContain("npm run verify");
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
    expect(config.match(/condition = "AND"/g)).toHaveLength(2);
    expect(config.match(/regexTarget = "line"/g)).toHaveLength(2);
    expect(config).toContain("^\\.env\\.example$");
    expect(config).toContain("^tests/unit/config\\.test\\.ts$");
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

  it("records every machine release gate without asserting human completion", () => {
    const workflow = readWorkflow("release-evidence.yml");
    const recordJob = workflow.slice(workflow.indexOf("\n  record:"));

    expect(workflow).toMatch(/workflow_dispatch:/);
    expect(workflow).toContain("npm run verify");
    expect(workflow).toContain("npm run audit:prod");
    expect(workflow).toContain("npm run license:prod");
    expect(workflow).toContain("npm run eval:smoke");
    expect(workflow).toContain("npm sbom --sbom-format cyclonedx");
    expect(workflow).toContain("github/codeql-action/init@");
    expect(workflow).toContain("github/codeql-action/analyze@");
    expect(workflow).toContain("gitleaks/gitleaks-action@");
    expect(workflow).toContain("uses: ./.github/workflows/live-smoke.yml");
    expect(workflow).toContain("RELEASE_COMMIT_SHA: ${{ github.sha }}");
    expect(recordJob).not.toContain("actions/checkout@");
    expect(recordJob).not.toContain("actions/setup-node@");
    expect(recordJob).not.toContain("npm ci");
    expect(recordJob).not.toContain("npx tsx");
    expect(recordJob).toContain("node <<'NODE'");
    expect(recordJob).toContain('"not_evaluated"');
    expect(recordJob).toContain("RELEASE_GATE_LIVE_SMOKE");
    expect(recordJob).toMatch(
      /name:\s*Upload release evidence[\s\S]*?if:\s*\$\{\{\s*always\(\)\s*\}\}/,
    );
    expectRemoteActionsPinned(workflow);
  });
});
