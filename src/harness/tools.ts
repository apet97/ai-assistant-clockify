import type { CatalogRegistry } from "./catalog.js";
import type { ToolDefinition } from "../assistant/model-client.js";
import type { ActionRegistry } from "./api-catalog.js";
import { DISCOVERY_META_TOOL_NAME } from "./api-operation.js";
import { actionParametersSchema } from "./tool-schema.js";
import { DISCOVERY_META_TOOL } from "../assistant-v2/discovery/api-search-tool.js";

export { actionParametersSchema } from "./tool-schema.js";

export {
  DISCOVERY_META_TOOL,
  DISCOVERY_STATUS_TEXT,
  V2_MAX_LOADED_API_TOOLS,
  findApiOperationsInputSchema,
  initialV2ToolSet,
  parseFindApiOperationsInput,
  refineLoadedToolSet,
  runDiscoverySearch,
  validateLoadedToolCall,
  type LoadedToolValidationFailure,
  type LoadedToolValidationResult,
  type ParsedFindApiOperationsInput,
} from "../assistant-v2/discovery/api-search-tool.js";

/**
 * Native tool-calling support (Phase 2). Each catalog action becomes a typed tool
 * whose `parameters` is a JSON Schema generated from the SAME Zod schema the
 * harness validates with.
 */

const REGISTRY_IDS = new Set(["v1-internal", "v2-api", "v2-local"]);
const cachedByRegistry = new WeakMap<CatalogRegistry, ToolDefinition[]>();

function assertToolRegistry(registry: unknown): asserts registry is CatalogRegistry {
  if (!registry || typeof registry !== "object"
    || !("id" in registry) || typeof registry.id !== "string"
    || !REGISTRY_IDS.has(registry.id)
    || !("actions" in registry) || !Array.isArray(registry.actions)
    || !("hash" in registry) || typeof registry.hash !== "function") {
    throw new Error("tools_for_model_registry_required");
  }
}

/**
 * The model-visible tool catalog — one tool per registry action. Requires an
 * exact ActionRegistry; names alone are never sufficient and there is no global
 * full-catalog default. Memoized per registry. With `actionNames`, returns the
 * SUBSET in registry order.
 */
export function toolsForModel(
  registry: CatalogRegistry,
  actionNames?: ReadonlySet<string>,
): ToolDefinition[] {
  assertToolRegistry(registry);
  let cached = cachedByRegistry.get(registry);
  if (!cached) {
    cached = registry.actions.map((action) => ({
      name: action.name,
      description: action.description,
      parameters: actionParametersSchema(action.schema),
    }));
    cachedByRegistry.set(registry, cached);
  }
  return actionNames ? cached.filter((tool) => actionNames.has(tool.name)) : cached;
}

/**
 * V2 model tools for an explicit loaded-name set: the discovery meta-tool plus
 * at most 12 API tools. Never resolves through the full registry.
 */
export function discoveryToolsForLoadedSet(
  registry: ActionRegistry,
  loadedNames: ReadonlySet<string>,
): ToolDefinition[] {
  if (!loadedNames.has(DISCOVERY_META_TOOL_NAME)) {
    throw new Error("discovery_meta_tool_required");
  }
  const apiNames = new Set(
    [...loadedNames].filter((name) => name !== DISCOVERY_META_TOOL_NAME),
  );
  const apiTools = registry.actions
    .filter((action) => apiNames.has(action.name))
    .map((action) => ({
      name: action.name,
      description: action.description,
      // Closure-plan PR 10 (F09): `referenceId` is NOT advertised — the
      // producer/resolver vertical has no runtime path, so offering it made
      // the model invoke a feature that always failed validation. The
      // dormant storage stays compatible until the feature is funded or
      // removed.
      parameters: actionParametersSchema(action.schema),
    }));
  return [DISCOVERY_META_TOOL, ...apiTools];
}

export function toolsForV2LoadedSet(
  registry: ActionRegistry,
  loadedNames: ReadonlySet<string>,
): ToolDefinition[] {
  assertToolRegistry(registry);
  if (registry.id !== "v2-api") {
    throw new Error("tools_for_v2_loaded_set_registry_required:v2-api");
  }
  return discoveryToolsForLoadedSet(registry, loadedNames);
}
