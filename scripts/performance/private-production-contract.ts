import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  FAST_4G_PROFILE,
  summarize,
  type Distribution,
} from "./local-ui-contract.js";

export const PRIVATE_PRODUCTION_SAMPLE_COUNTS = {
  warmIframeInteractive: 20,
  coldFast4gInteractive: 20,
  historyApi: 20,
  localStatus: 20,
  confirmationFirstReceipt: 20,
} as const;

export const PRIVATE_PRODUCTION_THRESHOLDS = {
  warmIframeP95Ms: 1_000,
  coldFast4gP95Ms: 2_000,
  historyApiP95Ms: 250,
  localStatusMaxMs: 100,
  confirmationFirstReceiptP95Ms: 8_000,
} as const;

export const PRIVATE_PRODUCTION_MAX_MEASUREMENT_WINDOW_MS = 4 * 60 * 60 * 1_000;

export interface PrivateProductionEnvironment {
  componentUrl: string;
  releaseSha: string;
  releaseBuildHash: string;
  evidenceDirectory: string;
  expectedWorkspaceId: string;
  worktreeRoot: string;
}

export type PrivateProductionSourceRelationship =
  | "exact_head"
  | "evidence_descendant"
  | "source_bound_builder";

export interface DeployedReleaseBinding {
  releaseBuildHash: string;
  serverArtifactSha256: string;
  sourceRelationship: PrivateProductionSourceRelationship;
  sourceBindingSha256: string | null;
}

export interface PrivateProductionSamples {
  warmIframeInteractiveMs: number[];
  coldFast4gInteractiveMs: number[];
  historyApiMs: number[];
  localStatusMs: number[];
  confirmationFirstReceiptMs: number[];
}

export interface PrivateProductionMeasurements {
  startedAt: string;
  completedAt: string;
  sha256: string;
  samples: PrivateProductionSamples;
}

export interface PrivateProductionEvidence {
  schemaVersion: 1;
  kind: "private_production_performance";
  generatedAt: string;
  source: { commitSha: string } & DeployedReleaseBinding;
  measurements: PrivateProductionMeasurements;
  runtime: {
    node: string;
    browser: "Chromium";
    browserVersion: string;
    networkProfile: typeof FAST_4G_PROFILE;
  };
  sampleCounts: typeof PRIVATE_PRODUCTION_SAMPLE_COUNTS;
  thresholds: typeof PRIVATE_PRODUCTION_THRESHOLDS;
  metrics: {
    warmIframeInteractive: Distribution & { thresholdP95Ms: number; passed: boolean };
    coldFast4gInteractive: Distribution & { thresholdP95Ms: number; passed: boolean };
    historyApi: Distribution & { thresholdP95Ms: number; passed: boolean };
    localStatus: Distribution & { thresholdMaxMs: number; passed: boolean };
    confirmationFirstReceipt: Distribution & { thresholdP95Ms: number; passed: boolean };
  };
  cleanup: {
    created: number;
    deletionProven: number;
    pendingPreviews: number;
    passed: true;
  };
  conclusion: "passed" | "failed";
  failures: string[];
}

export interface PrivateProductionEvidenceInput {
  measurementStartedAt: string;
  generatedAt: string;
  commitSha: string;
  deployed: DeployedReleaseBinding;
  node: string;
  browserVersion: string;
  samples: PrivateProductionSamples;
  cleanup: {
    created: number;
    deletionProven: number;
    pendingPreviews: number;
  };
}

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

function requireIsoTimestamp(value: string, label: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(`${label} must be an exact ISO timestamp`);
  }
  return timestamp;
}

function copySamples(samples: PrivateProductionSamples): PrivateProductionSamples {
  return {
    warmIframeInteractiveMs: [...samples.warmIframeInteractiveMs],
    coldFast4gInteractiveMs: [...samples.coldFast4gInteractiveMs],
    historyApiMs: [...samples.historyApiMs],
    localStatusMs: [...samples.localStatusMs],
    confirmationFirstReceiptMs: [...samples.confirmationFirstReceiptMs],
  };
}

