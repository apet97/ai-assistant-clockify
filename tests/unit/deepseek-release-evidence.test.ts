import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENTIC_CASES } from "../../scripts/eval/agentic-cases.js";

const CANDIDATE_SHA = "b".repeat(40);
const BASELINE_SHA = CANDIDATE_SHA;
const EVIDENCE_SHA = "c".repeat(40);
const BUILD_HASH = "d".repeat(64);
const SERVER_ARTIFACT_HASH = "e".repeat(64);
const SOURCE_BINDING_HASH = "f".repeat(64);
const ENDPOINT_HASH = "1".repeat(64);
const NOW = new Date("2026-07-19T00:10:00.000Z");
const FOCUSED_READ_CASE_ID = "agentic.count_projects";
const FOCUSED_PREVIEW_CASE_ID = "agentic.delete_tag_by_name";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function runtimeConfiguration(thinkingMode: null | "disabled", concurrency = 4) {
  return {
    provider: "http",
    model: "deepseek-v4-pro",
    endpointSha256: ENDPOINT_HASH,
    mode: "tool",
    agentic: true,
    toolSelect: true,
    reasoningEffort: null,
    thinkingMode,
    concurrency,
    nodeVersion: "v22.20.0",
    timeoutMs: 120_000,
    seed: null,
    mixedTier: false,
  };
}

function rawEval(sha: string, thinkingMode: null | "disabled", modelMs: number): string {
  const baseline = thinkingMode === null;
  const runTelemetry = Array.from({ length: 55 }, (_, index) => ({
    cohortIndex: Math.floor(index / AGENTIC_CASES.length) + 1,
    caseIndex: index % AGENTIC_CASES.length,
    caseId: AGENTIC_CASES[index % AGENTIC_CASES.length]!.id,
    area: "read_answer",
    pass: true,
    safetyViolations: 0,
    outcomeKind: "final",
    previewCount: 0,
    commitCount: 0,
    writeActionCount: 0,
    modelCalls: 2,
    modelMs,
    promptTokens: 1_000,
    completionTokens: 25,
    cachedPromptTokens: 900,
    usageReported: true,
    cachedPromptReported: true,
    narrowed: true,
    escapeHatchFired: false,
  }));
  return JSON.stringify({
    startedAt: baseline ? "2026-07-19T00:02:00.000Z" : "2026-07-19T00:04:00.000Z",
    completedAt: baseline ? "2026-07-19T00:03:00.000Z" : "2026-07-19T00:05:00.000Z",
    kind: "agentic-task-completion",
    mode: "agentic",
    provider: "http",
    model: "deepseek-v4-pro",
    toolSelect: true,
    repeat: 5,
    source: { gitCommitSha: sha, workingTreeClean: true },
    runtimeConfiguration: runtimeConfiguration(thinkingMode),
    summary: {
      totalRuns: 55,
      passRuns: 55,
      passRate: 1,
      safetyViolations: 0,
      meanRoundTrips: 2,
      latencyP50Ms: modelMs,
      latencyP95Ms: modelMs,
      tokensReported: true,
      totalPromptTokens: 55_000,
      totalCachedPromptTokens: 49_500,
      meanPromptTokens: 1_000,
      meanPromptTokensPerRoundTrip: 500,
      meanCompletionTokens: 25,
      meanCachedPromptTokens: 900,
      cachedPromptReported: true,
      cacheHitRate: 0.9,
      narrowedRuns: 55,
      escapeHatchFires: 0,
      escapeHatchFireRate: 0,
    },
    reports: AGENTIC_CASES.map(({ id, area }) => ({ id, area, passCount: 5, repeat: 5, sampleReasons: [] })),
    runTelemetry,
  });
}

function failedCandidateRaw(modelMs = 800): string {
  const raw = JSON.parse(rawEval(CANDIDATE_SHA, "disabled", modelMs)) as Record<string, unknown>;
  const telemetry = raw.runTelemetry as Array<Record<string, unknown>>;
  const failed = telemetry.find((run) => run.caseId === "agentic.invoice_for_named_client");
  if (!failed) throw new Error("missing invoice fixture case");
  failed.pass = false;
  const summary = raw.summary as Record<string, unknown>;
  summary.passRuns = 54;
  summary.passRate = 54 / 55;
  const report = (raw.reports as Array<Record<string, unknown>>)
    .find((candidate) => candidate.id === "agentic.invoice_for_named_client");
  if (!report) throw new Error("missing invoice fixture report");
  report.passCount = 4;
  report.sampleReasons = [];
  return JSON.stringify(raw);
}

function tailRegressedCandidateRaw(): string {
  const raw = JSON.parse(rawEval(CANDIDATE_SHA, "disabled", 900)) as Record<string, unknown>;
  const telemetry = raw.runTelemetry as Array<Record<string, unknown>>;
  for (const run of telemetry.slice(-3)) run.modelMs = 1_200;
  (raw.summary as Record<string, unknown>).latencyP95Ms = 1_200;
  return JSON.stringify(raw);
}

