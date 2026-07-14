import type { RestCore } from "./core.js";
import type { EntitySummary, ListResult } from "../types.js";
import type { ApprovalPort, ApprovalSummary } from "../ports/approvals.js";
import { assertCompleteAbsence } from "./list-pages.js";

/**
 * Approval request as read from `GET /approval-requests`. Either flat or wrapped
 * under `approvalRequest`; the state lives at `status.state` and the period at
 * `dateRange` (flat `state`/`period` are defensive fallbacks).
 */
type ApprovalReq = {
  id?: string;
  owner?: { userId?: string; userName?: string };
  userId?: string;
  userName?: string;
  status?: { state?: string } | string;
  state?: string;
  dateRange?: { start?: string; end?: string };
  period?: { start?: string; end?: string };
};
type ApprovalRow = ApprovalReq & { approvalRequest?: ApprovalReq };

function mapApproval(raw: ApprovalRow): ApprovalSummary {
  // Live shape (probed 2026-06-10): each list item WRAPS the approval under
  // `approvalRequest` next to period totals; the state lives at `status.state`
  // and the period at `dateRange`. Flat fields are kept as a defensive fallback.
  const req: ApprovalReq = raw?.approvalRequest && typeof raw.approvalRequest === "object" ? raw.approvalRequest : raw;
  const out: ApprovalSummary = { id: req.id as string };
  const owner: { userId?: string; userName?: string } = req.owner ?? {};
  const userId = owner.userId ?? req.userId;
  if (userId !== undefined) out.userId = userId;
  const userName = owner.userName ?? req.userName;
  if (userName !== undefined) out.userName = userName;
  const state = typeof req.status === "object" && req.status !== null ? req.status.state : (req.state ?? req.status);
  if (state !== undefined) out.state = state;
  const period: { start?: string; end?: string } = req.dateRange ?? req.period ?? {};
  if (period.start !== undefined) out.periodStart = period.start;
  if (period.end !== undefined) out.periodEnd = period.end;
  return out;
}

/**
 * Typed approval REST module (goclmcp §2.11). I/O only. Shapes pinned by the unit
 * tests + the 2026-06-10 live probe: list is `GET /approval-requests` (status
 * filter PENDING/APPROVED/WITHDRAWN_APPROVAL) returning WRAPPER items (see
 * {@link mapApproval}); the single GET is a list-scan; submit AND resubmit post
 * the same `{period, periodStart}` body (the spec + goclmcp agree; the old
 * `{approvalId, entryIds}` resubmit shape never existed upstream); approve/
 * reject/withdraw are `PATCH …/{id} {state,note?}`.
 */
export function makeApprovalRest(core: RestCore, workspaceId: string): ApprovalPort {
  const ws = `/workspaces/${workspaceId}`;

  async function listRaw(status?: string): Promise<ListResult<ApprovalRow>> {
    const params: Record<string, string> = {};
    if (status) params.status = status;
    const result = await core.paginate("api", `${ws}/approval-requests`, params);
    return { ...result, rows: result.rows as ApprovalRow[] };
  }

  return {
    async listApprovals(filter) {
      const result = await listRaw(filter?.status);
      return { ...result, rows: result.rows.map(mapApproval) };
    },
    async getApproval(id) {
      // Scan the MAPPED rows: the wire id is nested under approvalRequest.
      const result = await listRaw();
      const approval = result.rows.map(mapApproval).find((a) => a.id === id);
      if (!approval) assertCompleteAbsence(result.truncated, "approval", id);
      return approval ?? null;
    },
    async submitApproval(input): Promise<EntitySummary> {
      const a = (await core.call("api", "POST", `${ws}/approval-requests`, {
        period: input.period,
        periodStart: input.periodStart,
      })) as { id?: string };
      return { id: a?.id ?? "approval", name: a?.id ?? "approval" };
    },
    async setApprovalState(id, state, note): Promise<EntitySummary> {
      const r = (await core.call("api", "PATCH", `${ws}/approval-requests/${id}`, {
        state,
        ...(note !== undefined ? { note } : {}),
      })) as { id?: string } | null;
      return { id: r?.id ?? id, name: state };
    },
    async resubmitApproval(input): Promise<EntitySummary> {
      const r = (await core.call("api", "POST", `${ws}/approval-requests/resubmit-entries-for-approval`, {
        period: input.period,
        periodStart: input.periodStart,
      })) as { id?: string } | null;
      return { id: r?.id ?? "approval", name: r?.id ?? "resubmitted" };
    },
  };
}
