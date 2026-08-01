import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  PRIVATE_PRODUCTION_SAMPLE_COUNTS,
  PRIVATE_PRODUCTION_THRESHOLDS,
  assertSecretFreeEvidence,
  buildPrivateProductionEvidence,
  renderPrivateProductionMarkdown,
  validateDeployedRelease,
  validatePrivateProductionEnvironment,
} from "../../scripts/performance/private-production-contract.js";

const SHA = "a".repeat(40);

function samples(value: number): number[] {
  return Array.from({ length: 20 }, () => value);
}

function passingInput() {
  return {
    measurementStartedAt: "2026-07-17T23:50:00.000Z",
    generatedAt: "2026-07-18T00:00:00.000Z",
    commitSha: SHA,
    productVersion: "1.0.0",
    deployed: {
      releaseBuildHash: "b".repeat(64),
      serverArtifactSha256: "c".repeat(64),
      sourceRelationship: "exact_head" as const,
      sourceBindingSha256: null,
    },
    node: "v22.0.0",
    browserVersion: "1",
    samples: {
      warmIframeInteractiveMs: samples(900),
      coldFast4gInteractiveMs: samples(1_900),
      historyApiMs: samples(240),
      localStatusMs: samples(90),
      confirmationFirstReceiptMs: samples(7_900),
    },
    cleanup: { created: 20, deletionProven: 20, pendingPreviews: 0 },
  };
}

