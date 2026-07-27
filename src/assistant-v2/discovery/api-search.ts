import type {
  ApiSearchAccessFilter,
  ApiSearchAuthClass,
  ApiSearchResult,
  AuthClass,
  FindApiOperationsInput,
} from "../../harness/api-operation.js";
import {
  API_SEARCH_EXACT_MATCH_BONUS,
  API_SEARCH_MAX_LIMIT,
  API_SEARCH_QUERY_MAX_CHARS,
  API_SEARCH_TRIGRAM_THRESHOLD,
} from "../../harness/api-operation.js";
import type { FeatureGroup } from "../../harness/permissions.js";
import {
  type ApiOperationIndex,
  type IndexedApiOperation,
  isOperationAvailableForAuth,
  toApiOperationDescriptor,
} from "./api-index.js";
import { normalizeSearchText, tokenizeSearchText, trigramJaccardSimilarity } from "./api-text.js";

const FIELD_WEIGHTS = Object.freeze({
  operationId: 40,
  toolName: 40,
  methodPath: 30,
  groupArgumentAccess: 20,
  description: 10,
} as const);

type SearchFieldKey = keyof typeof FIELD_WEIGHTS;

function tokenSet(tokens: readonly string[]): Set<string> {
  return new Set(tokens);
}

function highestTokenFieldWeight(
  queryToken: string,
  fields: IndexedApiOperation["searchFields"],
): { weight: number; matched: boolean } {
  let weight = 0;
  let matched = false;
  const checks: Array<[SearchFieldKey, readonly string[]]> = [
    ["operationId", fields.operationId],
    ["toolName", fields.toolName],
    ["methodPath", fields.methodPath],
    ["groupArgumentAccess", fields.groupArgumentAccess],
    ["description", fields.description],
  ];
  for (const [field, fieldTokens] of checks) {
    if (tokenSet(fieldTokens).has(queryToken)) {
      matched = true;
      weight = Math.max(weight, FIELD_WEIGHTS[field]);
    }
  }
  return { weight, matched };
}

function highestTrigramSimilarity(
  queryText: string,
  fields: IndexedApiOperation["searchFields"],
): number {
  const fieldTexts = [
    fields.operationIdText,
    fields.toolNameText,
    fields.methodPathText,
    fields.groupArgumentAccessText,
    fields.descriptionText,
  ];
  let highest = 0;
  for (const fieldText of fieldTexts) {
    highest = Math.max(highest, trigramJaccardSimilarity(queryText, fieldText));
  }
  return highest;
}

export interface ScoredApiOperation {
  operation: IndexedApiOperation;
  score: number;
}

export function scoreIndexedOperation(
  operation: IndexedApiOperation,
  queryNormalized: string,
  queryTokens: readonly string[],
): ScoredApiOperation | undefined {
  if (queryTokens.length === 0) return undefined;

  let tokenScore = 0;
  let exactTokenMatched = false;
  for (const queryToken of new Set(queryTokens)) {
    const { weight, matched } = highestTokenFieldWeight(queryToken, operation.searchFields);
    if (matched) exactTokenMatched = true;
    tokenScore += weight;
  }

  if (
    queryNormalized === operation.searchFields.operationIdText
    || queryNormalized === operation.searchFields.toolNameText
  ) {
    tokenScore += API_SEARCH_EXACT_MATCH_BONUS;
    exactTokenMatched = true;
  }

  const trigramSimilarity = highestTrigramSimilarity(queryNormalized, operation.searchFields);
  const trigramScore = Math.floor(25 * trigramSimilarity);
  const score = tokenScore + trigramScore;

  const queryCodePoints = [...queryNormalized].length;
  const qualifies = queryCodePoints < 3
    ? exactTokenMatched
    : exactTokenMatched || trigramSimilarity >= API_SEARCH_TRIGRAM_THRESHOLD;
  if (!qualifies) return undefined;

  return { operation, score };
}

function compareScoredOperations(
  left: ScoredApiOperation,
  right: ScoredApiOperation,
): number {
  if (right.score !== left.score) return right.score - left.score;
  const operationIdOrder = left.operation.operationId.localeCompare(right.operation.operationId);
  if (operationIdOrder !== 0) return operationIdOrder;
  return left.operation.toolName.localeCompare(right.operation.toolName);
}

function passesAccessFilter(
  operation: IndexedApiOperation,
  access: ApiSearchAccessFilter,
): boolean {
  if (access === "any") return true;
  return operation.access === access;
}

function passesGroupFilter(
  operation: IndexedApiOperation,
  groups: readonly FeatureGroup[] | undefined,
): boolean {
  if (!groups || groups.length === 0) return true;
  return groups.includes(operation.featureGroup);
}

function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) return API_SEARCH_MAX_LIMIT;
  return Math.min(limit, API_SEARCH_MAX_LIMIT);
}

function searchPool(
  pool: readonly IndexedApiOperation[],
  queryNormalized: string,
  queryTokens: readonly string[],
  access: ApiSearchAccessFilter,
  groups: readonly FeatureGroup[] | undefined,
  limit: number,
): readonly ScoredApiOperation[] {
  const scored: ScoredApiOperation[] = [];
  for (const operation of pool) {
    if (!passesAccessFilter(operation, access)) continue;
    if (!passesGroupFilter(operation, groups)) continue;
    const result = scoreIndexedOperation(operation, queryNormalized, queryTokens);
    if (result) scored.push(result);
  }
  scored.sort(compareScoredOperations);
  return Object.freeze(scored.slice(0, limit));
}

/** Pure deterministic search over a trusted index with auth filtering before scoring. */
export function searchApiOperations(
  index: ApiOperationIndex,
  input: FindApiOperationsInput,
  authClass: ApiSearchAuthClass,
): ApiSearchResult {
  const access: ApiSearchAccessFilter = input.access ?? "any";
  const queryNormalized = normalizeSearchText(input.query.trim().slice(0, API_SEARCH_QUERY_MAX_CHARS));
  const queryTokens = tokenizeSearchText(queryNormalized);
  const limit = resolveLimit(input.limit);

  if (authClass === "missing_auth_class") {
    throw new Error("missing_auth_class");
  }

  if (queryTokens.length === 0) {
    return Object.freeze({
      kind: "matches",
      query: input.query.trim(),
      access,
      operations: Object.freeze([]),
    });
  }

  const availablePool = index.operations.filter((operation) =>
    isOperationAvailableForAuth(operation, authClass));
  const availableMatches = searchPool(
    availablePool,
    queryNormalized,
    queryTokens,
    access,
    input.groups,
    limit,
  );
  if (availableMatches.length > 0) {
    return Object.freeze({
      kind: "matches",
      query: input.query.trim(),
      access,
      operations: Object.freeze(availableMatches.map(({ operation }) =>
        Object.freeze(toApiOperationDescriptor(operation)))),
    });
  }

  const unavailablePool = index.operations.filter((operation) =>
    !isOperationAvailableForAuth(operation, authClass as AuthClass));
  const unavailableMatches = searchPool(
    unavailablePool,
    queryNormalized,
    queryTokens,
    access,
    input.groups,
    1,
  );
  if (unavailableMatches.length > 0) {
    return Object.freeze({
      kind: "notice",
      code: "no_available_operation_for_auth_class",
      authClass,
    });
  }

  return Object.freeze({
    kind: "matches",
    query: input.query.trim(),
    access,
    operations: Object.freeze([]),
  });
}
