/**
 * Audit slice of the {@link WorkspaceClient} port (goclmcp §2.15). The audit-log
 * search runs on the AUDIT host (`auditlog-api.api.clockify.me/v1`); the
 * experimental entity-changes feed runs on the primary API host. Both reads. The
 * add-on-token clearance for the audit host is unverified (no LIVE_ADDON_TOKEN);
 * the API-key dev path is spike-confirmed.
 */
export interface AuditSearchInput {
  /** At least one audit-log action type (e.g. CREATE_PROJECT, UPDATE_TASK). */
  actions: string[];
  /** ≤31-day window (full ISO); Clockify rejects wider ranges. */
  start: string;
  end: string;
  page?: number;
}

export interface AuditPort {
  searchAuditLog(input: AuditSearchInput): Promise<unknown[]>;
  listEntityChanges(changeType: "created" | "updated" | "deleted"): Promise<unknown[]>;
}
