import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyCurrentV2Evidence,
  type CurrentV2EvidenceClassification,
  type EvidenceTargetAssistantEngine,
} from "./release-evidence.js";
import { verifyDeployedV2Engine } from "./v2-deployed-engine.js";
import { writeDeterministicJson } from "./write-json.js";

/**
 * B6 — the v2 sibling of `live-browser-acceptance.ts` (the v1 browser-evidence
 * validator, which is the v1 ROLLBACK CONTRACT and stays untouched).
 *
 * The v2 journey list is not the v1 ten: it is the fifteen real-server
 * journeys of `tests/e2e-real/journeys.spec.ts` — the authoritative v2 product
 * journey set — replayed in embedded production Chrome. Member rejection is a
 * journey here, not a separate artifact, because that is how the v2 matrix
 * proves it. Every string field is pattern- or exact-matched and every object
 * is closed (unknown keys reject), so an accepted artifact is secret-free by
 * construction.
 */

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const BROWSER_VERSION_PATTERN = /^\d+(?:\.\d+){1,4}$/u;
const MAX_RUN_MS = 4 * 60 * 60 * 1_000;

/** In the exact order `tests/e2e-real/journeys.spec.ts` runs them. */
export const V2_BROWSER_JOURNEY_IDS = [
  "read_grounded_answer_card_reload",
  "read_failure_next_message",
  "preview_zero_premutation",
  "single_confirm_receipt",
  "cancel_settles_preview",
  "expired_preview_refuses",
  "batch_confirm_all",
  "batch_cancel_all",
  "batch_ambiguity_stop",
  "clarify_option_chip",
  "clarify_free_text",
  "request_replay_stored_result",
  "stale_nonce_rearm",
  "history_switcher_restore",
  "member_rejected_before_session",
] as const;

export type V2BrowserJourneyId = (typeof V2_BROWSER_JOURNEY_IDS)[number];

export interface V2LiveBrowserAcceptanceInput {
  evidence: unknown;
  deployedVersion: unknown;
  expectedCandidateSha: string;
}

export interface V2LiveBrowserAcceptanceValidation extends CurrentV2EvidenceClassification {
  schemaVersion: 1;
  kind: "v2-live-browser-acceptance-validation";
  conclusion: "passed";
  sourceCandidateSha: string;
  releaseBuildHash: string;
  serverArtifactSha256: string;
  browser: "Google Chrome";
  browserVersion: string;
  surface: "clockify_embedded_iframe";
  startedAt: string;
  completedAt: string;
  journeyCount: 15;
  cleanup: {
    resourcePrefix: "AIASSIST_SMOKE_";
    created: number;
    deletionProven: number;
    remaining: 0;
    pendingPreviews: 0;
  };
}

type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is malformed`);
  }
  return value as JsonObject;
}

function exactKeys(value: JsonObject, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} keys are malformed`);
  }
}

