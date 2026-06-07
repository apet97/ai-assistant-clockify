/**
 * Report slice of the {@link WorkspaceClient} port (goclmcp §2.14). Reports run
 * on the REPORTS host (`reports.api.clockify.me/v1`) via the multi-host core.
 * All reads. The reports host accepts the production X-Addon-Token (the core sends
 * it via the same host routing + auth-header path); the dev API key also works.
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
