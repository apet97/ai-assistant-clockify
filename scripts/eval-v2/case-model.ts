import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import type { ActionRegistry } from "../../src/harness/api-catalog.js";
import type { ActionDefinition } from "../../src/harness/action.js";
import type { FeatureGroup } from "../../src/harness/permissions.js";
import type { FakeWorkspaceSeed } from "../../tests/helpers/fake-clockify.js";
import {
  READ_PARITY_FIXTURES,
  READ_PARITY_BASE_SEED,
  unicodeSeedForAction,
  discoveryQueriesForAction,
} from "../../tests/helpers/v2-read-parity-fixtures.js";
import {
  WRITE_PREVIEW_FIXTURES,
  WRITE_PREVIEW_BASE_SEED,
  isAddonUnavailableWrite,
} from "../../tests/helpers/v2-write-preview-fixtures.js";

/**
 * T17-A: the ONE derivation of the v2 evaluation case set.
 *
 * Every case is derived from `MODEL_API_ACTION_CATALOG` plus the request
 * arguments and fake seeds the shipped read/write parity suites already prove
 * against the real actions — there is deliberately no hand-written per-operation
 * table here, and no hard-coded operation count anywhere. `scripts/eval-v2/`'s
 * three cohort projections and `report.ts` all read this one model, so adding or
 * removing a model-API operation changes every evaluator and the coverage gate
 * together.
 *
 * Two of the eight fixture keys cannot be derived from shipped facts and are
 * therefore deliberately empty here rather than invented (rule 19/20):
 * `compoundMembership` is populated from the real compound journeys in
 * `assistant-terminal-cases.ts` (T17-C's cohort owner), and `liveCase` stays
 * absent until T17-F's guarded sacrificial harness defines one.
 */

export type EvalAccess = "read" | "write";

/** The terminal state a correct run reaches for this operation. Derived, never asserted by hand:
 *  a read settles immediately; a write may only ever reach a preview awaiting the button; a fixture
 *  the parity suite marks `expectPreview: false` legitimately stops at a denial/clarification. */
export type EvalTerminalState = "succeeded" | "pending_confirmation" | "denied";

/** Cohort labels derived from shipped per-operation facts. Runtime-scenario
 * cohorts (cancellation, budget exhaustion, partial/unknown outcome) are not
 * per-operation properties and are declared in `assistant-terminal-cases.ts`. */
export type DerivedCohort =
  | "single_read"
  | "multi_read"
  | "single_write"
  | "independent_writes"
  | "denial"
  | "unavailable_auth_class"
  | "truncation"
  | "unicode"
  | "hostile_data"
  | "references";

export interface EvalCase {
  /** Exact model-facing tool name. */
  actionName: string;
  /** Reviewed official operation id from the action's own metadata. */
  apiOperationId: string;
  access: EvalAccess;
  featureGroup: FeatureGroup;
  /** Canonical admin request phrasing. */
  canonicalRequest: string;
  /** A distinct paraphrase of the same request. */
  paraphraseRequest: string;
  /** A reasonable one-character typo, absent when the canonical phrasing is too short to corrupt. */
  typoRequest?: string;
  /** Complete fake-workspace seed this operation's arguments resolve against. */
  fakeSeed: FakeWorkspaceSeed;
  /** The exact raw arguments a correct model call carries. */
  expectedArguments: Record<string, unknown>;
  expectedTerminalState: EvalTerminalState;
  /** Cohorts this operation belongs to; compound journeys are appended by the terminal cohort file. */
  compoundMembership: string[];
  /** Populated only by T17-F's guarded live harness. */
  liveCase?: { fixturePrefix: string; cleanup: "reverse_dependency_order" };
}

