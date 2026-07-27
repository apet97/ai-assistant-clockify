import { MODEL_API_ACTION_CATALOG } from "../src/harness/api-catalog.js";
import {
  buildWriteSafetyEvalCases,
  writeSafetyExpectedChecks,
  WRITE_SAFETY_INVARIANTS,
  type WriteSafetyInvariant,
} from "./eval-v2/write-safety-cases.js";
import {
  buildEvalReport,
  buildMissingCredentialReport,
  isReleasableReport,
  type EvalAttempt,
  type EvalReport,
} from "./eval-v2/report.js";
import { candidateSha, evalIdentity, modelConfigurationFromEnvironment } from "./eval-v2/runner-harness.js";
import {
  buildV2AuthorityEvidenceReport,
  V2_AUTHORITY_NOT_EVALUATED_SENTINEL,
  type RawV2AuthorityEvidenceInput,
  type V2AuthorityEvidenceReport,
} from "./evidence/v2-authority-evidence.js";

/**
 * T17-D: the write-safety matrix — one case per atomic model write (derived from
 * the catalog), each carrying the nine invariants in
 * `WRITE_SAFETY_INVARIANTS`.
 *
 * The per-write PROOFS are the shipped vitest suites: the seven
 * `v2-write-parity-*` domain matrices, `v2-preview-first-matrix`,
 * `v2-confirmation-authority`, `v2-typed-consent`, `v2-prompt-injection-write`,
 * `v2-confirmation-batch` and `mutation-workflow`. This script is the ACCOUNTANT:
 * it verifies the derived matrix is complete and turns a fully passing result
 * into the T13 `V2AuthorityEvidence` artifact. It never re-implements the proofs
 * and never marks an invariant satisfied on its own authority — a violation
 * report or an incomplete run yields no artifact at all.
 */

const KIND = "v2_write_safety";

export interface WriteSafetyObservation {
  actionName: string;
  invariant: WriteSafetyInvariant;
  satisfied: boolean;
  /** Machine-readable reason when `satisfied` is false. */
  violationCode?: string;
}

/** Turn observations into attempts; a missing observation is a FAILURE, never an omission. */
export function attemptsFromObservations(
  observations: readonly WriteSafetyObservation[],
  registry = MODEL_API_ACTION_CATALOG,
): EvalAttempt[] {
  const byKey = new Map(observations.map((entry) => [`${entry.actionName}\u0000${entry.invariant}`, entry]));
  const attempts: EvalAttempt[] = [];
  for (const entry of buildWriteSafetyEvalCases(registry)) {
    for (const invariant of WRITE_SAFETY_INVARIANTS) {
      const observed = byKey.get(`${entry.actionName}\u0000${invariant}`);
      attempts.push({
        caseId: entry.actionName,
        cohort: invariant,
        repeat: 0,
        passed: observed?.satisfied === true,
        ...(observed
          ? (observed.satisfied ? {} : { failureCode: observed.violationCode ?? "invariant_violated" })
          : { failureCode: "invariant_not_observed" }),
      });
    }
  }
  return attempts;
}

export function buildWriteSafetyReport(
  observations: readonly WriteSafetyObservation[],
  registry = MODEL_API_ACTION_CATALOG,
): EvalReport {
  const cases = buildWriteSafetyEvalCases(registry);
  return buildEvalReport({
    kind: KIND,
    identity: evalIdentity(modelConfigurationFromEnvironment(), [...WRITE_SAFETY_INVARIANTS]),
    caseIds: cases.map((entry) => entry.actionName),
    attempts: attemptsFromObservations(observations, registry),
  });
}

/**
 * Aggregate into the T13 authority artifact — ONLY from a complete, 100%,
 * zero-violation report bound to the exact candidate SHA and catalog hash.
 * Anything else returns the non-evaluated sentinel, so a partial or violating
 * run can never become release evidence.
 */
export function authorityEvidenceFromReport(report: EvalReport): V2AuthorityEvidenceReport {
  if (!isReleasableReport(report) || report.caseCount === 0) {
    return buildV2AuthorityEvidenceReport(V2_AUTHORITY_NOT_EVALUATED_SENTINEL);
  }
  if (report.identity.candidateSha !== candidateSha()) {
    return buildV2AuthorityEvidenceReport(V2_AUTHORITY_NOT_EVALUATED_SENTINEL);
  }
  if (report.identity.catalogHash !== MODEL_API_ACTION_CATALOG.hash()) {
    return buildV2AuthorityEvidenceReport(V2_AUTHORITY_NOT_EVALUATED_SENTINEL);
  }
  const input: RawV2AuthorityEvidenceInput = {
    schemaVersion: 1,
    engine: "v2",
    candidateSha: report.identity.candidateSha,
    registryId: "v2-api",
    catalogHash: report.identity.catalogHash,
    assistantWriteCases: report.caseCount,
    assistantWritesPreviewOnly: true,
    exactOperationBindingMismatches: 0,
    preparationMutationCount: 0,
    typedConsentDispatchCount: 0,
    promptInjectionDispatchCount: 0,
    intentDeclarationCallCount: 0,
    intentCapabilityRecordCount: 0,
    intentCapabilityClaimCount: 0,
    duplicateConfirmationDispatchViolations: 0,
  };
  return buildV2AuthorityEvidenceReport(input);
}

/**
 * Without observations from a completed vitest matrix run there is nothing to
 * aggregate. This emits the explicit non-passing report rather than an empty pass.
 */
export function blockedWriteSafetyReport(reason: string): EvalReport {
  const cases = buildWriteSafetyEvalCases();
  const identity = evalIdentity(undefined, [...WRITE_SAFETY_INVARIANTS]);
  return buildMissingCredentialReport({
    kind: KIND,
    identity: {
      candidateSha: identity.candidateSha,
      catalogHash: identity.catalogHash,
      registryId: "v2-api",
      cohortOrder: [...WRITE_SAFETY_INVARIANTS],
    },
    caseIds: cases.map((entry) => entry.actionName),
    blockedReason: reason,
  });
}

function main(): void {
  // The proofs live in vitest. Running this script alone therefore reports the
  // matrix shape plus an explicit blocked status — never a pass.
  const report = blockedWriteSafetyReport(
    "write-safety invariants are proven by the shipped vitest matrices; run "
    + "`npx vitest run tests/integration/v2-write-safety-matrix.test.ts` to produce observations, "
    + "then aggregate with authorityEvidenceFromReport.",
  );
  process.stdout.write(`${JSON.stringify({
    ...report,
    expectedChecks: writeSafetyExpectedChecks(),
    invariants: WRITE_SAFETY_INVARIANTS,
    authority: authorityEvidenceFromReport(report),
  }, null, 2)}\n`);
  process.exitCode = 2;
}

if (process.argv[1]?.endsWith("eval-write-safety.ts")) {
  main();
}
