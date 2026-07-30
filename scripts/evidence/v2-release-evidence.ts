import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

import { writeDeterministicJson } from "./write-json.js";
import {
  buildV2ReleaseEvidence,
  releaseGateConclusionsFromEnvironment,
  type ReleaseEvidenceV2,
  type V2EvaluationInput,
} from "./release-evidence.js";
import {
  buildV2AuthorityEvidenceReport,
  V2_AUTHORITY_NOT_EVALUATED_SENTINEL,
  type RawV2AuthorityEvidenceInput,
  type V2AuthorityEvidenceReport,
} from "./v2-authority-evidence.js";

/**
 * B5 — the v2 CLI entry for release evidence. The v1 entry
 * (`release-evidence.ts` `main()`) hardcodes `"v1"` by design; this is the only
 * command that produces a `ReleaseEvidenceV2` artifact.
 *
 * Inputs (environment):
 * - `V2_RELEASE_EVIDENCE_PATH` (required) — where the artifact is written.
 * - `RELEASE_SOURCE_CANDIDATE_SHA` / `RELEASE_EVIDENCE_COMMIT_SHA` (required,
 *   full 40-hex) — the same names the v1 entry and the record job use.
 * - `V2_AUTHORITY_REPORT_PATH` (required) — the JSON artifact written by
 *   `scripts/evidence/v2-authority-evidence.ts`. A `complete` report is
 *   RE-VALIDATED here (evidence re-checked, conclusions re-derived), so a
 *   doctored file cannot smuggle a conclusion past the schema gate.
 * - `V2_EVAL_API_DISCOVERY_REPORT_PATH` / `V2_EVAL_ASSISTANT_TERMINAL_REPORT_PATH`
 *   / `V2_EVAL_WRITE_SAFETY_REPORT_PATH` (optional) — the three eval reports in
 *   the `scripts/eval-v2/report.ts` shape (the B4 evidence files). A missing
 *   path leaves that evaluation `rejected`, so `v2EvaluationComplete` stays
 *   honestly false.
 * - `RELEASE_GATE_*` — the shared machine-gate conclusions.
 */
export function buildV2ReleaseEvidenceFromEnvironment(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): { outputPath: string; evidence: ReleaseEvidenceV2 } {
  const outputPath = env.V2_RELEASE_EVIDENCE_PATH;
  if (!outputPath) throw new Error("V2_RELEASE_EVIDENCE_PATH is required");
  const authorityPath = env.V2_AUTHORITY_REPORT_PATH;
  if (!authorityPath) throw new Error("V2_AUTHORITY_REPORT_PATH is required");

  const evidence = buildV2ReleaseEvidence({
    sourceCandidateSha: env.RELEASE_SOURCE_CANDIDATE_SHA ?? "",
    evidenceCommitSha: env.RELEASE_EVIDENCE_COMMIT_SHA ?? "",
    machineConclusions: releaseGateConclusionsFromEnvironment(env),
    v2Authority: revalidateAuthorityReport(JSON.parse(readFile(authorityPath)) as unknown),
    evaluations: {
      apiDiscovery: readEvaluation(env.V2_EVAL_API_DISCOVERY_REPORT_PATH, readFile),
      assistantTerminal: readEvaluation(env.V2_EVAL_ASSISTANT_TERMINAL_REPORT_PATH, readFile),
      writeSafety: readEvaluation(env.V2_EVAL_WRITE_SAFETY_REPORT_PATH, readFile),
    },
  });
  return { outputPath, evidence };
}

/** Never trust the file's own conclusions — re-validate and re-derive them. */
function revalidateAuthorityReport(parsed: unknown): V2AuthorityEvidenceReport {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("v2 authority report is not an object");
  }
  const { status, evidence } = parsed as { status?: unknown; evidence?: unknown };
  if (status === V2_AUTHORITY_NOT_EVALUATED_SENTINEL) {
    return buildV2AuthorityEvidenceReport(V2_AUTHORITY_NOT_EVALUATED_SENTINEL);
  }
  if (status !== "complete") {
    throw new Error(`v2 authority report has an unknown status: ${JSON.stringify(status)}`);
  }
  if (typeof evidence !== "object" || evidence === null) {
    throw new Error("a complete v2 authority report requires an evidence object");
  }
  return buildV2AuthorityEvidenceReport(evidence as RawV2AuthorityEvidenceInput);
}

function readEvaluation(
  path: string | undefined,
  readFile: (path: string) => string,
): V2EvaluationInput | undefined {
  if (!path) return undefined;
  const parsed: unknown = JSON.parse(readFile(path));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`evaluation report at ${path} is not an object`);
  }
  return parsed as V2EvaluationInput;
}

function main(): void {
  const { outputPath, evidence } = buildV2ReleaseEvidenceFromEnvironment(process.env);
  writeDeterministicJson(outputPath, evidence);
  process.stdout.write(`${JSON.stringify({
    v2EvaluationComplete: evidence.v2EvaluationComplete,
    evaluations: evidence.evaluations,
    outputPath,
  }, null, 2)}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`v2 release evidence generation failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
