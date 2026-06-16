import { isAdminRole } from "./roles.js";
import type { WorkspaceClient } from "../clockify/client.js";

/**
 * Opt-in per-request admin re-verification (authz-surface-01). Re-reads the
 * caller's CURRENT Clockify workspace role, cached per (workspace, admin) for
 * `ttlMs` (at most one Clockify call per admin per window). A negative result is
 * never cached. On a Clockify error we FAIL OPEN (return undefined = "no verdict")
 * so a Clockify blip can't lock out every admin — the session TTL still bounds
 * staleness.
 */
export interface RoleRechecker {
  stillAdmin(workspaceId: string, adminUserId: string, client: WorkspaceClient): Promise<boolean | undefined>;
}

export function createRoleRechecker(ttlMs: number, now: () => number = () => Date.now()): RoleRechecker {
  const cache = new Map<string, number>(); // key -> expiry ms (only PASS cached)
  return {
    async stillAdmin(workspaceId, adminUserId, client) {
      const key = `${workspaceId}:${adminUserId}`;
      const cached = cache.get(key);
      if (cached !== undefined && cached > now()) return true;
      if (cached !== undefined) cache.delete(key);
      let role: unknown;
      try {
        role = await client.getWorkspaceMemberRole(adminUserId);
      } catch {
        return undefined; // fail open; session TTL still bounds staleness
      }
      if (isAdminRole(role)) {
        cache.set(key, now() + ttlMs);
        return true;
      }
      return false;
    },
  };
}
