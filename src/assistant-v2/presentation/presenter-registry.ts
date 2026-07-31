import type { ActionDefinition } from "../../harness/action.js";
import {
  getPreparedWritePresenter,
  toPublicPresentationFacts,
  validateCatalogPresentationRegistries,
  type PreparedWritePresentation,
} from "../../harness/prepared-write-presentation.js";
import { PRESENTED_RESULT_MAX_FACTS, type PresentedResult } from "./presented-result.js";

/**
 * T15-B: the v2 presenter registry. `MODEL_API_ACTION_CATALOG` already
 * initializes and validates Task 11's `metadataDrivenPresentPreparedWrite`
 * registration for every action's `presentation.presenterId` (equal to
 * `action.name`, unique by the registry's own duplicate-name check) — see
 * `src/harness/api-catalog.ts`'s module-level
 * `initializePreparedWritePresentationRegistries` call. This module does NOT
 * reimplement that.
 *
 * Phase C (C1): the api-exposed completeness assertion that used to live ONLY
 * here — `validateCatalogPresentationRegistries` silently `continue`s past an
 * action with no `presentation` at all (appropriate for the full
 * `INTERNAL_ACTION_CATALOG`, where composite/generic actions legitimately have
 * none, but wrong for the model-facing surface) — now also runs at boot inside
 * `initializePreparedWritePresentationRegistries`. What remains here is the
 * error-collecting variant tests assert on, and the mechanical
 * `PreparedWriteFact[] -> PresentedResult["facts"]` adapter every v2 result
 * presenter (T15-C read presenters, T15-D write terminal presenters) shares.
 *
 * NOTE on the name "registry": all 127 `presentation` records register the
 * SAME function (`metadataDrivenPresentPreparedWrite`). Nothing is dispatched
 * through the registry — `operation-preparation-service.ts:301` calls that one
 * presenter directly, and the map exists to pin each action's presenter
 * VERSION and prove coverage. Per-action presenters are not planned.
 *
 * Reuses Task 11's formatters and `toPublicPresentationFacts` verbatim — this
 * file defines no formatting policy of its own.
 */

export interface PresenterCoverageError {
  code: "missing_presenter" | "duplicate_presenter" | "unregistered_presenter";
  actionName: string;
  presenterId?: string;
}

/**
 * Require exactly one presenter for every `api`-exposed action in the given
 * catalog (127 in `MODEL_API_ACTION_CATALOG` today — verify the live count
 * from `evidence/api-action-inventory.json` rather than hard-coding it
 * elsewhere). Throws on the first violation; callers that need every
 * violation should use `findPresenterCoverageErrors`.
 */
export function requireCompletePresenterCoverage(actions: readonly ActionDefinition[]): void {
  const errors = findPresenterCoverageErrors(actions);
  if (errors.length > 0) {
    const first = errors[0]!;
    throw new Error(`${first.code}:${first.actionName}${first.presenterId ? `:${first.presenterId}` : ""}`);
  }
  // Task 11's own validator additionally checks presenter VERSION match and
  // that every declared material formatter is registered — reuse it rather
  // than duplicating those checks here.
  validateCatalogPresentationRegistries(actions);
}

/** Same coverage check as `requireCompletePresenterCoverage`, but collects
 * every violation instead of throwing on the first — used by tests that want
 * to assert on the full error set. */
export function findPresenterCoverageErrors(actions: readonly ActionDefinition[]): PresenterCoverageError[] {
  const errors: PresenterCoverageError[] = [];
  const seenPresenterIds = new Set<string>();
  for (const action of actions) {
    if (action.apiExposure !== "api") continue;
    if (!action.presentation) {
      errors.push({ code: "missing_presenter", actionName: action.name });
      continue;
    }
    const { presenterId } = action.presentation;
    if (seenPresenterIds.has(presenterId)) {
      errors.push({ code: "duplicate_presenter", actionName: action.name, presenterId });
      continue;
    }
    seenPresenterIds.add(presenterId);
    if (!getPreparedWritePresenter(presenterId)) {
      errors.push({ code: "unregistered_presenter", actionName: action.name, presenterId });
    }
  }
  return errors;
}

/**
 * Mechanically expand a Task-11 `PreparedWritePresentation` into
 * `PresentedResult["facts"]` — the exact same public-fact projection Task 11
 * already uses for a prepared-write preview (`toPublicPresentationFacts`:
 * material facts, then "API endpoint", then "Reversibility"), capped at the
 * same `PRESENTED_RESULT_MAX_FACTS` bound `presentedResultSchema` enforces.
 * Does not duplicate formatting policy — every value string here already
 * passed through a Task 11 formatter.
 */
export function presentedFactsFromPreparedWrite(
  presentation: PreparedWritePresentation,
): PresentedResult["facts"] {
  const facts = toPublicPresentationFacts(presentation);
  if (facts.length > PRESENTED_RESULT_MAX_FACTS) {
    throw new Error(`presentation_limit_exceeded:facts:${facts.length}`);
  }
  return facts;
}
