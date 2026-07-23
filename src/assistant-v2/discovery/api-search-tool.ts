import { z } from "zod";

import type { ToolDefinition } from "../../assistant/model-client.js";
import type { ActionRegistry } from "../../harness/api-catalog.js";
import {
  API_SEARCH_MAX_LIMIT,
  API_SEARCH_QUERY_MAX_CHARS,
  DISCOVERY_META_TOOL_NAME,
  type ApiSearchAuthClass,
  type ApiSearchResult,
  type AuthClass,
  type FindApiOperationsInput,
} from "../../harness/api-operation.js";
import { FEATURE_GROUPS, type FeatureGroup } from "../../harness/permissions.js";
import { actionParametersSchema } from "../../harness/tool-schema.js";
import type { ApiOperationIndex } from "./api-index.js";
import { searchApiOperations } from "./api-search.js";

export const V2_MAX_LOADED_API_TOOLS = API_SEARCH_MAX_LIMIT;
export const DISCOVERY_STATUS_TEXT = "Finding the relevant Clockify API operations." as const;

const featureGroupSchema = z.enum(FEATURE_GROUPS as [FeatureGroup, ...FeatureGroup[]]);

export const findApiOperationsInputSchema = z.object({
  query: z.string().trim().min(1).max(API_SEARCH_QUERY_MAX_CHARS),
  access: z.enum(["read", "write", "any"]).optional(),
  groups: z.array(featureGroupSchema).optional(),
  limit: z.number().int().min(1).max(API_SEARCH_MAX_LIMIT).optional(),
}).strict();

export type ParsedFindApiOperationsInput = z.infer<typeof findApiOperationsInputSchema>;

export const DISCOVERY_META_TOOL: ToolDefinition = Object.freeze({
  name: DISCOVERY_META_TOOL_NAME,
  description:
    "Search the trusted Clockify API catalog for atomic operations matching a natural-language query. Returns ranked operation descriptors; only loaded operations may be called afterward.",
  parameters: actionParametersSchema(findApiOperationsInputSchema),
});

export type LoadedToolValidationFailure =
  | "tool_not_loaded"
  | "stale_catalog_hash"
  | "unknown_tool"
  | "unavailable_for_auth_class";

export type LoadedToolValidationResult =
  | { ok: true }
  | { ok: false; reason: LoadedToolValidationFailure };

function apiToolNames(names: Iterable<string>): string[] {
  const out: string[] = [];
  for (const name of names) {
    if (name !== DISCOVERY_META_TOOL_NAME) out.push(name);
  }
  return out;
}

/** Discovery-only initialization plus still-valid cached API tool names (never the full catalog). */
export function initialV2ToolSet(
  registry: ActionRegistry,
  cachedNames: Iterable<string> = [],
): ReadonlySet<string> {
  if (registry.id !== "v2-api") {
    throw new Error("initial_v2_tool_set_registry_required:v2-api");
  }
  const loaded = new Set<string>([DISCOVERY_META_TOOL_NAME]);
  for (const name of cachedNames) {
    if (name === DISCOVERY_META_TOOL_NAME) continue;
    if (!registry.get(name)) continue;
    if (apiToolNames(loaded).length >= V2_MAX_LOADED_API_TOOLS) break;
    loaded.add(name);
  }
  return loaded;
}

function rankedNamesFromSearch(searchResult: ApiSearchResult): readonly string[] {
  if (searchResult.kind !== "matches") return Object.freeze([]);
  return Object.freeze(searchResult.operations.map((operation) => operation.toolName));
}

/**
 * Merge discovery results into the loaded API tool set, preserving used tools and
 * capping API tools at 12. The discovery meta-tool is always retained separately.
 */
export function refineLoadedToolSet(
  currentLoaded: ReadonlySet<string>,
  usedNames: ReadonlySet<string>,
  searchResult: ApiSearchResult,
): ReadonlySet<string> {
  const next = new Set<string>([DISCOVERY_META_TOOL_NAME]);
  const ranked = rankedNamesFromSearch(searchResult);

  for (const name of usedNames) {
    if (name === DISCOVERY_META_TOOL_NAME) continue;
    next.add(name);
  }

  for (const name of ranked) {
    if (apiToolNames(next).length >= V2_MAX_LOADED_API_TOOLS) break;
    next.add(name);
  }

  for (const name of currentLoaded) {
    if (name === DISCOVERY_META_TOOL_NAME) continue;
    if (usedNames.has(name)) continue;
    if (apiToolNames(next).length >= V2_MAX_LOADED_API_TOOLS) break;
    next.add(name);
  }

  while (apiToolNames(next).length > V2_MAX_LOADED_API_TOOLS) {
    for (const name of next) {
      if (name === DISCOVERY_META_TOOL_NAME || usedNames.has(name)) continue;
      next.delete(name);
      break;
    }
  }

  return next;
}

export function validateLoadedToolCall(input: {
  toolName: string;
  loadedNames: ReadonlySet<string>;
  expectedCatalogHash: string;
  currentCatalogHash: string;
  registry: ActionRegistry;
  authClass: AuthClass;
}): LoadedToolValidationResult {
  if (input.toolName === DISCOVERY_META_TOOL_NAME) {
    return input.loadedNames.has(DISCOVERY_META_TOOL_NAME)
      ? { ok: true }
      : { ok: false, reason: "tool_not_loaded" };
  }
  if (input.expectedCatalogHash !== input.currentCatalogHash) {
    return { ok: false, reason: "stale_catalog_hash" };
  }
  if (!input.loadedNames.has(input.toolName)) {
    return { ok: false, reason: "tool_not_loaded" };
  }
  const action = input.registry.get(input.toolName);
  if (!action) {
    return { ok: false, reason: "unknown_tool" };
  }
  const availability = input.registry.availability(input.toolName, input.authClass);
  if (!availability.available) {
    return { ok: false, reason: "unavailable_for_auth_class" };
  }
  return { ok: true };
}

export function parseFindApiOperationsInput(raw: unknown): ParsedFindApiOperationsInput {
  return findApiOperationsInputSchema.parse(raw);
}

export function runDiscoverySearch(
  index: ApiOperationIndex,
  input: FindApiOperationsInput,
  authClass: ApiSearchAuthClass,
): ApiSearchResult {
  if (index.catalogHash === undefined) {
    throw new Error("discovery_index_required");
  }
  return searchApiOperations(index, input, authClass);
}
