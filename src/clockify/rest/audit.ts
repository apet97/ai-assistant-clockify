import type { RestCore } from "./core.js";
import type { AuditPort } from "../ports/audit.js";
import { collectPages } from "./list-pages.js";

const AUDIT_PAGE_SIZE = 50;

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
      const load = async (page: number) => {
        const body: Record<string, unknown> = {
          actions: input.actions,
          start: input.start,
          end: input.end,
          page,
          "page-size": AUDIT_PAGE_SIZE,
        };
        const rows = (await core.call("audit", "POST", `${ws}/audit-log`, body)) as unknown[] | null;
        return Array.isArray(rows) ? rows : [];
      };
      if (input.page !== undefined) {
        const rows = await load(input.page);
        return { rows, truncated: input.page > 1 || rows.length === AUDIT_PAGE_SIZE };
      }
      return collectPages({
        label: `${ws}/audit-log`,
        pageSize: AUDIT_PAGE_SIZE,
        load: async (page) => ({ rows: await load(page) }),
      });
    },
    async listEntityChanges(changeType) {
      const rows = (await core.call("api", "GET", `${ws}/entities/${changeType}`)) as unknown[] | null;
      return { rows: Array.isArray(rows) ? rows : [], truncated: false };
    },
  };
}
