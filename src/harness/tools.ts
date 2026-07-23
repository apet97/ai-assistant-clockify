import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { CatalogRegistry } from "./catalog.js";
import type { ToolDefinition } from "../assistant/model-client.js";

/**
 * Native tool-calling support (Phase 2). Each catalog action becomes a typed tool
 * whose `parameters` is a JSON Schema generated from the SAME Zod schema the
 * harness validates with. The provider validates the model's arguments against
 * this schema, so the model stops inventing arg shapes — but the harness still
 * re-validates every proposed action against the Zod schema + the risk/policy gate
 * before executing, so provider validation is a convenience, never the trust
 * boundary. Reads the schema only (no values), so no secret can leak.
 *
 * Generation unwraps our `z.preprocess`/`.refine` to the canonical inner object
 * (e.g. `create_work_package` exposes `project`, not the `projectName` alias),
 * which is exactly the shape we want the model to produce.
 */

/**
 * Strip presentation-only JSON-Schema keys the model doesn't need. Closed-object
 * boundaries are security signal and must remain visible to the provider as well
 * as being enforced again by the harness.
 */
function pruneSchemaNoise(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(pruneSchemaNoise);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "minLength" && value === 1) continue;
      if (key === "default") continue;
      out[key] = pruneSchemaNoise(value);
    }
    return out;
  }
  return node;
}

/** Generate the lean JSON Schema for an action's arguments (minus `$schema` + noise keys). */
export function actionParametersSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const json = zodToJsonSchema(schema, { $refStrategy: "none", target: "jsonSchema7" }) as Record<string, unknown>;
  const { $schema: _drop, ...rest } = json;
  void _drop;
  // The provider's `function.parameters` must be an object schema; coerce the rare
  // non-object top level (no current action hits this) into a permissive object.
  if (rest.type !== "object") {
    return { type: "object", properties: {}, additionalProperties: false };
  }
  return pruneSchemaNoise(rest) as Record<string, unknown>;
}

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
