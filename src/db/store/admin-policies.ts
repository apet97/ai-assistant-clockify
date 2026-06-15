import { randomUUID } from "node:crypto";
import { adminPolicySchema, defaultAdminPolicy, type AdminPolicy } from "../../harness/permissions.js";
import type { StoreContext } from "./context.js";

/** Admin-policy concern: per-admin, per-workspace assistant permissions. */
export function buildAdminPolicyStore(ctx: StoreContext): {
  getAdminPolicy(workspaceId: string, adminUserId: string): AdminPolicy | undefined;
  upsertAdminPolicy(workspaceId: string, adminUserId: string, policy: AdminPolicy): void;
} {
  const { db, nowIso } = ctx;
  return {
    getAdminPolicy(workspaceId, adminUserId) {
      const row = db
        .prepare(
          "SELECT policy_json FROM admin_policies WHERE workspace_id = ? AND admin_user_id = ?",
        )
        .get(workspaceId, adminUserId) as { policy_json: string } | undefined;
      if (!row) return undefined;
      // Back-compat migration: feature groups added after this policy was written
      // are absent from the stored JSON, but `adminPolicySchema` is `.strict()`
      // and requires every current group. Fill any missing key with the locked
      // full-access default (`read_write`) before validating, preserving any
      // non-default values the admin set on the groups that were stored.
      const stored = JSON.parse(row.policy_json) as {
        version?: number;
        groups?: Record<string, unknown>;
      };
      const merged = {
        version: stored.version ?? 1,
        groups: { ...defaultAdminPolicy().groups, ...(stored.groups ?? {}) },
      };
      return adminPolicySchema.parse(merged);
    },

    upsertAdminPolicy(workspaceId, adminUserId, policy) {
      const validated = adminPolicySchema.parse(policy);
      const timestamp = nowIso();
      db.prepare(
        `INSERT INTO admin_policies (id, workspace_id, admin_user_id, policy_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id, admin_user_id)
         DO UPDATE SET policy_json = excluded.policy_json, updated_at = excluded.updated_at`,
      ).run(randomUUID(), workspaceId, adminUserId, JSON.stringify(validated), timestamp, timestamp);
    },
  };
}
