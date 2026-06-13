import type { ActionContext } from "./action.js";
import type { EntityRef, SuccessReceipt, ErrorReceipt, Warning } from "./receipts.js";
import { successReceipt, errorReceipt } from "./receipts.js";
import { canWrite, type AdminPolicy, type FeatureGroup } from "./permissions.js";

/**
 * Undo of the last reversible action (Phase 5b). The only thing we reverse is a
 * CREATION — we delete the entities a successful action created (read straight from
 * `receipt.changed.created`), in REVERSE order so dependents go before their parents
 * (task → project → client). Deletes and field-updates are out of scope (a delete
 * can't be un-deleted; restoring a field needs before-state we don't capture yet).
 *
 * Higher-stakes creations (users, groups) are deliberately NOT reversible here. The
 * undo re-checks write policy for every affected group and denies the whole undo if
 * any is disabled — it never half-reverses on a policy boundary.
 */
const REVERSIBLE_ENTITY_GROUP: Record<string, FeatureGroup> = {
  project: "work_structure",
  client: "work_structure",
  task: "work_structure",
  tag: "work_structure",
  time_entry: "time_tracking",
  invoice: "invoices",
  expense: "expenses",
  webhook: "webhooks",
  group: "users_groups",
  holiday: "time_off_approvals",
  assignment: "scheduling",
  // time_off_request is deliberately ABSENT: its delete needs the POLICY id,
  // which the created-entity ref doesn't carry.
};

/** The created entities from a success receipt that can be reversed by deleting them. */
export function reversibleCreations(receipt: SuccessReceipt): EntityRef[] {
  return (receipt.changed?.created ?? []).filter((e) => e.type in REVERSIBLE_ENTITY_GROUP);
}

/** The first feature group an undo of these refs needs but the policy denies, else undefined. */
export function firstDeniedGroup(policy: AdminPolicy, refs: EntityRef[]): FeatureGroup | undefined {
  const groups = [...new Set(refs.map((r) => REVERSIBLE_ENTITY_GROUP[r.type]).filter(Boolean))] as FeatureGroup[];
  return groups.find((g) => !canWrite(policy, g));
}

/** Reverse a creation by deleting its entities (reverse order). Policy-gated; one call. */
export async function reverseCreation(
  ctx: ActionContext,
  refs: EntityRef[],
): Promise<SuccessReceipt | ErrorReceipt> {
  if (refs.length === 0) {
    return errorReceipt({ action: "undo", code: "not_undoable", message: "There is nothing to undo." });
  }

  const denied = firstDeniedGroup(ctx.policy, refs);
  if (denied) {
    return errorReceipt({
      action: "undo",
      code: "policy_denied",
      message: `Undo needs write access to ${denied}, which is disabled in your assistant permissions.`,
      recovery: { hint: `Enable write access for ${denied} and try again.`, retryable: true },
    });
  }

  if (!ctx.clockify.deleteEntity) {
    return errorReceipt({
      action: "undo",
      code: "unsupported",
      message: "Undo is not supported by the configured Clockify client.",
    });
  }

  const undone: EntityRef[] = [];
  const warnings: Warning[] = [];
  for (const ref of [...refs].reverse()) {
    try {
      await ctx.clockify.deleteEntity({ entityType: ref.type, id: ref.id });
      undone.push(ref);
    } catch (err) {
      warnings.push({
        code: "undo_failed",
        message: `Couldn't remove ${ref.type} ${ref.name ?? ref.id}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  if (undone.length === 0) {
    // Every delete failed (the host rejected them — the addon policy was already
    // re-checked above). The entities persist, so this is a FAILURE, not a silent
    // success: return an error receipt so the route responds 400 and the UI
    // re-enables the button with the real reason, instead of showing "Undone"
    // over changes that are still live. (A PARTIAL failure stays a success-with-
    // warnings below — some entities really were removed.)
    const detail = warnings.map((w) => w.message).join("; ");
    return errorReceipt({
      action: "undo",
      code: "undo_failed",
      message:
        refs.length === 1
          ? `Couldn't undo — the change could not be reversed. ${detail}`.trim()
          : `Couldn't undo — none of the ${refs.length} created items could be removed. ${detail}`.trim(),
      recovery: { hint: "Nothing was removed; remove them manually if needed.", retryable: false },
    });
  }

  return successReceipt({
    action: "undo",
    entity: "undo",
    ids: { workspaceId: ctx.workspaceId },
    changed: { deleted: undone },
    warnings: warnings.length ? warnings : undefined,
  });
}
