/**
 * T17-A: the one deterministic report builder every `eval:*` script emits
 * through. Numerator and denominator are ALWAYS computed from the attempts and
 * the case set handed in — never from a constant — so a shrinking case set can
 * never flatter a score, and a missing credential produces an explicit
 * non-passing sentinel instead of an invented number.
 */

import {
  API_DISCOVERY_REPORT_KIND,
  DISCOVERY_COHORT_ORDER,
  discoveryPolicyViolations,
} from "./api-discovery-policy.js";
import {
  buildDiscoveryEvalCases,
  buildDiscoveryEvalCorpus,
  DISCOVERY_CORPUS_VERSION,
} from "./api-discovery-cases.js";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";

export const MISSING_CREDENTIAL_STATUS = "not_evaluated_missing_credentials";

export type EvalReportStatus = "passed" | "failed" | typeof MISSING_CREDENTIAL_STATUS;

export interface EvalAttempt {
  /** The case (usually the model-API action name) this attempt scored. */
  caseId: string;
  /** Cohort or phrasing class, e.g. `canonical`, `paraphrase`, `typo`, or a terminal cohort. */
  cohort: string;
  /** Zero-based repeat index within `caseId` + `cohort`. */
  repeat: number;
  passed: boolean;
  /** Present when `passed` is false: the exact machine-readable reason. */
  failureCode?: string;
  /** Non-gating telemetry: unrelated destructive operations present in this attempt's loaded set. */
  loadedUnrelatedDestructiveOperations?: string[];
  /** Non-gating telemetry: the run durably asked for clarification without calling the target operation. */
  clarificationInsteadOfCall?: boolean;
}

export interface LoadedUnrelatedDestructiveTelemetry {
  /** Attempts whose loaded set contained at least one watched destructive operation. */
  attempts: number;
  /** Total distinct watched destructive loads across attempts. */
  loads: number;
  /** Per-operation load counts, sorted by action name. */
  operations: Array<{ actionName: string; loads: number }>;
}

export interface ClarificationInsteadOfCallTelemetry {
  /** Structured clarification-without-target-call attempts across the report. */
  attempts: number;
  /** Attempts for which the evaluator recorded this telemetry. */
  denominator: number;
  rate: number;
  cohorts: Array<{ cohort: string; attempts: number; denominator: number; rate: number }>;
}

export interface EvalCohortScore {
  cohort: string;
  numerator: number;
  denominator: number;
  /** Case ids with at least one failed attempt, sorted. */
  failedCaseIds: string[];
}

export interface EvalIdentity {
  /** Full 40-hex candidate SHA. */
  candidateSha: string;
  /** Full 64-hex model-API catalog hash. */
  catalogHash: string;
  registryId: "v2-api";
  /** Exact provider/model configuration, or the sentinel when credentials are absent. */
  modelConfiguration: string;
  /** Deterministic seed/cohort ordering identity. */
  cohortOrder: string[];
  /** Evaluator-specific corpus identity; omitted by generic and non-corpus evals. */
  corpusVersion?: string;
  /** Discovery-only corpus selection metadata; other eval identities omit it. */
  caseSelection?: {
    authClass: "addon" | "api_key";
    sourceOperationCount: number;
    excludedOperationNames: string[];
  };
}

export interface EvalReport {
  schemaVersion: 1;
  kind: string;
  status: EvalReportStatus;
  identity: EvalIdentity;
  /** Total cases in the derived set — the denominator's denominator. */
  caseCount: number;
  numerator: number;
  denominator: number;
  cohorts: EvalCohortScore[];
  /** Every failed attempt, in attempt order. Never summarized away. */
  failures: Array<Required<Pick<EvalAttempt, "caseId" | "cohort" | "repeat">> & { failureCode: string }>;
  /** Distinct case ids that received at least one attempt — the completeness proof. */
  scoredCaseIds: string[];
  /** Discovery-only expected case set used to prove the exact attempt grid. */
  caseIds?: string[];
  /** Discovery-only sanitized attempt evidence; never contains prompts or provider content. */
  attempts?: EvalAttempt[];
  /** Discovery-only canonical-corpus, completed-identity, floor, completeness, and zero-tolerance violations. */
  thresholdViolations?: string[];
  /** Present for evaluators that record loaded-destructive telemetry; never affects status. */
  loadedUnrelatedDestructiveTelemetry?: LoadedUnrelatedDestructiveTelemetry;
  /** Present for discovery reports; never affects status. */
  clarificationInsteadOfCallTelemetry?: ClarificationInsteadOfCallTelemetry;
  /** Present only for a non-passing missing-credential report. */
  blockedReason?: string;
}

const CANONICAL_DISCOVERY_CASE_IDS = buildDiscoveryEvalCases()
  .map((entry) => entry.actionName)
  .sort();
