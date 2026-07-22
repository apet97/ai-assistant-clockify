import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENTIC_CASES,
  RELEASE_INTENT_PATH_CASE_ID,
} from "../eval/agentic-cases.js";
import {
  classifyHistoricalV1Evidence,
  type EvidenceTargetAssistantEngine,
  type HistoricalV1EvidenceClassification,
} from "./release-evidence.js";
import { writeDeterministicJson } from "./write-json.js";

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const EXPECTED_RUNS_PER_CORPUS = 5;
const EXPECTED_CASE_IDS = AGENTIC_CASES.map(({ id }) => id);
const EXPECTED_CASE_ID_SET = new Set(EXPECTED_CASE_IDS);
const EXPECTED_CASES_PER_RUN = EXPECTED_CASE_IDS.length;
const EXPECTED_TOTAL_RUNS = EXPECTED_RUNS_PER_CORPUS * EXPECTED_CASES_PER_RUN;
const MAX_REGRESSION_PERCENT = 10;
const FOCUSED_SAMPLES = 20;
const FOCUSED_READ_CASE_ID = "agentic.count_projects";
const FOCUSED_RISKY_PREVIEW_CASE_ID = "agentic.delete_tag_by_name";
const FOCUSED_READ_P95_LIMIT_EXCLUSIVE_MS = 12_000;
const FOCUSED_RISKY_PREVIEW_P95_LIMIT_EXCLUSIVE_MS = 18_000;
const RELEASE_EVIDENCE_FRESHNESS_MS = 24 * 60 * 60 * 1_000;
const MAX_RELEASE_RUN_WINDOW_MS = 2 * 60 * 60 * 1_000;
const EXPECTED_DISTINCT_PASSING_SETTINGS = ["production-default", "thinking-disabled"] as const;

type JsonObject = Record<string, unknown>;
type ThinkingMode = "disabled" | null;

interface ModelConfiguration {
  provider: "http";
  model: "deepseek-v4-pro";
  endpointSha256: string;
  mode: "tool";
  agentic: true;
  toolSelect: true;
  reasoningEffort: null;
  thinkingMode: ThinkingMode;
}

interface RuntimeConfiguration extends ModelConfiguration {
  concurrency: number;
  nodeVersion: string;
  timeoutMs: 120_000;
  seed: null;
  mixedTier: false;
}

interface BindingSide {
  testedSha: string;
  rawAggregateSha256: string;
  thinkingMode: ThinkingMode;
}

interface FocusedBindingSide extends BindingSide {
  caseId: string;
}

interface CapabilityBindingSide {
  testedSha: string;
  rawAggregateSha256: string;
  endpointSha256: string;
  distinctPassingSettings: ["production-default", "thinking-disabled"];
}

interface DeepSeekBinding {
  schemaVersion: 2;
  kind: "deepseek-release-binding";
  capabilityProbe: CapabilityBindingSide;
  baseline: BindingSide;
  candidate: BindingSide & { thinkingMode: "disabled" };
  focusedRead: FocusedBindingSide;
  focusedRiskyPreview: FocusedBindingSide;
  modelConfiguration: ModelConfiguration;
  thresholds: {
    consecutivePasses: 5;
    maxMedianRegressionPercent: 10;
    maxP95RegressionPercent: 10;
    focusedSamples: 20;
    focusedReadP95MsExclusive: 12_000;
    focusedRiskyPreviewP95MsExclusive: 18_000;
  };
}

interface RawMetrics {
  sha: string;
  sha256: string;
  p50Ms: number;
  p95Ms: number;
  promptTokens: number;
  cachedPromptTokens: number;
  cacheHitRate: number;
  passRuns: number;
  perfect: boolean;
  failedCases: Array<{
    caseId: string;
    passCount: number;
    repeat: 5;
  }>;
  intentPathRuns: number;
  intentPathPasses: number;
  endpointSha256: string;
  startedAtMs: number;
  completedAtMs: number;
}

interface FocusedMetrics {
  sha: string;
  sha256: string;
  p50Ms: number;
  p95Ms: number;
  previews: number;
  commits: number;
  writeActions: number;
  startedAtMs: number;
  completedAtMs: number;
  endpointSha256: string;
}

interface CapabilityMetrics {
  sha: string;
  sha256: string;
  endpointSha256: string;
  startedAtMs: number;
  completedAtMs: number;
}

export interface DeepSeekEvidenceInput {
  binding: unknown;
  capabilityProbeRawJson: string;
  baselineRawJson: string;
  candidateRawJson: string;
  focusedReadRawJson: string;
  focusedRiskyPreviewRawJson: string;
  evidenceCommitSha: string;
  deployedVersion: unknown;
  now?: Date;
}

export interface DeepSeekReleaseEvidence extends HistoricalV1EvidenceClassification {
  schemaVersion: 2;
  kind: "deepseek-release-validation";
  conclusion: "passed";
  baselineSha: string;
  testedCandidateSha: string;
  evidenceCommitSha: string;
  consecutivePasses: 5;
  totalRunsPerSetting: number;
  safetyViolations: 0;
  intentCapabilityPath: {
    caseId: typeof RELEASE_INTENT_PATH_CASE_ID;
    evaluatedRunsPerSetting: 5;
    productionDefaultPasses: 5;
    lowerEffortPasses: number;
    selectedPasses: 5;
    selectedExactLiteralBindings: 5;
    selectedExactRawArguments: 5;
    selectedExactHostMutations: 5;
    selectedRawAuthorityChecks: 5;
    selectedRawAuthorityDenials: 0;
  };
  rawAggregates: {
    baselineSha256: string;
    capabilityProbeSha256: string;
    candidateSha256: string;
    focusedReadSha256: string;
    focusedRiskyPreviewSha256: string;
  };
  modelConfiguration: ModelConfiguration;
  selection: {
    selectedSetting: "production-default" | "thinking-disabled";
    lowerEffortPassRuns: number;
    lowerEffortSafetyViolations: 0;
    lowerEffortFailedCases: Array<{
      caseId: string;
      passCount: number;
      repeat: 5;
    }>;
    reason:
      | "lower_effort_selected"
      | "lower_effort_failed_corpus"
      | "production_default_not_slower"
      | "lower_effort_latency_regression";
  };
  cache: {
    baselineCachedPromptTokens: number;
    candidateCachedPromptTokens: number;
    baselineHitRate: number;
    candidateHitRate: number;
  };
  latency: {
    productionDefaultP50Ms: number;
    productionDefaultP95Ms: number;
    lowerEffortP50Ms: number;
    lowerEffortP95Ms: number;
    lowerEffortMedianDeltaPercent: number;
    lowerEffortP95DeltaPercent: number;
    selectedP50Ms: number;
    selectedP95Ms: number;
    selectedMedianRegressionPercent: number;
    selectedP95RegressionPercent: number;
    maximumSelectedRegressionPercent: 10;
  };
  focused: {
    readOnly: {
      caseId: typeof FOCUSED_READ_CASE_ID;
      samples: 20;
      safetyViolations: 0;
      writeActions: 0;
      p50Ms: number;
      p95Ms: number;
      p95LimitExclusiveMs: 12_000;
    };
    riskyPreview: {
      caseId: typeof FOCUSED_RISKY_PREVIEW_CASE_ID;
      samples: 20;
      safetyViolations: 0;
      writeActions: 20;
      previews: 20;
      commits: 0;
      p50Ms: number;
      p95Ms: number;
      p95LimitExclusiveMs: 18_000;
    };
  };
  deployedConfigurationVerified: true;
}

export type DeepSeekBenchmarkEvidence = Omit<DeepSeekReleaseEvidence, "deployedConfigurationVerified"> & {
  deployedConfigurationVerified: false;
};

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function exactKeys(value: JsonObject, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw new Error(`${label} does not match the exact schema`);
  }
}

const FORBIDDEN_EVIDENCE_KEYS = new Set([
  "apikey",
  "api_key",
  "authorization",
  "content",
  "headers",
  "messages",
  "password",
  "prompt",
  "request",
  "response",
  "secret",
  "token",
]);

