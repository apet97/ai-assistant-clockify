import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { FAST_4G_PROFILE, summarize, type Distribution } from "../performance/local-ui-contract.js";
import {
  PRIVATE_PRODUCTION_MAX_MEASUREMENT_WINDOW_MS,
  PRIVATE_PRODUCTION_SAMPLE_COUNTS,
  PRIVATE_PRODUCTION_THRESHOLDS,
  assertSecretFreeEvidence,
  privateProductionMeasurementSha256,
  validateDeployedRelease,
  type PrivateProductionEvidence,
  type PrivateProductionSamples,
  type PrivateProductionSourceRelationship,
} from "../performance/private-production-contract.js";
import { candidateProductVersion } from "../lib/candidate-product-version.js";
import {
  classifyHistoricalV1Evidence,
  type EvidenceTargetAssistantEngine,
  type HistoricalV1EvidenceClassification,
} from "./release-evidence.js";

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_EVIDENCE_BYTES = 1_048_576;
const EVIDENCE_PATH = "evidence/performance/private-production.json";

type JsonObject = Record<string, unknown>;

export interface PrivateProductionReleaseEvidenceInput {
  evidence: unknown;
  deployedVersion: unknown;
  expectedCandidateSha: string;
  /** Injected only by unit tests, whose candidate SHA is synthetic and has no
   * commit to read. Production always resolves the real candidate's version. */
  productVersionResolver?: (releaseSha: string) => string;
}

export interface PrivateProductionReleaseValidation extends HistoricalV1EvidenceClassification {
  schemaVersion: 1;
  conclusion: "passed";
  sourceCandidateSha: string;
  releaseBuildHash: string;
  serverArtifactSha256: string;
  sourceRelationship: PrivateProductionSourceRelationship;
  sourceBindingSha256: string | null;
  metricsPassed: 5;
  cleanup: {
    created: number;
    deletionProven: number;
    pendingPreviews: number;
  };
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is malformed`);
  }
  return value as JsonObject;
}

function exactKeys(value: JsonObject, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new Error(`${label} shape is malformed`);
  }
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} is malformed`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  const result = finiteNumber(value, label);
  if (!Number.isSafeInteger(result)) throw new Error(`${label} is malformed`);
  return result;
}

function fullCommit(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
    throw new Error(`${label} is malformed`);
  }
  return value;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} is malformed`);
  }
  return value;
}

function isoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is malformed`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(`${label} is malformed`);
  }
  return value;
}

function assertExactValues(
  value: unknown,
  expected: Readonly<Record<string, unknown>>,
  label: string,
): void {
  const record = object(value, label);
  exactKeys(record, Object.keys(expected), label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (record[key] !== expectedValue) throw new Error(`${label} ${key} mismatch`);
  }
}

function validateSource(value: unknown, expectedCandidateSha: string): {
  commitSha: string;
  releaseBuildHash: string;
  serverArtifactSha256: string;
  sourceRelationship: PrivateProductionSourceRelationship;
  sourceBindingSha256: string | null;
} {
  const source = object(value, "private-production source");
  exactKeys(source, [
    "commitSha",
    "releaseBuildHash",
    "serverArtifactSha256",
    "sourceRelationship",
    "sourceBindingSha256",
  ], "private-production source");
  const commitSha = fullCommit(source.commitSha, "private-production source candidate SHA");
  if (commitSha !== expectedCandidateSha) {
    throw new Error("private-production source candidate SHA mismatch");
  }
  const releaseBuildHash = sha256(source.releaseBuildHash, "private-production release build hash");
  const serverArtifactSha256 = sha256(source.serverArtifactSha256, "private-production runtime artifact");
  const relationship = source.sourceRelationship;
  if (
    relationship !== "exact_head"
    && relationship !== "evidence_descendant"
    && relationship !== "source_bound_builder"
  ) {
    throw new Error("private-production source relationship is malformed");
  }
  const sourceBindingSha256 = relationship === "source_bound_builder"
    ? sha256(source.sourceBindingSha256, "private-production source binding")
    : null;
  if (relationship !== "source_bound_builder" && source.sourceBindingSha256 !== null) {
    throw new Error("private-production source binding is inconsistent");
  }
  return {
    commitSha,
    releaseBuildHash,
    serverArtifactSha256,
    sourceRelationship: relationship,
    sourceBindingSha256,
  };
}

