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

/** Generate the JSON Schema for an action's arguments (minus the noisy `$schema`). */
export function actionParametersSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const json = zodToJsonSchema(schema, { $refStrategy: "none", target: "jsonSchema7" }) as Record<string, unknown>;
  const { $schema: _drop, ...rest } = json;
  void _drop;
  // The provider's `function.parameters` must be an object schema; coerce the rare
  // non-object top level (no current action hits this) into a permissive object.
  if (rest.type !== "object") {
    return { type: "object", properties: {}, additionalProperties: true };
  }
  return rest;
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
