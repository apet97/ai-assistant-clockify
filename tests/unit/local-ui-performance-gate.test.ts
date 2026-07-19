import { describe, expect, it } from "vitest";

import {
  FAST_4G_PROFILE,
  LOCAL_UI_SAMPLE_COUNTS,
  LOCAL_UI_THRESHOLDS,
  evaluateLocalUiEvidence,
  percentile,
  renderLocalUiMarkdown,
  summarize,
  type LocalUiEvidence,
} from "../../scripts/performance/local-ui-contract.js";

function passingEvidence(): Omit<LocalUiEvidence, "conclusion" | "failures"> {
  const distribution = { samples: 20, minMs: 1, p50Ms: 4, p95Ms: 8, maxMs: 9 };
  return {
    schemaVersion: 1,
    kind: "local_fixture_ui_performance",
    generatedAt: "2026-07-18T00:00:00.000Z",
    scope: {
      classification: "secret-free local Playwright fixture",
      productionClaim: false,
      fixture: "tests/e2e/fixtures/server.mjs",
      note: "fixture only",
    },
    source: { commitSha: "a".repeat(40), workingTreeDirty: true },
    environment: {
      node: "v22.0.0",
      platform: "darwin",
      architecture: "arm64",
      browser: "Chromium",
      browserVersion: "1",
      networkProfile: FAST_4G_PROFILE,
    },
    sampleCounts: LOCAL_UI_SAMPLE_COUNTS,
    thresholds: LOCAL_UI_THRESHOLDS,
    metrics: {
      statusFeedback: { ...distribution, thresholdMaxMs: 100, passed: true },
      warmShellInteractive: { ...distribution, thresholdP95Ms: 1_000, passed: true },
      coldFast4gShellInteractive: { ...distribution, thresholdP95Ms: 2_000, passed: true },
      historyHydration: {
        ...distribution,
        thresholdP95Ms: 250,
        supportedMessages: 50,
        response: distribution,
        renderAfterResponse: distribution,
        passed: true,
      },
      uiAssets: {
        files: [{ path: "dist/ui/main.js", rawBytes: 10_000, gzipBytes: 5_000 }],
        rawBytes: 10_000,
        gzipBytes: 5_000,
        limitBytes: 20_480,
        passed: true,
      },
    },
  };
}

describe("local UI performance gate contract", () => {
  it("uses the documented nearest-rank p50 and p95", () => {
    const values = Array.from({ length: 20 }, (_, index) => index + 1);
    expect(percentile(values, 0.5)).toBe(10);
    expect(percentile(values, 0.95)).toBe(19);
    expect(summarize(values)).toEqual({ samples: 20, minMs: 1, p50Ms: 10, p95Ms: 19, maxMs: 20 });
  });

  it("rejects empty, invalid, and out-of-range sample inputs", () => {
    expect(() => summarize([])).toThrow(/must not be empty/);
    expect(() => summarize([1, Number.NaN])).toThrow(/finite/);
    expect(() => percentile([1], 0)).toThrow(/Percentile/);
  });

  it("passes only when all five local fixture gates pass", () => {
    const passed = evaluateLocalUiEvidence(passingEvidence());
    expect(passed.conclusion).toBe("passed");
    expect(passed.failures).toEqual([]);

    const failedInput = passingEvidence();
    failedInput.metrics.historyHydration.passed = false;
    failedInput.metrics.uiAssets.passed = false;
    const failed = evaluateLocalUiEvidence(failedInput);
    expect(failed.conclusion).toBe("failed");
    expect(failed.failures).toHaveLength(2);
  });

  it("labels generated evidence as local fixture data, never production staging data", () => {
    const markdown = renderLocalUiMarkdown(evaluateLocalUiEvidence(passingEvidence()));
    expect(markdown).toContain("secret-free local Playwright fixture evidence only");
    expect(markdown).toContain("not production or staging claims");
    expect(markdown).toContain("50-message history hydration");
    expect(markdown).toContain("20.00 KiB");
  });
});
