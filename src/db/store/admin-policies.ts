import { randomUUID } from "node:crypto";
import { adminPolicySchema, CURRENT_POLICY_VERSION, FEATURE_GROUPS, type AdminPolicy, type PermissionLevel } from "../../harness/permissions.js";
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
      // Versioned back-compat migration: a genuinely new admin gets the full
      // default in the route, but an EXISTING policy must opt into capabilities
      // added after it was saved. Missing groups therefore migrate to `off`.
      const stored = JSON.parse(row.policy_json) as {
        version?: number;
        groups?: Record<string, unknown>;
      };
      const disabled = Object.fromEntries(
        FEATURE_GROUPS.map((group) => [group, "off" as PermissionLevel]),
      );
      const merged = {
        version: CURRENT_POLICY_VERSION,
        groups: { ...disabled, ...(stored.groups ?? {}) },
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
