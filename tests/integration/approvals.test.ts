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

  it("normalizes a bare date periodStart to a full ISO UTC instant (the Clockify 400-format bug)", async () => {
    const fake = createFakeWorkspace();
    const preview = await executeAction({ actionName: "clockify_approvals_submit", args: { periodStart: "2026-06-01" }, context: makeContext(fake) });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    // Clockify rejects a bare date; the pinned payload must be a full ISO instant ending in Z.
    const pinned = (preview.operation.payload as { periodStart: string }).periodStart;
    expect(pinned).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(pinned).toBe("2026-06-01T00:00:00Z");
    await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(fake.state.approvals.at(-1)?.periodStart).toBe("2026-06-01T00:00:00Z");
  });

  it("rejects an OFFSET-NAIVE ISO periodStart instead of guessing a zone", async () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "America/New_York"; // UTC-4/-5 — a naive instant parsed locally would shift hours
    try {
      const fake = createFakeWorkspace();
      const preview = await executeAction({
        actionName: "clockify_approvals_submit",
        args: { periodStart: "2026-06-01T00:00:00" },
        context: makeContext(fake),
      });
      expect(preview.kind).toBe("clarify");
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  it("resolves a relative week server-side from ctx.now so the model never guesses a date", async () => {
    // NOW is Sat 2026-06-06; the Monday of this week is 2026-06-01.
    const fake = createFakeWorkspace();
    const thisWeek = await executeAction({ actionName: "clockify_approvals_submit", args: { week: "this_week" }, context: makeContext(fake) });
    if (thisWeek.kind !== "preview") throw new Error("expected a preview");
    expect((thisWeek.operation.payload as { periodStart: string }).periodStart).toBe("2026-06-01T00:00:00Z");

    const lastWeek = await executeAction({ actionName: "clockify_approvals_submit", args: { week: "last_week" }, context: makeContext(fake) });
    if (lastWeek.kind !== "preview") throw new Error("expected a preview");
    expect((lastWeek.operation.payload as { periodStart: string }).periodStart).toBe("2026-05-25T00:00:00Z");
  });

  it("uses the verified workspace zone and week start for approval period instants", async () => {
    const fake = createFakeWorkspace();
    const context = { ...makeContext(fake), timeZone: "Europe/Belgrade", weekStartsOn: 1 };
    const preview = await executeAction({
      actionName: "clockify_approvals_submit",
      args: { week: "this_week" },
      context,
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect((preview.operation.payload as { periodStart: string }).periodStart).toBe("2026-05-31T22:00:00Z");
  });

  it("clarifies (not invalid_args) when neither a week nor a periodStart is given", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({ actionName: "clockify_approvals_submit", args: {}, context: makeContext(fake) });
    expect(result.kind).toBe("clarify");
    expect(fake.counts.submitApproval ?? 0).toBe(0);
  });

  it("resolves a RELATIVE periodStart server-side (next monday, partial month-day — never a guessed year)", async () => {
    // NOW is Sat 2026-06-06 → next monday = 2026-06-08.
    const fake = createFakeWorkspace();
    const monday = await executeAction({
      actionName: "clockify_approvals_submit",
      args: { periodStart: "next monday" },
      context: makeContext(fake),
    });
    if (monday.kind !== "preview") throw new Error(`expected a preview, got ${monday.kind}`);
    expect((monday.operation.payload as { periodStart: string }).periodStart).toBe("2026-06-08T00:00:00Z");

    // "June 1" must resolve to the CURRENT year — new Date("June 1") fabricates 2001.
    const partial = await executeAction({
      actionName: "clockify_approvals_submit",
      args: { periodStart: "June 1" },
      context: makeContext(fake),
    });
    if (partial.kind !== "preview") throw new Error(`expected a preview, got ${partial.kind}`);
    expect((partial.operation.payload as { periodStart: string }).periodStart).toBe("2026-06-01T00:00:00Z");
  });

  it("clarifies on an unresolvable periodStart instead of wiring it (submit AND resubmit)", async () => {
    const fake = createFakeWorkspace();
    const submit = await executeAction({
      actionName: "clockify_approvals_submit",
      args: { periodStart: "whenever" },
      context: makeContext(fake),
    });
    expect(submit.kind).toBe("clarify");
    expect(fake.counts.submitApproval ?? 0).toBe(0);

    const resubmit = await executeAction({
      actionName: "clockify_approvals_resubmit",
      args: { periodStart: "whenever" },
      context: makeContext(fake),
    });
    expect(resubmit.kind).toBe("clarify");
    expect(fake.counts.resubmitApproval ?? 0).toBe(0);
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

    const resubmit = await executeAction({ actionName: "clockify_approvals_resubmit", args: { week: "this_week" }, context: makeContext(fake) });
    if (resubmit.kind !== "preview") throw new Error("expected a preview");
    expect(resubmit.operation.risks).toEqual(expect.arrayContaining(["bulk", "external_side_effect"]));
    // the wire payload is the same {period, periodStart} body as submit
    expect(resubmit.operation.payload).toMatchObject({ period: "WEEKLY" });
    expect((resubmit.operation.payload as { periodStart: string }).periodStart).toMatch(/T00:00:00Z$/);
    const receipt = await commitConfirmedOperation(makeContext(fake), resubmit.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.resubmitApproval).toBe(1);
  });
});
