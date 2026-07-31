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

/**
 * The one place `referenceId` is added to a model-facing tool schema (Task
 * 14). Never required, never duplicated per action — added only when the
 * action's normalized registry entry carries `referenceSelector`. The
 * underlying action Zod schema is untouched and (being closed/strict) still
 * rejects `referenceId`; resolution must strip it before Zod validation runs.
 *
 * ── THE DOUBLE LOCK (C5) ───────────────────────────────────────────────────
 * The entity-reference vertical is DORMANT, and it is held dormant by two
 * independent locks. Neither may be removed without funding the whole feature:
 *
 *   LOCK 1 — nothing calls this function. `actionParametersSchemaWithReference`
 *     has zero callers; both live tool builders (`toolsForModel`,
 *     `discoveryToolsForLoadedSet`, tools.ts:60,:86) call the plain
 *     `actionParametersSchema`, so `referenceId` is never advertised to a
 *     model. This is deliberate — closure-plan PR 10 (F09) removed the
 *     advertisement because offering it made the model invoke a feature that
 *     always failed validation.
 *   LOCK 2 — nothing writes a reference. `upsertEntityReference` has no
 *     production caller, so the `entity_references` table is reachable in
 *     production for DELETE only (retention.ts, installations.ts erasure).
 *     Even if LOCK 1 were lifted, every resolution would miss.
 *
 * DECISION 2026-07-31 (owner, Phase C task C5): KEEP DORMANT — not funded for
 * this release. Storage and the `referenceSelector` metadata stay compatible
 * so the feature can be funded later WITHOUT a migration, and no catalog-hash
 * event is spent on retiring it before the release evidence run. Retiring it
 * fully (deleting this function, the four dormant Store methods, the table via
 * a v14 migration, and `referenceSelector` from the fingerprint contract at
 * catalog.ts:211) would move every action fingerprint and the catalog hash, so
 * it must be scheduled as a regeneration event before any evidence run — never
 * between two. Revisit after launch.
 *
 * What is GONE (C5) is the plumbing that pretended to carry a reference at
 * runtime: the clarification candidate's never-set `referenceId` field and the
 * permanently-false forward that copied it into a run event. Because the
 * module stays, `src/assistant-v2/references/entity-reference.ts` remains an
 * intentional orphan and is allowlisted by name in the C7 orphan gate.
 */
export function actionParametersSchemaWithReference(
  schema: z.ZodTypeAny,
  hasReferenceSelector: boolean,
): Record<string, unknown> {
  const base = actionParametersSchema(schema);
  if (!hasReferenceSelector) return base;
  const properties = { ...(base.properties as Record<string, unknown> | undefined ?? {}) };
  properties.referenceId = {
    type: "string",
    minLength: 1,
    description: "Id of a previously grounded entity reference to resolve from, in place of its raw id argument(s).",
  };
  return { ...base, properties };
}
