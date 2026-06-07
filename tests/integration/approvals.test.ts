import { describe, expect, it } from "vitest";
import { commitConfirmedOperation, executeAction } from "../../src/harness/actions.js";
import { type AdminPolicy, defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import type { ActionContext } from "../../src/harness/action.js";

const NOW = new Date("2026-06-06T00:00:00.000Z");
function makeContext(fake: FakeWorkspace, policy: AdminPolicy = defaultAdminPolicy()): ActionContext {
  return { workspaceId: "ws-1", adminUserId: "admin-1", policy, clockify: fake.client, now: () => NOW };
}
const seed = () => ({ approvals: [{ id: "ap1", userId: "u1", state: "PENDING", periodStart: "2026-06-01" }] });

describe("approval actions", () => {
  it("approvals_list is read-gated", async () => {
    const fake = createFakeWorkspace(seed());
    const ok = await executeAction({ actionName: "clockify_approvals_list", args: {}, context: makeContext(fake) });
    if (ok.kind === "receipt" && ok.receipt.ok) expect((ok.receipt.data as any).count).toBe(1);
    else throw new Error("expected receipt");
    const off = defaultAdminPolicy();
    off.groups.approvals = "off";
    const denied = await executeAction({ actionName: "clockify_approvals_list", args: {}, context: makeContext(fake, off) });
    if (denied.kind === "receipt" && !denied.receipt.ok) expect(denied.receipt.code).toBe("policy_denied");
    else throw new Error("expected policy_denied");
  });

  it("approvals_get reads one", async () => {
    const fake = createFakeWorkspace(seed());
    const get = await executeAction({ actionName: "clockify_approvals_get", args: { id: "ap1" }, context: makeContext(fake) });
    if (get.kind === "receipt" && get.receipt.ok) expect((get.receipt.data as any).entity).toMatchObject({ id: "ap1" });
    else throw new Error("expected receipt");
  });

  it("submit previews high_risk_write then submits", async () => {
    const fake = createFakeWorkspace();
    const preview = await executeAction({ actionName: "clockify_approvals_submit", args: { periodStart: "2026-06-01" }, context: makeContext(fake) });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("high_risk_write");
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.submitApproval).toBe(1);
  });

  it("approve / reject preview external_side_effect then set state", async () => {
    const fake = createFakeWorkspace(seed());
    const approve = await executeAction({ actionName: "clockify_approvals_approve", args: { id: "ap1" }, context: makeContext(fake) });
    if (approve.kind !== "preview") throw new Error("expected a preview");
    expect(approve.operation.risks).toContain("external_side_effect");
    expect(approve.operation.payload).toMatchObject({ state: "APPROVED" });
    await commitConfirmedOperation(makeContext(fake), approve.operation);
    expect(fake.state.approvals[0].state).toBe("APPROVED");

    const reject = await executeAction({ actionName: "clockify_approvals_reject", args: { id: "ap1", note: "no" }, context: makeContext(fake) });
    if (reject.kind !== "preview") throw new Error("expected a preview");
    expect(reject.operation.payload).toMatchObject({ state: "REJECTED" });
    await commitConfirmedOperation(makeContext(fake), reject.operation);
    expect(fake.state.approvals[0].state).toBe("REJECTED");
  });

  it("withdraw + resubmit preview correctly (external_side_effect / bulk)", async () => {
    const fake = createFakeWorkspace(seed());
    const withdraw = await executeAction({ actionName: "clockify_approvals_withdraw", args: { id: "ap1" }, context: makeContext(fake) });
    if (withdraw.kind !== "preview") throw new Error("expected a preview");
    expect(withdraw.operation.risks).toContain("external_side_effect");
    expect(withdraw.operation.payload).toMatchObject({ state: "WITHDRAWN_SUBMISSION" });
    await commitConfirmedOperation(makeContext(fake), withdraw.operation);
    expect(fake.counts.setApprovalState).toBe(1);

    const resubmit = await executeAction({ actionName: "clockify_approvals_resubmit", args: { id: "ap1", entryIds: ["e1"] }, context: makeContext(fake) });
    if (resubmit.kind !== "preview") throw new Error("expected a preview");
    expect(resubmit.operation.risks).toEqual(expect.arrayContaining(["bulk", "external_side_effect"]));
    const receipt = await commitConfirmedOperation(makeContext(fake), resubmit.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.resubmitApproval).toBe(1);
  });
});
