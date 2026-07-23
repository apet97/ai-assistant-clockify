import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

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
  if (rest.type !== "object") {
    return { type: "object", properties: {}, additionalProperties: false };
  }
  return pruneSchemaNoise(rest) as Record<string, unknown>;
}

export function requiredArgumentsFromSchema(schema: z.ZodTypeAny): readonly string[] {
  const jsonSchema = actionParametersSchema(schema);
  const required = jsonSchema.required;
  if (!Array.isArray(required)) return Object.freeze([]);
  return Object.freeze(required.filter((entry): entry is string => typeof entry === "string"));
}
