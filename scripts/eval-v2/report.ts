/**
 * T17-A: the one deterministic report builder every `eval:*` script emits
 * through. Numerator and denominator are ALWAYS computed from the attempts and
 * the case set handed in — never from a constant — so a shrinking case set can
 * never flatter a score, and a missing credential produces an explicit
 * non-passing sentinel instead of an invented number.
 */

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
}

export interface LoadedUnrelatedDestructiveTelemetry {
  /** Attempts whose loaded set contained at least one watched destructive operation. */
  attempts: number;
  /** Total distinct watched destructive loads across attempts. */
  loads: number;
  /** Per-operation load counts, sorted by action name. */
  operations: Array<{ actionName: string; loads: number }>;
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
  /** Present for evaluators that record loaded-destructive telemetry; never affects status. */
  loadedUnrelatedDestructiveTelemetry?: LoadedUnrelatedDestructiveTelemetry;
  /** Present only for a non-passing missing-credential report. */
  blockedReason?: string;
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
  return {
    schemaVersion: 1,
    kind: input.kind,
    // An empty attempt set is NOT a pass: nothing was proved.
    status: denominator > 0 && numerator === denominator ? "passed" : "failed",
    identity: input.identity,
    caseCount: input.caseIds.length,
    numerator,
    denominator,
    cohorts: cohortScores(input.attempts),
    failures,
    scoredCaseIds: [...new Set(input.attempts.map((attempt) => attempt.caseId))].sort(),
    ...(loadedDestructiveTelemetry
      ? { loadedUnrelatedDestructiveTelemetry: loadedDestructiveTelemetry }
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
 * A report is releasable only when it is complete, scored, and fully passing —
 * where COMPLETE means it attempted at least one scored attempt per case in its
 * own derived set. A short attempt set was previously accepted as "passed"
 * because `denominator` and `caseCount` were never compared (pre-T18 review).
 */
export function isReleasableReport(report: EvalReport): boolean {
  return report.status === "passed"
    && report.denominator > 0
    && report.numerator === report.denominator
    && report.failures.length === 0
    && report.caseCount > 0
    && report.denominator >= report.caseCount
    && scoredCaseCount(report) === report.caseCount;
}

/** Distinct cases with at least one attempt. */
export function scoredCaseCount(report: EvalReport): number {
  return report.cohorts.reduce((total, cohort) => total + cohort.denominator, 0) > 0
    ? new Set(report.scoredCaseIds ?? []).size
    : 0;
}

/** Exact ratio for a cohort, or `undefined` when the cohort was never attempted. */
export function cohortRatio(report: EvalReport, cohort: string): number | undefined {
  const score = report.cohorts.find((entry) => entry.cohort === cohort);
  if (!score || score.denominator === 0) return undefined;
  return score.numerator / score.denominator;
}