function focusedRaw(
  kind: "read-only" | "risky-preview",
  modelMs: number,
  options: {
    commitCount?: number;
    previewCount?: number;
    writeActionCount?: number;
    thinkingMode?: null | "disabled";
  } = {},
): string {
  const preview = kind === "risky-preview";
  const caseId = preview ? FOCUSED_PREVIEW_CASE_ID : FOCUSED_READ_CASE_ID;
  const area = preview ? "single_risky" : "read_answer";
  const previewCount = options.previewCount ?? (preview ? 1 : 0);
  const commitCount = options.commitCount ?? 0;
  const writeActionCount = options.writeActionCount ?? (preview ? 1 : 0);
  const runTelemetry = Array.from({ length: 20 }, () => ({
    cohortIndex: 1,
    caseIndex: 0,
    caseId,
    area,
    pass: true,
    safetyViolations: 0,
    outcomeKind: preview ? "interrupted" : "final",
    previewCount,
    commitCount,
    writeActionCount,
    modelCalls: 1,
    modelMs,
    promptTokens: 1_000,
    completionTokens: 25,
    cachedPromptTokens: 900,
    usageReported: true,
    cachedPromptReported: true,
    narrowed: true,
    escapeHatchFired: false,
  }));
  return JSON.stringify({
    startedAt: preview ? "2026-07-19T00:08:00.000Z" : "2026-07-19T00:06:00.000Z",
    completedAt: preview ? "2026-07-19T00:09:00.000Z" : "2026-07-19T00:07:00.000Z",
    kind: "agentic-task-completion",
    mode: preview ? "agentic-preview" : "agentic",
    provider: "http",
    model: "deepseek-v4-pro",
    toolSelect: true,
    repeat: 20,
    source: { gitCommitSha: CANDIDATE_SHA, workingTreeClean: true },
    runtimeConfiguration: runtimeConfiguration(
      options.thinkingMode === undefined ? "disabled" : options.thinkingMode,
    ),
    summary: {
      totalRuns: 20,
      passRuns: 20,
      passRate: 1,
      safetyViolations: 0,
      meanRoundTrips: 1,
      latencyP50Ms: modelMs,
      latencyP95Ms: modelMs,
      tokensReported: true,
      totalPromptTokens: 20_000,
      totalCachedPromptTokens: 18_000,
      meanPromptTokens: 1_000,
      meanPromptTokensPerRoundTrip: 1_000,
      meanCompletionTokens: 25,
      meanCachedPromptTokens: 900,
      cachedPromptReported: true,
      cacheHitRate: 0.9,
      narrowedRuns: 20,
      escapeHatchFires: 0,
      escapeHatchFireRate: 0,
    },
    reports: [{ id: caseId, area, passCount: 20, repeat: 20, sampleReasons: [] }],
    runTelemetry,
  });
}

function capabilityProbeRaw(): string {
  return JSON.stringify({
    schemaVersion: 1,
    kind: "deepseek-capability-probe",
    startedAt: "2026-07-19T00:00:00.000Z",
    completedAt: "2026-07-19T00:01:00.000Z",
    source: { gitCommitSha: CANDIDATE_SHA, workingTreeClean: true },
    runtimeConfiguration: runtimeConfiguration(null, 1),
    settings: [
      { setting: "production-default", classification: "distinct-passing", accepted: true, httpStatus: 200 },
      { setting: "reasoning-high", classification: "compatibility-alias", accepted: true, httpStatus: 200 },
      { setting: "reasoning-medium", classification: "compatibility-alias", accepted: true, httpStatus: 200 },
      { setting: "reasoning-low", classification: "compatibility-alias", accepted: true, httpStatus: 200 },
      { setting: "reasoning-none", classification: "unsupported", accepted: false, httpStatus: 400 },
      { setting: "thinking-disabled", classification: "distinct-passing", accepted: true, httpStatus: 200 },
    ],
    distinctPassingSettings: ["production-default", "thinking-disabled"],
  });
}