const CANONICAL_DISCOVERY_CASE_SELECTION = buildDiscoveryEvalCorpus().caseSelection;
const COMPLETED_DISCOVERY_MODEL_CONFIGURATION =
  /^provider=http model=\S+(?: thinking=(?:disabled|enabled))?(?: seed=-?(?:\d+(?:\.\d+)?|\.\d+))?$/u;

function sameStringArray(left: unknown, right: readonly string[]): boolean {
  return Array.isArray(left)
    && left.every((entry) => typeof entry === "string")
    && JSON.stringify(left) === JSON.stringify(right);
}

function discoveryIdentityViolations(identity: unknown): string[] {
  if (typeof identity !== "object" || identity === null || Array.isArray(identity)) {
    return ["discovery_identity_missing"];
  }
  const record = identity as Record<string, unknown>;
  const violations: string[] = [];
  if (typeof record.candidateSha !== "string" || !/^[a-f0-9]{40}$/u.test(record.candidateSha)) {
    violations.push("discovery_candidate_sha_invalid");
  }
  if (record.catalogHash !== MODEL_API_ACTION_CATALOG.hash()) {
    violations.push("discovery_catalog_hash_mismatch");
  }
  if (record.registryId !== "v2-api") violations.push("discovery_registry_id_mismatch");
  if (
    typeof record.modelConfiguration !== "string"
    || !COMPLETED_DISCOVERY_MODEL_CONFIGURATION.test(record.modelConfiguration)
  ) {
    violations.push("discovery_model_configuration_not_completed");
  }
  if (!sameStringArray(record.cohortOrder, DISCOVERY_COHORT_ORDER)) {
    violations.push("discovery_cohort_order_mismatch");
  }
  if (record.corpusVersion !== DISCOVERY_CORPUS_VERSION) {
    violations.push("discovery_corpus_version_mismatch");
  }

  const selection = record.caseSelection;
  if (typeof selection !== "object" || selection === null || Array.isArray(selection)) {
    violations.push("discovery_case_selection_missing");
  } else {
    const selectionRecord = selection as Record<string, unknown>;
    const expectedKeys = ["authClass", "excludedOperationNames", "sourceOperationCount"];
    if (JSON.stringify(Object.keys(selectionRecord).sort()) !== JSON.stringify(expectedKeys)) {
      violations.push("discovery_case_selection_shape_mismatch");
    }
    if (selectionRecord.authClass !== CANONICAL_DISCOVERY_CASE_SELECTION.authClass) {
      violations.push("discovery_case_selection_auth_class_mismatch");
    }
    if (selectionRecord.sourceOperationCount !== CANONICAL_DISCOVERY_CASE_SELECTION.sourceOperationCount) {
      violations.push("discovery_case_selection_source_count_mismatch");
    }
    if (!sameStringArray(
      selectionRecord.excludedOperationNames,
      CANONICAL_DISCOVERY_CASE_SELECTION.excludedOperationNames,
    )) {
      violations.push("discovery_case_selection_exclusions_mismatch");
    }
  }
  return violations;
}

function discoveryArtifactViolations(
  identity: unknown,
  caseIds: readonly string[],
  attempts: readonly EvalAttempt[],
): string[] {
  const violations = new Set(discoveryPolicyViolations(caseIds, attempts));
  const uniqueSortedCaseIds = [...new Set(caseIds)].sort();
  if (
    uniqueSortedCaseIds.length !== caseIds.length
    || JSON.stringify(uniqueSortedCaseIds) !== JSON.stringify(CANONICAL_DISCOVERY_CASE_IDS)
  ) {
    violations.add("discovery_case_ids_not_canonical");
  }
  for (const violation of discoveryIdentityViolations(identity)) violations.add(violation);
  return [...violations].sort();
}

function cohortScores(attempts: readonly EvalAttempt[]): EvalCohortScore[] {
  const byCohort = new Map<string, { numerator: number; denominator: number; failed: Set<string> }>();
  for (const attempt of attempts) {
    const entry = byCohort.get(attempt.cohort) ?? { numerator: 0, denominator: 0, failed: new Set<string>() };
    entry.denominator += 1;
    if (attempt.passed) entry.numerator += 1;
    else entry.failed.add(attempt.caseId);
    byCohort.set(attempt.cohort, entry);
  }
  return [...byCohort.entries()]
    .map(([cohort, entry]) => ({
      cohort,
      numerator: entry.numerator,
      denominator: entry.denominator,
      failedCaseIds: [...entry.failed].sort(),
    }))
    .sort((left, right) => left.cohort.localeCompare(right.cohort));
}

