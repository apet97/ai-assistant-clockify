import { z } from "zod";
import { zNumberLike } from "../arg-shapes.js";
import { fromMinor } from "../money.js";
import type { EntityRef } from "../receipts.js";

/**
 * Shared rate-update plumbing for the THREE billing rate actions
 * (`clockify_projects_rate_update`, `clockify_tasks_rate_update`,
 * `clockify_users_rate_update`). Each of those is a per-MEMBER / per-TASK /
 * per-workspace-member billable hourly|cost rate; they share an identical arg
 * fragment and an identical preview shape that differs only in the entity noun
 * and the scope phrasing. Centralising both here keeps the major↔minor display
 * (always MAJOR units in the preview, never raw minor) and the risk copy from
 * drifting between the three callers — each one still resolves + verifies its OWN
 * entity (project membership / verifyTask / resolveUserRef) before building the
 * preview, so an identity mistake still clarifies, never confirmed-then-failed.
 */

/**
 * The Zod arg fragment every rate action shares — spread into each action's
 * schema AFTER its entity-ref fields so the catalog arg-summary order is stable.
 * `amount` accepts a numeric string; `amountUnit` defaults to MAJOR (converted
 * ×100 to the minor units Clockify wants); `since` is the optional effective date.
 */
export const RATE_FIELDS = {
  rateKind: z.enum(["HOURLY", "COST"]),
  amount: zNumberLike(z.number().nonnegative()),
  /** `major` (e.g. 75.00) is converted ×100 to the minor units Clockify wants. */
  amountUnit: z.enum(["major", "minor"]).default("major"),
  since: z.string().optional(),
} as const;

/** The preview block (everything but the operation payload) for a rate update. */
export interface RatePreviewBlock {
  actionLabel: string;
  targets: EntityRef[];
  expectedChanges: string[];
  reversibility: string;
  warnings: string[];
}

/**
 * Build the shared rate-update preview block. `scopeLabel` carries each action's
 * distinct phrasing ("for Bob on \"Website\"" / 'for "Design"' / "for Bob") so
 * the expectedChanges line reads naturally per entity; `kindNoun` names the
 * entity in the action label and the future-entries warning. The amount is always
 * rendered in MAJOR units via {@link fromMinor} (truthful preview: the admin never
 * sees raw minor units).
 */
export function buildRatePreview(opts: {
  targetType: string;
  targetId: string;
  targetName?: string;
  /** The distinct per-action scope phrasing, e.g. `for Bob on "Website"`. */
  scopeLabel: string;
  amountMinor: number;
  rateKind: "HOURLY" | "COST";
  /** The entity noun for the action label + warning, e.g. "project"/"task"/"member". */
  kindNoun: string;
}): RatePreviewBlock {
  return {
    actionLabel: `Set ${opts.kindNoun} ${opts.rateKind === "COST" ? "cost" : "hourly"} rate`,
    targets: [
      {
        type: opts.targetType,
        id: opts.targetId,
        ...(opts.targetName !== undefined ? { name: opts.targetName } : {}),
      },
    ],
    expectedChanges: [`Set ${opts.rateKind} rate ${opts.scopeLabel} to ${fromMinor(opts.amountMinor)}`],
    reversibility: "You can set a new rate at any time; past entries keep their recorded rate.",
    warnings: [
      opts.kindNoun === "member"
        ? "This changes the member's default billable rate for future entries."
        : opts.kindNoun === "task"
          ? "This changes the billable amount of future entries on the task."
          : "This changes the billable amount of future entries.",
    ],
  };
}