export function privateProductionMeasurementSha256(input: {
  source: { commitSha: string } & DeployedReleaseBinding;
  startedAt: string;
  completedAt: string;
  samples: PrivateProductionSamples;
}): string {
  const canonical = {
    source: {
      commitSha: input.source.commitSha,
      releaseBuildHash: input.source.releaseBuildHash,
      serverArtifactSha256: input.source.serverArtifactSha256,
      sourceRelationship: input.source.sourceRelationship,
      sourceBindingSha256: input.source.sourceBindingSha256,
    },
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    samples: copySamples(input.samples),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Validate every opt-in before Playwright starts or an evidence path is opened. */
export function validatePrivateProductionEnvironment(
  environment: Record<string, string | undefined>,
  gitHead: string,
  worktreeRoot: string,
): PrivateProductionEnvironment {
  if (
    environment.LIVE_CLOCKIFY !== "1"
    || environment.LIVE_PERFORMANCE !== "1"
    || environment.LIVE_SACRIFICIAL_WORKSPACE !== "1"
  ) {
    throw new Error("live performance attestation is incomplete");
  }
  const releaseSha = environment.LIVE_RELEASE_SHA?.trim() ?? "";
  if (!SHA_PATTERN.test(releaseSha) || releaseSha !== gitHead.trim()) {
    throw new Error("LIVE_RELEASE_SHA must match the checked-out release SHA");
  }
  const releaseBuildHash = environment.LIVE_RELEASE_BUILD_HASH?.trim() ?? "";
  if (!/^[0-9a-f]{64}$/i.test(releaseBuildHash)) {
    throw new Error("LIVE_RELEASE_BUILD_HASH must be the exact 64-character release build hash");
  }
  const rawUrl = environment.LIVE_COMPONENT_URL?.trim() ?? "";
  const expectedWorkspaceId = environment.LIVE_WORKSPACE_ID?.trim() ?? "";
  if (!expectedWorkspaceId) throw new Error("LIVE_WORKSPACE_ID is required for the sacrificial workspace attestation");
  const rawEvidenceDirectory = environment.PERF_EVIDENCE_DIR?.trim() ?? "";
  if (!rawEvidenceDirectory) throw new Error("PERF_EVIDENCE_DIR is required for aggregate evidence");
  if (!isAbsolute(rawEvidenceDirectory)) throw new Error("PERF_EVIDENCE_DIR must be absolute");
  const evidenceDirectory = resolve(rawEvidenceDirectory);
  const normalizedWorktree = resolve(worktreeRoot);
  if (!isOutsideWorktree(evidenceDirectory, normalizedWorktree)) {
    throw new Error("PERF_EVIDENCE_DIR must be outside the release checkout");
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("LIVE_COMPONENT_URL must be a valid private component URL");
  }
  const validUrl = parsed.protocol === "https:"
    && parsed.username === ""
    && parsed.password === ""
    && parsed.hash === ""
    && parsed.pathname.endsWith("/component/assistant")
    && Boolean(parsed.searchParams.get("auth_token"));
  if (!validUrl) throw new Error("LIVE_COMPONENT_URL must be an authenticated HTTPS component URL");
  return {
    componentUrl: parsed.toString(),
    releaseSha,
    releaseBuildHash,
    evidenceDirectory,
    expectedWorkspaceId,
    worktreeRoot: normalizedWorktree,
  };
}

export function isOutsideWorktree(candidate: string, worktreeRoot: string): boolean {
  const path = relative(resolve(worktreeRoot), resolve(candidate));
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
}

/** Bind aggregate evidence to the process that is actually serving the component. */
export function validateDeployedRelease(
  value: unknown,
  expectedSha: string,
  expectedBuildHash: string,
): DeployedReleaseBinding {
  if (!SHA_PATTERN.test(expectedSha)) {
    throw new Error("expected release SHA is invalid");
  }
  if (!SHA256_PATTERN.test(expectedBuildHash)) {
    throw new Error("expected release build hash is invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("deployed release metadata is invalid");
  }
  const metadata = value as Record<string, unknown>;
  if (metadata.version !== "1.0.0") {
    throw new Error("deployed version is not 1.0.0");
  }
  if (metadata.releaseSha !== expectedSha) {
    throw new Error("deployed release SHA does not match the attested release");
  }
  if (metadata.buildHash !== expectedBuildHash) {
    throw new Error("deployed build metadata is missing or invalid");
  }
  if (
    typeof metadata.serverArtifactSha256 !== "string"
    || !/^[0-9a-f]{64}$/i.test(metadata.serverArtifactSha256)
  ) {
    throw new Error("deployed runtime artifact binding is missing or invalid");
  }
  if (
    metadata.sourceRelationship !== "exact_head"
    && metadata.sourceRelationship !== "evidence_descendant"
    && metadata.sourceRelationship !== "source_bound_builder"
  ) {
    throw new Error("deployed source relationship is not independently bound");
  }
  if (
    metadata.sourceRelationship === "source_bound_builder"
    && (
      typeof metadata.sourceBindingSha256 !== "string"
      || !/^[0-9a-f]{64}$/i.test(metadata.sourceBindingSha256)
    )
  ) {
    throw new Error("deployed source binding is missing or invalid");
  }
  if (
    metadata.sourceRelationship !== "source_bound_builder"
    && metadata.sourceBindingSha256 !== null
  ) {
    throw new Error("deployed source binding is inconsistent");
  }
  return {
    releaseBuildHash: expectedBuildHash,
    serverArtifactSha256: metadata.serverArtifactSha256,
    sourceRelationship: metadata.sourceRelationship,
    sourceBindingSha256: metadata.sourceRelationship === "source_bound_builder"
      ? metadata.sourceBindingSha256 as string
      : null,
  };
}

function requireSamples(values: number[], label: string, expected: number): Distribution {
  if (values.length !== expected) throw new Error(`${label} requires exactly ${expected} samples`);
  return summarize(values);
}

/** Build the only object the runner is allowed to persist. Exact samples are
 * numeric-only so release validation can independently recompute aggregates. */
export function buildPrivateProductionEvidence(
  input: PrivateProductionEvidenceInput,
): PrivateProductionEvidence {
  const deployed = validateDeployedRelease({
    version: "1.0.0",
    releaseSha: input.commitSha,
    buildHash: input.deployed.releaseBuildHash,
    serverArtifactSha256: input.deployed.serverArtifactSha256,
    sourceRelationship: input.deployed.sourceRelationship,
    sourceBindingSha256: input.deployed.sourceBindingSha256,
  }, input.commitSha, input.deployed.releaseBuildHash);
  const measurementStartedAt = requireIsoTimestamp(input.measurementStartedAt, "measurement start");
  const measurementCompletedAt = requireIsoTimestamp(input.generatedAt, "measurement completion");
  if (
    measurementCompletedAt < measurementStartedAt
    || measurementCompletedAt - measurementStartedAt > PRIVATE_PRODUCTION_MAX_MEASUREMENT_WINDOW_MS
  ) {
    throw new Error("measurement time window is invalid");
  }
  const warm = requireSamples(input.samples.warmIframeInteractiveMs, "warm iframe interactivity", PRIVATE_PRODUCTION_SAMPLE_COUNTS.warmIframeInteractive);
  const cold = requireSamples(input.samples.coldFast4gInteractiveMs, "cold fast-4G interactivity", PRIVATE_PRODUCTION_SAMPLE_COUNTS.coldFast4gInteractive);
  const history = requireSamples(input.samples.historyApiMs, "history API", PRIVATE_PRODUCTION_SAMPLE_COUNTS.historyApi);
  const status = requireSamples(input.samples.localStatusMs, "local status", PRIVATE_PRODUCTION_SAMPLE_COUNTS.localStatus);
  const confirmation = requireSamples(input.samples.confirmationFirstReceiptMs, "confirmation first receipt", PRIVATE_PRODUCTION_SAMPLE_COUNTS.confirmationFirstReceipt);

  if (
    input.cleanup.created !== PRIVATE_PRODUCTION_SAMPLE_COUNTS.confirmationFirstReceipt
    || input.cleanup.deletionProven !== input.cleanup.created
    || input.cleanup.pendingPreviews !== 0
  ) {
    throw new Error("cleanup proof is incomplete; evidence must not be emitted");
  }

  const metrics: PrivateProductionEvidence["metrics"] = {
    warmIframeInteractive: {
      ...warm,
      thresholdP95Ms: PRIVATE_PRODUCTION_THRESHOLDS.warmIframeP95Ms,
      passed: warm.p95Ms < PRIVATE_PRODUCTION_THRESHOLDS.warmIframeP95Ms,
    },
    coldFast4gInteractive: {
      ...cold,
      thresholdP95Ms: PRIVATE_PRODUCTION_THRESHOLDS.coldFast4gP95Ms,
      passed: cold.p95Ms < PRIVATE_PRODUCTION_THRESHOLDS.coldFast4gP95Ms,
    },
    historyApi: {
      ...history,
      thresholdP95Ms: PRIVATE_PRODUCTION_THRESHOLDS.historyApiP95Ms,
      passed: history.p95Ms < PRIVATE_PRODUCTION_THRESHOLDS.historyApiP95Ms,
    },
    localStatus: {
      ...status,
      thresholdMaxMs: PRIVATE_PRODUCTION_THRESHOLDS.localStatusMaxMs,
      passed: status.maxMs < PRIVATE_PRODUCTION_THRESHOLDS.localStatusMaxMs,
    },
    confirmationFirstReceipt: {
      ...confirmation,
      thresholdP95Ms: PRIVATE_PRODUCTION_THRESHOLDS.confirmationFirstReceiptP95Ms,
      passed: confirmation.p95Ms < PRIVATE_PRODUCTION_THRESHOLDS.confirmationFirstReceiptP95Ms,
    },
  };
  const failures: string[] = [];
  if (!metrics.warmIframeInteractive.passed) failures.push("warm iframe p95 must be below 1000 ms");
  if (!metrics.coldFast4gInteractive.passed) failures.push("cold fast-4G p95 must be below 2000 ms");
  if (!metrics.historyApi.passed) failures.push("history API p95 must be below 250 ms");
  if (!metrics.localStatus.passed) failures.push("local status maximum must be below 100 ms");
  if (!metrics.confirmationFirstReceipt.passed) failures.push("confirmation first-receipt p95 must be below 8000 ms");

  const source = { commitSha: input.commitSha, ...deployed };
  const measurementSamples = copySamples(input.samples);
  const evidence: PrivateProductionEvidence = {
    schemaVersion: 1,
    kind: "private_production_performance",
    generatedAt: input.generatedAt,
    source,
    measurements: {
      startedAt: input.measurementStartedAt,
      completedAt: input.generatedAt,
      sha256: privateProductionMeasurementSha256({
        source,
        startedAt: input.measurementStartedAt,
        completedAt: input.generatedAt,
        samples: measurementSamples,
      }),
      samples: measurementSamples,
    },
    runtime: {
      node: input.node,
      browser: "Chromium",
      browserVersion: input.browserVersion,
      networkProfile: FAST_4G_PROFILE,
    },
    sampleCounts: PRIVATE_PRODUCTION_SAMPLE_COUNTS,
    thresholds: PRIVATE_PRODUCTION_THRESHOLDS,
    metrics,
    cleanup: { ...input.cleanup, passed: true },
    conclusion: failures.length === 0 ? "passed" : "failed",
    failures,
  };
  assertSecretFreeEvidence(evidence);
  return evidence;
}

const FORBIDDEN_EVIDENCE = /https?:\/\/|auth_token|ai_assistant_session|AIASSIST_PERF_|token|\b(?:url|uri|cookie|nonce|prompt|requestId|previewId|workspaceId|resourceId|responseBody)\b/i;

/** Defense in depth: reject evidence if a future edit adds an operational secret or identifier. */
export function assertSecretFreeEvidence(evidence: PrivateProductionEvidence): void {
  if (FORBIDDEN_EVIDENCE.test(JSON.stringify(evidence))) {
    throw new Error("performance evidence contains a forbidden field or value");
  }
}

function ms(value: number): string {
  return `${value.toFixed(2)} ms`;
}

export function renderPrivateProductionMarkdown(evidence: PrivateProductionEvidence): string {
  assertSecretFreeEvidence(evidence);
  const rows = [
    ["Warm iframe interactive", evidence.metrics.warmIframeInteractive, "< 1000 ms p95"],
    ["Cold fast-4G iframe interactive", evidence.metrics.coldFast4gInteractive, "< 2000 ms p95"],
    ["Same-session history API", evidence.metrics.historyApi, "< 250 ms p95"],
    ["Local understanding status", evidence.metrics.localStatus, "< 100 ms max"],
    ["Confirmation first receipt", evidence.metrics.confirmationFirstReceipt, "< 8000 ms p95"],
  ] as const;
  const markdown = `# Private-production performance gate\n\n`+
    `**${evidence.conclusion.toUpperCase()}** — commit \`${evidence.source.commitSha}\`, ${evidence.generatedAt}.\n\n`+
    `This is aggregate evidence from the private production component in a specifically attested sacrificial workspace. No address, credential, session material, request text, response payload, operation identifier, or synthetic-resource identifier is retained.\n\n`+
    `| Gate | Samples | p50 | p95 | Max | Threshold | Result |\n`+
    `|---|---:|---:|---:|---:|---:|:---:|\n`+
    rows.map(([label, metric, threshold]) =>
      `| ${label} | ${metric.samples} | ${ms(metric.p50Ms)} | ${ms(metric.p95Ms)} | ${ms(metric.maxMs)} | ${threshold} | ${metric.passed ? "PASS" : "FAIL"} |`,
    ).join("\n")+
    `\n\nCleanup proof: ${evidence.cleanup.deletionProven}/${evidence.cleanup.created} synthetic resources durably deleted; ${evidence.cleanup.pendingPreviews} pending previews remain.\n`+
    (evidence.failures.length > 0 ? `\n## Failures\n\n${evidence.failures.map((failure) => `- ${failure}`).join("\n")}\n` : "");
  if (FORBIDDEN_EVIDENCE.test(markdown)) throw new Error("performance Markdown contains a forbidden field or value");
  return markdown;
}