describe("private production performance gate contract", () => {
  it("requires all destructive/live attestations and an exact release SHA", () => {
    const validated = validatePrivateProductionEnvironment({
      LIVE_CLOCKIFY: "1",
      LIVE_PERFORMANCE: "1",
      LIVE_SACRIFICIAL_WORKSPACE: "1",
      LIVE_RELEASE_SHA: SHA,
      LIVE_RELEASE_BUILD_HASH: "b".repeat(64),
      LIVE_COMPONENT_URL: "https://private.example.test/component/assistant?auth_token=secret",
      LIVE_WORKSPACE_ID: "workspace-sacrificial",
      PERF_EVIDENCE_DIR: "/tmp/private-performance",
    }, SHA, "/repo");
    expect(validated.releaseSha).toBe(SHA);
    expect(validated.componentUrl).toContain("auth_token=secret");

    for (const key of ["LIVE_CLOCKIFY", "LIVE_PERFORMANCE", "LIVE_SACRIFICIAL_WORKSPACE"] as const) {
      const env = {
        LIVE_CLOCKIFY: "1",
        LIVE_PERFORMANCE: "1",
        LIVE_SACRIFICIAL_WORKSPACE: "1",
        LIVE_RELEASE_SHA: SHA,
        LIVE_RELEASE_BUILD_HASH: "b".repeat(64),
        LIVE_COMPONENT_URL: "https://private.example.test/component/assistant?auth_token=secret",
        LIVE_WORKSPACE_ID: "workspace-sacrificial",
        PERF_EVIDENCE_DIR: "/tmp/private-performance",
      };
      delete env[key];
      expect(() => validatePrivateProductionEnvironment(env, SHA, "/repo")).toThrow(/attestation/);
    }
    expect(() => validatePrivateProductionEnvironment({
      LIVE_CLOCKIFY: "1",
      LIVE_PERFORMANCE: "1",
      LIVE_SACRIFICIAL_WORKSPACE: "1",
      LIVE_RELEASE_SHA: "b".repeat(40),
      LIVE_RELEASE_BUILD_HASH: "b".repeat(64),
      LIVE_COMPONENT_URL: "https://private.example.test/component/assistant?auth_token=secret",
      LIVE_WORKSPACE_ID: "workspace-sacrificial",
      PERF_EVIDENCE_DIR: "/tmp/private-performance",
    }, SHA, "/repo")).toThrow(/release SHA/);
    expect(() => validatePrivateProductionEnvironment({
      LIVE_CLOCKIFY: "1",
      LIVE_PERFORMANCE: "1",
      LIVE_SACRIFICIAL_WORKSPACE: "1",
      LIVE_RELEASE_SHA: SHA,
      LIVE_RELEASE_BUILD_HASH: "b".repeat(64),
      LIVE_COMPONENT_URL: "https://private.example.test/component/assistant?auth_token=secret",
      LIVE_WORKSPACE_ID: "workspace-sacrificial",
    }, SHA, "/repo")).toThrow(/PERF_EVIDENCE_DIR/);
  });

  it("rejects non-HTTPS, credential-free, or wrong-path component URLs", () => {
    const base = {
      LIVE_CLOCKIFY: "1",
      LIVE_PERFORMANCE: "1",
      LIVE_SACRIFICIAL_WORKSPACE: "1",
      LIVE_RELEASE_SHA: SHA,
      LIVE_RELEASE_BUILD_HASH: "b".repeat(64),
      LIVE_WORKSPACE_ID: "workspace-sacrificial",
      PERF_EVIDENCE_DIR: "/tmp/private-performance",
    };
    for (const componentUrl of [
      "http://private.example.test/component/assistant?auth_token=secret",
      "https://private.example.test/component/assistant",
      "https://private.example.test/not-the-component?auth_token=secret",
      "https://user:pass@private.example.test/component/assistant?auth_token=secret",
    ]) {
      expect(() => validatePrivateProductionEnvironment({ ...base, LIVE_COMPONENT_URL: componentUrl }, SHA, "/repo")).toThrow(/component URL/);
    }
  });

  it("requires an absolute evidence directory outside the release checkout", () => {
    const base = {
      LIVE_CLOCKIFY: "1",
      LIVE_PERFORMANCE: "1",
      LIVE_SACRIFICIAL_WORKSPACE: "1",
      LIVE_RELEASE_SHA: SHA,
      LIVE_RELEASE_BUILD_HASH: "b".repeat(64),
      LIVE_WORKSPACE_ID: "workspace-sacrificial",
      LIVE_COMPONENT_URL: "https://private.example.test/component/assistant?auth_token=secret",
    };
    expect(() => validatePrivateProductionEnvironment({ ...base, PERF_EVIDENCE_DIR: "evidence/performance" }, SHA, "/repo")).toThrow(/absolute/);
    expect(() => validatePrivateProductionEnvironment({ ...base, PERF_EVIDENCE_DIR: "/repo/evidence" }, SHA, "/repo")).toThrow(/outside/);
    expect(validatePrivateProductionEnvironment({ ...base, PERF_EVIDENCE_DIR: "/tmp/performance" }, SHA, "/repo").evidenceDirectory)
      .toBe("/tmp/performance");
  });

  it("requires the deployed public version metadata to match the release exactly", () => {
    const exact = {
      version: "1.0.0",
      releaseSha: SHA,
      buildHash: "b".repeat(64),
      serverArtifactSha256: "c".repeat(64),
      sourceRelationship: "exact_head",
      sourceBindingSha256: null,
    };
    expect(() => validateDeployedRelease(exact, SHA, "b".repeat(64), "1.0.0"))
      .not.toThrow();
    expect(validateDeployedRelease(exact, SHA, "b".repeat(64), "1.0.0")).toEqual({
      releaseBuildHash: "b".repeat(64),
      serverArtifactSha256: "c".repeat(64),
      sourceRelationship: "exact_head",
      sourceBindingSha256: null,
    });
    expect(() => validateDeployedRelease({ ...exact, releaseSha: "c".repeat(40) }, SHA, "b".repeat(64), "1.0.0"))
      .toThrow(/deployed release/);
    expect(() => validateDeployedRelease({ ...exact, buildHash: null }, SHA, "b".repeat(64), "1.0.0"))
      .toThrow(/build metadata/);
    expect(() => validateDeployedRelease({ ...exact, version: "0.1.0" }, SHA, "b".repeat(64), "1.0.0"))
      .toThrow(/version/);
    expect(() => validateDeployedRelease({ ...exact, sourceRelationship: "builder_attested" }, SHA, "b".repeat(64), "1.0.0"))
      .toThrow(/source relationship/);
    expect(() => validateDeployedRelease({
      ...exact,
      sourceRelationship: "source_bound_builder",
      sourceBindingSha256: "d".repeat(64),
    }, SHA, "b".repeat(64), "1.0.0")).not.toThrow();
  });

  it("requires exactly twenty samples for every production metric", () => {
    expect(PRIVATE_PRODUCTION_SAMPLE_COUNTS).toEqual({
      warmIframeInteractive: 20,
      coldFast4gInteractive: 20,
      historyApi: 20,
      localStatus: 20,
      confirmationFirstReceipt: 20,
    });
    const input = passingInput();
    input.samples.historyApiMs.pop();
    expect(() => buildPrivateProductionEvidence(input)).toThrow(/exactly 20/);
    input.samples.historyApiMs.push(1, 2);
    expect(() => buildPrivateProductionEvidence(input)).toThrow(/exactly 20/);
  });

  it("uses strict release thresholds and fails closed on incomplete cleanup", () => {
    const passed = buildPrivateProductionEvidence(passingInput());
    expect(passed.conclusion).toBe("passed");
    expect(passed.failures).toEqual([]);

    const boundary = passingInput();
    boundary.samples.warmIframeInteractiveMs.fill(PRIVATE_PRODUCTION_THRESHOLDS.warmIframeP95Ms);
    boundary.samples.coldFast4gInteractiveMs.fill(PRIVATE_PRODUCTION_THRESHOLDS.coldFast4gP95Ms);
    boundary.samples.historyApiMs.fill(PRIVATE_PRODUCTION_THRESHOLDS.historyApiP95Ms);
    boundary.samples.localStatusMs.fill(PRIVATE_PRODUCTION_THRESHOLDS.localStatusMaxMs);
    boundary.samples.confirmationFirstReceiptMs.fill(PRIVATE_PRODUCTION_THRESHOLDS.confirmationFirstReceiptP95Ms);
    const failed = buildPrivateProductionEvidence(boundary);
    expect(failed.conclusion).toBe("failed");
    expect(failed.failures).toHaveLength(5);

    const dirty = passingInput();
    dirty.cleanup.deletionProven = 19;
    expect(() => buildPrivateProductionEvidence(dirty)).toThrow(/cleanup proof/);
  });

  it("emits exact secret-free measurements plus aggregate JSON and Markdown", () => {
    const evidence = buildPrivateProductionEvidence(passingInput());
    expect(evidence.source).toEqual({
      commitSha: SHA,
      releaseBuildHash: "b".repeat(64),
      serverArtifactSha256: "c".repeat(64),
      sourceRelationship: "exact_head",
      sourceBindingSha256: null,
    });
    expect(evidence.measurements.samples.historyApiMs).toHaveLength(20);
    expect(evidence.measurements.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.measurements.startedAt).toBe("2026-07-17T23:50:00.000Z");
    expect(evidence.measurements.completedAt).toBe(evidence.generatedAt);
    expect(() => assertSecretFreeEvidence(evidence)).not.toThrow();
    const tainted = structuredClone(evidence);
    tainted.failures.push("providerToken=https://private.example.test/secret");
    expect(() => assertSecretFreeEvidence(tainted)).toThrow(/forbidden/);
    const json = JSON.stringify(evidence);
    const markdown = renderPrivateProductionMarkdown(evidence);
    for (const output of [json, markdown]) {
      expect(output).not.toMatch(/https?:\/\//i);
      expect(output).not.toMatch(/auth_token|ai_assistant_session|AIASSIST_PERF_|nonce|requestId|previewId|workspaceId|resourceId/i);
      expect(output).not.toContain("secret");
    }
    expect(markdown).toContain("Private-production performance gate");
    expect(markdown).toContain("20");
  });

  it("keeps the runner guarded, UUID-bound, streamed, and cleanup-first", () => {
    const source = readFileSync(resolve("scripts/performance/private-production-gate.ts"), "utf8");
    const contract = readFileSync(resolve("scripts/performance/private-production-contract.ts"), "utf8");
    expect(source).toContain("validatePrivateProductionEnvironment");
    expect(source).toContain("AIASSIST_PERF_");
    expect(source).toContain("randomUUID");
    expect(source).toContain("?stream=1");
    expect(source).toContain("cleanupOutstanding");
    expect(source).toContain("/api/undo/");
    expect(source).toContain("env: browserEnvironment()");
    expect(contract).toContain("LIVE_WORKSPACE_ID");
    expect(source).toContain("validateDeployedRelease");
    expect(source).toContain("seedSupportedHistory");
    expect(source).toContain("messages.length !== 50");
    expect(contract).toContain("PERF_EVIDENCE_DIR");
    expect(source).not.toMatch(/console\.(?:log|error)\([^\n]*(?:componentUrl|LIVE_COMPONENT_URL)/);
  });

  it("documents an exact no-command-line-secret operator invocation", () => {
    const runbook = readFileSync(resolve("scripts/performance/PRIVATE_PRODUCTION.md"), "utf8");
    const launcher = readFileSync(resolve("scripts/performance/run-private-production-secure.ts"), "utf8");
    const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { scripts?: Record<string, string> };
    for (const name of [
      "LIVE_CLOCKIFY",
      "LIVE_PERFORMANCE",
      "LIVE_SACRIFICIAL_WORKSPACE",
      "LIVE_RELEASE_SHA",
      "LIVE_RELEASE_BUILD_HASH",
      "LIVE_WORKSPACE_ID",
      "LIVE_ADDON_TOKEN",
      "LIVE_ADDON_BASE_URL",
      "LIVE_BACKEND_URL",
      "PERF_EVIDENCE_DIR",
    ]) expect(runbook).toContain(name);
    expect(runbook).toContain("npm run perf:private-production:secure");
    expect(pkg.scripts?.["perf:private-production:secure"]).toContain("run-private-production-secure.ts");
    expect(runbook).not.toContain("read -r -s LIVE_COMPONENT_URL");
    expect(runbook).not.toContain("pbcopy");
    expect(runbook).not.toMatch(/LIVE_COMPONENT_URL=['\"]https?:/);
    expect(launcher).toContain('args: ["--import", "tsx"');
    expect(launcher).toContain("environment.LIVE_COMPONENT_URL = componentUrl");
    expect(launcher).not.toMatch(/console\.(?:log|error)\([^\n]*(?:userCredential|addonCredential|component)/u);
  });
});
