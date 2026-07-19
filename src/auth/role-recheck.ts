import { isAdminRole } from "./roles.js";
import type { WorkspaceClient } from "../clockify/client.js";

/**
 * Mandatory per-request admin re-verification (authz-surface-01). Re-reads the
 * caller's CURRENT Clockify workspace role. Authenticated reads may use the
 * short positive-only cache; mutation checks force a fresh lookup. Callers fail
 * closed for both non_admin and unknown verdicts.
 */
export type RoleVerdict = "admin" | "non_admin" | "unknown";

export interface RoleRechecker {
  check(
    workspaceId: string,
    adminUserId: string,
    client: WorkspaceClient,
    options?: { force?: boolean; generation?: number },
  ): Promise<RoleVerdict>;
}

export function createRoleRechecker(ttlMs: number, now: () => number = () => Date.now()): RoleRechecker {
  // Configuration may come from a legacy deployment or a direct test caller.
  // The authorization contract is fixed: a positive read verdict lives for at
  // most 60 seconds. Non-admin and unknown verdicts are never cached.
  const positiveTtlMs = Math.max(0, Math.min(ttlMs, 60_000));
  const cache = new Map<string, number>(); // key -> expiry ms (only PASS cached)
  const latestIssued = new Map<string, number>();
  const latestCompleted = new Map<string, number>();
  const nonForcedInFlight = new Map<string, Promise<RoleVerdict>>();
  return {
    async check(workspaceId, adminUserId, client, options) {
      // Token replacement creates a new authorization universe. Never reuse a
      // positive verdict (or an in-flight request) across installation
      // generations; legacy isolated callers share the explicit `legacy` key.
      const generation = Number.isSafeInteger(options?.generation)
        ? String(options!.generation)
        : "legacy";
      const key = `${workspaceId}:${adminUserId}:${generation}`;
      const cached = cache.get(key);
      if (!options?.force && cached !== undefined && cached > now()) return "admin";
      if (cached !== undefined) cache.delete(key);

      // The iframe shell deliberately initializes several independent admin
      // surfaces in parallel. They all need the same cold positive verdict, so
      // share one non-forced I/O instead of racing epochs and failing all but the
      // newest request closed. Forced mutation checks never share this promise.
      if (!options?.force) {
        const existing = nonForcedInFlight.get(key);
        if (existing) return existing;
      }
      const epoch = (latestIssued.get(key) ?? 0) + 1;
      latestIssued.set(key, epoch);
      const check = (async (): Promise<RoleVerdict> => {
        let role: unknown;
        try {
          role = await client.getWorkspaceMemberRole(adminUserId);
        } catch {
          if (epoch !== latestIssued.get(key) || epoch < (latestCompleted.get(key) ?? 0)) return "unknown";
          latestCompleted.set(key, epoch);
          return "unknown";
        }
        // Once a newer check has been issued, this completion can no longer
        // establish current authority—even if it happens to return ADMIN.
        if (epoch !== latestIssued.get(key) || epoch < (latestCompleted.get(key) ?? 0)) return "unknown";
        latestCompleted.set(key, epoch);
        if (isAdminRole(role)) {
          cache.set(key, now() + positiveTtlMs);
          return "admin";
        }
        cache.delete(key);
        return role === undefined ? "unknown" : "non_admin";
      })();
      if (!options?.force) {
        nonForcedInFlight.set(key, check);
        void check.finally(() => {
          if (nonForcedInFlight.get(key) === check) nonForcedInFlight.delete(key);
        });
      }
      return check;
    },
  };
}
