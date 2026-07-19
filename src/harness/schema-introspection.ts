/**
 * The sole compatibility seam for the small read-only slice of Zod internals
 * used to render planner argument signatures. Zod 3 does not expose a public
 * visitor for these shapes, so callers consume this normalized description
 * instead of reaching into `_def` themselves.
 */
export interface ZodSchemaDescription {
  typeName?: string;
  innerType?: unknown;
  schema?: unknown;
  type?: unknown;
  out?: unknown;
  values?: unknown[];
  value?: unknown;
  options?: unknown;
  shape?: Record<string, unknown>;
}

interface ZodInternalNode {
  _def?: {
    typeName?: unknown;
    innerType?: unknown;
    schema?: unknown;
    type?: unknown;
    out?: unknown;
    values?: unknown;
    value?: unknown;
    options?: unknown;
    shape?: unknown;
  };
  shape?: unknown;
}

/**
 * Extract the Zod 3 schema metadata needed by the prompt-only argument
 * summarizer. Unsupported or future Zod shapes return an empty description so
 * consumers can retain their conservative `object` fallback.
 */
export function inspectZodSchema(schema: unknown): ZodSchemaDescription {
  const node = (schema ?? {}) as ZodInternalNode;
  const def = node._def;
  if (!def || typeof def.typeName !== "string") return {};
  const shape = typeof def.shape === "function"
    ? def.shape()
    : node.shape;
  return {
    typeName: def.typeName,
    ...(def.innerType !== undefined ? { innerType: def.innerType } : {}),
    ...(def.schema !== undefined ? { schema: def.schema } : {}),
    ...(def.type !== undefined ? { type: def.type } : {}),
    ...(def.out !== undefined ? { out: def.out } : {}),
    ...(Array.isArray(def.values) ? { values: def.values } : {}),
    ...(def.value !== undefined ? { value: def.value } : {}),
    ...(def.options !== undefined ? { options: def.options } : {}),
    ...(shape && typeof shape === "object" && !Array.isArray(shape)
      ? { shape: shape as Record<string, unknown> }
      : {}),
  };
}
