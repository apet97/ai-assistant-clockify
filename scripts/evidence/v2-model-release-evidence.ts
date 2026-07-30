import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyCurrentV2Evidence,
  classifyV2Evaluation,
  type CurrentV2EvidenceClassification,
  type EvidenceTargetAssistantEngine,
  type V2EvaluationInput,
} from "./release-evidence.js";
import { verifyDeployedV2Engine } from "./v2-deployed-engine.js";
import { writeDeterministicJson } from "./write-json.js";

/**
 * B6 — the v2 sibling of `deepseek-release-evidence.ts` (the v1 model-release
 * validator, which is the v1 ROLLBACK CONTRACT and stays untouched).
 *
 * V2's model evidence is not a DeepSeek five-pass corpus: it is the three v2
 * evaluation reports (`eval:api-discovery`, `eval:assistant-terminal`,
 * `eval:write-safety`) in the deterministic `scripts/eval-v2/report.ts` shape,
 * each classified by the same fail-closed `classifyV2Evaluation` the aggregate
 * uses — so the aggregate and this validator can never disagree about what a
 * passing evaluation is. Mirroring the v1 pair, the release validation
 * additionally binds a deployed `/version` payload proving production serves
 * the exact candidate on the v2 engine; the benchmark variant omits that and is
 * honestly marked unverified.
 */

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

const EVALUATION_NAMES = ["apiDiscovery", "assistantTerminal", "writeSafety"] as const;
type EvaluationName = (typeof EVALUATION_NAMES)[number];
const EVALUATION_KINDS: Record<EvaluationName, string> = {
  apiDiscovery: "v2_api_discovery",
  assistantTerminal: "v2_assistant_terminal",
  writeSafety: "v2_write_safety",
};

export interface V2ModelReleaseEvidenceInput {
  apiDiscovery: unknown;
  assistantTerminal: unknown;
  writeSafety: unknown;
  deployedVersion: unknown;
  expectedCandidateSha: string;
  expectedCatalogHash: string;
}

export interface V2ModelReleaseEvidence extends CurrentV2EvidenceClassification {
  schemaVersion: 1;
  kind: "v2-model-release-validation";
  conclusion: "passed";
  testedCandidateSha: string;
  catalogHash: string;
  evaluations: Record<EvaluationName, "passed">;
  deployedConfigurationVerified: true;
}

export type V2ModelBenchmarkEvidence = Omit<V2ModelReleaseEvidence, "deployedConfigurationVerified"> & {
  deployedConfigurationVerified: false;
};

/** Every evaluation must be `passed` — a sentinel or partial report throws, naming the evaluation. */
export function validateV2ModelBenchmarkEvidence(
  input: Omit<V2ModelReleaseEvidenceInput, "deployedVersion">,
  targetAssistantEngine: EvidenceTargetAssistantEngine = "v2",
): V2ModelBenchmarkEvidence {
  const classification = classifyCurrentV2Evidence(targetAssistantEngine);
  if (!SHA_PATTERN.test(input.expectedCandidateSha)) {
    throw new Error("expected candidate SHA must be a full lowercase commit SHA");
  }
  if (!SHA256_PATTERN.test(input.expectedCatalogHash)) {
    throw new Error("expected catalog hash must be a lowercase SHA-256 digest");
  }
  const expected = {
    candidateSha: input.expectedCandidateSha,
    catalogHash: input.expectedCatalogHash,
  };
  const evaluations = {} as Record<EvaluationName, "passed">;
  for (const name of EVALUATION_NAMES) {
    const report = input[name];
    const status = classifyV2Evaluation(
      report && typeof report === "object" ? (report as V2EvaluationInput) : undefined,
      { ...expected, kind: EVALUATION_KINDS[name] },
    );
    if (status !== "passed") {
      throw new Error(`${name} evaluation is ${status} for the candidate`);
    }
    evaluations[name] = "passed";
  }
  return {
    ...classification,
    schemaVersion: 1,
    kind: "v2-model-release-validation",
    conclusion: "passed",
    testedCandidateSha: input.expectedCandidateSha,
    catalogHash: input.expectedCatalogHash,
    evaluations,
    deployedConfigurationVerified: false,
  };
}

export function validateV2ModelReleaseEvidence(
  input: V2ModelReleaseEvidenceInput,
  targetAssistantEngine: EvidenceTargetAssistantEngine = "v2",
): V2ModelReleaseEvidence {
  const benchmark = validateV2ModelBenchmarkEvidence(input, targetAssistantEngine);
  verifyDeployedV2Engine(input.deployedVersion, benchmark.testedCandidateSha);
  return { ...benchmark, deployedConfigurationVerified: true };
}

function requiredEnvironment(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function validateV2ModelReleaseEvidenceFromEnvironment(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): { outputPath: string; evidence: V2ModelReleaseEvidence } {
  const outputPath = requiredEnvironment(env, "V2_MODEL_VALIDATION_PATH");
  const readJson = (name: string): unknown =>
    JSON.parse(readFile(requiredEnvironment(env, name))) as unknown;
  const evidence = validateV2ModelReleaseEvidence({
    apiDiscovery: readJson("V2_EVAL_API_DISCOVERY_REPORT_PATH"),
    assistantTerminal: readJson("V2_EVAL_ASSISTANT_TERMINAL_REPORT_PATH"),
    writeSafety: readJson("V2_EVAL_WRITE_SAFETY_REPORT_PATH"),
    deployedVersion: readJson("V2_MODEL_DEPLOYED_VERSION_PATH"),
    expectedCandidateSha: env.V2_MODEL_EXPECTED_CANDIDATE_SHA ?? "",
    expectedCatalogHash: env.V2_MODEL_EXPECTED_CATALOG_HASH ?? "",
  });
  return { outputPath, evidence };
}

function main(): void {
  const { outputPath, evidence } = validateV2ModelReleaseEvidenceFromEnvironment(process.env);
  writeDeterministicJson(outputPath, evidence);
  process.stdout.write(`V2 model release evidence passed for ${evidence.testedCandidateSha}.\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`v2 model release evidence validation failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
