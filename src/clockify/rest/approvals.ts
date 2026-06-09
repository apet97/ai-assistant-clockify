import type { RestCore } from "./core.js";
import type { EntitySummary } from "../types.js";
import type { ApprovalPort, ApprovalSummary } from "../ports/approvals.js";

function mapApproval(raw: any): ApprovalSummary {
  // Live shape (probed 2026-06-10): each list item WRAPS the approval under
  // `approvalRequest` next to period totals; the state lives at `status.state`
  // and the period at `dateRange`. Flat fields are kept as a defensive fallback.
  const req = raw?.approvalRequest && typeof raw.approvalRequest === "object" ? raw.approvalRequest : raw;
  const out: ApprovalSummary = { id: req.id };
  const owner = req.owner ?? {};
  const userId = owner.userId ?? req.userId;
  if (userId !== undefined) out.userId = userId;
  const userName = owner.userName ?? req.userName;
  if (userName !== undefined) out.userName = userName;
  const state = typeof req.status === "object" && req.status !== null ? req.status.state : (req.state ?? req.status);
  if (state !== undefined) out.state = state;
  const period = req.dateRange ?? req.period ?? {};
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

  async function listRaw(status?: string): Promise<any[]> {
    const params: Record<string, string> = {};
    if (status) params.status = status;
    const rows = await core.paginate("api", `${ws}/approval-requests`, params);
    return rows as any[];
  }

  return {
    async listApprovals(filter) {
      return (await listRaw(filter?.status)).map(mapApproval);
    },
    async getApproval(id) {
      // Scan the MAPPED rows: the wire id is nested under approvalRequest.
      return (await listRaw()).map(mapApproval).find((a) => a.id === id) ?? null;
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