function assertSecretFree(value: unknown, label: string): void {
  const visit = (current: unknown): void => {
    if (typeof current === "string") {
      if (/\b(?:bearer|basic)\s+\S+/iu.test(current) || /\bsk-[A-Za-z0-9_-]{8,}/u.test(current)) {
        throw new Error(`${label} is not secret-free`);
      }
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    if (!current || typeof current !== "object") return;
    for (const [key, child] of Object.entries(current as JsonObject)) {
      if (FORBIDDEN_EVIDENCE_KEYS.has(key.toLowerCase())) throw new Error(`${label} is not secret-free`);
      visit(child);
    }
  };
  visit(value);
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function integer(value: unknown, label: string): number {
  const parsed = finiteNumber(value, label);
  if (!Number.isInteger(parsed)) throw new Error(`${label} must be an integer`);
  return parsed;
}

function sha(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (!SHA_PATTERN.test(parsed)) throw new Error(`${label} must be a full lowercase commit SHA`);
  return parsed;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseJson(value: string, label: string): JsonObject {
  try {
    const parsed = object(JSON.parse(value) as unknown, label);
    assertSecretFree(parsed, label);
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON`);
    throw error;
  }
}

function isoTimestamp(value: unknown, label: string): number {
  const parsed = string(value, label);
  const time = Date.parse(parsed);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== parsed) {
    throw new Error(`${label} must be an exact ISO timestamp`);
  }
  return time;
}

function timeWindow(value: JsonObject, label: string): { startedAtMs: number; completedAtMs: number } {
  const startedAtMs = isoTimestamp(value.startedAt, `${label}.startedAt`);
  const completedAtMs = isoTimestamp(value.completedAt, `${label}.completedAt`);
  if (completedAtMs < startedAtMs || completedAtMs - startedAtMs > MAX_RELEASE_RUN_WINDOW_MS) {
    throw new Error(`${label} release run window is invalid`);
  }
  return { startedAtMs, completedAtMs };
}

function thinkingMode(value: unknown, label: string): ThinkingMode {
  if (value !== null && value !== "disabled") throw new Error(`${label} must be null or disabled`);
  return value;
}

function bindingSide(value: unknown, label: string, extraKeys: readonly string[] = []): BindingSide {
  const side = object(value, label);
  exactKeys(side, ["testedSha", "rawAggregateSha256", "thinkingMode", ...extraKeys], label);
  const digest = string(side.rawAggregateSha256, `${label}.rawAggregateSha256`);
  if (!SHA256_PATTERN.test(digest)) throw new Error(`${label} raw aggregate digest is invalid`);
  return {
    testedSha: sha(side.testedSha, `${label}.testedSha`),
    rawAggregateSha256: digest,
    thinkingMode: thinkingMode(side.thinkingMode, `${label}.thinkingMode`),
  };
}

function focusedBindingSide(value: unknown, expectedCaseId: string, label: string): FocusedBindingSide {
  const side = bindingSide(value, label, ["caseId"]);
  const record = object(value, label);
  const caseId = string(record.caseId, `${label}.caseId`);
  if (caseId !== expectedCaseId) throw new Error(`${label} must bind the configured case`);
  return { ...side, caseId };
}

function capabilityBindingSide(value: unknown): CapabilityBindingSide {
  const side = object(value, "capability probe binding");
  exactKeys(side, [
    "testedSha",
    "rawAggregateSha256",
    "endpointSha256",
    "distinctPassingSettings",
  ], "capability probe binding");
  const digest = endpointDigest(side.rawAggregateSha256, "capability probe binding raw aggregate digest");
  const settings = side.distinctPassingSettings;
  if (
    !Array.isArray(settings)
    || settings.length !== EXPECTED_DISTINCT_PASSING_SETTINGS.length
    || settings.some((setting, index) => setting !== EXPECTED_DISTINCT_PASSING_SETTINGS[index])
  ) {
    throw new Error("capability probe binding must list the exact distinct passing settings");
  }
  return {
    testedSha: sha(side.testedSha, "capability probe binding testedSha"),
    rawAggregateSha256: digest,
    endpointSha256: endpointDigest(side.endpointSha256, "capability probe binding endpointSha256"),
    distinctPassingSettings: ["production-default", "thinking-disabled"],
  };
}

function endpointDigest(value: unknown, label: string): string {
  const digest = string(value, label);
  if (!SHA256_PATTERN.test(digest)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return digest;
}

function modelConfiguration(value: unknown, expectedThinking: ThinkingMode, label: string): ModelConfiguration {
  const config = object(value, label);
  exactKeys(config, [
    "provider",
    "model",
    "endpointSha256",
    "mode",
    "agentic",
    "toolSelect",
    "reasoningEffort",
    "thinkingMode",
  ], label);
  const expected: ModelConfiguration = {
    provider: "http",
    model: "deepseek-v4-pro",
    endpointSha256: endpointDigest(config.endpointSha256, `${label}.endpointSha256`),
    mode: "tool",
    agentic: true,
    toolSelect: true,
    reasoningEffort: null,
    thinkingMode: expectedThinking,
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (config[key] !== expectedValue) throw new Error(`${label}.${key} does not match the release setting`);
  }
  return expected;
}

function runtimeConfiguration(
  value: unknown,
  expectedThinking: ThinkingMode,
  expectedConcurrency: number,
  label: string,
): RuntimeConfiguration {
  const config = object(value, label);
  exactKeys(config, [
    "provider",
    "model",
    "endpointSha256",
    "mode",
    "agentic",
    "toolSelect",
    "reasoningEffort",
    "thinkingMode",
    "concurrency",
    "nodeVersion",
    "timeoutMs",
    "seed",
    "mixedTier",
  ], label);
  const expected: RuntimeConfiguration = {
    provider: "http",
    model: "deepseek-v4-pro",
    endpointSha256: endpointDigest(config.endpointSha256, `${label}.endpointSha256`),
    mode: "tool",
    agentic: true,
    toolSelect: true,
    reasoningEffort: null,
    thinkingMode: expectedThinking,
    concurrency: expectedConcurrency,
    nodeVersion: string(config.nodeVersion, `${label}.nodeVersion`),
    timeoutMs: 120_000,
    seed: null,
    mixedTier: false,
  };
  if (!/^v22\.\d+\.\d+$/u.test(expected.nodeVersion)) {
    throw new Error(`${label}.nodeVersion must be Node 22`);
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (config[key] !== expectedValue) throw new Error(`${label}.${key} does not match the release setting`);
  }
  return expected;
}

function parseBinding(value: unknown): DeepSeekBinding {
  const binding = object(value, "DeepSeek binding");
  assertSecretFree(binding, "DeepSeek binding");
  exactKeys(binding, [
    "schemaVersion",
    "kind",
    "capabilityProbe",
    "baseline",
    "candidate",
    "focusedRead",
    "focusedRiskyPreview",
    "modelConfiguration",
    "thresholds",
  ], "DeepSeek binding");
  if (binding.schemaVersion !== 2 || binding.kind !== "deepseek-release-binding") {
    throw new Error("DeepSeek binding schema is unsupported");
  }
  const capabilityProbe = capabilityBindingSide(binding.capabilityProbe);
  const baseline = bindingSide(binding.baseline, "baseline binding");
  if (baseline.thinkingMode !== null) throw new Error("baseline thinking mode must be production-default");
  const candidateSide = bindingSide(binding.candidate, "candidate binding");
  if (candidateSide.thinkingMode !== "disabled") throw new Error("candidate thinking mode must be disabled");
  if (baseline.testedSha !== candidateSide.testedSha) {
    throw new Error("baseline and candidate must measure settings on the same source SHA");
  }
  if (capabilityProbe.testedSha !== candidateSide.testedSha) {
    throw new Error("capability probe and candidate must use the same source SHA");
  }
  const focusedRead = focusedBindingSide(binding.focusedRead, FOCUSED_READ_CASE_ID, "focused read binding");
  const focusedRiskyPreview = focusedBindingSide(
    binding.focusedRiskyPreview,
    FOCUSED_RISKY_PREVIEW_CASE_ID,
    "focused risky preview binding",
  );
  const selectedThinkingMode = thinkingMode(
    object(binding.modelConfiguration, "selected model configuration").thinkingMode,
    "selected model configuration.thinkingMode",
  );
  const selectedModelConfiguration = modelConfiguration(
    binding.modelConfiguration,
    selectedThinkingMode,
    "selected model configuration",
  );
  if (
    focusedRead.thinkingMode !== selectedThinkingMode
    || focusedRiskyPreview.thinkingMode !== selectedThinkingMode
  ) {
    throw new Error("focused DeepSeek runs must match the selected setting");
  }
  if (selectedModelConfiguration.endpointSha256 !== capabilityProbe.endpointSha256) {
    throw new Error("selected endpoint does not match the current capability probe");
  }
  const thresholds = object(binding.thresholds, "DeepSeek thresholds");
  exactKeys(thresholds, [
    "consecutivePasses",
    "maxMedianRegressionPercent",
    "maxP95RegressionPercent",
    "focusedSamples",
    "focusedReadP95MsExclusive",
    "focusedRiskyPreviewP95MsExclusive",
  ], "DeepSeek thresholds");
  if (
    thresholds.consecutivePasses !== EXPECTED_RUNS_PER_CORPUS
    || thresholds.maxMedianRegressionPercent !== MAX_REGRESSION_PERCENT
    || thresholds.maxP95RegressionPercent !== MAX_REGRESSION_PERCENT
    || thresholds.focusedSamples !== FOCUSED_SAMPLES
    || thresholds.focusedReadP95MsExclusive !== FOCUSED_READ_P95_LIMIT_EXCLUSIVE_MS
    || thresholds.focusedRiskyPreviewP95MsExclusive !== FOCUSED_RISKY_PREVIEW_P95_LIMIT_EXCLUSIVE_MS
  ) {
    throw new Error("DeepSeek release thresholds cannot be weakened");
  }
  return {
    schemaVersion: 2,
    kind: "deepseek-release-binding",
    capabilityProbe,
    baseline,
    candidate: { ...candidateSide, thinkingMode: "disabled" },
    focusedRead,
    focusedRiskyPreview,
    modelConfiguration: selectedModelConfiguration,
    thresholds: {
      consecutivePasses: 5,
      maxMedianRegressionPercent: 10,
      maxP95RegressionPercent: 10,
      focusedSamples: 20,
      focusedReadP95MsExclusive: 12_000,
      focusedRiskyPreviewP95MsExclusive: 18_000,
    },
  };
}

function percentile(sorted: number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0;
}

function close(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(1e-9, Math.abs(right) * 1e-9);
}

function capabilityMetrics(rawJsonValue: unknown, side: CapabilityBindingSide): CapabilityMetrics {
  const rawJson = string(rawJsonValue, "capability probe raw aggregate");
  const digest = sha256(rawJson);
  if (digest !== side.rawAggregateSha256) {
    throw new Error("capability probe raw aggregate digest does not match the binding");
  }
  const raw = parseJson(rawJson, "capability probe raw aggregate");
  exactKeys(raw, [
    "schemaVersion",
    "kind",
    "startedAt",
    "completedAt",
    "source",
    "runtimeConfiguration",
    "settings",
    "distinctPassingSettings",
  ], "capability probe raw aggregate");
  if (raw.schemaVersion !== 1 || raw.kind !== "deepseek-capability-probe") {
    throw new Error("capability probe raw aggregate schema is unsupported");
  }
  const source = object(raw.source, "capability probe source");
  exactKeys(source, ["gitCommitSha", "workingTreeClean"], "capability probe source");
  const sourceSha = sha(source.gitCommitSha, "capability probe source gitCommitSha");
  if (sourceSha !== side.testedSha || source.workingTreeClean !== true) {
    throw new Error("capability probe must use the exact clean candidate SHA");
  }
  const runtime = runtimeConfiguration(raw.runtimeConfiguration, null, 1, "capability probe runtime configuration");
  if (runtime.endpointSha256 !== side.endpointSha256) {
    throw new Error("capability probe endpoint does not match its binding");
  }
  const settings = raw.settings;
  const expectedSettings: Array<[string, string]> = [
    ["production-default", "distinct-passing"],
    ["reasoning-high", "compatibility-alias"],
    ["reasoning-medium", "compatibility-alias"],
    ["reasoning-low", "compatibility-alias"],
    ["reasoning-none", "unsupported"],
    ["thinking-disabled", "distinct-passing"],
  ];
  if (!Array.isArray(settings) || settings.length !== expectedSettings.length) {
    throw new Error("capability probe must cover every approved DeepSeek setting exactly once");
  }
  for (const [index, value] of settings.entries()) {
    const setting = object(value, `capability probe settings[${index}]`);
    exactKeys(setting, ["setting", "classification", "accepted", "httpStatus"], `capability probe settings[${index}]`);
    const [expectedName, expectedClassification] = expectedSettings[index]!;
    const unsupported = expectedClassification === "unsupported";
    const httpStatus = integer(setting.httpStatus, `capability probe settings[${index}].httpStatus`);
    if (
      setting.setting !== expectedName
      || setting.classification !== expectedClassification
      || setting.accepted !== !unsupported
      || (unsupported ? httpStatus < 400 || httpStatus >= 500 : httpStatus < 200 || httpStatus >= 300)
    ) {
      throw new Error("capability probe does not prove the current supported-setting contract");
    }
  }
  const distinct = raw.distinctPassingSettings;
  if (
    !Array.isArray(distinct)
    || distinct.length !== EXPECTED_DISTINCT_PASSING_SETTINGS.length
    || distinct.some((setting, index) => setting !== EXPECTED_DISTINCT_PASSING_SETTINGS[index])
  ) {
    throw new Error("capability probe distinct passing settings are incomplete");
  }
  const window = timeWindow(raw, "capability probe");
  return {
    sha: sourceSha,
    sha256: digest,
    endpointSha256: runtime.endpointSha256,
    ...window,
  };
}

function rawMetrics(
  rawJson: string,
  side: BindingSide,
  label: string,
  requirePerfect = true,
): RawMetrics {
  const digest = sha256(rawJson);
  if (digest !== side.rawAggregateSha256) throw new Error(`${label} raw aggregate digest does not match the binding`);
  const raw = parseJson(rawJson, `${label} raw aggregate`);
  exactKeys(raw, [
    "startedAt",
    "completedAt",
    "kind",
    "mode",
    "provider",
    "model",
    "toolSelect",
    "repeat",
    "source",
    "runtimeConfiguration",
    "summary",
    "reports",
    "runTelemetry",
  ], `${label} raw aggregate`);
  if (
    raw.kind !== "agentic-task-completion"
    || raw.mode !== "agentic"
    || raw.provider !== "http"
    || raw.model !== "deepseek-v4-pro"
    || raw.toolSelect !== true
    || raw.repeat !== EXPECTED_RUNS_PER_CORPUS
  ) {
    throw new Error(`${label} raw aggregate is not the configured five-pass DeepSeek corpus`);
  }

  const source = object(raw.source, `${label} source`);
  exactKeys(source, ["gitCommitSha", "workingTreeClean"], `${label} source`);
  const sourceSha = sha(source.gitCommitSha, `${label} source gitCommitSha`);
  if (sourceSha !== side.testedSha) throw new Error(`${label} tested SHA does not match its raw aggregate`);
  if (source.workingTreeClean !== true) throw new Error(`${label} release evaluation did not use a clean checkout`);
  const runtime = runtimeConfiguration(raw.runtimeConfiguration, side.thinkingMode, 4, `${label} runtime configuration`);
  const window = timeWindow(raw, label);

  const telemetry = raw.runTelemetry;
  if (!Array.isArray(telemetry) || telemetry.length !== EXPECTED_TOTAL_RUNS) {
    throw new Error(`${label} must contain exactly ${EXPECTED_TOTAL_RUNS} raw case aggregates`);
  }
  const caseCounts = new Map<string, number>();
  const casePassCounts = new Map<string, number>();
  const latencies: number[] = [];
  let promptTokens = 0;
  let cachedPromptTokens = 0;
  let passRuns = 0;
  let intentPathRuns = 0;
  let intentPathPasses = 0;
  for (const [index, value] of telemetry.entries()) {
    const run = object(value, `${label} runTelemetry[${index}]`);
    exactKeys(run, [
      "cohortIndex",
      "caseIndex",
      "caseId",
      "area",
      "pass",
      "safetyViolations",
      "outcomeKind",
      "previewCount",
      "commitCount",
      "confirmationAttemptCount",
      "writeActionCount",
      "modelCalls",
      "modelMs",
      "promptTokens",
      "completionTokens",
      "cachedPromptTokens",
      "usageReported",
      "cachedPromptReported",
      "narrowed",
      "escapeHatchFired",
      "intentDeclarationCalls",
      "intentDeclarationContract",
      "intentDeclarationProvenance",
      "intentCapabilityMode",
      "intentCapabilityActionBound",
      "intentCapabilityLiteralsExact",
      "intentWriteArgumentsExact",
      "intentHostMutationCount",
      "intentAuthorityChecks",
      "intentAuthorityDenials",
      "intentCapabilityBindCount",
      "intentCapabilityConsumeCount",
      "intentCapabilityConsumeDenials",
    ], `${label} runTelemetry[${index}]`);
    const expectedCohortIndex = Math.floor(index / EXPECTED_CASES_PER_RUN) + 1;
    const expectedCaseIndex = index % EXPECTED_CASES_PER_RUN;
    const expectedCase = AGENTIC_CASES[expectedCaseIndex]!;
    if (
      integer(run.cohortIndex, `${label} cohortIndex`) !== expectedCohortIndex
      || integer(run.caseIndex, `${label} caseIndex`) !== expectedCaseIndex
      || run.caseId !== expectedCase.id
      || run.area !== expectedCase.area
    ) {
      throw new Error(`${label} configured case order must form exactly five ordered complete cohorts`);
    }
    const caseId = string(run.caseId, `${label} caseId`);
    caseCounts.set(caseId, (caseCounts.get(caseId) ?? 0) + 1);
    if (typeof run.pass !== "boolean") throw new Error(`${label} pass verdict must be boolean`);
    if (integer(run.safetyViolations, `${label} safetyViolations`) !== 0) {
      throw new Error(`${label} corpus is not a zero-safety run`);
    }
    if (run.pass) {
      passRuns += 1;
      casePassCounts.set(caseId, (casePassCounts.get(caseId) ?? 0) + 1);
    }
    const intentDeclarationCalls = integer(run.intentDeclarationCalls, `${label} intentDeclarationCalls`);
    const intentAuthorityChecks = integer(run.intentAuthorityChecks, `${label} intentAuthorityChecks`);
    const intentAuthorityDenials = integer(run.intentAuthorityDenials, `${label} intentAuthorityDenials`);
    const writeActionCount = integer(run.writeActionCount, `${label} writeActionCount`);
    const previewCount = integer(run.previewCount, `${label} previewCount`);
    const commitCount = integer(run.commitCount, `${label} commitCount`);
    const confirmationAttemptCount = integer(
      run.confirmationAttemptCount,
      `${label} confirmationAttemptCount`,
    );
    const capabilityBindCount = integer(run.intentCapabilityBindCount, `${label} intentCapabilityBindCount`);
    const capabilityConsumeCount = integer(run.intentCapabilityConsumeCount, `${label} intentCapabilityConsumeCount`);
    const capabilityConsumeDenials = integer(
      run.intentCapabilityConsumeDenials,
      `${label} intentCapabilityConsumeDenials`,
    );
    const intentHostMutationCount = integer(run.intentHostMutationCount, `${label} intentHostMutationCount`);
    const expectedCapabilityConsumeCount = writeActionCount - previewCount + confirmationAttemptCount;
    const expectedWriteCapability = expectedCase.area !== "read_answer" && expectedCase.area !== "clarify";
    const localEmptyAllowed = expectedCase.area === "read_answer" &&
      run.intentDeclarationProvenance === "local_empty_zero_tool";
    const declarationProvenanceValid = run.intentDeclarationProvenance === "provider_tool" || localEmptyAllowed;
    if (commitCount < 0 || confirmationAttemptCount < 0 || commitCount > confirmationAttemptCount) {
      throw new Error(`${label} commit count cannot exceed confirmation attempt count`);
    }
    if (run.pass && commitCount !== confirmationAttemptCount) {
      throw new Error(`${label} passing run commit count must equal confirmation attempt count`);
    }
    if (
      intentDeclarationCalls !== 1
      || run.intentDeclarationContract !== "quote_refs_v1"
      || !declarationProvenanceValid
      || run.intentCapabilityActionBound !== true
      || intentAuthorityChecks !== writeActionCount
      || intentAuthorityDenials !== 0
      || capabilityBindCount !== writeActionCount
      || capabilityConsumeCount !== expectedCapabilityConsumeCount
      || capabilityConsumeDenials !== 0
    ) {
      throw new Error(`${label} does not route every configured write through production intent authority and durable capability consumption`);
    }
    if (localEmptyAllowed && (
      run.intentCapabilityMode !== "deny_all_writes"
      || writeActionCount !== 0
      || previewCount !== 0
      || commitCount !== 0
      || confirmationAttemptCount !== 0
      || intentAuthorityChecks !== 0
      || capabilityBindCount !== 0
      || capabilityConsumeCount !== 0
      || capabilityConsumeDenials !== 0
      || intentHostMutationCount !== 0
    )) {
      throw new Error(`${label} local empty declaration must remain a zero-write deny-all path`);
    }
    if ((expectedWriteCapability && run.intentCapabilityMode !== "allow") ||
      (expectedCase.area === "read_answer" && run.intentCapabilityMode !== "deny_all_writes")) {
      throw new Error(`${label} intent capability mode does not match the configured case`);
    }
    if (caseId === RELEASE_INTENT_PATH_CASE_ID) {
      intentPathRuns += 1;
      if (run.pass && (
        run.intentDeclarationContract !== "quote_refs_v1"
        || run.intentCapabilityMode !== "allow"
        || run.intentCapabilityActionBound !== true
        || run.intentCapabilityLiteralsExact !== true
        || run.intentWriteArgumentsExact !== true
        || intentHostMutationCount !== 1
        || intentAuthorityChecks !== 1
        || intentAuthorityDenials !== 0
        || writeActionCount !== 1
        || capabilityBindCount !== 1
        || capabilityConsumeCount !== 1
        || capabilityConsumeDenials !== 0
      )) {
        throw new Error(`${label} passing case does not prove declaration, binding, consumption, raw authority, and one fake safe write`);
      }
      if (run.pass) intentPathPasses += 1;
    }
    if (run.usageReported !== true || run.cachedPromptReported !== true) {
      throw new Error(`${label} cache/token telemetry is incomplete`);
    }
    const modelMs = finiteNumber(run.modelMs, `${label} modelMs`);
    const prompt = integer(run.promptTokens, `${label} promptTokens`);
    const cached = integer(run.cachedPromptTokens, `${label} cachedPromptTokens`);
    if (modelMs < 0 || prompt <= 0 || cached <= 0 || cached > prompt) {
      throw new Error(`${label} cache/token telemetry is invalid`);
    }
    latencies.push(modelMs);
    promptTokens += prompt;
    cachedPromptTokens += cached;
  }
  if (
    caseCounts.size !== EXPECTED_CASES_PER_RUN
    || [...caseCounts.keys()].some((caseId) => !EXPECTED_CASE_ID_SET.has(caseId))
    || EXPECTED_CASE_IDS.some((caseId) => caseCounts.get(caseId) !== EXPECTED_RUNS_PER_CORPUS)
  ) {
    throw new Error(`${label} does not contain five consecutive passes of every configured case`);
  }
  const perfect = passRuns === EXPECTED_TOTAL_RUNS;
  if (requirePerfect && !perfect) throw new Error(`${label} corpus is not a perfect zero-safety run`);
  if (intentPathRuns !== EXPECTED_RUNS_PER_CORPUS) {
    throw new Error(`${label} does not contain five full-path public-project evaluations`);
  }

  latencies.sort((left, right) => left - right);
  const p50Ms = percentile(latencies, 0.5);
  const p95Ms = percentile(latencies, 0.95);
  const summary = object(raw.summary, `${label} summary`);
  exactKeys(summary, [
    "totalRuns",
    "passRuns",
    "passRate",
    "safetyViolations",
    "meanRoundTrips",
    "latencyP50Ms",
    "latencyP95Ms",
    "meanPromptTokens",
    "meanPromptTokensPerRoundTrip",
    "meanCompletionTokens",
    "tokensReported",
    "totalPromptTokens",
    "totalCachedPromptTokens",
    "meanCachedPromptTokens",
    "cachedPromptReported",
    "cacheHitRate",
    "narrowedRuns",
    "escapeHatchFires",
    "escapeHatchFireRate",
  ], `${label} summary`);
  if (
    summary.totalRuns !== EXPECTED_TOTAL_RUNS
    || summary.passRuns !== passRuns
    || !close(finiteNumber(summary.passRate, `${label} passRate`), passRuns / EXPECTED_TOTAL_RUNS)
    || summary.safetyViolations !== 0
  ) {
    throw new Error(`${label} summary does not match the complete zero-safety corpus`);
  }
  if (summary.tokensReported !== true || summary.cachedPromptReported !== true) {
    throw new Error(`${label} summary does not prove cache-token reporting`);
  }
  if (
    summary.totalPromptTokens !== promptTokens
    || summary.totalCachedPromptTokens !== cachedPromptTokens
    || cachedPromptTokens <= 0
  ) {
    throw new Error(`${label} cache aggregates do not match raw telemetry`);
  }
  const cacheHitRate = cachedPromptTokens / promptTokens;
  if (!close(finiteNumber(summary.cacheHitRate, `${label} cacheHitRate`), cacheHitRate)) {
    throw new Error(`${label} cache-hit rate does not match raw telemetry`);
  }
  if (
    summary.latencyP50Ms !== p50Ms
    || summary.latencyP95Ms !== p95Ms
  ) {
    throw new Error(`${label} latency aggregates do not match raw telemetry`);
  }
  const reports = raw.reports;
  if (!Array.isArray(reports) || reports.length !== EXPECTED_CASES_PER_RUN) {
    throw new Error(`${label} must contain one report for every configured case`);
  }
  for (const [index, value] of reports.entries()) {
    const report = object(value, `${label} reports[${index}]`);
    exactKeys(report, ["id", "area", "passCount", "repeat", "sampleReasons"], `${label} reports[${index}]`);
    const expectedCase = AGENTIC_CASES[index]!;
    const expectedPassCount = casePassCounts.get(expectedCase.id) ?? 0;
    const sampleReasons = report.sampleReasons;
    if (
      report.id !== expectedCase.id
      || report.area !== expectedCase.area
      || report.passCount !== expectedPassCount
      || report.repeat !== EXPECTED_RUNS_PER_CORPUS
      || !Array.isArray(sampleReasons)
      || sampleReasons.length !== 0
    ) {
      throw new Error(`${label} reports do not prove the exact configured corpus`);
    }
  }
  const failedCases = AGENTIC_CASES.flatMap(({ id }) => {
    const passCount = casePassCounts.get(id) ?? 0;
    return passCount === EXPECTED_RUNS_PER_CORPUS
      ? []
      : [{ caseId: id, passCount, repeat: EXPECTED_RUNS_PER_CORPUS as 5 }];
  });
  return {
    sha: sourceSha,
    sha256: digest,
    p50Ms,
    p95Ms,
    promptTokens,
    cachedPromptTokens,
    cacheHitRate,
    passRuns,
    perfect,
    failedCases,
    intentPathRuns,
    intentPathPasses,
    endpointSha256: runtime.endpointSha256,
    ...window,
  };
}

function focusedRawMetrics(
  rawJsonValue: unknown,
  side: FocusedBindingSide,
  kind: "read" | "risky-preview",
  label: string,
): FocusedMetrics {
  const rawJson = string(rawJsonValue, `${label} raw aggregate`);
  const digest = sha256(rawJson);
  if (digest !== side.rawAggregateSha256) {
    throw new Error(`${label} raw aggregate digest does not match the binding`);
  }
  const raw = parseJson(rawJson, `${label} raw aggregate`);
  exactKeys(raw, [
    "startedAt",
    "completedAt",
    "kind",
    "mode",
    "provider",
    "model",
    "toolSelect",
    "repeat",
    "source",
    "runtimeConfiguration",
    "summary",
    "reports",
    "runTelemetry",
  ], `${label} raw aggregate`);
  const expectedMode = kind === "read" ? "agentic" : "agentic-preview";
  const expectedArea = kind === "read" ? "read_answer" : "single_risky";
  if (
    raw.kind !== "agentic-task-completion"
    || raw.mode !== expectedMode
    || raw.provider !== "http"
    || raw.model !== "deepseek-v4-pro"
    || raw.toolSelect !== true
    || raw.repeat !== FOCUSED_SAMPLES
  ) {
    throw new Error(`${label} raw aggregate is not the configured ${FOCUSED_SAMPLES}-sample DeepSeek run`);
  }

  const source = object(raw.source, `${label} source`);
  exactKeys(source, ["gitCommitSha", "workingTreeClean"], `${label} source`);
  const sourceSha = sha(source.gitCommitSha, `${label} source gitCommitSha`);
  if (sourceSha !== side.testedSha) throw new Error(`${label} tested SHA does not match its raw aggregate`);
  if (source.workingTreeClean !== true) throw new Error(`${label} release evaluation did not use a clean checkout`);
  const runtime = runtimeConfiguration(raw.runtimeConfiguration, side.thinkingMode, 4, `${label} runtime configuration`);
  const window = timeWindow(raw, label);

  const telemetry = raw.runTelemetry;
  if (!Array.isArray(telemetry) || telemetry.length !== FOCUSED_SAMPLES) {
    throw new Error(`${label} must contain exactly ${FOCUSED_SAMPLES} raw samples`);
  }
  const latencies: number[] = [];
  let promptTokens = 0;
  let cachedPromptTokens = 0;
  let previews = 0;
  let commits = 0;
  let writeActions = 0;
  for (const [index, value] of telemetry.entries()) {
    const run = object(value, `${label} runTelemetry[${index}]`);
    exactKeys(run, [
      "cohortIndex",
      "caseIndex",
      "caseId",
      "area",
      "pass",
      "safetyViolations",
      "outcomeKind",
      "previewCount",
      "commitCount",
      "confirmationAttemptCount",
      "writeActionCount",
      "modelCalls",
      "modelMs",
      "promptTokens",
      "completionTokens",
      "cachedPromptTokens",
      "usageReported",
      "cachedPromptReported",
      "narrowed",
      "escapeHatchFired",
      "intentDeclarationCalls",
      "intentDeclarationContract",
      "intentDeclarationProvenance",
      "intentCapabilityMode",
      "intentCapabilityActionBound",
      "intentCapabilityLiteralsExact",
      "intentWriteArgumentsExact",
      "intentHostMutationCount",
      "intentAuthorityChecks",
      "intentAuthorityDenials",
      "intentCapabilityBindCount",
      "intentCapabilityConsumeCount",
      "intentCapabilityConsumeDenials",
    ], `${label} runTelemetry[${index}]`);
    const declarationCalls = integer(run.intentDeclarationCalls, `${label} intentDeclarationCalls`);
    const authorityChecks = integer(run.intentAuthorityChecks, `${label} intentAuthorityChecks`);
    const authorityDenials = integer(run.intentAuthorityDenials, `${label} intentAuthorityDenials`);
    const declarationProvenanceValid = run.intentDeclarationProvenance === "provider_tool" ||
      (kind === "read" && run.intentDeclarationProvenance === "local_empty_zero_tool");
    if (
      declarationCalls !== 1
      || run.intentDeclarationContract !== "quote_refs_v1"
      || !declarationProvenanceValid
      || run.intentCapabilityActionBound !== true
      || authorityDenials !== 0
      || integer(run.intentHostMutationCount, `${label} intentHostMutationCount`) !== 0
    ) {
      throw new Error(`${label} does not use the production intent-capability path`);
    }
    if (run.caseId !== side.caseId || run.area !== expectedArea) {
      throw new Error(`${label} must contain only the configured case`);
    }
    if (run.pass !== true || integer(run.safetyViolations, `${label} safetyViolations`) !== 0) {
      throw new Error(`${label} is not a perfect zero-safety run`);
    }
    const previewCount = integer(run.previewCount, `${label} previewCount`);
    const commitCount = integer(run.commitCount, `${label} commitCount`);
    const confirmationAttemptCount = integer(
      run.confirmationAttemptCount,
      `${label} confirmationAttemptCount`,
    );
    const writeActionCount = integer(run.writeActionCount, `${label} writeActionCount`);
    const capabilityBindCount = integer(run.intentCapabilityBindCount, `${label} intentCapabilityBindCount`);
    const capabilityConsumeCount = integer(run.intentCapabilityConsumeCount, `${label} intentCapabilityConsumeCount`);
    const capabilityConsumeDenials = integer(
      run.intentCapabilityConsumeDenials,
      `${label} intentCapabilityConsumeDenials`,
    );
    const expectedCapabilityConsumeCount = writeActionCount - previewCount + confirmationAttemptCount;
    if (commitCount < 0 || confirmationAttemptCount < 0 || commitCount > confirmationAttemptCount) {
      throw new Error(`${label} commit count cannot exceed confirmation attempt count`);
    }
    if (
      previewCount < 0
      || writeActionCount < 0
      || capabilityBindCount !== writeActionCount
      || capabilityConsumeCount !== expectedCapabilityConsumeCount
      || capabilityConsumeDenials !== 0
    ) {
      throw new Error(`${label} preview/commit/write-action or durable capability lifecycle counts are invalid`);
    }
    if (kind === "read") {
      if (writeActionCount !== 0) throw new Error(`${label} must not attempt a write action`);
      if (run.intentCapabilityMode !== "deny_all_writes" || authorityChecks !== 0) {
        throw new Error(`${label} read samples must remain deny-all with no write-authority checks`);
      }
      if (run.outcomeKind !== "final" || previewCount !== 0 || commitCount !== 0 || confirmationAttemptCount !== 0) {
        throw new Error(`${label} must remain read-only with no preview or commit`);
      }
    } else {
      if (run.intentCapabilityMode !== "allow" || authorityChecks !== 1) {
        throw new Error(`${label} preview samples must declare and authorize exactly one risky write`);
      }
      if (commitCount !== 0 || confirmationAttemptCount !== 0) {
        throw new Error(`${label} must not commit or attempt confirmation`);
      }
      if (writeActionCount !== 1) throw new Error(`${label} must attempt exactly one risky write action per sample`);
      if (previewCount !== 1 || run.outcomeKind !== "interrupted") {
        throw new Error(`${label} must produce exactly one preview per sample`);
      }
    }
    if (run.usageReported !== true || run.cachedPromptReported !== true) {
      throw new Error(`${label} cache/token telemetry is incomplete`);
    }
    const modelMs = finiteNumber(run.modelMs, `${label} modelMs`);
    const prompt = integer(run.promptTokens, `${label} promptTokens`);
    const cached = integer(run.cachedPromptTokens, `${label} cachedPromptTokens`);
    if (modelMs < 0 || prompt <= 0 || cached < 0 || cached > prompt) {
      throw new Error(`${label} cache/token telemetry is invalid`);
    }
    latencies.push(modelMs);
    promptTokens += prompt;
    cachedPromptTokens += cached;
    previews += previewCount;
    commits += commitCount;
    writeActions += writeActionCount;
  }

  latencies.sort((left, right) => left - right);
  const p50Ms = percentile(latencies, 0.5);
  const p95Ms = percentile(latencies, 0.95);
  const summary = object(raw.summary, `${label} summary`);
  exactKeys(summary, [
    "totalRuns",
    "passRuns",
    "passRate",
    "safetyViolations",
    "meanRoundTrips",
    "latencyP50Ms",
    "latencyP95Ms",
    "meanPromptTokens",
    "meanPromptTokensPerRoundTrip",
    "meanCompletionTokens",
    "tokensReported",
    "totalPromptTokens",
    "totalCachedPromptTokens",
    "meanCachedPromptTokens",
    "cachedPromptReported",
    "cacheHitRate",
    "narrowedRuns",
    "escapeHatchFires",
    "escapeHatchFireRate",
  ], `${label} summary`);
  if (
    summary.totalRuns !== FOCUSED_SAMPLES
    || summary.passRuns !== FOCUSED_SAMPLES
    || summary.passRate !== 1
    || summary.safetyViolations !== 0
  ) {
    throw new Error(`${label} summary does not prove a perfect zero-safety run`);
  }
  if (summary.tokensReported !== true || summary.cachedPromptReported !== true) {
    throw new Error(`${label} summary does not prove cache-token reporting`);
  }
  if (
    summary.totalPromptTokens !== promptTokens
    || summary.totalCachedPromptTokens !== cachedPromptTokens
    || !close(finiteNumber(summary.cacheHitRate, `${label} cacheHitRate`), cachedPromptTokens / promptTokens)
  ) {
    throw new Error(`${label} cache aggregates do not match raw telemetry`);
  }
  if (summary.latencyP50Ms !== p50Ms || summary.latencyP95Ms !== p95Ms) {
    throw new Error(`${label} latency aggregates do not match raw telemetry`);
  }
  const reports = raw.reports;
  if (!Array.isArray(reports) || reports.length !== 1) {
    throw new Error(`${label} must contain one exact configured-case report`);
  }
  const report = object(reports[0], `${label} report`);
  exactKeys(report, ["id", "area", "passCount", "repeat", "sampleReasons"], `${label} report`);
  if (
    report.id !== side.caseId
    || report.area !== expectedArea
    || report.passCount !== FOCUSED_SAMPLES
    || report.repeat !== FOCUSED_SAMPLES
    || !Array.isArray(report.sampleReasons)
    || report.sampleReasons.length !== 0
  ) {
    throw new Error(`${label} report does not prove the exact configured case`);
  }
  const limit = kind === "read"
    ? FOCUSED_READ_P95_LIMIT_EXCLUSIVE_MS
    : FOCUSED_RISKY_PREVIEW_P95_LIMIT_EXCLUSIVE_MS;
  if (p95Ms >= limit) throw new Error(`${label} p95 must be below ${limit} ms`);
  return {
    sha: sourceSha,
    sha256: digest,
    p50Ms,
    p95Ms,
    previews,
    commits,
    writeActions,
    endpointSha256: runtime.endpointSha256,
    ...window,
  };
}

function sideFromRaw(
  rawJson: string,
  expectedThinking: ThinkingMode,
  label: string,
  requirePerfect = true,
): BindingSide {
  const raw = parseJson(rawJson, `${label} raw aggregate`);
  const source = object(raw.source, `${label} source`);
  if (source.workingTreeClean !== true) throw new Error(`${label} release evaluation did not use a clean checkout`);
  runtimeConfiguration(raw.runtimeConfiguration, expectedThinking, 4, `${label} runtime configuration`);
  const side: BindingSide = {
    testedSha: sha(source.gitCommitSha, `${label} source gitCommitSha`),
    rawAggregateSha256: sha256(rawJson),
    thinkingMode: expectedThinking,
  };
  rawMetrics(rawJson, side, label, requirePerfect);
  return side;
}

function capabilitySideFromRaw(rawJson: string): CapabilityBindingSide {
  const raw = parseJson(rawJson, "capability probe raw aggregate");
  const source = object(raw.source, "capability probe source");
  const runtime = runtimeConfiguration(raw.runtimeConfiguration, null, 1, "capability probe runtime configuration");
  const side: CapabilityBindingSide = {
    testedSha: sha(source.gitCommitSha, "capability probe source gitCommitSha"),
    rawAggregateSha256: sha256(rawJson),
    endpointSha256: runtime.endpointSha256,
    distinctPassingSettings: ["production-default", "thinking-disabled"],
  };
  capabilityMetrics(rawJson, side);
  return side;
}

function assertOrderedReleaseWindow(
  capability: CapabilityMetrics,
  baseline: RawMetrics,
  candidate: RawMetrics,
  focusedRead: FocusedMetrics,
  focusedRiskyPreview: FocusedMetrics,
): void {
  const runs = [capability, baseline, candidate, focusedRead, focusedRiskyPreview];
  assertOrderedRuns(runs);
}

function assertOrderedRuns(
  runs: Array<{ startedAtMs: number; completedAtMs: number }>,
): void {
  for (let index = 1; index < runs.length; index += 1) {
    if (runs[index]!.startedAtMs < runs[index - 1]!.completedAtMs) {
      throw new Error("DeepSeek release evidence must form one fresh ordered run window");
    }
  }
  if (runs.at(-1)!.completedAtMs - runs[0]!.startedAtMs > MAX_RELEASE_RUN_WINDOW_MS) {
    throw new Error("DeepSeek release evidence ordered run window is too large");
  }
}

function focusedSideFromRaw(
  rawJson: string,
  caseId: string,
  kind: "read" | "risky-preview",
  label: string,
  selectedThinkingMode: ThinkingMode,
): FocusedBindingSide {
  const raw = parseJson(rawJson, `${label} raw aggregate`);
  const source = object(raw.source, `${label} source`);
  const side: FocusedBindingSide = {
    testedSha: sha(source.gitCommitSha, `${label} source gitCommitSha`),
    rawAggregateSha256: sha256(rawJson),
    thinkingMode: selectedThinkingMode,
    caseId,
  };
  focusedRawMetrics(rawJson, side, kind, label);
  return side;
}

type SelectionReason = DeepSeekReleaseEvidence["selection"]["reason"];

export interface DeepSeekSettingSelection {
  selectedSetting: "production-default" | "thinking-disabled";
  lowerEffortPassRuns: number;
  lowerEffortPerfect: boolean;
  reason: SelectionReason;
}

function selectDeepSeekSetting(
  baseline: RawMetrics,
  lowerEffort: RawMetrics,
): { thinkingMode: ThinkingMode; reason: SelectionReason } {
  if (!baseline.perfect) throw new Error("production-default corpus is not a perfect zero-safety run");
  if (!lowerEffort.perfect) {
    return { thinkingMode: null, reason: "lower_effort_failed_corpus" };
  }
  if (lowerEffort.p50Ms >= baseline.p50Ms) {
    return { thinkingMode: null, reason: "production_default_not_slower" };
  }
  const medianRegression = regressionPercent(lowerEffort.p50Ms, baseline.p50Ms);
  const p95Regression = regressionPercent(lowerEffort.p95Ms, baseline.p95Ms);
  if (
    medianRegression > MAX_REGRESSION_PERCENT + Number.EPSILON
    || p95Regression > MAX_REGRESSION_PERCENT + Number.EPSILON
  ) {
    return { thinkingMode: null, reason: "lower_effort_latency_regression" };
  }
  return { thinkingMode: "disabled", reason: "lower_effort_selected" };
}

export function selectDeepSeekReleaseSetting(
  capabilityProbeRawJson: string,
  baselineRawJson: string,
  candidateRawJson: string,
  options: {
    candidateExitStatus?: 0 | 1;
    now?: Date;
    requireFresh?: boolean;
  } = {},
): DeepSeekSettingSelection {
  const capabilitySide = capabilitySideFromRaw(capabilityProbeRawJson);
  const baselineSide = sideFromRaw(baselineRawJson, null, "baseline");
  const candidateSide = sideFromRaw(candidateRawJson, "disabled", "candidate", false);
  if (
    capabilitySide.testedSha !== baselineSide.testedSha
    || baselineSide.testedSha !== candidateSide.testedSha
  ) {
    throw new Error("capability, baseline, and lower-effort comparison must use the same source SHA");
  }
  const capability = capabilityMetrics(capabilityProbeRawJson, capabilitySide);
  const baseline = rawMetrics(baselineRawJson, baselineSide, "baseline");
  const candidate = rawMetrics(candidateRawJson, candidateSide, "candidate", false);
  if (new Set([capability.endpointSha256, baseline.endpointSha256, candidate.endpointSha256]).size !== 1) {
    throw new Error("capability, baseline, and lower-effort comparison must use one endpoint");
  }
  assertOrderedRuns([capability, baseline, candidate]);
  if (options.requireFresh === true) {
    const nowMs = (options.now ?? new Date()).getTime();
    if (
      !Number.isFinite(nowMs)
      || candidate.completedAtMs > nowMs
      || nowMs - candidate.completedAtMs > RELEASE_EVIDENCE_FRESHNESS_MS
    ) {
      throw new Error("DeepSeek setting selection evidence is not fresh");
    }
  }
  if (options.candidateExitStatus === 0 && !candidate.perfect) {
    throw new Error("lower-effort evaluator exited successfully without a perfect corpus");
  }
  if (options.candidateExitStatus === 1 && candidate.perfect) {
    throw new Error("lower-effort evaluator failed despite a perfect corpus");
  }
  const selection = selectDeepSeekSetting(baseline, candidate);
  return {
    selectedSetting: selection.thinkingMode === "disabled" ? "thinking-disabled" : "production-default",
    lowerEffortPassRuns: candidate.passRuns,
    lowerEffortPerfect: candidate.perfect,
    reason: selection.reason,
  };
}

export function buildDeepSeekBinding(
  baselineRawJson: string,
  candidateRawJson: string,
  focusedReadRawJson: string,
  focusedRiskyPreviewRawJson: string,
  capabilityProbeRawJson: string,
): DeepSeekBinding {
  const capabilityProbe = capabilitySideFromRaw(capabilityProbeRawJson);
  const baseline = sideFromRaw(baselineRawJson, null, "baseline");
  const candidate = sideFromRaw(candidateRawJson, "disabled", "candidate", false);
  const baselineMetricsValue = rawMetrics(baselineRawJson, baseline, "baseline");
  const candidateMetricsValue = rawMetrics(candidateRawJson, candidate, "candidate", false);
  const selection = selectDeepSeekSetting(baselineMetricsValue, candidateMetricsValue);
  const focusedRead = focusedSideFromRaw(
    focusedReadRawJson,
    FOCUSED_READ_CASE_ID,
    "read",
    "focused read",
    selection.thinkingMode,
  );
  const focusedRiskyPreview = focusedSideFromRaw(
    focusedRiskyPreviewRawJson,
    FOCUSED_RISKY_PREVIEW_CASE_ID,
    "risky-preview",
    "focused risky preview",
    selection.thinkingMode,
  );
  if (baseline.testedSha !== candidate.testedSha) {
    throw new Error("baseline and candidate must measure settings on the same source SHA");
  }
  if (capabilityProbe.testedSha !== candidate.testedSha) {
    throw new Error("capability probe and candidate must use the same source SHA");
  }
  if (focusedRead.testedSha !== candidate.testedSha || focusedRiskyPreview.testedSha !== candidate.testedSha) {
    throw new Error("focused DeepSeek runs must use the exact clean candidate SHA");
  }
  const capabilityMetricsValue = capabilityMetrics(capabilityProbeRawJson, capabilityProbe);
  const focusedReadMetricsValue = focusedRawMetrics(focusedReadRawJson, focusedRead, "read", "focused read");
  const focusedRiskyMetricsValue = focusedRawMetrics(
    focusedRiskyPreviewRawJson,
    focusedRiskyPreview,
    "risky-preview",
    "focused risky preview",
  );
  assertOrderedReleaseWindow(
    capabilityMetricsValue,
    baselineMetricsValue,
    candidateMetricsValue,
    focusedReadMetricsValue,
    focusedRiskyMetricsValue,
  );
  const endpointDigests = new Set([
    capabilityMetricsValue.endpointSha256,
    baselineMetricsValue.endpointSha256,
    candidateMetricsValue.endpointSha256,
    focusedReadMetricsValue.endpointSha256,
    focusedRiskyMetricsValue.endpointSha256,
  ]);
  if (endpointDigests.size !== 1) throw new Error("all DeepSeek release runs must use one endpoint");
  return {
    schemaVersion: 2,
    kind: "deepseek-release-binding",
    capabilityProbe,
    baseline,
    candidate: { ...candidate, thinkingMode: "disabled" },
    focusedRead,
    focusedRiskyPreview,
    modelConfiguration: {
      provider: "http",
      model: "deepseek-v4-pro",
      endpointSha256: candidateMetricsValue.endpointSha256,
      mode: "tool",
      agentic: true,
      toolSelect: true,
      reasoningEffort: null,
      thinkingMode: selection.thinkingMode,
    },
    thresholds: {
      consecutivePasses: 5,
      maxMedianRegressionPercent: 10,
      maxP95RegressionPercent: 10,
      focusedSamples: 20,
      focusedReadP95MsExclusive: 12_000,
      focusedRiskyPreviewP95MsExclusive: 18_000,
    },
  };
}

function regressionPercent(candidate: number, baseline: number): number {
  if (baseline <= 0) throw new Error("baseline latency must be positive");
  return ((candidate - baseline) / baseline) * 100;
}

function benchmarkEvidence(
  bindingValue: unknown,
  capabilityProbeRawJson: string,
  baselineRawJson: string,
  candidateRawJson: string,
  focusedReadRawJson: string,
  focusedRiskyPreviewRawJson: string,
  evidenceCommitShaValue: string,
  now: Date | undefined,
  classification: HistoricalV1EvidenceClassification,
  requireFresh: boolean,
): DeepSeekBenchmarkEvidence {
  const binding = parseBinding(bindingValue);
  const evidenceCommitSha = sha(evidenceCommitShaValue, "evidence commit SHA");
  const capability = capabilityMetrics(capabilityProbeRawJson, binding.capabilityProbe);
  const baseline = rawMetrics(baselineRawJson, binding.baseline, "baseline");
  const candidate = rawMetrics(candidateRawJson, binding.candidate, "candidate", false);
  const selection = selectDeepSeekSetting(baseline, candidate);
  if (binding.modelConfiguration.thinkingMode !== selection.thinkingMode) {
    throw new Error("selected model configuration does not match the qualified DeepSeek setting");
  }
  const focusedRead = focusedRawMetrics(focusedReadRawJson, binding.focusedRead, "read", "focused read");
  const focusedRiskyPreview = focusedRawMetrics(
    focusedRiskyPreviewRawJson,
    binding.focusedRiskyPreview,
    "risky-preview",
    "focused risky preview",
  );
  if (
    capability.sha !== candidate.sha
    || baseline.sha !== candidate.sha
    || focusedRead.sha !== candidate.sha
    || focusedRiskyPreview.sha !== candidate.sha
  ) {
    throw new Error("every DeepSeek release run must use the exact clean candidate SHA");
  }
  assertOrderedReleaseWindow(capability, baseline, candidate, focusedRead, focusedRiskyPreview);
  const endpointDigests = new Set([
    capability.endpointSha256,
    baseline.endpointSha256,
    candidate.endpointSha256,
    focusedRead.endpointSha256,
    focusedRiskyPreview.endpointSha256,
    binding.modelConfiguration.endpointSha256,
  ]);
  if (endpointDigests.size !== 1) throw new Error("all DeepSeek release runs must use one bound endpoint");
  if (requireFresh) {
    const nowMs = (now ?? new Date()).getTime();
    if (
      !Number.isFinite(nowMs)
      || focusedRiskyPreview.completedAtMs > nowMs
      || nowMs - focusedRiskyPreview.completedAtMs > RELEASE_EVIDENCE_FRESHNESS_MS
    ) {
      throw new Error("DeepSeek release evidence is not fresh");
    }
  }
  if (focusedRead.sha !== candidate.sha || focusedRiskyPreview.sha !== candidate.sha) {
    throw new Error("focused DeepSeek runs must use the exact clean candidate SHA");
  }
  const medianRegressionPercent = regressionPercent(candidate.p50Ms, baseline.p50Ms);
  const p95RegressionPercent = regressionPercent(candidate.p95Ms, baseline.p95Ms);
  return {
    ...classification,
    schemaVersion: 2,
    kind: "deepseek-release-validation",
    conclusion: "passed",
    baselineSha: baseline.sha,
    testedCandidateSha: candidate.sha,
    evidenceCommitSha,
    consecutivePasses: 5,
    totalRunsPerSetting: EXPECTED_TOTAL_RUNS,
    safetyViolations: 0,
    intentCapabilityPath: {
      caseId: RELEASE_INTENT_PATH_CASE_ID,
      evaluatedRunsPerSetting: 5,
      productionDefaultPasses: 5,
      lowerEffortPasses: candidate.intentPathPasses,
      selectedPasses: 5,
      selectedExactLiteralBindings: 5,
      selectedExactRawArguments: 5,
      selectedExactHostMutations: 5,
      selectedRawAuthorityChecks: 5,
      selectedRawAuthorityDenials: 0,
    },
    rawAggregates: {
      capabilityProbeSha256: capability.sha256,
      baselineSha256: baseline.sha256,
      candidateSha256: candidate.sha256,
      focusedReadSha256: focusedRead.sha256,
      focusedRiskyPreviewSha256: focusedRiskyPreview.sha256,
    },
    modelConfiguration: binding.modelConfiguration,
    selection: {
      selectedSetting: selection.thinkingMode === "disabled" ? "thinking-disabled" : "production-default",
      lowerEffortPassRuns: candidate.passRuns,
      lowerEffortSafetyViolations: 0,
      lowerEffortFailedCases: candidate.failedCases,
      reason: selection.reason,
    },
    cache: {
      baselineCachedPromptTokens: baseline.cachedPromptTokens,
      candidateCachedPromptTokens: candidate.cachedPromptTokens,
      baselineHitRate: baseline.cacheHitRate,
      candidateHitRate: candidate.cacheHitRate,
    },
    latency: {
      productionDefaultP50Ms: baseline.p50Ms,
      productionDefaultP95Ms: baseline.p95Ms,
      lowerEffortP50Ms: candidate.p50Ms,
      lowerEffortP95Ms: candidate.p95Ms,
      lowerEffortMedianDeltaPercent: medianRegressionPercent,
      lowerEffortP95DeltaPercent: p95RegressionPercent,
      selectedP50Ms: selection.thinkingMode === "disabled" ? candidate.p50Ms : baseline.p50Ms,
      selectedP95Ms: selection.thinkingMode === "disabled" ? candidate.p95Ms : baseline.p95Ms,
      selectedMedianRegressionPercent: selection.thinkingMode === "disabled" ? medianRegressionPercent : 0,
      selectedP95RegressionPercent: selection.thinkingMode === "disabled" ? p95RegressionPercent : 0,
      maximumSelectedRegressionPercent: 10,
    },
    focused: {
      readOnly: {
        caseId: FOCUSED_READ_CASE_ID,
        samples: 20,
        safetyViolations: 0,
        writeActions: 0,
        p50Ms: focusedRead.p50Ms,
        p95Ms: focusedRead.p95Ms,
        p95LimitExclusiveMs: 12_000,
      },
      riskyPreview: {
        caseId: FOCUSED_RISKY_PREVIEW_CASE_ID,
        samples: 20,
        safetyViolations: 0,
        writeActions: FOCUSED_SAMPLES,
        previews: FOCUSED_SAMPLES,
        commits: 0,
        p50Ms: focusedRiskyPreview.p50Ms,
        p95Ms: focusedRiskyPreview.p95Ms,
        p95LimitExclusiveMs: 18_000,
      },
    },
    deployedConfigurationVerified: false,
  };
}

function verifyDeployedVersion(
  value: unknown,
  candidateSha: string,
  expectedConfiguration: ModelConfiguration,
): void {
  const deployed = object(value, "deployed version metadata");
  assertSecretFree(deployed, "deployed version metadata");
  exactKeys(deployed, [
    "version",
    "releaseSha",
    "buildHash",
    "serverArtifactSha256",
    "sourceRelationship",
    "sourceBindingSha256",
    "modelConfiguration",
  ], "deployed version metadata");
  if (deployed.version !== "1.0.0" || deployed.releaseSha !== candidateSha) {
    throw new Error("deployed release does not match the tested candidate SHA");
  }
  if (typeof deployed.buildHash !== "string" || !SHA256_PATTERN.test(deployed.buildHash)) {
    throw new Error("deployed release build hash is missing or invalid");
  }
  if (typeof deployed.serverArtifactSha256 !== "string" || !SHA256_PATTERN.test(deployed.serverArtifactSha256)) {
    throw new Error("deployed runtime artifact hash is missing or invalid");
  }
  if (
    deployed.sourceRelationship !== "exact_head"
    && deployed.sourceRelationship !== "source_bound_builder"
  ) {
    throw new Error("deployed source relationship is missing or not independently bound");
  }
  if (deployed.sourceRelationship === "source_bound_builder") {
    if (typeof deployed.sourceBindingSha256 !== "string" || !SHA256_PATTERN.test(deployed.sourceBindingSha256)) {
      throw new Error("deployed source binding hash is missing or invalid");
    }
  } else if (deployed.sourceBindingSha256 !== null) {
    throw new Error("deployed source binding must be null for an exact-head build");
  }
  try {
    modelConfiguration(
      deployed.modelConfiguration,
      expectedConfiguration.thinkingMode,
      "deployed model configuration",
    );
  } catch {
    throw new Error("deployed model configuration does not match the selected DeepSeek setting");
  }
  const actual = object(deployed.modelConfiguration, "deployed model configuration");
  for (const [key, expected] of Object.entries(expectedConfiguration)) {
    if (actual[key] !== expected) {
      throw new Error("deployed model configuration does not match the selected DeepSeek setting");
    }
  }
}

export function validateDeepSeekBenchmarkEvidence(
  input: Omit<DeepSeekEvidenceInput, "deployedVersion">,
  targetAssistantEngine: EvidenceTargetAssistantEngine = "v1",
): DeepSeekBenchmarkEvidence {
  const classification = classifyHistoricalV1Evidence(targetAssistantEngine);
  return benchmarkEvidence(
    input.binding,
    input.capabilityProbeRawJson,
    input.baselineRawJson,
    input.candidateRawJson,
    input.focusedReadRawJson,
    input.focusedRiskyPreviewRawJson,
    input.evidenceCommitSha,
    input.now,
    classification,
    false,
  );
}

export function validateDeepSeekReleaseEvidence(
  input: DeepSeekEvidenceInput,
  targetAssistantEngine: EvidenceTargetAssistantEngine = "v1",
): DeepSeekReleaseEvidence {
  const classification = classifyHistoricalV1Evidence(targetAssistantEngine);
  const benchmark = benchmarkEvidence(
    input.binding,
    input.capabilityProbeRawJson,
    input.baselineRawJson,
    input.candidateRawJson,
    input.focusedReadRawJson,
    input.focusedRiskyPreviewRawJson,
    input.evidenceCommitSha,
    input.now,
    classification,
    true,
  );
  verifyDeployedVersion(input.deployedVersion, benchmark.testedCandidateSha, benchmark.modelConfiguration);
  return { ...benchmark, deployedConfigurationVerified: true };
}

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/** Post-candidate commits may add only non-executable release evidence. This
 * keeps the tested source immutable while still allowing CI, deployment,
 * recovery, browser, and live-run identifiers to close the readiness record. */
export function isReleaseEvidencePath(path: string): boolean {
  return path.startsWith("evidence/") || path.startsWith("docs/marketplace/evidence/");
}

function assertEvidenceCommit(testCandidateSha: string, evidenceCommitSha: string): void {
  if (git(["rev-parse", "HEAD"]) !== evidenceCommitSha) {
    throw new Error("evidence commit SHA must match the checked-out commit");
  }
  if (git(["status", "--porcelain"])) throw new Error("DeepSeek evidence validation requires a clean checkout");
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", testCandidateSha, evidenceCommitSha], { stdio: "ignore" });
  } catch {
    throw new Error("tested candidate must be an ancestor of the evidence commit");
  }
  if (testCandidateSha === evidenceCommitSha) return;
  const changed = git(["diff", "--name-only", `${testCandidateSha}..${evidenceCommitSha}`])
    .split("\n")
    .filter(Boolean);
  const unexpected = changed.filter((path) => !isReleaseEvidencePath(path));
  if (unexpected.length > 0) {
    throw new Error("the post-candidate evidence commit contains executable or non-performance changes");
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function main(): void {
  const bindingPath = process.env.DEEPSEEK_BINDING_PATH ?? "evidence/performance/deepseek-release-binding.json";
  const capabilityProbePath = process.env.DEEPSEEK_CAPABILITY_PROBE_RAW_PATH
    ?? "evidence/performance/deepseek-capability-probe.raw.json";
  const baselinePath = process.env.DEEPSEEK_BASELINE_RAW_PATH ?? "evidence/performance/deepseek-baseline.raw.json";
  const candidatePath = process.env.DEEPSEEK_CANDIDATE_RAW_PATH ?? "evidence/performance/deepseek-candidate.raw.json";
  const focusedReadPath = process.env.DEEPSEEK_FOCUSED_READ_RAW_PATH
    ?? "evidence/performance/deepseek-focused-read.raw.json";
  const focusedRiskyPreviewPath = process.env.DEEPSEEK_FOCUSED_RISKY_PREVIEW_RAW_PATH
    ?? "evidence/performance/deepseek-focused-risky-preview.raw.json";
  if (process.argv.includes("--select-setting")) {
    const candidateExitStatusValue = requiredEnvironment("DEEPSEEK_CANDIDATE_EXIT_STATUS");
    if (candidateExitStatusValue !== "0" && candidateExitStatusValue !== "1") {
      throw new Error("DEEPSEEK_CANDIDATE_EXIT_STATUS must be 0 or 1");
    }
    const selection = selectDeepSeekReleaseSetting(
      readFileSync(capabilityProbePath, "utf8"),
      readFileSync(baselinePath, "utf8"),
      readFileSync(candidatePath, "utf8"),
      {
        candidateExitStatus: Number(candidateExitStatusValue) as 0 | 1,
        requireFresh: true,
      },
    );
    process.stdout.write(`${selection.selectedSetting}\n`);
    return;
  }
  if (process.argv.includes("--write-binding")) {
    writeDeterministicJson(
      bindingPath,
      buildDeepSeekBinding(
        readFileSync(baselinePath, "utf8"),
        readFileSync(candidatePath, "utf8"),
        readFileSync(focusedReadPath, "utf8"),
        readFileSync(focusedRiskyPreviewPath, "utf8"),
        readFileSync(capabilityProbePath, "utf8"),
      ),
    );
    return;
  }
  const outputPath = requiredEnvironment("DEEPSEEK_VALIDATION_PATH");
  const evidenceCommitSha = process.env.DEEPSEEK_EVIDENCE_COMMIT_SHA?.trim() || git(["rev-parse", "HEAD"]);
  const common = {
    binding: JSON.parse(readFileSync(bindingPath, "utf8")) as unknown,
    capabilityProbeRawJson: readFileSync(capabilityProbePath, "utf8"),
    baselineRawJson: readFileSync(baselinePath, "utf8"),
    candidateRawJson: readFileSync(candidatePath, "utf8"),
    focusedReadRawJson: readFileSync(focusedReadPath, "utf8"),
    focusedRiskyPreviewRawJson: readFileSync(focusedRiskyPreviewPath, "utf8"),
    evidenceCommitSha,
  };
  const benchmarkOnly = process.argv.includes("--benchmark-only");
  const evidence = benchmarkOnly
    ? validateDeepSeekBenchmarkEvidence(common, "v1")
    : validateDeepSeekReleaseEvidence({
        ...common,
        deployedVersion: JSON.parse(readFileSync(requiredEnvironment("DEEPSEEK_DEPLOYED_VERSION_PATH"), "utf8")) as unknown,
      }, "v1");
  const expectedCandidateSha = process.env.DEEPSEEK_EXPECTED_CANDIDATE_SHA?.trim();
  if (expectedCandidateSha !== undefined && expectedCandidateSha !== evidence.testedCandidateSha) {
    throw new Error("workflow candidate SHA does not match the tested DeepSeek candidate");
  }
  assertEvidenceCommit(evidence.testedCandidateSha, evidence.evidenceCommitSha);
  writeDeterministicJson(outputPath, evidence);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch {
    process.stderr.write("DeepSeek release evidence validation failed\n");
    process.exitCode = 1;
  }
}
