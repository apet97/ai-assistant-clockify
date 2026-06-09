import type { RestCore } from "./core.js";
import type { EntitySummary } from "../types.js";
import type { ApprovalPort, ApprovalSummary } from "../ports/approvals.js";

function mapApproval(raw: any): ApprovalSummary {
  const out: ApprovalSummary = { id: raw.id };
  if (raw.userId !== undefined) out.userId = raw.userId;
  if (raw.userName !== undefined) out.userName = raw.userName;
  const state = raw.state ?? raw.status;
  if (state !== undefined) out.state = state;
  const period = raw.period ?? {};
  if (period.start !== undefined) out.periodStart = period.start;
  if (period.end !== undefined) out.periodEnd = period.end;
  return out;
}

/**
 * Typed approval REST module (goclmcp §2.11). I/O only. Shapes pinned by the unit
 * tests: list is `GET /approval-requests` (status filter PENDING/APPROVED/
 * WITHDRAWN_APPROVAL); the single GET is a list-scan; submit posts
 * `{period, periodStart}`; approve/reject/withdraw are `PATCH …/{id} {state,note?}`;
 * resubmit posts `{approvalId, entryIds, note?}` to `…/resubmit-entries-for-approval`.
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
      const raw = (await listRaw()).find((a) => a.id === id);
      return raw ? mapApproval(raw) : null;
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
    async resubmitApproval(id, entryIds, note): Promise<EntitySummary> {
      const r = (await core.call("api", "POST", `${ws}/approval-requests/resubmit-entries-for-approval`, {
        approvalId: id,
        entryIds,
        ...(note !== undefined ? { note } : {}),
      })) as { id?: string } | null;
      return { id: r?.id ?? id, name: "resubmitted" };
    },
  };
}
