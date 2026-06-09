import type { WorkspaceClient } from "../../../src/clockify/client.js";
import type { ApprovalSummary } from "../../../src/clockify/ports/approvals.js";
import type { FakeContext } from "./state.js";

export function makeFakeApprovals({ state, bump, nextId }: FakeContext): Pick<
  WorkspaceClient,
  | "listApprovals"
  | "getApproval"
  | "submitApproval"
  | "setApprovalState"
  | "resubmitApproval"
> {
  return {
    async listApprovals(filter) {
      bump("listApprovals");
      return filter?.status ? state.approvals.filter((a) => a.state === filter.status) : state.approvals;
    },
    async getApproval(id) {
      bump("getApproval");
      return state.approvals.find((a) => a.id === id) ?? null;
    },
    async submitApproval(input) {
      bump("submitApproval");
      const a: ApprovalSummary = { id: nextId("ap"), state: "PENDING", periodStart: input.periodStart };
      state.approvals.push(a);
      return { id: a.id, name: a.id };
    },
    async setApprovalState(id, st, note) {
      bump("setApprovalState");
      void note;
      const a = state.approvals.find((x) => x.id === id);
      if (a) a.state = st;
      return { id, name: st };
    },
    async resubmitApproval(id, entryIds, note) {
      bump("resubmitApproval");
      void entryIds;
      void note;
      return { id, name: "resubmitted" };
    },
  };
}