function fixture(candidateModelMs = 900) {
  const capabilityProbeRawJson = capabilityProbeRaw();
  const baselineRawJson = rawEval(BASELINE_SHA, null, 1_000);
  const candidateRawJson = rawEval(CANDIDATE_SHA, "disabled", candidateModelMs);
  const focusedReadRawJson = focusedRaw("read-only", 3_000);
  const focusedRiskyPreviewRawJson = focusedRaw("risky-preview", 2_000);
  return {
    binding: {
      schemaVersion: 2,
      kind: "deepseek-release-binding",
      capabilityProbe: {
        testedSha: CANDIDATE_SHA,
        rawAggregateSha256: sha256(capabilityProbeRawJson),
        endpointSha256: ENDPOINT_HASH,
        distinctPassingSettings: ["production-default", "thinking-disabled"],
      },
      baseline: {
        testedSha: BASELINE_SHA,
        rawAggregateSha256: sha256(baselineRawJson),
        thinkingMode: null,
      },
      candidate: {
        testedSha: CANDIDATE_SHA,
        rawAggregateSha256: sha256(candidateRawJson),
        thinkingMode: "disabled",
      },
      focusedRead: {
        testedSha: CANDIDATE_SHA,
        rawAggregateSha256: sha256(focusedReadRawJson),
        thinkingMode: "disabled",
        caseId: FOCUSED_READ_CASE_ID,
      },
      focusedRiskyPreview: {
        testedSha: CANDIDATE_SHA,
        rawAggregateSha256: sha256(focusedRiskyPreviewRawJson),
        thinkingMode: "disabled",
        caseId: FOCUSED_PREVIEW_CASE_ID,
      },
      modelConfiguration: {
        provider: "http",
        model: "deepseek-v4-pro",
        endpointSha256: ENDPOINT_HASH,
        mode: "tool",
        agentic: true,
        toolSelect: true,
        reasoningEffort: null,
        thinkingMode: "disabled",
      },
      thresholds: {
        consecutivePasses: 5,
        maxMedianRegressionPercent: 10,
        maxP95RegressionPercent: 10,
        focusedSamples: 20,
        focusedReadP95MsExclusive: 12_000,
        focusedRiskyPreviewP95MsExclusive: 18_000,
      },
    },
    baselineRawJson,
    capabilityProbeRawJson,
    candidateRawJson,
    focusedReadRawJson,
    focusedRiskyPreviewRawJson,
    evidenceCommitSha: EVIDENCE_SHA,
    now: NOW,
    deployedVersion: {
      version: "1.0.0",
      releaseSha: CANDIDATE_SHA,
      buildHash: BUILD_HASH,
      serverArtifactSha256: SERVER_ARTIFACT_HASH,
      sourceRelationship: "exact_head",
      sourceBindingSha256: null,
      modelConfiguration: {
        provider: "http",
        model: "deepseek-v4-pro",
        endpointSha256: ENDPOINT_HASH,
        mode: "tool",
        agentic: true,
        toolSelect: true,
        reasoningEffort: null,
        thinkingMode: "disabled",
      },
    },
  };
}

function fallbackFixture(candidateModelMs = 800) {
  const input = fixture(candidateModelMs);
  input.candidateRawJson = failedCandidateRaw(candidateModelMs);
  input.focusedReadRawJson = focusedRaw("read-only", 3_000, { thinkingMode: null });
  input.focusedRiskyPreviewRawJson = focusedRaw("risky-preview", 2_000, { thinkingMode: null });
  input.binding.candidate.rawAggregateSha256 = sha256(input.candidateRawJson);
  input.binding.focusedRead.rawAggregateSha256 = sha256(input.focusedReadRawJson);
  input.binding.focusedRead.thinkingMode = null as never;
  input.binding.focusedRiskyPreview.rawAggregateSha256 = sha256(input.focusedRiskyPreviewRawJson);
  input.binding.focusedRiskyPreview.thinkingMode = null as never;
  input.binding.modelConfiguration.thinkingMode = null as never;
  input.deployedVersion.modelConfiguration.thinkingMode = null as never;
  return input;
}

async function validator(): Promise<Record<string, (...args: unknown[]) => unknown>> {
  const modulePath = "../../scripts/evidence/deepseek-release-evidence.js";
  const loaded = await import(/* @vite-ignore */ modulePath).catch(() => undefined);
  expect(loaded, "DeepSeek release evidence validator must exist").toBeDefined();
  return loaded as Record<string, (...args: unknown[]) => unknown>;
}

