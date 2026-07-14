import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * Forgiving scalar shapes for model-emitted arguments. The planner sometimes
 * sends a single string where an array is expected (`assigneeIds: "Bob"`) or a
 * numeric string where a number is expected (`amount: "75"`). zodToJsonSchema
 * unwraps `z.preprocess` to the inner schema (see tools.ts), so the
 * model-visible tool schema stays the canonical array/number — only the
 * harness's acceptance widens. Coercion is conservative: no comma splitting
 * (names may contain commas), no boolean coercion, and never `""` → 0 (a
 * silent $0 amount would be a money bug).
 */

/**
 * Accept a bare string for a string list (`"x"` ⇒ `["x"]`). Pass a constrained
 * array schema to keep its rules: `zStringList(z.array(z.string().min(1)).min(1))`.
 * Generic so `z.infer` keeps the array element type at every adoption site.
 */
export function zStringList<S extends z.ZodTypeAny = z.ZodArray<z.ZodString>>(
  schema?: S,
): z.ZodEffects<S, z.output<S>, unknown> {
  const inner = (schema ?? z.array(z.string().min(1))) as S;
  return z.preprocess((value) => (typeof value === "string" ? [value] : value), inner);
}

/**
 * Accept a numeric string for a number (`"40.5"` ⇒ 40.5). Non-numeric and
 * empty strings pass through untouched so the inner schema reports the real
 * type error; constraints (`.positive()`, `.int()`) apply AFTER coercion.
 */
export function zNumberLike<S extends z.ZodTypeAny = z.ZodNumber>(schema?: S): z.ZodEffects<S, z.output<S>, unknown> {
  const inner = (schema ?? z.number()) as S;
  return z.preprocess((value) => {
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
    return value;
  }, inner);
}

/**
 * invalid_args copy the agent loop can self-correct from: each issue prefixed
 * with its field path ("assigneeIds: Expected array, received string";
 * "items.0.amount: …"). A bare Zod message names the failure but not the
 * field — useless to a model holding ten arguments.
 */
export function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join("; ");
}

type JsonSchema = Record<string, unknown>;
const jsonSchemaCache = new WeakMap<z.ZodTypeAny, JsonSchema>();

function jsonSchemaFor(schema: z.ZodTypeAny): JsonSchema {
  const cached = jsonSchemaCache.get(schema);
  if (cached) return cached;
  const generated = zodToJsonSchema(schema, {
    $refStrategy: "none",
    target: "jsonSchema7",
  }) as JsonSchema;
  jsonSchemaCache.set(schema, generated);
  return generated;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesType(schema: JsonSchema, value: unknown): boolean {
  switch (schema.type) {
    case "object": return isRecord(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "number":
    case "integer": return typeof value === "number";
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    default: return true;
  }
}

function unknownPaths(
  schema: JsonSchema,
  value: unknown,
  path: string,
  aliases: ReadonlySet<string> | undefined,
  openPaths: ReadonlySet<string>,
  schemaPath: string,
): string[] {
  const branches = (schema.anyOf ?? schema.oneOf) as JsonSchema[] | undefined;
  if (branches) {
    const matching = branches.filter((branch) => matchesType(branch, value));
    const candidates = matching.length > 0 ? matching : branches;
    const findings = candidates.map((branch) => unknownPaths(branch, value, path, aliases, openPaths, schemaPath));
    return findings.find((items) => items.length === 0) ?? findings[0] ?? [];
  }

  if (Array.isArray(value)) {
    const items = schema.items;
    if (!items || typeof items !== "object" || Array.isArray(items)) return [];
    return value.flatMap((item, index) =>
      unknownPaths(items as JsonSchema, item, `${path}[${index}]`, undefined, openPaths, `${schemaPath}[]`));
  }

  if (!isRecord(value) || schema.type !== "object") return [];
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const additional = schema.additionalProperties;
  const findings: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    const property = properties[key];
    if (property && typeof property === "object" && !Array.isArray(property)) {
      const childSchemaPath = schemaPath ? `${schemaPath}.${key}` : key;
      findings.push(...unknownPaths(property as JsonSchema, child, childPath, undefined, openPaths, childSchemaPath));
    } else if (!path && aliases?.has(key)) {
      continue;
    } else if (openPaths.has(schemaPath)) {
      if (additional && typeof additional === "object" && !Array.isArray(additional)) {
        findings.push(...unknownPaths(additional as JsonSchema, child, childPath, undefined, openPaths, schemaPath));
      }
    } else {
      findings.push(childPath);
    }
  }
  return findings;
}

/** Unknown fields are rejected before preprocessors can silently discard them. */
export function unknownArgumentPaths(
  schema: z.ZodTypeAny,
  value: unknown,
  allowedTopLevelAliases: readonly string[] = [],
  allowedOpenPaths: readonly string[] = [],
): string[] {
  return unknownPaths(
    jsonSchemaFor(schema),
    value,
    "",
    new Set(allowedTopLevelAliases),
    new Set(allowedOpenPaths),
    "",
  );
}