function loadedUnrelatedDestructiveTelemetry(
  attempts: readonly EvalAttempt[],
): LoadedUnrelatedDestructiveTelemetry | undefined {
  let recordsTelemetry = false;
  let attemptCount = 0;
  let loadCount = 0;
  const byOperation = new Map<string, number>();
  for (const attempt of attempts) {
    const loaded = attempt.loadedUnrelatedDestructiveOperations;
    if (loaded === undefined) continue;
    recordsTelemetry = true;
    const unique = [...new Set(loaded)];
    if (unique.length > 0) attemptCount += 1;
    loadCount += unique.length;
    for (const actionName of unique) {
      byOperation.set(actionName, (byOperation.get(actionName) ?? 0) + 1);
    }
  }
  if (!recordsTelemetry) return undefined;
  return {
    attempts: attemptCount,
    loads: loadCount,
    operations: [...byOperation.entries()]
      .map(([actionName, loads]) => ({ actionName, loads }))
      .sort((left, right) => left.actionName.localeCompare(right.actionName)),
  };
}

function clarificationInsteadOfCallTelemetry(
  attempts: readonly EvalAttempt[],
): ClarificationInsteadOfCallTelemetry | undefined {
  const recorded = attempts.filter((attempt) => attempt.clarificationInsteadOfCall !== undefined);
  if (recorded.length === 0) return undefined;
  const byCohort = new Map<string, { attempts: number; denominator: number }>();
  let clarificationAttempts = 0;
  for (const attempt of recorded) {
    const cohort = byCohort.get(attempt.cohort) ?? { attempts: 0, denominator: 0 };
    cohort.denominator += 1;
    if (attempt.clarificationInsteadOfCall) {
      cohort.attempts += 1;
      clarificationAttempts += 1;
    }
    byCohort.set(attempt.cohort, cohort);
  }
  return {
    attempts: clarificationAttempts,
    denominator: recorded.length,
    rate: clarificationAttempts / recorded.length,
    cohorts: [...byCohort.entries()]
      .map(([cohort, entry]) => ({
        cohort,
        ...entry,
        rate: entry.attempts / entry.denominator,
      }))
      .sort((left, right) => left.cohort.localeCompare(right.cohort)),
  };
}

function cloneAttempt(attempt: EvalAttempt): EvalAttempt {
  return {
    ...attempt,
    ...(attempt.loadedUnrelatedDestructiveOperations
      ? { loadedUnrelatedDestructiveOperations: [...attempt.loadedUnrelatedDestructiveOperations] }
      : {}),
  };
}

/**
 * Build a complete report. `caseIds` is the derived case set: its length is the
 * report's `caseCount`, and an attempt naming a case outside it is rejected
 * rather than scored, so a report can never grade work it was not asked to do.
 */
export function buildEvalReport(input: {
  kind: string;
  identity: EvalIdentity;
  caseIds: readonly string[];
  attempts: readonly EvalAttempt[];
}): EvalReport {
  const known = new Set(input.caseIds);
  const unknown = [...new Set(input.attempts.filter((a) => !known.has(a.caseId)).map((a) => a.caseId))].sort();
  if (unknown.length > 0) {
    throw new Error(`unknown_eval_case:${unknown.join(",")}`);
  }
  const denominator = input.attempts.length;
  const numerator = input.attempts.filter((attempt) => attempt.passed).length;
  const failures = input.attempts
    .filter((attempt) => !attempt.passed)
    .map((attempt) => ({
      caseId: attempt.caseId,
      cohort: attempt.cohort,
      repeat: attempt.repeat,
      failureCode: attempt.failureCode ?? "unspecified_failure",
    }));
  const loadedDestructiveTelemetry = loadedUnrelatedDestructiveTelemetry(input.attempts);
  const clarificationTelemetry = clarificationInsteadOfCallTelemetry(input.attempts);
  const discovery = input.kind === API_DISCOVERY_REPORT_KIND;
  const thresholdViolations = discovery
    ? discoveryArtifactViolations(input.identity, input.caseIds, input.attempts)
    : undefined;
  return {
    schemaVersion: 1,
    kind: input.kind,
    // An empty attempt set is NOT a pass: nothing was proved.
    status: discovery
      ? denominator > 0 && thresholdViolations?.length === 0 ? "passed" : "failed"
      : denominator > 0 && numerator === denominator ? "passed" : "failed",
    identity: input.identity,
    caseCount: input.caseIds.length,
    numerator,
    denominator,
    cohorts: cohortScores(input.attempts),
    failures,
    scoredCaseIds: [...new Set(input.attempts.map((attempt) => attempt.caseId))].sort(),
    ...(discovery
      ? {
          caseIds: [...input.caseIds],
          attempts: input.attempts.map(cloneAttempt),
          thresholdViolations: thresholdViolations ?? [],
        }
      : {}),
    ...(loadedDestructiveTelemetry
      ? { loadedUnrelatedDestructiveTelemetry: loadedDestructiveTelemetry }
      : {}),
    ...(clarificationTelemetry
      ? { clarificationInsteadOfCallTelemetry: clarificationTelemetry }
      : {}),
  };
}

