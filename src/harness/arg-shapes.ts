import { z } from "zod";

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
