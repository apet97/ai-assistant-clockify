import {
  isPartialCommitResult,
  type CommitResult,
} from "../../src/harness/action.js";

export type ConfirmedOutcomeStatus =
  | "succeeded"
  | "definitive_failed"
  | "partial"
  | "outcome_unknown";

export interface ConfirmedActionOutcome {
  action: string;
  status: ConfirmedOutcomeStatus;
}

/** Secret-free classification used by the evaluator. A button click is an
 * attempt; only an exact successful receipt is a completed mutation. */
export function classifyConfirmedOutcome(
  action: string,
  result: CommitResult,
): ConfirmedActionOutcome {
  const status: ConfirmedOutcomeStatus = isPartialCommitResult(result)
    ? "partial"
    : result.ok
      ? "succeeded"
      : result.code === "commit_outcome_unknown"
        ? "outcome_unknown"
        : "definitive_failed";
  return { action, status };
}

export function recordConfirmedOutcome(
  action: string,
  result: CommitResult,
  successfulActions: string[],
  outcomes: ConfirmedActionOutcome[],
): ConfirmedActionOutcome {
  const outcome = classifyConfirmedOutcome(action, result);
  outcomes.push(outcome);
  if (outcome.status === "succeeded") successfulActions.push(action);
  return outcome;
}

/** Global run-level guard: a case-specific end-state check can observe host
 * mutation after ambiguous settlement, but that must never turn the run green. */
export function scoreConfirmedOutcomes(
  outcomes: readonly ConfirmedActionOutcome[] | undefined,
): string[] {
  return (outcomes ?? [])
    .filter((outcome) => outcome.status !== "succeeded")
    .map((outcome) => `${outcome.action} confirmation settled as ${outcome.status}`);
}
