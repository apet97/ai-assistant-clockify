export const LOCAL_UI_SAMPLE_COUNTS = {
  statusFeedback: 30,
  warmShell: 25,
  coldFast4gShell: 15,
  historyHydration: 40,
} as const;

export const LOCAL_UI_THRESHOLDS = {
  statusFeedbackMaxMs: 100,
  warmShellP95Ms: 1_000,
  coldFast4gShellP95Ms: 2_000,
  historyHydrationP95Ms: 250,
  uiGzipBytes: 20 * 1_024,
} as const;

export const FAST_4G_PROFILE = {
  latencyMs: 60,
  downloadBitsPerSecond: 4_000_000,
  uploadBitsPerSecond: 3_000_000,
  cacheDisabled: true,
} as const;

export interface Distribution {
  samples: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface AssetGzipResult {
  files: Array<{ path: string; rawBytes: number; gzipBytes: number }>;
  rawBytes: number;
  gzipBytes: number;
  limitBytes: number;
  passed: boolean;
}

export interface LocalUiEvidence {
  schemaVersion: 1;
  kind: "local_fixture_ui_performance";
  generatedAt: string;
  scope: {
    classification: "secret-free local Playwright fixture";
    productionClaim: false;
    fixture: string;
    note: string;
  };
  source: {
    commitSha: string;
    workingTreeDirty: boolean;
  };
  environment: {
    node: string;
    platform: string;
    architecture: string;
    browser: string;
    browserVersion: string;
    networkProfile: typeof FAST_4G_PROFILE;
  };
  sampleCounts: typeof LOCAL_UI_SAMPLE_COUNTS;
  thresholds: typeof LOCAL_UI_THRESHOLDS;
  metrics: {
    statusFeedback: Distribution & { thresholdMaxMs: number; passed: boolean };
    warmShellInteractive: Distribution & { thresholdP95Ms: number; passed: boolean };
    coldFast4gShellInteractive: Distribution & { thresholdP95Ms: number; passed: boolean };
    historyHydration: Distribution & {
      thresholdP95Ms: number;
      supportedMessages: number;
      response: Distribution;
      renderAfterResponse: Distribution;
      passed: boolean;
    };
    uiAssets: AssetGzipResult;
  };
  conclusion: "passed" | "failed";
  failures: string[];
}

function finiteSamples(values: number[]): number[] {
  if (values.length === 0) throw new Error("Performance samples must not be empty.");
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("Performance samples must be finite, non-negative numbers.");
  }
  return [...values].sort((left, right) => left - right);
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Nearest-rank percentile: rank = ceil(p * n), with one-based sample ranks. */
export function percentile(values: number[], proportion: number): number {
  if (!(proportion > 0 && proportion <= 1)) throw new Error("Percentile must be in (0, 1].");
  const sorted = finiteSamples(values);
  return sorted[Math.ceil(proportion * sorted.length) - 1];
}

export function summarize(values: number[]): Distribution {
  const sorted = finiteSamples(values);
  return {
    samples: sorted.length,
    minMs: roundMs(sorted[0]),
    p50Ms: roundMs(percentile(sorted, 0.5)),
    p95Ms: roundMs(percentile(sorted, 0.95)),
    maxMs: roundMs(sorted[sorted.length - 1]),
  };
}

export function evaluateLocalUiEvidence(
  input: Omit<LocalUiEvidence, "conclusion" | "failures">,
): LocalUiEvidence {
  const failures: string[] = [];
  const { metrics } = input;
  if (!metrics.statusFeedback.passed) {
    failures.push(`status feedback max ${metrics.statusFeedback.maxMs}ms must be < ${metrics.statusFeedback.thresholdMaxMs}ms`);
  }
  if (!metrics.warmShellInteractive.passed) {
    failures.push(`warm shell p95 ${metrics.warmShellInteractive.p95Ms}ms must be < ${metrics.warmShellInteractive.thresholdP95Ms}ms`);
  }
  if (!metrics.coldFast4gShellInteractive.passed) {
    failures.push(`cold fast-4G shell p95 ${metrics.coldFast4gShellInteractive.p95Ms}ms must be < ${metrics.coldFast4gShellInteractive.thresholdP95Ms}ms`);
  }
  if (!metrics.historyHydration.passed) {
    failures.push(`history hydration p95 ${metrics.historyHydration.p95Ms}ms must be < ${metrics.historyHydration.thresholdP95Ms}ms`);
  }
  if (!metrics.uiAssets.passed) {
    failures.push(`UI JS+CSS gzip ${metrics.uiAssets.gzipBytes} bytes must be <= ${metrics.uiAssets.limitBytes} bytes`);
  }
  return { ...input, conclusion: failures.length === 0 ? "passed" : "failed", failures };
}

function ms(value: number): string {
  return `${value.toFixed(2)} ms`;
}

function kib(value: number): string {
  return `${(value / 1_024).toFixed(2)} KiB`;
}

export function renderLocalUiMarkdown(evidence: LocalUiEvidence): string {
  const { metrics } = evidence;
  const verdict = evidence.conclusion === "passed" ? "PASS" : "FAIL";
  const rows = [
    ["Local visible status feedback", metrics.statusFeedback, `< ${metrics.statusFeedback.thresholdMaxMs} ms (max)`, metrics.statusFeedback.passed],
    ["Warm shell interactive", metrics.warmShellInteractive, `< ${metrics.warmShellInteractive.thresholdP95Ms} ms (p95)`, metrics.warmShellInteractive.passed],
    ["Cold fast-4G shell interactive", metrics.coldFast4gShellInteractive, `< ${metrics.coldFast4gShellInteractive.thresholdP95Ms} ms (p95)`, metrics.coldFast4gShellInteractive.passed],
    ["50-message history hydration", metrics.historyHydration, `< ${metrics.historyHydration.thresholdP95Ms} ms (p95)`, metrics.historyHydration.passed],
  ] as const;

  return `# Local UI performance gate\n\n`+
    `**${verdict}** — generated ${evidence.generatedAt} from commit \`${evidence.source.commitSha}\`${evidence.source.workingTreeDirty ? " plus intentional working-tree changes" : ""}.\n\n`+
    `> Scope: secret-free local Playwright fixture evidence only. These measurements are not production or staging claims. The fixture serves the built UI and deterministic same-origin API responses; real Railway, Clockify, DeepSeek, and network performance require separate live evidence.\n\n`+
    `| Gate | Samples | p50 | p95 | Max | Threshold | Result |\n`+
    `|---|---:|---:|---:|---:|---:|:---:|\n`+
    rows.map(([label, distribution, threshold, passed]) =>
      `| ${label} | ${distribution.samples} | ${ms(distribution.p50Ms)} | ${ms(distribution.p95Ms)} | ${ms(distribution.maxMs)} | ${threshold} | ${passed ? "PASS" : "FAIL"} |`,
    ).join("\n")+
    `\n| Built UI JavaScript + CSS | ${metrics.uiAssets.files.length} assets | — | — | ${kib(metrics.uiAssets.gzipBytes)} gzip | <= ${kib(metrics.uiAssets.limitBytes)} | ${metrics.uiAssets.passed ? "PASS" : "FAIL"} |\n\n`+
    `## Method\n\n`+
    `- Browser: ${evidence.environment.browser} ${evidence.environment.browserVersion}; Node ${evidence.environment.node}.\n`+
    `- Status timing starts at the composer's submit event and ends when the browser first exposes a laid-out, visible “Understanding your request…” state. A deterministic 175 ms fixture response delay keeps the transient state observable; the delay is not included before the local status starts.\n`+
    `- Shell timing starts at navigation and ends on the first animation frame where the heading and enabled message composer are visible. Warm samples reuse one browser context. Cold samples disable cache and emulate ${FAST_4G_PROFILE.latencyMs} ms latency, ${(FAST_4G_PROFILE.downloadBitsPerSecond / 1_000_000).toFixed(1)} Mbps down, and ${(FAST_4G_PROFILE.uploadBitsPerSecond / 1_000_000).toFixed(1)} Mbps up.\n`+
    `- History timing starts when \`/api/chat/history\` is requested and ends on the first animation frame after all ${metrics.historyHydration.supportedMessages} supported messages are in the DOM. Its response-only p50/p95 are ${ms(metrics.historyHydration.response.p50Ms)} / ${ms(metrics.historyHydration.response.p95Ms)}; render-after-response p50/p95 are ${ms(metrics.historyHydration.renderAfterResponse.p50Ms)} / ${ms(metrics.historyHydration.renderAfterResponse.p95Ms)}.\n`+
    `- Asset size is the sum of deterministic gzip level 9 output for every built \`.js\` and \`.css\` file. Current raw/gzip: ${kib(metrics.uiAssets.rawBytes)} / ${kib(metrics.uiAssets.gzipBytes)}.\n`+
    (evidence.failures.length > 0 ? `\n## Failures\n\n${evidence.failures.map((failure) => `- ${failure}`).join("\n")}\n` : "");
}
