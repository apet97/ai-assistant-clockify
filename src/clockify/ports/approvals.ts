import type { EntitySummary } from "../types.js";

export interface ApprovalSummary {
  id: string;
  userId?: string;
  userName?: string;
  state?: string;
  periodStart?: string;
  periodEnd?: string;
}

/**
 * Approval slice of the {@link WorkspaceClient} port (goclmcp §2.11). Reads are
 * immediate; submit / state-change / resubmit run from the handler. Gotchas
 * pinned by the unit tests + the 2026-06-10 live probe: the list returns
 * WRAPPERS (`{approvalRequest: {…}, …totals}`); the single GET is a list-scan;
 * submit AND resubmit post the same `{period, periodStart}` body (resubmit has
 * no approvalId/entryIds — that shape never existed upstream); approve/reject/
 * withdraw are `PATCH /approval-requests/{id} {state, note?}`.
 */
export interface ApprovalPort {
  listApprovals(filter?: { status?: string }): Promise<ApprovalSummary[]>;
  getApproval(id: string): Promise<ApprovalSummary | null>;
  submitApproval(input: { period: string; periodStart: string }): Promise<EntitySummary>;
  setApprovalState(id: string, state: string, note?: string): Promise<EntitySummary>;
  resubmitApproval(input: { period: string; periodStart: string }): Promise<EntitySummary>;
}
