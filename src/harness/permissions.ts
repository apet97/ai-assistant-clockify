import { z } from "zod";

/**
 * Feature groups are the admin-facing permission units (SPEC "Feature Groups").
 * Each group is independently set to off / read / read_write.
 *
 * NOTE: This module is created in Task 2 because the store needs the policy
 * types and `defaultAdminPolicy()`. Task 4 extends it with the policy predicate
 * helpers (`canRead`, `canWrite`, `applyPolicyPatch`).
 */
export type FeatureGroup =
  | "time_tracking"
  | "work_structure"
  | "reports"
  | "invoices"
  | "expenses"
  | "users_groups"
  | "time_off_approvals"
  | "scheduling"
  | "webhooks"
  | "workspace_settings";

export type PermissionLevel = "off" | "read" | "read_write";

export const FEATURE_GROUPS: FeatureGroup[] = [
  "time_tracking",
  "work_structure",
  "reports",
  "invoices",
  "expenses",
  "users_groups",
  "time_off_approvals",
  "scheduling",
  "webhooks",
  "workspace_settings",
];

export interface AdminPolicy {
  version: number;
  groups: Record<FeatureGroup, PermissionLevel>;
}

export const permissionLevelSchema = z.enum(["off", "read", "read_write"]);

export const adminPolicySchema = z.object({
  version: z.number().int().positive(),
  groups: z
    .object(
      Object.fromEntries(
        FEATURE_GROUPS.map((g) => [g, permissionLevelSchema]),
      ) as Record<FeatureGroup, typeof permissionLevelSchema>,
    )
    .strict(),
});

/** Default posture: full read_write for every feature group (locked V1 decision). */
export function defaultAdminPolicy(): AdminPolicy {
  const groups = Object.fromEntries(
    FEATURE_GROUPS.map((g) => [g, "read_write" as PermissionLevel]),
  ) as Record<FeatureGroup, PermissionLevel>;
  return { version: 1, groups };
}

/** A partial change to an admin's policy (used by in-chat permission updates). */
export interface PolicyPatch {
  groups: Partial<Record<FeatureGroup, PermissionLevel>>;
}

export function canRead(policy: AdminPolicy, group: FeatureGroup): boolean {
  const level = policy.groups[group];
  return level === "read" || level === "read_write";
}

export function canWrite(policy: AdminPolicy, group: FeatureGroup): boolean {
  return policy.groups[group] === "read_write";
}

/**
 * Return a new policy with the patched groups applied. The merged result is
 * Zod-validated (strict), so unknown groups or invalid levels throw rather than
 * silently corrupting the stored policy.
 */
export function applyPolicyPatch(policy: AdminPolicy, patch: PolicyPatch): AdminPolicy {
  const next: AdminPolicy = {
    version: policy.version,
    groups: { ...policy.groups, ...patch.groups },
  };
  return adminPolicySchema.parse(next);
}
