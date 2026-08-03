import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import {
  buildWriteSafetyEvalCases,
  writeSafetyExpectedChecks,
} from "../eval-v2/write-safety-cases.js";
import {
  buildWriteSafetyReport,
  observedAuthorityCountsFromAttempts,
  type ObservedAuthorityCounts,
  type WriteSafetyObservation,
} from "../eval-write-safety.js";
import { candidateSha } from "../eval-v2/runner-harness.js";
import { writeDeterministicJson } from "./write-json.js";
import { observeWriteSafetyMatrix } from "../../tests/helpers/v2-write-safety-observer.js";

export interface V2WriteSafetyObservationArtifact extends ObservedAuthorityCounts {
  status: "evaluated";
  binding: {
    candidateSha: string;
    catalogHash: string;
    assistantWriteCases: number;
    expectedChecks: number;
    observationCount: number;
  };
}

/** Build the authority-consumable aggregate from the executed observation records. */
export function buildV2WriteSafetyObservationArtifact(
  observations: readonly WriteSafetyObservation[],
): V2WriteSafetyObservationArtifact {
  const report = buildWriteSafetyReport(observations);
  if (!report.attempts) throw new Error("write-safety report did not retain attempts");
  return {
    status: "evaluated",
    ...observedAuthorityCountsFromAttempts(report.attempts),
    binding: {
      candidateSha: candidateSha(),
      catalogHash: MODEL_API_ACTION_CATALOG.hash(),
      assistantWriteCases: buildWriteSafetyEvalCases().length,
      expectedChecks: writeSafetyExpectedChecks(),
      observationCount: observations.length,
    },
  };
}

export async function main(): Promise<void> {
  const outputPath = process.env.V2_AUTHORITY_OBSERVATIONS_PATH;
  if (!outputPath) throw new Error("V2_AUTHORITY_OBSERVATIONS_PATH is required");
  const observations = await observeWriteSafetyMatrix();
  writeDeterministicJson(outputPath, buildV2WriteSafetyObservationArtifact(observations));
}

if (process.argv[1]?.endsWith("v2-write-safety-observation.ts")) {
  void main().catch((error: unknown) => {
    process.stderr.write(`v2 write-safety observation generation failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
