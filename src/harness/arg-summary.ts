import type { z } from "zod";

/**
 * Terse argument-signature summariser (Phase 1B — the model-agnostic variance
 * killer). Given an action's Zod schema it produces a one-line signature like
 * `clientName?: string; items?: object[]; number?: string` that is rendered into
 * the system prompt so the planner uses the *exact* argument names instead of
 * inventing shapes (`projectName` vs `project`, `startTimer: true`, missing ids).
 *
 * It introspects Zod's internal `_def` (read-only) rather than taking a new
 * dependency. Wrappers that don't change a field's "shape category" are peeled
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

interface ZodNode {
  _def?: {
    typeName?: string;
    innerType?: ZodNode;
    schema?: ZodNode;
    type?: ZodNode;
    out?: ZodNode;
    values?: unknown[];
    value?: unknown;
    options?: unknown;
    valueType?: ZodNode;
    shape?: () => Record<string, ZodNode>;
  };
  shape?: Record<string, ZodNode>;
}

function asNode(schema: unknown): ZodNode {
  return (schema ?? {}) as ZodNode;
}

/**
 * Peel wrappers that don't change a field's shape category. Returns the inner
 * base node and whether the field is omittable (optional/default).
 */
function unwrap(schema: unknown): { base: ZodNode; optional: boolean } {
  let node = asNode(schema);
  let optional = false;
  for (let i = 0; i < 32 && node?._def; i += 1) {
    const tn = node._def.typeName;
    if (tn === "ZodOptional" || tn === "ZodDefault") {
      optional = true;
      node = asNode(node._def.innerType);
    } else if (tn === "ZodNullable" || tn === "ZodReadonly") {
      node = asNode(node._def.innerType);
    } else if (tn === "ZodEffects") {
      node = asNode(node._def.schema);
    } else if (tn === "ZodBranded") {
      node = asNode(node._def.type);
    } else if (tn === "ZodPipeline") {
      node = asNode(node._def.out);
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
  const def = base._def;
  switch (def?.typeName) {
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
      return clamp(enumLabel(def.values ?? []));
    case "ZodNativeEnum":
      return "enum";
    case "ZodLiteral":
      return clamp(typeof def.value === "string" ? JSON.stringify(def.value) : String(def.value));
    case "ZodArray":
      return clamp(`${labelOf(def.type)}[]`);
    case "ZodObject":
    case "ZodRecord":
    case "ZodMap":
      return "object";
    case "ZodUnion":
    case "ZodDiscriminatedUnion":
      return clamp(unionLabel(def.options));
    case "ZodTuple":
      return "array";
    case "ZodAny":
    case "ZodUnknown":
      return "any";
    default:
      return "object";
  }
}

function objectShape(base: ZodNode): Record<string, ZodNode> | undefined {
  if (base._def?.typeName !== "ZodObject") return undefined;
  if (typeof base._def.shape === "function") return base._def.shape();
  return base.shape;
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