describe("DeepSeek release evidence", () => {
  it("persists outcome, preview, and commit counts needed to prove preview-only runs", () => {
    const evaluator = readFileSync(resolve("scripts/eval-agentic.ts"), "utf8");

    expect(evaluator).toContain("outcomeKind: run.outcomeKind");
    expect(evaluator).toContain("previewCount: run.previewCount");
    expect(evaluator).toContain("commitCount: run.commitCount");
    expect(evaluator).toContain("writeActionCount: run.writeActionCount");
    expect(evaluator).toContain("cohortIndex: run.cohortIndex");
    expect(evaluator).toContain("caseIndex: run.caseIndex");
  });

  it("allows only non-executable evidence paths after the tested candidate", async () => {
    const { isReleaseEvidencePath } = await validator();

    expect(isReleaseEvidencePath("evidence/performance/deepseek-candidate.raw.json")).toBe(true);
    expect(isReleaseEvidencePath("evidence/recovery/restore-drill.json")).toBe(true);
    expect(isReleaseEvidencePath("docs/marketplace/evidence/release-candidate.md")).toBe(true);
    expect(isReleaseEvidencePath("src/server.ts")).toBe(false);
    expect(isReleaseEvidencePath("MARKETPLACE_READINESS.md")).toBe(false);
  });

  it("builds a digest-bound release manifest from the corpus and two focused clean raw aggregates", async () => {
    const { buildDeepSeekBinding } = await validator();
    const input = fixture();
    const binding = buildDeepSeekBinding(
      input.baselineRawJson,
      input.candidateRawJson,
      input.focusedReadRawJson,
      input.focusedRiskyPreviewRawJson,
      input.capabilityProbeRawJson,
    ) as Record<string, unknown>;

    expect(binding).toEqual(input.binding);
  });

  it("records a complete rejected lower-effort cohort and selects production-default", async () => {
    const { buildDeepSeekBinding, validateDeepSeekReleaseEvidence } = await validator();
    const input = fallbackFixture();
    const binding = buildDeepSeekBinding(
      input.baselineRawJson,
      input.candidateRawJson,
      input.focusedReadRawJson,
      input.focusedRiskyPreviewRawJson,
      input.capabilityProbeRawJson,
    ) as typeof input.binding;

    expect(binding).toEqual(input.binding);
    const result = validateDeepSeekReleaseEvidence({ ...input, binding } as never) as Record<string, unknown>;
    expect(result).toHaveProperty("modelConfiguration.thinkingMode", null);
    expect(result).toHaveProperty("selection.selectedSetting", "production-default");
    expect(result).toHaveProperty("selection.lowerEffortPassRuns", 54);
    expect(result).toHaveProperty("selection.lowerEffortFailedCases", [{
      caseId: "agentic.invoice_for_named_client",
      passCount: 4,
      repeat: 5,
    }]);
    expect(result).toHaveProperty("selection.reason", "lower_effort_failed_corpus");
  });

  it("strictly selects the setting before focused runs and binds evaluator exit status", async () => {
    const { selectDeepSeekReleaseSetting } = await validator();
    const fallback = fallbackFixture();
    const selected = selectDeepSeekReleaseSetting(
      fallback.capabilityProbeRawJson,
      fallback.baselineRawJson,
      fallback.candidateRawJson,
      { candidateExitStatus: 1, now: NOW, requireFresh: true },
    ) as Record<string, unknown>;
    expect(selected).toMatchObject({
      selectedSetting: "production-default",
      lowerEffortPassRuns: 54,
      lowerEffortPerfect: false,
      reason: "lower_effort_failed_corpus",
    });

    expect(() => selectDeepSeekReleaseSetting(
      fallback.capabilityProbeRawJson,
      fallback.baselineRawJson,
      fallback.candidateRawJson,
      { candidateExitStatus: 0, now: NOW, requireFresh: true },
    )).toThrow(/exited successfully/i);

    const passing = fixture();
    expect(() => selectDeepSeekReleaseSetting(
      passing.capabilityProbeRawJson,
      passing.baselineRawJson,
      passing.candidateRawJson,
      { candidateExitStatus: 1, now: NOW, requireFresh: true },
    )).toThrow(/failed despite a perfect corpus/i);
  });

  it("prefers production-default on a latency tie", async () => {
    const { selectDeepSeekReleaseSetting } = await validator();
    const input = fixture(1_000);
    const selected = selectDeepSeekReleaseSetting(
      input.capabilityProbeRawJson,
      input.baselineRawJson,
      input.candidateRawJson,
      { candidateExitStatus: 0, now: NOW, requireFresh: true },
    ) as Record<string, unknown>;
    expect(selected).toHaveProperty("selectedSetting", "production-default");
    expect(selected).toHaveProperty("reason", "production_default_not_slower");
  });

  it("binds clean raw aggregates, both tested SHAs, evidence commit, cache use, thresholds, and deployed config", async () => {
    const { validateDeepSeekReleaseEvidence } = await validator();
    const result = validateDeepSeekReleaseEvidence(fixture() as never) as Record<string, unknown>;

    expect(result).toMatchObject({
      conclusion: "passed",
      baselineSha: BASELINE_SHA,
      testedCandidateSha: CANDIDATE_SHA,
      evidenceCommitSha: EVIDENCE_SHA,
      consecutivePasses: 5,
      totalRunsPerSetting: 55,
      safetyViolations: 0,
      deployedConfigurationVerified: true,
    });
    expect(result).toHaveProperty("rawAggregates.baselineSha256", fixture().binding.baseline.rawAggregateSha256);
    expect(result).toHaveProperty(
      "rawAggregates.capabilityProbeSha256",
      fixture().binding.capabilityProbe.rawAggregateSha256,
    );
    expect(result).toHaveProperty("rawAggregates.candidateSha256", fixture().binding.candidate.rawAggregateSha256);
    expect(result).toHaveProperty("rawAggregates.focusedReadSha256", fixture().binding.focusedRead.rawAggregateSha256);
    expect(result).toHaveProperty(
      "rawAggregates.focusedRiskyPreviewSha256",
      fixture().binding.focusedRiskyPreview.rawAggregateSha256,
    );
    expect(result).toHaveProperty("cache.candidateCachedPromptTokens", 49_500);
    expect(result).toHaveProperty("focused.readOnly", {
      caseId: FOCUSED_READ_CASE_ID,
      samples: 20,
      safetyViolations: 0,
      writeActions: 0,
      p50Ms: 3_000,
      p95Ms: 3_000,
      p95LimitExclusiveMs: 12_000,
    });
    expect(result).toHaveProperty("focused.riskyPreview", {
      caseId: FOCUSED_PREVIEW_CASE_ID,
      samples: 20,
      safetyViolations: 0,
      writeActions: 20,
      previews: 20,
      commits: 0,
      p50Ms: 2_000,
      p95Ms: 2_000,
      p95LimitExclusiveMs: 18_000,
    });
  });

  it("rejects missing or tampered focused raw evidence", async () => {
    const { validateDeepSeekReleaseEvidence } = await validator();

    const missing = { ...fixture(), focusedReadRawJson: undefined };
    expect(() => validateDeepSeekReleaseEvidence(missing as never)).toThrow(/focused read/i);

    const tampered = fixture();
    tampered.focusedRiskyPreviewRawJson += " ";
    expect(() => validateDeepSeekReleaseEvidence(tampered as never)).toThrow(/focused risky preview.*digest/i);
  });

  it("rejects a focused read at the 12 second boundary", async () => {
    const { validateDeepSeekReleaseEvidence } = await validator();
    const slow = fixture();
    slow.focusedReadRawJson = focusedRaw("read-only", 12_000);
    slow.binding.focusedRead.rawAggregateSha256 = sha256(slow.focusedReadRawJson);

    expect(() => validateDeepSeekReleaseEvidence(slow as never)).toThrow(/focused read.*p95/i);
  });

  it("rejects a nominally read-only focused run that attempts any write action", async () => {
    const { validateDeepSeekReleaseEvidence } = await validator();
    const wrote = fixture();
    wrote.focusedReadRawJson = focusedRaw("read-only", 3_000, { writeActionCount: 1 });
    wrote.binding.focusedRead.rawAggregateSha256 = sha256(wrote.focusedReadRawJson);

    expect(() => validateDeepSeekReleaseEvidence(wrote as never)).toThrow(/focused read.*write action/i);
  });

  it("rejects a focused risky preview that commits or does not produce exactly one preview per sample", async () => {
    const { validateDeepSeekReleaseEvidence } = await validator();
    const committed = fixture();
    committed.focusedRiskyPreviewRawJson = focusedRaw("risky-preview", 2_000, { commitCount: 1 });
    committed.binding.focusedRiskyPreview.rawAggregateSha256 = sha256(committed.focusedRiskyPreviewRawJson);
    expect(() => validateDeepSeekReleaseEvidence(committed as never)).toThrow(/focused risky preview.*commit/i);

    const missingPreview = fixture();
    missingPreview.focusedRiskyPreviewRawJson = focusedRaw("risky-preview", 2_000, { previewCount: 0 });
    missingPreview.binding.focusedRiskyPreview.rawAggregateSha256 = sha256(missingPreview.focusedRiskyPreviewRawJson);
    expect(() => validateDeepSeekReleaseEvidence(missingPreview as never)).toThrow(/focused risky preview.*exactly one preview/i);
  });

  it("rejects a non-perfect selected corpus, missing cache telemetry, dirty source, or tampered raw aggregate", async () => {
    const { validateDeepSeekReleaseEvidence } = await validator();

    const failed = fixture();
    const failedRaw = JSON.parse(failed.baselineRawJson) as Record<string, unknown>;
    const telemetry = failedRaw.runTelemetry as Array<Record<string, unknown>>;
    telemetry[0]!.pass = false;
    (failedRaw.summary as Record<string, unknown>).passRuns = 54;
    (failedRaw.summary as Record<string, unknown>).passRate = 54 / 55;
    const firstReport = (failedRaw.reports as Array<Record<string, unknown>>)[0]!;
    firstReport.passCount = 4;
    firstReport.sampleReasons = [];
    failed.baselineRawJson = JSON.stringify(failedRaw);
    failed.binding.baseline.rawAggregateSha256 = sha256(failed.baselineRawJson);
    expect(() => validateDeepSeekReleaseEvidence(failed as never)).toThrow(/perfect/i);

    const uncached = fixture();
    const uncachedRaw = JSON.parse(uncached.candidateRawJson) as Record<string, unknown>;
    (uncachedRaw.summary as Record<string, unknown>).totalCachedPromptTokens = 0;
    uncached.candidateRawJson = JSON.stringify(uncachedRaw);
    uncached.binding.candidate.rawAggregateSha256 = sha256(uncached.candidateRawJson);
    expect(() => validateDeepSeekReleaseEvidence(uncached as never)).toThrow(/cache/i);

    const dirty = fixture();
    const dirtyRaw = JSON.parse(dirty.candidateRawJson) as Record<string, unknown>;
    (dirtyRaw.source as Record<string, unknown>).workingTreeClean = false;
    dirty.candidateRawJson = JSON.stringify(dirtyRaw);
    dirty.binding.candidate.rawAggregateSha256 = sha256(dirty.candidateRawJson);
    expect(() => validateDeepSeekReleaseEvidence(dirty as never)).toThrow(/clean/i);

    const tampered = fixture();
    tampered.candidateRawJson += " ";
    expect(() => validateDeepSeekReleaseEvidence(tampered as never)).toThrow(/digest/i);

    const substitutedCase = fixture();
    const substitutedRaw = JSON.parse(substitutedCase.candidateRawJson) as Record<string, unknown>;
    const configuredCaseId = AGENTIC_CASES[0]!.id;
    for (const run of substitutedRaw.runTelemetry as Array<Record<string, unknown>>) {
      if (run.caseId === configuredCaseId) run.caseId = "invented.easy_case";
    }
    substitutedCase.candidateRawJson = JSON.stringify(substitutedRaw);
    substitutedCase.binding.candidate.rawAggregateSha256 = sha256(substitutedCase.candidateRawJson);
    expect(() => validateDeepSeekReleaseEvidence(substitutedCase as never)).toThrow(/configured case/i);
  });

  it("rejects five-count aggregates that are not five ordered complete corpus cohorts", async () => {
    const { validateDeepSeekReleaseEvidence } = await validator();
    const forged = fixture();
    const raw = JSON.parse(forged.candidateRawJson) as Record<string, unknown>;
    const telemetry = raw.runTelemetry as Array<Record<string, unknown>>;
    [telemetry[0], telemetry[1]] = [telemetry[1]!, telemetry[0]!];
    forged.candidateRawJson = JSON.stringify(raw);
    forged.binding.candidate.rawAggregateSha256 = sha256(forged.candidateRawJson);

    expect(() => validateDeepSeekReleaseEvidence(forged as never)).toThrow(/ordered complete cohort/i);
  });

  it("rejects forged lower-effort summaries and per-case reports", async () => {
    const { validateDeepSeekReleaseEvidence } = await validator();

    const forgedSummary = fallbackFixture();
    const summaryRaw = JSON.parse(forgedSummary.candidateRawJson) as Record<string, unknown>;
    (summaryRaw.summary as Record<string, unknown>).passRuns = 55;
    forgedSummary.candidateRawJson = JSON.stringify(summaryRaw);
    forgedSummary.binding.candidate.rawAggregateSha256 = sha256(forgedSummary.candidateRawJson);
    expect(() => validateDeepSeekReleaseEvidence(forgedSummary as never)).toThrow(/summary/i);

    const forgedReport = fallbackFixture();
    const reportRaw = JSON.parse(forgedReport.candidateRawJson) as Record<string, unknown>;
    const report = (reportRaw.reports as Array<Record<string, unknown>>)
      .find((candidate) => candidate.id === "agentic.invoice_for_named_client");
    if (!report) throw new Error("missing invoice report fixture");
    report.passCount = 5;
    forgedReport.candidateRawJson = JSON.stringify(reportRaw);
    forgedReport.binding.candidate.rawAggregateSha256 = sha256(forgedReport.candidateRawJson);
    expect(() => validateDeepSeekReleaseEvidence(forgedReport as never)).toThrow(/reports/i);
  });

  it("rejects baseline and candidate settings measured from different source SHAs", async () => {
    const { buildDeepSeekBinding } = await validator();
    const input = fixture();
    input.baselineRawJson = rawEval("a".repeat(40), null, 1_000);

    expect(() => buildDeepSeekBinding(
      input.baselineRawJson,
      input.candidateRawJson,
      input.focusedReadRawJson,
      input.focusedRiskyPreviewRawJson,
      input.capabilityProbeRawJson,
    )).toThrow(/same source SHA/i);
  });

  it("selects the fastest qualifying setting and falls back on speed or tail-latency regression", async () => {
    const { validateDeepSeekReleaseEvidence } = await validator();
    const slower = fixture(1_001);
    slower.focusedReadRawJson = focusedRaw("read-only", 3_000, { thinkingMode: null });
    slower.binding.focusedRead.rawAggregateSha256 = sha256(slower.focusedReadRawJson);
    slower.binding.focusedRead.thinkingMode = null as never;
    slower.focusedRiskyPreviewRawJson = focusedRaw("risky-preview", 2_000, { thinkingMode: null });
    slower.binding.focusedRiskyPreview.rawAggregateSha256 = sha256(slower.focusedRiskyPreviewRawJson);
    slower.binding.focusedRiskyPreview.thinkingMode = null as never;
    slower.binding.modelConfiguration.thinkingMode = null as never;
    slower.deployedVersion.modelConfiguration.thinkingMode = null as never;
    const selected = validateDeepSeekReleaseEvidence(slower as never) as Record<string, unknown>;
    expect(selected).toHaveProperty("selection.selectedSetting", "production-default");
    expect(selected).toHaveProperty("selection.reason", "production_default_not_slower");

    const regressed = fixture();
    regressed.candidateRawJson = tailRegressedCandidateRaw();
    regressed.binding.candidate.rawAggregateSha256 = sha256(regressed.candidateRawJson);
    regressed.focusedReadRawJson = focusedRaw("read-only", 3_000, { thinkingMode: null });
    regressed.binding.focusedRead.rawAggregateSha256 = sha256(regressed.focusedReadRawJson);
    regressed.binding.focusedRead.thinkingMode = null as never;
    regressed.focusedRiskyPreviewRawJson = focusedRaw("risky-preview", 2_000, { thinkingMode: null });
    regressed.binding.focusedRiskyPreview.rawAggregateSha256 = sha256(regressed.focusedRiskyPreviewRawJson);
    regressed.binding.focusedRiskyPreview.thinkingMode = null as never;
    regressed.binding.modelConfiguration.thinkingMode = null as never;
    regressed.deployedVersion.modelConfiguration.thinkingMode = null as never;
    const tailSelected = validateDeepSeekReleaseEvidence(regressed as never) as Record<string, unknown>;
    expect(tailSelected).toHaveProperty("selection.reason", "lower_effort_latency_regression");

    const mismatched = fixture();
    mismatched.deployedVersion.modelConfiguration.thinkingMode = null as never;
    expect(() => validateDeepSeekReleaseEvidence(mismatched as never)).toThrow(/deployed model configuration/i);
  });

  it("rejects a binding that claims a setting different from the derived selection", async () => {
    const { validateDeepSeekReleaseEvidence } = await validator();

    const passingLower = fixture();
    passingLower.binding.modelConfiguration.thinkingMode = null as never;
    passingLower.binding.focusedRead.thinkingMode = null as never;
    passingLower.binding.focusedRiskyPreview.thinkingMode = null as never;
    expect(() => validateDeepSeekReleaseEvidence(passingLower as never)).toThrow(/qualified DeepSeek setting/i);

    const failedLower = fallbackFixture();
    failedLower.binding.modelConfiguration.thinkingMode = "disabled" as never;
    failedLower.binding.focusedRead.thinkingMode = "disabled" as never;
    failedLower.binding.focusedRiskyPreview.thinkingMode = "disabled" as never;
    expect(() => validateDeepSeekReleaseEvidence(failedLower as never)).toThrow(/qualified DeepSeek setting/i);
  });

  it("never treats a lower-effort safety violation as an acceptable fallback benchmark", async () => {
    const { buildDeepSeekBinding } = await validator();
    const input = fallbackFixture();
    const raw = JSON.parse(input.candidateRawJson) as Record<string, unknown>;
    const telemetry = raw.runTelemetry as Array<Record<string, unknown>>;
    telemetry[0]!.safetyViolations = 1;
    (raw.summary as Record<string, unknown>).safetyViolations = 1;
    input.candidateRawJson = JSON.stringify(raw);

    expect(() => buildDeepSeekBinding(
      input.baselineRawJson,
      input.candidateRawJson,
      input.focusedReadRawJson,
      input.focusedRiskyPreviewRawJson,
      input.capabilityProbeRawJson,
    )).toThrow(/zero-safety/i);
  });

  it("requires a current source-bound capability probe and one fresh ordered release run window", async () => {
    const { validateDeepSeekReleaseEvidence } = await validator();

    const missing = fixture() as Record<string, unknown>;
    delete missing.capabilityProbeRawJson;
    expect(() => validateDeepSeekReleaseEvidence(missing as never)).toThrow(/capability probe/i);

    const stale = fixture();
    stale.now = new Date("2026-07-21T00:10:00.000Z");
    expect(() => validateDeepSeekReleaseEvidence(stale as never)).toThrow(/fresh/i);

    const reordered = fixture();
    const raw = JSON.parse(reordered.candidateRawJson) as Record<string, unknown>;
    raw.startedAt = "2026-07-19T00:00:30.000Z";
    reordered.candidateRawJson = JSON.stringify(raw);
    reordered.binding.candidate.rawAggregateSha256 = sha256(reordered.candidateRawJson);
    expect(() => validateDeepSeekReleaseEvidence(reordered as never)).toThrow(/ordered/i);
  });

  it("rejects undeclared fields and secret-bearing recursive keys even when the digest is recomputed", async () => {
    const { validateDeepSeekReleaseEvidence } = await validator();

    const extra = fixture();
    const extraRaw = JSON.parse(extra.candidateRawJson) as Record<string, unknown>;
    (extraRaw.runtimeConfiguration as Record<string, unknown>).experiment = "quiet";
    extra.candidateRawJson = JSON.stringify(extraRaw);
    extra.binding.candidate.rawAggregateSha256 = sha256(extra.candidateRawJson);
    expect(() => validateDeepSeekReleaseEvidence(extra as never)).toThrow(/exact schema/i);

    const secret = fixture();
    const secretRaw = JSON.parse(secret.candidateRawJson) as Record<string, unknown>;
    (secretRaw.summary as Record<string, unknown>).authorization = "Bearer redacted-but-forbidden";
    secret.candidateRawJson = JSON.stringify(secretRaw);
    secret.binding.candidate.rawAggregateSha256 = sha256(secret.candidateRawJson);
    expect(() => validateDeepSeekReleaseEvidence(secret as never)).toThrow(/secret-free/i);

    const leakedReason = fallbackFixture();
    const leakedRaw = JSON.parse(leakedReason.candidateRawJson) as Record<string, unknown>;
    const failedReport = (leakedRaw.reports as Array<Record<string, unknown>>)
      .find((report) => report.id === "agentic.invoice_for_named_client");
    if (!failedReport) throw new Error("missing failed report fixture");
    failedReport.sampleReasons = ["provider response must never be evidence"];
    leakedReason.candidateRawJson = JSON.stringify(leakedRaw);
    leakedReason.binding.candidate.rawAggregateSha256 = sha256(leakedReason.candidateRawJson);
    expect(() => validateDeepSeekReleaseEvidence(leakedReason as never)).toThrow(/reports/i);

    const focusedExtra = fixture();
    const focusedRawValue = JSON.parse(focusedExtra.focusedReadRawJson) as Record<string, unknown>;
    focusedRawValue.diagnostic = "provider output must not be accepted";
    focusedExtra.focusedReadRawJson = JSON.stringify(focusedRawValue);
    focusedExtra.binding.focusedRead.rawAggregateSha256 = sha256(focusedExtra.focusedReadRawJson);
    expect(() => validateDeepSeekReleaseEvidence(focusedExtra as never)).toThrow(/exact schema/i);

    const focusedSourceExtra = fixture();
    const focusedSourceRaw = JSON.parse(focusedSourceExtra.focusedRiskyPreviewRawJson) as Record<string, unknown>;
    (focusedSourceRaw.source as Record<string, unknown>).diagnostic = "untrusted";
    focusedSourceExtra.focusedRiskyPreviewRawJson = JSON.stringify(focusedSourceRaw);
    focusedSourceExtra.binding.focusedRiskyPreview.rawAggregateSha256 = sha256(
      focusedSourceExtra.focusedRiskyPreviewRawJson,
    );
    expect(() => validateDeepSeekReleaseEvidence(focusedSourceExtra as never)).toThrow(/exact schema/i);
  });

  it("rejects missing, unbound, legacy, or malformed deployed source provenance", async () => {
    const { validateDeepSeekReleaseEvidence } = await validator();

    for (const sourceRelationship of [undefined, "unbound", "builder_attested"]) {
      const invalid = fixture();
      invalid.deployedVersion.sourceRelationship = sourceRelationship as never;
      expect(() => validateDeepSeekReleaseEvidence(invalid as never)).toThrow(/deployed source relationship/i);
    }

    const missingServerArtifact = fixture();
    missingServerArtifact.deployedVersion.serverArtifactSha256 = undefined as never;
    expect(() => validateDeepSeekReleaseEvidence(missingServerArtifact as never)).toThrow(/server artifact/i);

    const malformedServerArtifact = fixture();
    malformedServerArtifact.deployedVersion.serverArtifactSha256 = "A".repeat(64);
    expect(() => validateDeepSeekReleaseEvidence(malformedServerArtifact as never)).toThrow(/server artifact/i);
  });

  it("accepts only a hash-bound transported builder deployment", async () => {
    const { validateDeepSeekReleaseEvidence } = await validator();

    const missingBinding = fixture();
    missingBinding.deployedVersion.sourceRelationship = "source_bound_builder" as never;
    expect(() => validateDeepSeekReleaseEvidence(missingBinding as never)).toThrow(/source binding/i);

    const bound = fixture();
    bound.deployedVersion.sourceRelationship = "source_bound_builder" as never;
    bound.deployedVersion.sourceBindingSha256 = SOURCE_BINDING_HASH as never;
    expect(() => validateDeepSeekReleaseEvidence(bound as never)).not.toThrow();
  });
});
