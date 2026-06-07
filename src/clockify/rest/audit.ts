import type { RestCore } from "./core.js";
import type { AuditPort } from "../ports/audit.js";

/**
 * Typed audit REST module (goclmcp §2.15). I/O only. The audit-log search runs on
 * the AUDIT host (`core.call("audit", …)` → auditlog-api.api.clockify.me/v1); the
 * experimental entity-changes feed runs on the primary API host. Both return bare
 * arrays (tolerated defensively). The add-on-token clearance for the audit host is
 * unverified (no LIVE_ADDON_TOKEN); the API-key dev path is spike-confirmed.
 */
export function makeAuditRest(core: RestCore, workspaceId: string): AuditPort {
  const ws = `/workspaces/${workspaceId}`;

  return {
    async searchAuditLog(input) {
      const body: Record<string, unknown> = {
        actions: input.actions,
        start: input.start,
        end: input.end,
        ...(input.page !== undefined ? { page: input.page } : {}),
      };
      const rows = (await core.call("audit", "POST", `${ws}/audit-log`, body)) as unknown[] | null;
      return Array.isArray(rows) ? rows : [];
    },
    async listEntityChanges(changeType) {
      const rows = (await core.call("api", "GET", `${ws}/entities/${changeType}`)) as unknown[] | null;
      return Array.isArray(rows) ? rows : [];
    },
  };
}
