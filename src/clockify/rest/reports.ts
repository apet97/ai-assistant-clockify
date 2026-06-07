import type { RestCore } from "./core.js";
import type { ReportPort, ReportRange } from "../ports/reports.js";

function reportBody(range: ReportRange, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    dateRangeStart: range.dateRangeStart,
    dateRangeEnd: range.dateRangeEnd,
    dateRangeType: "ABSOLUTE",
    exportType: "JSON",
    ...extra,
  };
}

/**
 * Typed report REST module (goclmcp §2.14). I/O only. Reports run on the REPORTS
 * host (`core.call("reports", …)` routes there); all are `POST` searches with a
 * JSON export body. The add-on-token clearance for the reports host is unverified
 * (no LIVE_ADDON_TOKEN) — the API-key dev path is spike-confirmed.
 */
export function makeReportRest(core: RestCore, workspaceId: string): ReportPort {
  const ws = `/workspaces/${workspaceId}`;

  return {
    async summaryReport(range, groups) {
      return core.call("reports", "POST", `${ws}/reports/summary`, reportBody(range, { summaryFilter: { groups: groups ?? ["PROJECT"] } }));
    },
    async detailedReport(range) {
      return core.call("reports", "POST", `${ws}/reports/detailed`, reportBody(range, { detailedFilter: { page: 1, pageSize: 50 } }));
    },
    async weeklyReport(range) {
      return core.call("reports", "POST", `${ws}/reports/weekly`, reportBody(range, { weeklyFilter: { group: "PROJECT", subgroup: "TIME" } }));
    },
  };
}
