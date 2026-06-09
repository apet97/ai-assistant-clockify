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
 * pinned by the unit tests: list status filter is one of PENDING / APPROVED /
 * WITHDRAWN_APPROVAL; the single GET is a list-scan; submit posts
 * `{period, periodStart}`; approve/reject/withdraw are `PATCH /approval-requests/
 * {id} {state, note?}`; resubmit posts to `…/resubmit-entries-for-approval`.
 */
export interface ApprovalPort {
  listApprovals(filter?: { status?: string }): Promise<ApprovalSummary[]>;
  getApproval(id: string): Promise<ApprovalSummary | null>;
  submitApproval(input: { period: string; periodStart: string }): Promise<EntitySummary>;
  setApprovalState(id: string, state: string, note?: string): Promise<EntitySummary>;
  resubmitApproval(id: string, entryIds: string[], note?: string): Promise<EntitySummary>;
}
