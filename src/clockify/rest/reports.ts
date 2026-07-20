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
 * host (`core.postQuery("reports", …)` routes there); all are `POST` searches with a
 * JSON export body. The reports host accepts the production X-Addon-Token (same
 * host routing + auth header as the api host); the dev API key also works.
 */
export function makeReportRest(core: RestCore, workspaceId: string): ReportPort {
  const ws = `/workspaces/${workspaceId}`;

  return {
    async summaryReport(range, groups) {
      return core.postQuery("reports", `${ws}/reports/summary`, reportBody(range, { summaryFilter: { groups: groups ?? ["PROJECT"] } }));
    },
    async detailedReport(range) {
      return core.postQuery("reports", `${ws}/reports/detailed`, reportBody(range, { detailedFilter: { page: 1, pageSize: 50 } }));
    },
    async weeklyReport(range) {
      return core.postQuery("reports", `${ws}/reports/weekly`, reportBody(range, { weeklyFilter: { group: "PROJECT", subgroup: "TIME" } }));
    },
  };
}