const METRIC_SPECS = [
  {
    name: "warmIframeInteractive",
    sampleField: "warmIframeInteractiveMs",
    observedField: "p95Ms",
    thresholdField: "thresholdP95Ms",
    threshold: PRIVATE_PRODUCTION_THRESHOLDS.warmIframeP95Ms,
    samples: PRIVATE_PRODUCTION_SAMPLE_COUNTS.warmIframeInteractive,
  },
  {
    name: "coldFast4gInteractive",
    sampleField: "coldFast4gInteractiveMs",
    observedField: "p95Ms",
    thresholdField: "thresholdP95Ms",
    threshold: PRIVATE_PRODUCTION_THRESHOLDS.coldFast4gP95Ms,
    samples: PRIVATE_PRODUCTION_SAMPLE_COUNTS.coldFast4gInteractive,
  },
  {
    name: "historyApi",
    sampleField: "historyApiMs",
    observedField: "p95Ms",
    thresholdField: "thresholdP95Ms",
    threshold: PRIVATE_PRODUCTION_THRESHOLDS.historyApiP95Ms,
    samples: PRIVATE_PRODUCTION_SAMPLE_COUNTS.historyApi,
  },
  {
    name: "localStatus",
    sampleField: "localStatusMs",
    observedField: "maxMs",
    thresholdField: "thresholdMaxMs",
    threshold: PRIVATE_PRODUCTION_THRESHOLDS.localStatusMaxMs,
    samples: PRIVATE_PRODUCTION_SAMPLE_COUNTS.localStatus,
  },
  {
    name: "confirmationFirstReceipt",
    sampleField: "confirmationFirstReceiptMs",
    observedField: "p95Ms",
    thresholdField: "thresholdP95Ms",
    threshold: PRIVATE_PRODUCTION_THRESHOLDS.confirmationFirstReceiptP95Ms,
    samples: PRIVATE_PRODUCTION_SAMPLE_COUNTS.confirmationFirstReceipt,
  },
] as const;

function validateMeasurements(
  value: unknown,
  source: ReturnType<typeof validateSource>,
  generatedAt: string,
): PrivateProductionSamples {
  const measurements = object(value, "private-production measurements");
  exactKeys(measurements, ["startedAt", "completedAt", "sha256", "samples"], "private-production measurements");
  const startedAt = isoTimestamp(measurements.startedAt, "private-production measurement start");
  const completedAt = isoTimestamp(measurements.completedAt, "private-production measurement completion");
  if (completedAt !== generatedAt) {
    throw new Error("private-production measurement time does not bind generatedAt");
  }
  const durationMs = Date.parse(completedAt) - Date.parse(startedAt);
  if (durationMs < 0 || durationMs > PRIVATE_PRODUCTION_MAX_MEASUREMENT_WINDOW_MS) {
    throw new Error("private-production measurement time window is invalid");
  }
  const raw = object(measurements.samples, "private-production measurement samples");
  exactKeys(raw, METRIC_SPECS.map((spec) => spec.sampleField), "private-production measurement samples");
  const samples = {} as PrivateProductionSamples;
  for (const spec of METRIC_SPECS) {
    const values = raw[spec.sampleField];
    if (!Array.isArray(values) || values.length !== spec.samples) {
      throw new Error(`${spec.name} measurement requires exactly ${spec.samples} samples`);
    }
    const validated = values.map((sample) => finiteNumber(sample, `${spec.name} measurement sample`));
    samples[spec.sampleField] = validated;
  }
  const digest = sha256(measurements.sha256, "private-production measurement digest");
  const expectedDigest = privateProductionMeasurementSha256({
    source,
    startedAt,
    completedAt,
    samples,
  });
  if (digest !== expectedDigest) {
    throw new Error("private-production measurement digest mismatch");
  }
  return samples;
}

function distributionEquals(metric: JsonObject, expected: Distribution): boolean {
  return metric.samples === expected.samples
    && metric.minMs === expected.minMs
    && metric.p50Ms === expected.p50Ms
    && metric.p95Ms === expected.p95Ms
    && metric.maxMs === expected.maxMs;
}

