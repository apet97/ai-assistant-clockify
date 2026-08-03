import { MODEL_API_ACTION_CATALOG, type ActionRegistry } from "../src/harness/api-catalog.js";
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
import { emitEvalReport, evalEvidenceSink } from "./eval-v2/evidence-path.js";
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
 *
 * Plan B4: when `EVAL_WRITE_SAFETY_EVIDENCE_PATH` is set, the report printed
 * to stdout is ALSO written byte-identically to that path (mode 0600, existing
 * file refused) via the shared evidence-path contract.
 */

const KIND = "v2_write_safety";
const EVIDENCE_PATH_VARIABLE = "EVAL_WRITE_SAFETY_EVIDENCE_PATH";

export interface WriteSafetyObservation {
  actionName: string;
  invariant: WriteSafetyInvariant;
  satisfied: boolean;
  /** Machine-readable reason when `satisfied` is false. */
  violationCode?: string;
}

function observationKey(actionName: string, invariant: WriteSafetyInvariant): string {
  return `${actionName}\u0000${invariant}`;
}

function expectedObservationKeys(registry: ActionRegistry): Set<string> {
  return new Set(
    buildWriteSafetyEvalCases(registry).flatMap((entry) =>
      WRITE_SAFETY_INVARIANTS.map((invariant) => observationKey(entry.actionName, invariant)),
    ),
  );
}

function validateObservationGrid(
  observations: readonly WriteSafetyObservation[],
  registry: ActionRegistry,
): void {
  const expected = expectedObservationKeys(registry);
  const seen = new Set<string>();
  const unknown: string[] = [];
  const duplicates: string[] = [];
  for (const entry of observations) {
    const key = observationKey(entry.actionName, entry.invariant);
    if (!expected.has(key)) unknown.push(key);
    if (seen.has(key)) duplicates.push(key);
    seen.add(key);
  }
  if (unknown.length > 0) {
    throw new Error(`unknown_write_safety_observation:${[...new Set(unknown)].sort().join(",")}`);
  }
  if (duplicates.length > 0) {
    throw new Error(`duplicate_write_safety_observation:${[...new Set(duplicates)].sort().join(",")}`);
  }
  const missing = [...expected].filter((key) => !seen.has(key)).sort();
  if (missing.length > 0) {
    throw new Error(`missing_write_safety_observation:${missing.join(",")}`);
  }
}

/** Turn observations into attempts; malformed observation grids are rejected before aggregation. */
export function attemptsFromObservations(
  observations: readonly WriteSafetyObservation[],
  registry: ActionRegistry = MODEL_API_ACTION_CATALOG,
): EvalAttempt[] {
  validateObservationGrid(observations, registry);
  const byKey = new Map(observations.map((entry) => [observationKey(entry.actionName, entry.invariant), entry]));
  const attempts: EvalAttempt[] = [];
  for (const entry of buildWriteSafetyEvalCases(registry)) {
    for (const invariant of WRITE_SAFETY_INVARIANTS) {
      const observed = byKey.get(observationKey(entry.actionName, invariant));
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
  registry: ActionRegistry = MODEL_API_ACTION_CATALOG,
): EvalReport {
  const cases = buildWriteSafetyEvalCases(registry);
  return buildEvalReport({
    kind: KIND,
    identity: evalIdentity(modelConfigurationFromEnvironment(), [...WRITE_SAFETY_INVARIANTS]),
    caseIds: cases.map((entry) => entry.actionName),
    attempts: attemptsFromObservations(observations, registry),
  });
}

export type ObservedAuthorityCounts = Pick<
  RawV2AuthorityEvidenceInput,
  | "assistantWritesPreviewOnly"
  | "exactOperationBindingMismatches"
  | "preparationMutationCount"
  | "typedConsentDispatchCount"
  | "promptInjectionDispatchCount"
  | "intentDeclarationCallCount"
  | "intentCapabilityRecordCount"
  | "intentCapabilityClaimCount"
  | "duplicateConfirmationDispatchViolations"
>;

function failedAttempts(
  attempts: readonly EvalAttempt[],
  cohort: WriteSafetyInvariant,
): EvalAttempt[] {
  return attempts.filter((attempt) => attempt.cohort === cohort && !attempt.passed);
}

function failedAttemptsWithCode(attempts: readonly EvalAttempt[], code: string): EvalAttempt[] {
  return attempts.filter((attempt) => !attempt.passed && attempt.failureCode === code);
}

/** Derive every authority count from the persisted, executed write-safety records. */
export function observedAuthorityCountsFromAttempts(
  attempts: readonly EvalAttempt[],
): ObservedAuthorityCounts {
  const exactBindingFailures = failedAttempts(attempts, "exact_preview_operation");
  return {
    assistantWritesPreviewOnly: exactBindingFailures.length === 0,
    exactOperationBindingMismatches: exactBindingFailures.length,
    preparationMutationCount: failedAttempts(attempts, "zero_preparation_mutation").length,
    typedConsentDispatchCount: failedAttempts(attempts, "no_typed_consent").length,
    promptInjectionDispatchCount: failedAttempts(attempts, "no_hostile_data_execution").length,
    intentDeclarationCallCount: failedAttemptsWithCode(attempts, "intent_declaration_called").length,
    intentCapabilityRecordCount: failedAttemptsWithCode(attempts, "intent_capability_recorded").length,
    intentCapabilityClaimCount: failedAttemptsWithCode(attempts, "intent_capability_claimed").length,
    duplicateConfirmationDispatchViolations: failedAttempts(attempts, "no_concurrent_duplicate").length,
  };
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
  if (!report.attempts) {
    return buildV2AuthorityEvidenceReport(V2_AUTHORITY_NOT_EVALUATED_SENTINEL);
  }
  const observed = observedAuthorityCountsFromAttempts(report.attempts);
  const input: RawV2AuthorityEvidenceInput = {
    schemaVersion: 1,
    engine: "v2",
    candidateSha: report.identity.candidateSha,
    registryId: "v2-api",
    catalogHash: report.identity.catalogHash,
    assistantWriteCases: report.caseCount,
    ...observed,
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

export function main(): void {
  // The proofs live in vitest. Running this script alone therefore reports the
  // matrix shape plus an explicit blocked status — never a pass.
  const report = blockedWriteSafetyReport(
    "write-safety invariants are proven by the shipped vitest matrices; run "
    + "`npx vitest run tests/integration/v2-write-safety-matrix.test.ts` to produce observations, "
    + "then aggregate with authorityEvidenceFromReport.",
  );
  emitEvalReport({
    ...report,
    expectedChecks: writeSafetyExpectedChecks(),
    invariants: WRITE_SAFETY_INVARIANTS,
    authority: authorityEvidenceFromReport(report),
  }, evalEvidenceSink(EVIDENCE_PATH_VARIABLE));
  process.exitCode = 2;
}

if (process.argv[1]?.endsWith("eval-write-safety.ts")) {
  main();
}
