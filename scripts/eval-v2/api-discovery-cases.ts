import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import type { ActionRegistry } from "../../src/harness/api-catalog.js";
import { buildEvalCases, type EvalCase } from "./case-model.js";
export {
  DISCOVERY_EXPECTED_CASE_COUNT,
  DISCOVERY_MAX_TOOLS,
  DISCOVERY_REPEATS,
  DISCOVERY_THRESHOLDS,
} from "./api-discovery-policy.js";

/**
 * T17-A/M4: the discovery cohort. One case per model-API operation loadable by
 * the harness's add-on auth class, each carrying the three request phrasings the
 * evaluator repeats three times, plus the exact destructive operations that the
 * model must NEVER call for that request.
 *
 * The destructive watch list is derived, not chosen: every `write` operation
 * whose reviewed HTTP method is `DELETE`, minus anything in the request's own
 * feature group (a delete inside the requested domain is a plausible neighbour;
 * a model call to one in an unrelated domain is a discovery failure). Merely
 * loading a watched operation is retained as non-gating evaluator telemetry.
 */

/** Stable identity for the M5 argument-bearing discovery request corpus. */
export const DISCOVERY_CORPUS_VERSION = "v2-discovery-argument-bearing-v1";

/** The real eval harness scope (`runner-harness.ts`) and discovery pool use this auth class. */
export const DISCOVERY_HARNESS_AUTH_CLASS = "addon" as const;

export interface DiscoveryEvalCase {
  actionName: string;
  apiOperationId: string;
  featureGroup: EvalCase["featureGroup"];
  /** Must load the operation in all 3 repeats. */
  canonicalRequest: string;
  /** Must load the operation in at least 2 of 3 repeats. */
  paraphraseRequest: string;
  /** Must load the operation in at least 2 of 3 repeats; absent when the name is too short to corrupt. */
  typoRequest?: string;
  /** Must call NONE of these in any repeat. */
  unrelatedDestructiveOperations: string[];
}

export interface DiscoveryEvalCaseSelection {
  authClass: typeof DISCOVERY_HARNESS_AUTH_CLASS;
  /** All model-API operations before applying the harness auth contract. */
  sourceOperationCount: number;
  /** Operations rejected by the registry contract, sorted so denominator drift is reviewable. */
  excludedOperationNames: string[];
}

export interface DiscoveryEvalCorpus {
  cases: DiscoveryEvalCase[];
  caseSelection: DiscoveryEvalCaseSelection;
}

function destructiveWriteNames(registry: ActionRegistry): Array<{ name: string; featureGroup: EvalCase["featureGroup"] }> {
  return registry.actions
    .filter((action) => action.apiOperation?.access === "write" && action.apiOperation.method === "DELETE")
    .map((action) => ({ name: action.name, featureGroup: action.featureGroup }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function buildDiscoveryEvalCorpus(
  registry: ActionRegistry = MODEL_API_ACTION_CATALOG,
): DiscoveryEvalCorpus {
  const destructive = destructiveWriteNames(registry);
  const sourceCases = buildEvalCases(registry);
  const excludedOperationNames = sourceCases
    .filter((entry) => !registry.availability(entry.actionName, DISCOVERY_HARNESS_AUTH_CLASS).available)
    .map((entry) => entry.actionName)
    .sort();
  const cases = sourceCases
    .filter((entry) => registry.availability(entry.actionName, DISCOVERY_HARNESS_AUTH_CLASS).available)
    .map((entry) => ({
      actionName: entry.actionName,
      apiOperationId: entry.apiOperationId,
      featureGroup: entry.featureGroup,
      canonicalRequest: entry.canonicalRequest,
      paraphraseRequest: entry.paraphraseRequest,
      ...(entry.typoRequest ? { typoRequest: entry.typoRequest } : {}),
      unrelatedDestructiveOperations: destructive
        .filter((candidate) => candidate.featureGroup !== entry.featureGroup && candidate.name !== entry.actionName)
        .map((candidate) => candidate.name),
    }));
  return {
    cases,
    caseSelection: {
      authClass: DISCOVERY_HARNESS_AUTH_CLASS,
      sourceOperationCount: sourceCases.length,
      excludedOperationNames,
    },
  };
}

export function buildDiscoveryEvalCases(
  registry: ActionRegistry = MODEL_API_ACTION_CATALOG,
): DiscoveryEvalCase[] {
  return buildDiscoveryEvalCorpus(registry).cases;
}
