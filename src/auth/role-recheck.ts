import { isAdminRole } from "./roles.js";
import type { WorkspaceClient } from "../clockify/client.js";

/**
 * Opt-in per-request admin re-verification (authz-surface-01). Re-reads the
 * caller's CURRENT Clockify workspace role. Ordinary authenticated reads may
 * use the short pass cache; mutation checks force a fresh lookup and fail closed
 * on an unknown result.
 */
export type RoleVerdict = "admin" | "non_admin" | "unknown";

export interface RoleRechecker {
  check(
    workspaceId: string,
    adminUserId: string,
    client: WorkspaceClient,
    options?: { force?: boolean },
  ): Promise<RoleVerdict>;
}

export function createRoleRechecker(ttlMs: number, now: () => number = () => Date.now()): RoleRechecker {
  const cache = new Map<string, number>(); // key -> expiry ms (only PASS cached)
  return {
    async check(workspaceId, adminUserId, client, options) {
      const key = `${workspaceId}:${adminUserId}`;
      const cached = cache.get(key);
      if (!options?.force && cached !== undefined && cached > now()) return "admin";
      if (cached !== undefined) cache.delete(key);
      let role: unknown;
      try {
        role = await client.getWorkspaceMemberRole(adminUserId);
      } catch {
        return "unknown";
      }
      if (isAdminRole(role)) {
        cache.set(key, now() + ttlMs);
        return "admin";
      }
      return role === undefined ? "unknown" : "non_admin";
    },
  };
}