function validateMetrics(value: unknown, samples: PrivateProductionSamples): void {
  const metrics = object(value, "private-production metrics");
  exactKeys(metrics, METRIC_SPECS.map((spec) => spec.name), "private-production metrics");
  for (const spec of METRIC_SPECS) {
    const metric = object(metrics[spec.name], `${spec.name} metric`);
    exactKeys(metric, [
      "samples",
      "minMs",
      "p50Ms",
      "p95Ms",
      "maxMs",
      spec.thresholdField,
      "passed",
    ], `${spec.name} metric`);
    if (integer(metric.samples, `${spec.name} metric sample count`) !== spec.samples) {
      throw new Error(`${spec.name} metric sample count mismatch`);
    }
    const min = finiteNumber(metric.minMs, `${spec.name} metric minimum`);
    const p50 = finiteNumber(metric.p50Ms, `${spec.name} metric p50`);
    const p95 = finiteNumber(metric.p95Ms, `${spec.name} metric p95`);
    const max = finiteNumber(metric.maxMs, `${spec.name} metric maximum`);
    if (!(min <= p50 && p50 <= p95 && p95 <= max)) {
      throw new Error(`${spec.name} metric distribution is inconsistent`);
    }
    const recomputed = summarize(samples[spec.sampleField]);
    if (!distributionEquals(metric, recomputed)) {
      throw new Error(`${spec.name} metric aggregate does not match exact measurements`);
    }
    if (metric[spec.thresholdField] !== spec.threshold) {
      throw new Error(`${spec.name} threshold mismatch`);
    }
    const observed = spec.observedField === "maxMs" ? max : p95;
    if (metric.passed !== true || !(observed < spec.threshold)) {
      throw new Error(`${spec.name} metric does not pass its strict threshold`);
    }
  }
}

/** Re-evaluate the committed aggregate evidence and bind it to a fresh deployed
 * `/version` response. Stored verdict booleans are never accepted on trust. */
export function validatePrivateProductionReleaseEvidence(
  input: PrivateProductionReleaseEvidenceInput,
  targetAssistantEngine: EvidenceTargetAssistantEngine = "v1",
): PrivateProductionReleaseValidation {
  const classification = classifyHistoricalV1Evidence(targetAssistantEngine);
  const expectedCandidateSha = fullCommit(input.expectedCandidateSha, "expected candidate SHA");
  const evidence = object(input.evidence, "private-production evidence");
  exactKeys(evidence, [
    "schemaVersion",
    "kind",
    "generatedAt",
    "source",
    "measurements",
    "runtime",
    "sampleCounts",
    "thresholds",
    "metrics",
    "cleanup",
    "conclusion",
    "failures",
  ], "private-production evidence");
  if (evidence.schemaVersion !== 1 || evidence.kind !== "private_production_performance") {
    throw new Error("private-production evidence schema is unsupported");
  }
  const generatedAt = isoTimestamp(evidence.generatedAt, "private-production generation time");
  const source = validateSource(evidence.source, expectedCandidateSha);
  const samples = validateMeasurements(evidence.measurements, source, generatedAt);

  const runtime = object(evidence.runtime, "private-production runtime");
  exactKeys(runtime, ["node", "browser", "browserVersion", "networkProfile"], "private-production runtime");
  if (typeof runtime.node !== "string" || !/^v22\./u.test(runtime.node)) {
    throw new Error("private-production evidence requires Node 22");
  }
  if (runtime.browser !== "Chromium" || typeof runtime.browserVersion !== "string" || runtime.browserVersion.length === 0) {
    throw new Error("private-production browser runtime is malformed");
  }
  assertExactValues(runtime.networkProfile, FAST_4G_PROFILE, "private-production network profile");
  assertExactValues(evidence.sampleCounts, PRIVATE_PRODUCTION_SAMPLE_COUNTS, "private-production sample counts");
  assertExactValues(evidence.thresholds, PRIVATE_PRODUCTION_THRESHOLDS, "private-production thresholds");
  validateMetrics(evidence.metrics, samples);

  const cleanup = object(evidence.cleanup, "private-production cleanup");
  exactKeys(cleanup, ["created", "deletionProven", "pendingPreviews", "passed"], "private-production cleanup");
  const created = integer(cleanup.created, "private-production cleanup created count");
  const deletionProven = integer(cleanup.deletionProven, "private-production cleanup deletion count");
  const pendingPreviews = integer(cleanup.pendingPreviews, "private-production cleanup pending previews");
  if (
    created !== PRIVATE_PRODUCTION_SAMPLE_COUNTS.confirmationFirstReceipt
    || deletionProven !== created
    || pendingPreviews !== 0
    || cleanup.passed !== true
  ) {
    throw new Error("private-production cleanup proof is incomplete");
  }
  if (evidence.conclusion !== "passed" || !Array.isArray(evidence.failures) || evidence.failures.length !== 0) {
    throw new Error("private-production conclusion is not passed");
  }

  const deployed = validateDeployedRelease(
    input.deployedVersion,
    expectedCandidateSha,
    source.releaseBuildHash,
    // The attested candidate's own declared version. For the frozen v1 record
    // this resolves to 1.0.0 exactly as before; nothing historical is rewritten.
    (input.productVersionResolver ?? candidateProductVersion)(expectedCandidateSha),
  );
  if (deployed.serverArtifactSha256 !== source.serverArtifactSha256) {
    throw new Error("deployed runtime artifact mismatch");
  }
  if (deployed.sourceRelationship !== source.sourceRelationship) {
    throw new Error("deployed source relationship mismatch");
  }
  if (deployed.sourceBindingSha256 !== source.sourceBindingSha256) {
    throw new Error("deployed source binding mismatch");
  }
  assertSecretFreeEvidence(evidence as unknown as PrivateProductionEvidence);

  return {
    ...classification,
    schemaVersion: 1,
    conclusion: "passed",
    sourceCandidateSha: expectedCandidateSha,
    releaseBuildHash: source.releaseBuildHash,
    serverArtifactSha256: source.serverArtifactSha256,
    sourceRelationship: source.sourceRelationship,
    sourceBindingSha256: source.sourceBindingSha256,
    metricsPassed: 5,
    cleanup: { created, deletionProven, pendingPreviews },
  };
}

