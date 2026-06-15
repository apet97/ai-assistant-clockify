import { describe, expect, it } from "vitest";
import { executeAction, commitConfirmedOperation } from "../../src/harness/actions.js";
import { confirmPending, createPendingConfirmation } from "../../src/harness/confirmations.js";
import { type AdminPolicy, defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import type { ActionContext, ConfirmableOperation, IdempotencyLedger } from "../../src/harness/catalog.js";
import type { SuccessReceipt } from "../../src/harness/receipts.js";

/**
 * clockify_setup_project — risk classification, policy gating (at preview AND at
 * confirm, across all three sub-groups), confirmation safety, and idempotency.
 * Mirrors risky-preview.test.ts.
 */

const SECRET = "session-secret";
const NOW = new Date("2026-06-05T00:00:00.000Z");

function makeContext(fake: FakeWorkspace, policy: AdminPolicy = defaultAdminPolicy(), idempotency?: IdempotencyLedger): ActionContext {
  return { workspaceId: "ws-1", adminUserId: "admin-1", policy, clockify: fake.client, now: () => NOW, ...(idempotency ? { idempotency } : {}) };
}

function policyWith(overrides: Partial<AdminPolicy["groups"]>): AdminPolicy {
  const p = defaultAdminPolicy();
  p.groups = { ...p.groups, ...overrides };
  return p;
}

function memoryLedger(): IdempotencyLedger {
  const map = new Map<string, SuccessReceipt>();
  return { lookup: (k) => map.get(k), record: (k, r) => void map.set(k, r) };
}

const ARGS = { name: "test1122", private: true, members: ["me"], projectRate: 50, memberRates: [{ member: "me", amount: 25 }] };

async function preview(ctx: ActionContext, args: Record<string, unknown> = ARGS) {
  const result = await executeAction({ actionName: "clockify_setup_project", args, context: ctx });
  if (result.kind !== "preview") throw new Error(`expected a preview, got ${result.kind}`);
  return result;
}

describe("clockify_setup_project — risk, policy, confirmation, idempotency", () => {
  it("is high_risk_write + billing, so it always previews + requires confirmation", async () => {
    const fake = createFakeWorkspace({ users: [{ id: "admin-1", name: "Ada" }] });
    const p = await preview(makeContext(fake));
    expect(p.operation.risks).toEqual(expect.arrayContaining(["high_risk_write", "billing"]));
  });

  it("a typed 'yes' is not a valid confirmation and executes nothing", async () => {
    const fake = createFakeWorkspace({ users: [{ id: "admin-1", name: "Ada" }] });
    const p = await preview(makeContext(fake));
    const created = createPendingConfirmation({
      sessionId: "sess-1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      risk: p.operation.risks,
      preview: p.preview,
      operation: p.operation,
      sessionSecret: SECRET,
      now: NOW,
    });
    const confirm = confirmPending({
      record: created.record,
      sessionId: "sess-1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      nonce: "yes",
      sessionSecret: SECRET,
      now: NOW,
    });
    expect(confirm.ok).toBe(false);
    expect(fake.counts.createProject ?? 0).toBe(0);
  });

  it("policy gate at PREVIEW: work_structure write off → denied by the executor (no preview)", async () => {
    const fake = createFakeWorkspace({ users: [{ id: "admin-1", name: "Ada" }] });
    const result = await executeAction({
      actionName: "clockify_setup_project",
      args: ARGS,
      context: makeContext(fake, policyWith({ work_structure: "off" })),
    });
    if (result.kind !== "receipt") throw new Error("expected a policy_denied receipt");
    expect(result.receipt.ok).toBe(false);
    if (!result.receipt.ok) expect(result.receipt.code).toBe("policy_denied");
    expect(fake.counts.createProject ?? 0).toBe(0);
  });

  it("policy pre-check at PREVIEW: members requested but users_groups write off → clarifies, no half-build", async () => {
    const fake = createFakeWorkspace({ users: [{ id: "admin-1", name: "Ada" }] });
    const result = await executeAction({
      actionName: "clockify_setup_project",
      args: { name: "test1122", members: ["me"] },
      context: makeContext(fake, policyWith({ users_groups: "off" })),
    });
    expect(result.kind).toBe("clarify");
    expect(fake.counts.createProject ?? 0).toBe(0);
  });

  it("policy pre-check at PREVIEW: rates requested but invoices write off → clarifies", async () => {
    const fake = createFakeWorkspace({ users: [{ id: "admin-1", name: "Ada" }] });
    const result = await executeAction({
      actionName: "clockify_setup_project",
      args: { name: "test1122", memberRates: [{ member: "me", amount: 25 }] },
      context: makeContext(fake, policyWith({ invoices: "off" })),
    });
    expect(result.kind).toBe("clarify");
    expect(fake.counts.createProject ?? 0).toBe(0);
  });

  it("policy is re-checked at CONFIRM: a preview under full policy is denied if work_structure is later disabled", async () => {
    const fake = createFakeWorkspace({ users: [{ id: "admin-1", name: "Ada" }] });
    const p = await preview(makeContext(fake));
    const receipt = await commitConfirmedOperation(makeContext(fake, policyWith({ work_structure: "off" })), p.operation);
    expect(receipt.ok).toBe(false);
    if (!receipt.ok) expect(receipt.code).toBe("policy_denied");
    expect(fake.counts.createProject ?? 0).toBe(0);
  });

  it("idempotent re-confirm: confirming the same intent twice creates ONE project", async () => {
    const fake = createFakeWorkspace({ users: [{ id: "admin-1", name: "Ada" }] });
    const ledger = memoryLedger();
    const ctx = makeContext(fake, defaultAdminPolicy(), ledger);
    const op: ConfirmableOperation = (await preview(ctx)).operation;
    const first = await commitConfirmedOperation(ctx, op);
    const second = await commitConfirmedOperation(ctx, op);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(fake.counts.createProject).toBe(1); // the replay did not create a second project
  });

  it("resolves members + every per-member rate from ONE listUsers fetch (no N+1)", async () => {
    // Members block resolves once; without the single-flight each memberRate would
    // re-fetch, so 3 rates here would be 1 + 3 = 4 fetches. The lazy thunk pins it to 1.
    const fake = createFakeWorkspace({
      users: [
        { id: "admin-1", name: "Ada" },
        { id: "u-2", name: "Bo" },
        { id: "u-3", name: "Cy" },
      ],
    });
    await preview(makeContext(fake), {
      name: "test-n-plus-1",
      members: ["me"],
      memberRates: [
        { member: "Ada", amount: 25 },
        { member: "Bo", amount: 30 },
        { member: "Cy", amount: 35 },
      ],
    });
    expect(fake.counts.listUsers).toBe(1);
  });

  it("invalid args (no name) are rejected before any preview", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({ actionName: "clockify_setup_project", args: {}, context: makeContext(fake) });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt" && !result.receipt.ok) expect(result.receipt.code).toBe("invalid_args");
    expect(fake.counts.createProject ?? 0).toBe(0);
  });
});
