import type { ReferenceSelectorBinding, ReferenceSelectorMetadata } from "../../harness/api-operation.js";
import { getValueAtPointer } from "../../harness/prepared-write-presentation.js";
import type { EntityReferenceRecord } from "../../db/store/entity-references.js";

export type { ReferenceSelectorBinding, ReferenceSelectorMetadata };

/** Resolved by scope + entity type; never trusts a caller-chosen record. */
export type EntityReferenceLookup = (entityType: string, referenceId: string) => EntityReferenceRecord | undefined;

export type ReferenceResolutionFailureCode =
  | "reference_not_supplied"
  | "reference_not_found"
  | "reference_wrong_entity_type"
  | "reference_not_active"
  | "reference_conflicts_with_explicit_id"
  | "reference_binding_target_not_object";

export type ResolveReferenceResult =
  | { ok: true; args: Record<string, unknown>; reference: EntityReferenceRecord }
  | { ok: false; code: ReferenceResolutionFailureCode };

function valueForReferenceField(
  record: EntityReferenceRecord,
  field: ReferenceSelectorBinding["referenceField"],
): unknown {
  if (field === "externalId") return record.externalId;
  // "scope.projectId": the sole reviewed non-externalId reference field,
  // captured as a scope VALUE on the reference itself when it was verified
  // (e.g. a task's parent project) — never inferred from display text.
  return record.bindings.find((binding) => binding.field === field)?.value;
}

function setAtPointer(root: Record<string, unknown>, pointer: string, value: unknown): true | ReferenceResolutionFailureCode {
  if (!pointer.startsWith("/")) throw new Error(`invalid_pointer:${pointer}`);
  const segments = pointer.slice(1).split("/").map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  let current: Record<string, unknown> = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]!;
    const next = current[segment];
    if (next === undefined) {
      const created: Record<string, unknown> = {};
      current[segment] = created;
      current = created;
      continue;
    }
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      return "reference_binding_target_not_object";
    }
    current = next as Record<string, unknown>;
  }
  current[segments[segments.length - 1]!] = value;
  return true;
}

/**
 * Resolution steps 1-4 and 7 of the canonical Task 14 order: load the
 * reference under exact scope, require active status and a matching entity
 * type, require exact equality with any conflicting explicit id already
 * present at a binding's target path, then inject only the reviewed binding
 * values and remove `referenceId` — all BEFORE the action's strict Zod
 * validation runs. Steps 5 (narrowing-only authority), 6 (fresh Clockify
 * lookup at write-preparation time), 8 (post-outcome status transitions), and
 * 9 (bounded discovery context) are owned by the preparation service, the
 * write workflow, and the discovery context builder respectively — not this
 * pure function.
 */
export function resolveEntityReference(input: {
  rawArgs: Record<string, unknown>;
  selector: ReferenceSelectorMetadata;
  lookup: EntityReferenceLookup;
}): ResolveReferenceResult {
  const { rawArgs, selector, lookup } = input;
  const referenceId = rawArgs.referenceId;
  if (typeof referenceId !== "string" || referenceId.length === 0) {
    return { ok: false, code: "reference_not_supplied" };
  }

  const record = lookup(selector.entityType, referenceId);
  if (!record) return { ok: false, code: "reference_not_found" };
  if (record.entityType !== selector.entityType) return { ok: false, code: "reference_wrong_entity_type" };
  if (record.status !== "active") return { ok: false, code: "reference_not_active" };

  const args: Record<string, unknown> = { ...rawArgs };
  delete args.referenceId;

  for (const binding of selector.bindings) {
    const value = valueForReferenceField(record, binding.referenceField);
    if (value === undefined) return { ok: false, code: "reference_wrong_entity_type" };
    const existing = getValueAtPointer(args, binding.argumentPath);
    if (existing.present && existing.value !== undefined && existing.value !== value) {
      return { ok: false, code: "reference_conflicts_with_explicit_id" };
    }
    const outcome = setAtPointer(args, binding.argumentPath, value);
    if (outcome !== true) return { ok: false, code: outcome };
  }

  return { ok: true, args, reference: record };
}