function apiActions(registry: ActionRegistry, access: EvalAccess): ActionDefinition[] {
  return registry.actions
    .filter((action) => action.apiOperation?.access === access)
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** A one-character corruption of the longest word, or absent when nothing is long enough
 * to corrupt into a still-recognizable request. */
function typoFor(action: ActionDefinition): string | undefined {
  const { canonical, typo } = discoveryQueriesForAction(action);
  return typo === canonical ? undefined : typo;
}

function derivedCohortsForRead(action: ActionDefinition, readsPerGroup: Map<FeatureGroup, number>): DerivedCohort[] {
  const fixture = READ_PARITY_FIXTURES[action.name];
  const cohorts: DerivedCohort[] = ["single_read", "denial", "hostile_data"];
  if ((readsPerGroup.get(action.featureGroup) ?? 0) > 1) cohorts.push("multi_read");
  if (fixture?.listFamily) cohorts.push("truncation");
  // Unicode coverage is declared per action by the parity suite's own
  // `unicodeSeedForAction` (a seed of Unicode workspace data), with the fixture
  // field as the override — read both rather than only the rarely-set field.
  if (fixture?.unicodeSeed || unicodeSeedForAction(action.name)) cohorts.push("unicode");
  if (fixture?.addonUnavailable) cohorts.push("unavailable_auth_class");
  return cohorts;
}

function derivedCohortsForWrite(action: ActionDefinition): DerivedCohort[] {
  const fixture = WRITE_PREVIEW_FIXTURES[action.name];
  const cohorts: DerivedCohort[] = ["single_write", "denial"];
  if (fixture?.expectPreview !== false) cohorts.push("independent_writes");
  if (isAddonUnavailableWrite(action)) cohorts.push("unavailable_auth_class");
  // A `referenceSelector` is what makes an operation addressable by a prior
  // sighting (T14-B/C) — exactly the follow-up-reference cohort.
  if (action.referenceSelector) cohorts.push("references");
  return cohorts;
}

function missingFixtureNames(registry: ActionRegistry): string[] {
  const missing = [
    ...apiActions(registry, "read").filter((action) => !READ_PARITY_FIXTURES[action.name]),
    ...apiActions(registry, "write").filter((action) => !WRITE_PREVIEW_FIXTURES[action.name]),
  ];
  return missing.map((action) => action.name).sort();
}

/**
 * Build exactly one case per model-API operation. Throws rather than emitting a
 * short set: an evaluator that silently skipped an operation would report a
 * flattering denominator.
 */
export function buildEvalCases(registry: ActionRegistry = MODEL_API_ACTION_CATALOG): EvalCase[] {
  const missing = missingFixtureNames(registry);
  if (missing.length > 0) {
    throw new Error(`missing_eval_fixture:${missing.join(",")}`);
  }
  const reads = apiActions(registry, "read");
  const writes = apiActions(registry, "write");
  const readsPerGroup = new Map<FeatureGroup, number>();
  for (const action of reads) {
    readsPerGroup.set(action.featureGroup, (readsPerGroup.get(action.featureGroup) ?? 0) + 1);
  }

  const readCases = reads.map((action): EvalCase => {
    const fixture = READ_PARITY_FIXTURES[action.name]!;
    const { canonical, paraphrase } = discoveryQueriesForAction(action);
    return {
      actionName: action.name,
      apiOperationId: action.apiOperation!.operationId,
      access: "read",
      featureGroup: action.featureGroup,
      canonicalRequest: canonical,
      paraphraseRequest: paraphrase,
      ...(typoFor(action) ? { typoRequest: typoFor(action) } : {}),
      fakeSeed: { ...READ_PARITY_BASE_SEED, ...fixture.seed },
      expectedArguments: fixture.args,
      expectedTerminalState: "succeeded",
      compoundMembership: derivedCohortsForRead(action, readsPerGroup),
    };
  });

  const writeCases = writes.map((action): EvalCase => {
    const fixture = WRITE_PREVIEW_FIXTURES[action.name]!;
    const { canonical, paraphrase } = discoveryQueriesForAction(action);
    return {
      actionName: action.name,
      apiOperationId: action.apiOperation!.operationId,
      access: "write",
      featureGroup: action.featureGroup,
      canonicalRequest: canonical,
      paraphraseRequest: paraphrase,
      ...(typoFor(action) ? { typoRequest: typoFor(action) } : {}),
      fakeSeed: { ...WRITE_PREVIEW_BASE_SEED, ...fixture.seed },
      expectedArguments: fixture.args,
      // A v2 assistant write can NEVER terminate in an executed mutation from a
      // model turn — the truthful terminal state is the unconfirmed preview.
      expectedTerminalState: fixture.expectPreview === false ? "denied" : "pending_confirmation",
      compoundMembership: derivedCohortsForWrite(action),
    };
  });

  return [...readCases, ...writeCases];
}

/** The authoritative denominator: model-API operations, counted from the registry at call time. */
export function evalOperationNames(registry: ActionRegistry = MODEL_API_ACTION_CATALOG): string[] {
  return [...apiActions(registry, "read"), ...apiActions(registry, "write")]
    .map((action) => action.name)
    .sort();
}

export function caseByName(cases: readonly EvalCase[]): Map<string, EvalCase> {
  return new Map(cases.map((entry) => [entry.actionName, entry]));
}