/** Post-candidate commits may contain release evidence, never executable or
 * operational source. This permits one consolidated evidence-only PR head. */
export function isPrivateProductionEvidencePath(path: string): boolean {
  return !path.startsWith("/")
    && !path.includes("\\")
    && (path.startsWith("evidence/") || path.startsWith("docs/marketplace/evidence/"));
}

function git(args: readonly string[], cwd = process.cwd()): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export function assertPrivateProductionEvidenceOnlyDescendant(
  sourceCandidateSha: string,
  evidenceCommitSha: string,
  cwd = process.cwd(),
): void {
  fullCommit(sourceCandidateSha, "source candidate SHA");
  fullCommit(evidenceCommitSha, "evidence commit SHA");
  if (git(["rev-parse", "HEAD"], cwd) !== evidenceCommitSha) {
    throw new Error("evidence commit SHA must match the checked-out commit");
  }
  if (git(["status", "--porcelain", "--untracked-files=all"], cwd) !== "") {
    throw new Error("private-production evidence validation requires a clean checkout");
  }
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sourceCandidateSha, evidenceCommitSha], {
      cwd,
      stdio: "ignore",
    });
  } catch {
    throw new Error("source candidate must be an ancestor of the evidence commit");
  }
  const changed = sourceCandidateSha === evidenceCommitSha
    ? []
    : git(["diff", "--name-only", `${sourceCandidateSha}..${evidenceCommitSha}`], cwd)
      .split("\n")
      .filter(Boolean);
  const forbidden = changed.filter((path) => !isPrivateProductionEvidencePath(path));
  if (forbidden.length > 0) {
    throw new Error(`evidence commit contains non-evidence changes: ${forbidden.join(", ")}`);
  }
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", EVIDENCE_PATH], { cwd, stdio: "ignore" });
  } catch {
    throw new Error("committed private-production aggregate evidence is missing");
  }
}

function readBoundedJson(path: string, label: string): JsonObject {
  const absolute = resolve(path);
  const info = lstatSync(absolute);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_EVIDENCE_BYTES) {
    throw new Error(`${label} is missing, unsafe, or too large`);
  }
  return object(JSON.parse(readFileSync(absolute, "utf8")) as unknown, label);
}

function writeAtomic(path: string, value: unknown): void {
  const absolute = resolve(path);
  const temporary = `${absolute}.tmp`;
  mkdirSync(dirname(absolute), { recursive: true });
  rmSync(temporary, { force: true });
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, absolute);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function main(): void {
  const sourceCandidateSha = requiredEnvironment("PRIVATE_PRODUCTION_EXPECTED_CANDIDATE_SHA");
  const evidenceCommitSha = requiredEnvironment("PRIVATE_PRODUCTION_EVIDENCE_COMMIT_SHA");
  assertPrivateProductionEvidenceOnlyDescendant(sourceCandidateSha, evidenceCommitSha);
  const result = validatePrivateProductionReleaseEvidence({
    evidence: readBoundedJson(EVIDENCE_PATH, "committed private-production evidence"),
    deployedVersion: readBoundedJson(
      requiredEnvironment("PRIVATE_PRODUCTION_DEPLOYED_VERSION_PATH"),
      "deployed version",
    ),
    expectedCandidateSha: sourceCandidateSha,
  }, "v1");
  writeAtomic(
    process.env.PRIVATE_PRODUCTION_VALIDATION_PATH ?? "/tmp/private-production-release-validation.json",
    result,
  );
  process.stdout.write(`Private-production release evidence passed for ${result.sourceCandidateSha}.\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  try {
    main();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "private-production evidence validation failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
