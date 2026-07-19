import { describe, expect, it } from "vitest";
import { commitConfirmedOperation, executeAction } from "../../src/harness/actions.js";
import { type AdminPolicy, defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import { isPartialCommitResult, type ActionContext } from "../../src/harness/action.js";
import { createStore } from "../../src/db/store.js";
import { actionFingerprint, catalogHash } from "../../src/harness/catalog.js";
import { hashOperation } from "../../src/harness/confirmations.js";
import { errorReceipt } from "../../src/harness/receipts.js";
import { APPROVAL_PENDING_BATCH_MAX, TURN_HOST_CALL_LIMIT } from "../../src/harness/safety-limits.js";

const NOW = new Date("2026-06-06T00:00:00.000Z");
function makeContext(fake: FakeWorkspace, policy: AdminPolicy = defaultAdminPolicy()): ActionContext {
  return { workspaceId: "ws-1", adminUserId: "admin-1", policy, clockify: fake.client, now: () => NOW };
}
const seed = () => ({ approvals: [{ id: "ap1", userId: "u1", state: "PENDING", periodStart: "2026-06-01" }] });

describe("approval actions", () => {
  it("previews every pending timesheet as one button-bound batch and applies exactly that batch", async () => {
    const fake = createFakeWorkspace({ approvals: [
      { id: "ap1", userId: "u1", userName: "Ada", state: "PENDING", periodStart: "2026-06-01" },
      { id: "ap2", userId: "u2", userName: "Grace", state: "APPROVED", periodStart: "2026-06-01" },
      { id: "ap3", userId: "u3", userName: "Linus", state: "PENDING", periodStart: "2026-06-08" },
    ] });

    const result = await executeAction({
      actionName: "clockify_approvals_approve_pending",
      args: {},
      context: makeContext(fake),
    });
    if (result.kind !== "preview") throw new Error(`expected a preview, got ${result.kind}`);

    expect(fake.counts.setApprovalState ?? 0).toBe(0);
    expect(result.operation.risks).toEqual(expect.arrayContaining(["bulk", "external_side_effect"]));
    expect(result.operation.payload).toMatchObject({
      approvals: [
        { id: "ap1", previousState: "PENDING" },
        { id: "ap3", previousState: "PENDING" },
      ],
    });
    expect(result.operation.mutationPlan?.mode).toBe("batch");
    expect(result.operation.mutationPlan?.steps.map((step) => step.id)).toEqual([
      "approve-pending-0",
      "approve-pending-1",
    ]);

    const committed = await commitConfirmedOperation(makeContext(fake), result.operation);
    expect(committed.ok).toBe(true);
    expect(fake.counts.setApprovalState).toBe(2);
    expect(fake.state.approvals.map((approval) => [approval.id, approval.state])).toEqual([
      ["ap1", "APPROVED"],
      ["ap2", "APPROVED"],
      ["ap3", "APPROVED"],
    ]);
  });

  it("does not offer an empty or incomplete approve-all preview", async () => {
    const empty = createFakeWorkspace({ approvals: [{ id: "ap1", state: "APPROVED" }] });
    const none = await executeAction({
      actionName: "clockify_approvals_approve_pending",
      args: {},
      context: makeContext(empty),
    });
    expect(none.kind).toBe("clarify");

    const truncated = createFakeWorkspace({
      approvals: [{ id: "ap1", state: "PENDING" }],
      listTruncated: { listApprovals: true },
    });
    const incomplete = await executeAction({
      actionName: "clockify_approvals_approve_pending",
      args: {},
      context: makeContext(truncated),
    });
    expect(incomplete.kind).toBe("clarify");
    expect(truncated.counts.setApprovalState ?? 0).toBe(0);
  });

  it("stops an approve-all batch truthfully when fresh authorization is lost before the second dispatch", async () => {
    const fake = createFakeWorkspace({ approvals: [
      { id: "ap1", userId: "u1", state: "PENDING", periodStart: "2026-06-01" },
      { id: "ap2", userId: "u2", state: "PENDING", periodStart: "2026-06-08" },
      { id: "ap3", userId: "u3", state: "PENDING", periodStart: "2026-06-15" },
    ] });
    const preview = await executeAction({
      actionName: "clockify_approvals_approve_pending",
      args: {},
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected preview");

    const store = createStore(":memory:");
    store.prepareOperationRun({
      id: preview.operation.operationId,
      confirmationId: `confirmation-${preview.operation.operationId}`,
      sessionId: "session-1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      actionName: preview.operation.actionName,
      actionFingerprint: actionFingerprint(preview.operation.actionName)!,
      catalogHash: catalogHash(),
      operationHash: hashOperation(preview.operation),
      operation: preview.operation,
      mutationPlan: preview.operation.mutationPlan,
    });
    store.markOperationExecuting(preview.operation.operationId);
    let authorizationChecks = 0;
    const result = await commitConfirmedOperation({
      ...makeContext(fake),
      mutationJournal: store.mutationStepJournal(preview.operation.operationId),
      authorizeWrite: async () => {
        authorizationChecks += 1;
        return authorizationChecks >= 3
          ? errorReceipt({
              action: preview.operation.actionName,
              code: "role_denied",
              message: "Admin authorization was lost.",
              recovery: { hint: "Restore admin access.", retryable: true },
            })
          : undefined;
      },
    }, preview.operation);

    expect(result).toMatchObject({ kind: "partial" });
    if (!isPartialCommitResult(result)) throw new Error("expected partial result");
    const partialResult = result;
    expect(partialResult.message).toMatch(/authorization.*before dispatch/i);
    expect(partialResult.message).not.toMatch(/Clockify definitively rejected/i);
    expect(fake.counts.setApprovalStateAtomic).toBe(1);
    expect(fake.state.approvals.map((approval) => approval.state)).toEqual([
      "APPROVED",
      "PENDING",
      "PENDING",
    ]);
    expect(store.listOperationSteps(preview.operation.operationId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ planStepId: "approve-pending-0", status: "succeeded" }),
      expect.objectContaining({ planStepId: "approve-pending-1", status: "definitive_failed" }),
    ]));
    store.close();
  });

  it("accepts the exact approve-all boundary and rejects boundary plus one before preview", async () => {
    const pending = (count: number) => Array.from({ length: count }, (_, index) => ({
      id: `ap-${String(index).padStart(2, "0")}`,
      userId: `u-${index}`,
      state: "PENDING",
      periodStart: "2026-06-01",
    }));
    const maximum = createFakeWorkspace({ approvals: pending(APPROVAL_PENDING_BATCH_MAX) });
    const preview = await executeAction({
      actionName: "clockify_approvals_approve_pending",
      args: {},
      context: makeContext(maximum),
    });
    if (preview.kind !== "preview") throw new Error("expected maximum-boundary preview");
    expect(preview.operation.mutationPlan?.steps).toHaveLength(APPROVAL_PENDING_BATCH_MAX);
    expect(preview.operation.mutationPlan?.maxHostCalls).toBeLessThanOrEqual(TURN_HOST_CALL_LIMIT);
    const committed = await commitConfirmedOperation(makeContext(maximum), preview.operation);
    expect(committed.ok).toBe(true);
    expect(maximum.counts.setApprovalStateAtomic).toBe(APPROVAL_PENDING_BATCH_MAX);

    const over = createFakeWorkspace({ approvals: pending(APPROVAL_PENDING_BATCH_MAX + 1) });
    const refused = await executeAction({
      actionName: "clockify_approvals_approve_pending",
      args: {},
      context: makeContext(over),
    });
    expect(refused.kind).toBe("clarify");
    expect(over.counts.setApprovalStateAtomic ?? 0).toBe(0);
  });

  it("records only the first approval when the second target drifts and never dispatches later items", async () => {
    const fake = createFakeWorkspace({ approvals: [
      { id: "ap1", userId: "u1", state: "PENDING", periodStart: "2026-06-01" },
      { id: "ap2", userId: "u2", state: "PENDING", periodStart: "2026-06-08" },
      { id: "ap3", userId: "u3", state: "PENDING", periodStart: "2026-06-15" },
    ] });
    const preview = await executeAction({
      actionName: "clockify_approvals_approve_pending",
      args: {},
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected preview");
    fake.state.approvals[1]!.state = "APPROVED";

    const result = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(result).toMatchObject({ kind: "partial" });
    if (!isPartialCommitResult(result)) throw new Error("expected partial");
    const partialResult = result;
    expect(partialResult.message).toMatch(/1 of 3/);
    expect(partialResult.message).toMatch(/changed after preview/i);
    expect(fake.counts.setApprovalStateAtomic).toBe(1);
    expect(fake.state.approvals.map((approval) => approval.state)).toEqual([
      "APPROVED",
      "APPROVED",
      "PENDING",
    ]);
  });

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
