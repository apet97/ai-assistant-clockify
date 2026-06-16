import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ACTION_CATALOG } from "./catalog.js";
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
 * Strip JSON-Schema keys the model doesn't need — they're re-validated by the harness
 * (executeAction Zod-parses every proposal), so they're invisible at the trust boundary
 * but inflate the prompt (re-sent every model call, ~99% of token cost; ~11.7% of the
 * tool array). Drops `additionalProperties:false` (the bare deny literal — a real nested
 * object-schema survives), `minLength:1`, and `default`. KEEPS all signal: enums,
 * type, required, descriptions, minimum/maximum, nested schemas.
 */
function pruneSchemaNoise(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(pruneSchemaNoise);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "additionalProperties" && value === false) continue;
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
    return { type: "object", properties: {}, additionalProperties: true };
  }
  return pruneSchemaNoise(rest) as Record<string, unknown>;
}

let cached: ToolDefinition[] | undefined;

/**
 * The model-visible tool catalog — one tool per action. Memoized (catalog is
 * static). With `actionNames`, returns the SUBSET in catalog order (Phase 1 tool
 * subsetting); without it, the full list, byte-identical to before. The full list
 * is memoized once and merely filtered — the subset is a cheap view, not a rebuild.
 */
export function toolsForModel(actionNames?: ReadonlySet<string>): ToolDefinition[] {
  if (!cached) {
    cached = ACTION_CATALOG.map((action) => ({
      name: action.name,
      description: action.description,
      parameters: actionParametersSchema(action.schema),
    }));
  }
  return actionNames ? cached.filter((tool) => actionNames.has(tool.name)) : cached;
}