function iso(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is malformed`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} is malformed`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} is malformed`);
  return Number(value);
}

function validateJourneys(value: unknown): void {
  if (!Array.isArray(value) || value.length !== V2_BROWSER_JOURNEY_IDS.length) {
    throw new Error("v2 browser journeys must cover every real-server journey exactly once");
  }
  for (const [index, entry] of value.entries()) {
    const journey = object(entry, `v2 browser journeys[${index}]`);
    exactKeys(journey, ["id", "passed"], `v2 browser journeys[${index}]`);
    const expectedId = V2_BROWSER_JOURNEY_IDS[index]!;
    if (journey.id !== expectedId) {
      throw new Error(`v2 browser journeys[${index}] must be ${expectedId} in the pinned order`);
    }
    if (journey.passed !== true) throw new Error(`v2 browser journey ${expectedId} did not pass`);
  }
}

export function validateV2LiveBrowserAcceptanceEvidence(
  input: V2LiveBrowserAcceptanceInput,
  targetAssistantEngine: EvidenceTargetAssistantEngine = "v2",
): V2LiveBrowserAcceptanceValidation {
  const classification = classifyCurrentV2Evidence(targetAssistantEngine);
  if (!SHA_PATTERN.test(input.expectedCandidateSha)) {
    throw new Error("expected candidate SHA must be a full lowercase commit SHA");
  }
  const row = object(input.evidence, "v2 live browser evidence");
  exactKeys(row, [
    "schemaVersion",
    "kind",
    "conclusion",
    "candidateSha",
    "startedAt",
    "completedAt",
    "runtime",
    "journeys",
    "cleanup",
  ], "v2 live browser evidence");
  if (row.schemaVersion !== 1 || row.kind !== "v2_production_browser_acceptance" || row.conclusion !== "passed") {
    throw new Error("v2 live browser evidence did not pass");
  }
  if (row.candidateSha !== input.expectedCandidateSha) {
    throw new Error("v2 live browser candidate mismatch");
  }
  const startedAt = iso(row.startedAt, "v2 live browser start time");
  const completedAt = iso(row.completedAt, "v2 live browser completion time");
  const startMs = Date.parse(startedAt);
  const completedMs = Date.parse(completedAt);
  if (completedMs < startMs || completedMs - startMs > MAX_RUN_MS) {
    throw new Error("v2 live browser evidence time window is invalid");
  }

  const runtime = object(row.runtime, "v2 browser runtime");
  exactKeys(runtime, ["browser", "browserVersion", "surface"], "v2 browser runtime");
  if (
    runtime.browser !== "Google Chrome"
    || typeof runtime.browserVersion !== "string"
    || !BROWSER_VERSION_PATTERN.test(runtime.browserVersion)
    || runtime.surface !== "clockify_embedded_iframe"
  ) throw new Error("v2 browser runtime is invalid");
  validateJourneys(row.journeys);

  const cleanup = object(row.cleanup, "v2 browser cleanup");
  exactKeys(cleanup, ["resourcePrefix", "created", "deletionProven", "remaining", "pendingPreviews"], "v2 browser cleanup");
  const created = nonNegativeInteger(cleanup.created, "v2 browser cleanup created count");
  const deletionProven = nonNegativeInteger(cleanup.deletionProven, "v2 browser cleanup deletion count");
  if (
    cleanup.resourcePrefix !== "AIASSIST_SMOKE_"
    || created < 1
    || deletionProven !== created
    || cleanup.remaining !== 0
    || cleanup.pendingPreviews !== 0
  ) throw new Error("v2 browser cleanup proof is incomplete");

  const deployed = verifyDeployedV2Engine(input.deployedVersion, input.expectedCandidateSha);

  return {
    ...classification,
    schemaVersion: 1,
    kind: "v2-live-browser-acceptance-validation",
    conclusion: "passed",
    sourceCandidateSha: input.expectedCandidateSha,
    releaseBuildHash: deployed.buildHash,
    serverArtifactSha256: deployed.serverArtifactSha256,
    browser: "Google Chrome",
    browserVersion: runtime.browserVersion,
    surface: "clockify_embedded_iframe",
    startedAt,
    completedAt,
    journeyCount: 15,
    cleanup: {
      resourcePrefix: "AIASSIST_SMOKE_",
      created,
      deletionProven,
      remaining: 0,
      pendingPreviews: 0,
    },
  };
}

function requiredEnvironment(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function validateV2LiveBrowserAcceptanceEvidenceFromEnvironment(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): { outputPath: string; validation: V2LiveBrowserAcceptanceValidation } {
  const outputPath = requiredEnvironment(env, "V2_LIVE_BROWSER_VALIDATION_PATH");
  const readJson = (name: string): unknown =>
    JSON.parse(readFile(requiredEnvironment(env, name))) as unknown;
  const validation = validateV2LiveBrowserAcceptanceEvidence({
    evidence: readJson("V2_LIVE_BROWSER_EVIDENCE_PATH"),
    deployedVersion: readJson("V2_LIVE_BROWSER_DEPLOYED_VERSION_PATH"),
    expectedCandidateSha: env.V2_LIVE_BROWSER_EXPECTED_CANDIDATE_SHA ?? "",
  });
  return { outputPath, validation };
}

function main(): void {
  const { outputPath, validation } = validateV2LiveBrowserAcceptanceEvidenceFromEnvironment(process.env);
  writeDeterministicJson(outputPath, validation);
  process.stdout.write(`V2 live browser acceptance passed for ${validation.sourceCandidateSha}.\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`v2 live browser acceptance validation failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