/**
 * The only report a credential-less run may emit. It carries the real case count
 * and identity but scores nothing, so it can never be mistaken for a pass.
 */
export function buildMissingCredentialReport(input: {
  kind: string;
  identity: Omit<EvalIdentity, "modelConfiguration"> & { modelConfiguration?: string };
  caseIds: readonly string[];
  blockedReason: string;
}): EvalReport {
  return {
    schemaVersion: 1,
    kind: input.kind,
    status: MISSING_CREDENTIAL_STATUS,
    identity: { ...input.identity, modelConfiguration: MISSING_CREDENTIAL_STATUS },
    caseCount: input.caseIds.length,
    numerator: 0,
    denominator: 0,
    cohorts: [],
    failures: [],
    scoredCaseIds: [],
    blockedReason: input.blockedReason,
  };
}

/**
 * A report is releasable only when it is complete and passes the policy for its
 * kind. Discovery uses the owner-ratified per-case floors; every other kind
 * remains all-attempts-must-pass. A short attempt set was previously accepted
 * as "passed" because `denominator` and `caseCount` were never compared
 * (pre-T18 review).
 */
export function isReleasableReport(report: EvalReport): boolean {
  if (!Array.isArray(report.scoredCaseIds) || !Array.isArray(report.failures)) return false;
  const baseComplete = report.status === "passed"
    && report.denominator > 0
    && report.caseCount > 0
    && report.denominator >= report.caseCount
    && scoredCaseCount(report) === report.caseCount;
  if (!baseComplete) return false;
  if (report.kind === API_DISCOVERY_REPORT_KIND) {
    if (!Array.isArray(report.caseIds) || !Array.isArray(report.attempts)) return false;
    if (report.caseIds.length !== report.caseCount || report.attempts.length !== report.denominator) return false;
    if (!report.attempts.every((attempt) =>
      typeof attempt === "object"
      && attempt !== null
      && typeof attempt.caseId === "string"
      && typeof attempt.cohort === "string"
      && typeof attempt.repeat === "number"
      && typeof attempt.passed === "boolean"
      && (attempt.failureCode === undefined || typeof attempt.failureCode === "string")
      && (attempt.clarificationInsteadOfCall === undefined
        || typeof attempt.clarificationInsteadOfCall === "boolean")
      && (attempt.loadedUnrelatedDestructiveOperations === undefined
        || (Array.isArray(attempt.loadedUnrelatedDestructiveOperations)
          && attempt.loadedUnrelatedDestructiveOperations.every((name) => typeof name === "string"))))) return false;
    if (report.numerator !== report.attempts.filter((attempt) => attempt.passed).length) return false;
    const expectedScoredCaseIds = [...new Set(report.caseIds)].sort();
    if (JSON.stringify([...report.scoredCaseIds].sort()) !== JSON.stringify(expectedScoredCaseIds)) return false;
    const expectedFailures = report.attempts
      .filter((attempt) => !attempt.passed)
      .map((attempt) => ({
        caseId: attempt.caseId,
        cohort: attempt.cohort,
        repeat: attempt.repeat,
        failureCode: attempt.failureCode ?? "unspecified_failure",
      }));
    if (JSON.stringify(report.failures) !== JSON.stringify(expectedFailures)) return false;
    if (JSON.stringify(report.cohorts) !== JSON.stringify(cohortScores(report.attempts))) return false;
    const recomputed = discoveryArtifactViolations(report.identity, report.caseIds, report.attempts);
    return recomputed.length === 0
      && Array.isArray(report.thresholdViolations)
      && report.thresholdViolations.length === 0;
  }
  return report.numerator === report.denominator && report.failures.length === 0;
}

/** Recompute discovery violations from the persisted sanitized attempt grid. */
export function discoveryThresholdViolations(report: EvalReport): string[] {
  if (report.kind !== API_DISCOVERY_REPORT_KIND) return [`unexpected_report_kind:${report.kind}`];
  if (!Array.isArray(report.caseIds) || !Array.isArray(report.attempts)) {
    return ["discovery_attempt_evidence_missing"];
  }
  return discoveryArtifactViolations(report.identity, report.caseIds, report.attempts);
}

/** Distinct cases with at least one attempt. */
export function scoredCaseCount(report: EvalReport): number {
  return report.denominator > 0 && Array.isArray(report.scoredCaseIds)
    ? new Set(report.scoredCaseIds).size
    : 0;
}

/** Exact ratio for a cohort, or `undefined` when the cohort was never attempted. */
export function cohortRatio(report: EvalReport, cohort: string): number | undefined {
  const score = report.cohorts.find((entry) => entry.cohort === cohort);
  if (!score || score.denominator === 0) return undefined;
  return score.numerator / score.denominator;
}
