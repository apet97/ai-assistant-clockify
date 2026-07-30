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
 * B6 — the v2 sibling of `private-production-release-evidence.ts` (the v1
 * private-production validator, which is the v1 ROLLBACK CONTRACT and stays
 * untouched).
 *
 * V2 has no released performance thresholds yet, so this sibling does not
 * pretend to validate a five-metric performance artifact — that would be a
 * fabricated contract. What a v2 private-production deployment can truthfully
 * attest today is exactly what the executed cutover record proved: `/version`
 * exact-matches the candidate on the v2 engine, and `/live`, `/health`, and
 * `/manifest` all answer 200. Every object is closed (unknown keys reject) and
 * every field is pattern- or exact-matched, so an accepted artifact is
 * secret-free by construction.
 */

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const PROBE_NAMES = ["live", "health", "manifest"] as const;

export interface V2PrivateProductionReleaseEvidenceInput {
  evidence: unknown;
  deployedVersion: unknown;
  expectedCandidateSha: string;
}

export interface V2PrivateProductionReleaseValidation extends CurrentV2EvidenceClassification {
  schemaVersion: 1;
  kind: "v2-private-production-release-validation";
  conclusion: "passed";
  sourceCandidateSha: string;
  releaseBuildHash: string;
  serverArtifactSha256: string;
  observedAt: string;
  probesPassed: 3;
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

export function validateV2PrivateProductionReleaseEvidence(
  input: V2PrivateProductionReleaseEvidenceInput,
  targetAssistantEngine: EvidenceTargetAssistantEngine = "v2",
): V2PrivateProductionReleaseValidation {
  const classification = classifyCurrentV2Evidence(targetAssistantEngine);
  if (!SHA_PATTERN.test(input.expectedCandidateSha)) {
    throw new Error("expected candidate SHA must be a full lowercase commit SHA");
  }
  const row = object(input.evidence, "v2 private-production evidence");
  exactKeys(row, [
    "schemaVersion",
    "kind",
    "conclusion",
    "candidateSha",
    "observedAt",
    "probes",
  ], "v2 private-production evidence");
  if (
    row.schemaVersion !== 1
    || row.kind !== "v2_private_production_deployment"
    || row.conclusion !== "passed"
  ) {
    throw new Error("v2 private-production evidence did not pass");
  }
  if (row.candidateSha !== input.expectedCandidateSha) {
    throw new Error("v2 private-production candidate mismatch");
  }
  const observedAt = row.observedAt;
  if (
    typeof observedAt !== "string"
    || !Number.isFinite(Date.parse(observedAt))
    || new Date(Date.parse(observedAt)).toISOString() !== observedAt
  ) {
    throw new Error("v2 private-production observedAt is malformed");
  }
  const probes = object(row.probes, "v2 private-production probes");
  exactKeys(probes, PROBE_NAMES, "v2 private-production probes");
  for (const probe of PROBE_NAMES) {
    if (probes[probe] !== 200) throw new Error(`v2 private-production ${probe} probe is not 200`);
  }

  const deployed = verifyDeployedV2Engine(input.deployedVersion, input.expectedCandidateSha);

  return {
    ...classification,
    schemaVersion: 1,
    kind: "v2-private-production-release-validation",
    conclusion: "passed",
    sourceCandidateSha: input.expectedCandidateSha,
    releaseBuildHash: deployed.buildHash,
    serverArtifactSha256: deployed.serverArtifactSha256,
    observedAt,
    probesPassed: 3,
  };
}

function requiredEnvironment(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function validateV2PrivateProductionReleaseEvidenceFromEnvironment(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): { outputPath: string; validation: V2PrivateProductionReleaseValidation } {
  const outputPath = requiredEnvironment(env, "V2_PRIVATE_PRODUCTION_VALIDATION_PATH");
  const readJson = (name: string): unknown =>
    JSON.parse(readFile(requiredEnvironment(env, name))) as unknown;
  const validation = validateV2PrivateProductionReleaseEvidence({
    evidence: readJson("V2_PRIVATE_PRODUCTION_EVIDENCE_PATH"),
    deployedVersion: readJson("V2_PRIVATE_PRODUCTION_DEPLOYED_VERSION_PATH"),
    expectedCandidateSha: env.V2_PRIVATE_PRODUCTION_EXPECTED_CANDIDATE_SHA ?? "",
  });
  return { outputPath, validation };
}

function main(): void {
  const { outputPath, validation } = validateV2PrivateProductionReleaseEvidenceFromEnvironment(process.env);
  writeDeterministicJson(outputPath, validation);
  process.stdout.write(`V2 private-production release evidence passed for ${validation.sourceCandidateSha}.\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`v2 private-production evidence validation failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
