/**
 * Report slice of the {@link WorkspaceClient} port (goclmcp §2.14). Reports run
 * on the REPORTS host (`reports.api.clockify.me/v1`) via the multi-host core.
 * All reads. The add-on-token clearance for this host is unverified (no
 * LIVE_ADDON_TOKEN); the API-key dev path is spike-confirmed.
 */
export interface ReportRange {
  dateRangeStart: string; // full ISO
  dateRangeEnd: string; // full ISO
}

export interface ReportPort {
  summaryReport(range: ReportRange, groups?: string[]): Promise<unknown>;
  detailedReport(range: ReportRange): Promise<unknown>;
  weeklyReport(range: ReportRange): Promise<unknown>;
}
