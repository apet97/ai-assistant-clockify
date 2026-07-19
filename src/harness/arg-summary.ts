import type { z } from "zod";
import { inspectZodSchema } from "./schema-introspection.js";

/**
 * Terse argument-signature summariser (Phase 1B — the model-agnostic variance
 * killer). Given an action's Zod schema it produces a one-line signature like
 * `clientName?: string; items?: object[]; number?: string` that is rendered into
 * the system prompt so the planner uses the *exact* argument names instead of
 * inventing shapes (`projectName` vs `project`, `startTimer: true`, missing ids).
 *
 * It obtains a small, compatibility-tested description from the schema
 * introspection adapter rather than taking a new dependency. Wrappers that
 * don't change a field's "shape category" are peeled
 * (optional/default/nullable/effects/branded/readonly); `optional`/`default` mark
 * a field omittable. Anything it can't see inside falls back to `object`, and the
 * whole line is length-bounded so the prompt stays compact. It only reads the
 * schema — never values — so no secret can leak through it.
 */

/** Longest rendered signature line before truncation with an ellipsis. */
const MAX_SIG_LEN = 200;
/** Longest single field/type label before truncation. */
const MAX_LABEL_LEN = 48;
/** Most enum values rendered inline before an ellipsis. */
const MAX_ENUM_VALUES = 8;
/** Most union options rendered before an ellipsis. */
const MAX_UNION_OPTIONS = 4;

/**
 * Peel wrappers that don't change a field's shape category. Returns the inner
 * base node and whether the field is omittable (optional/default).
 */
function unwrap(schema: unknown): { base: unknown; optional: boolean } {
  let node = schema;
  let optional = false;
  for (let i = 0; i < 32; i += 1) {
    const description = inspectZodSchema(node);
    const tn = description.typeName;
    if (tn === "ZodOptional" || tn === "ZodDefault") {
      optional = true;
      node = description.innerType;
    } else if (tn === "ZodNullable" || tn === "ZodReadonly") {
      node = description.innerType;
    } else if (tn === "ZodEffects") {
      node = description.schema;
    } else if (tn === "ZodBranded") {
      node = description.type;
    } else if (tn === "ZodPipeline") {
      node = description.out;
    } else {
      break;
    }
  }
  return { base: node, optional };
}

function clamp(label: string): string {
  return label.length > MAX_LABEL_LEN ? `${label.slice(0, MAX_LABEL_LEN - 1)}…` : label;
}

function enumLabel(values: unknown[]): string {
  const shown = values.slice(0, MAX_ENUM_VALUES).map((v) => String(v));
  const joined = shown.join("|");
  return values.length > MAX_ENUM_VALUES ? `${joined}|…` : joined;
}

function unionLabel(options: unknown): string {
  const list = options instanceof Map ? [...options.values()] : Array.isArray(options) ? options : [];
  const labels: string[] = [];
  for (const opt of list.slice(0, MAX_UNION_OPTIONS)) {
    const label = labelOf(opt);
    if (!labels.includes(label)) labels.push(label);
  }
  const joined = labels.join("|");
  return list.length > MAX_UNION_OPTIONS ? `${joined}|…` : joined;
}

/** A short type label for a field's base node. */
function labelOf(schema: unknown): string {
  const { base } = unwrap(schema);
  const description = inspectZodSchema(base);
  switch (description.typeName) {
    case "ZodString":
      return "string";
    case "ZodNumber":
    case "ZodBigInt":
      return "number";
    case "ZodBoolean":
      return "boolean";
    case "ZodDate":
      return "date";
    case "ZodEnum":
      return clamp(enumLabel(description.values ?? []));
    case "ZodNativeEnum":
      return "enum";
    case "ZodLiteral":
      return clamp(typeof description.value === "string" ? JSON.stringify(description.value) : String(description.value));
    case "ZodArray":
      return clamp(`${labelOf(description.type)}[]`);
    case "ZodObject":
    case "ZodRecord":
    case "ZodMap":
      return "object";
    case "ZodUnion":
    case "ZodDiscriminatedUnion":
      return clamp(unionLabel(description.options));
    case "ZodTuple":
      return "array";
    case "ZodAny":
    case "ZodUnknown":
      return "any";
    default:
      return "object";
  }
}

function objectShape(base: unknown): Record<string, unknown> | undefined {
  const description = inspectZodSchema(base);
  return description.typeName === "ZodObject" ? description.shape : undefined;
}

/**
 * Summarise an action's argument schema as a terse one-line signature for the
 * model prompt. Non-object top-level schemas collapse to a single coarse label.
 */
export function summarizeArgs(schema: z.ZodTypeAny): string {
  const { base } = unwrap(schema);
  const shape = objectShape(base);
  if (!shape) return labelOf(base);

  const keys = Object.keys(shape);
  if (keys.length === 0) return "(none)";

  const parts = keys.map((key) => {
    const field = shape[key];
    const { optional } = unwrap(field);
    return `${key}${optional ? "?" : ""}: ${labelOf(field)}`;
  });
  const sig = parts.join("; ");
  return sig.length > MAX_SIG_LEN ? `${sig.slice(0, MAX_SIG_LEN - 1)}…` : sig;
}
