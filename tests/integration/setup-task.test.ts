import { describe, expect, it } from "vitest";
import { executeAction, commitConfirmedOperation } from "../../src/harness/actions.js";
import { reverseCreation, reversibleCreations } from "../../src/harness/undo.js";
import { type AdminPolicy, defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import type { ActionContext, ConfirmableOperation, IdempotencyLedger } from "../../src/harness/catalog.js";
import type { UpdateTaskRateInput } from "../../src/clockify/ports/tasks.js";
import type { SuccessReceipt } from "../../src/harness/receipts.js";
import type { WorkspaceClient } from "../../src/clockify/client.js";

/**
 * clockify_setup_task — the task analog of setup_project: create a task in an
 * existing project + assign members + set the task's billable rate, as ONE preview
 * → ONE Confirm → atomic composition (rollback via deleteTask on a step failure).
 */

function ctxWith(fake: FakeWorkspace, client: WorkspaceClient = fake.client, policy = defaultAdminPolicy(), idempotency?: IdempotencyLedger): ActionContext {
  return { workspaceId: "ws-1", adminUserId: "admin-1", policy, clockify: client, now: () => new Date("2026-06-05T00:00:00.000Z"), ...(idempotency ? { idempotency } : {}) };
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

function rateSpy(fake: FakeWorkspace): { client: WorkspaceClient; rate: UpdateTaskRateInput[] } {
  const rate: UpdateTaskRateInput[] = [];
  const client: WorkspaceClient = {
    ...fake.client,
    updateTaskRate: async (input) => {
      rate.push(input);
      await fake.client.updateTaskRate(input);
    },
  };
  return { client, rate };
}

const SEED = { projects: [{ id: "p1", name: "Apollo" }], users: [{ id: "admin-1", name: "Ada" }, { id: "u2", name: "Bob" }] };
const ARGS = { projectName: "Apollo", name: "Login", assignees: ["me", "Bob"], rate: 60 };

async function previewSetup(ctx: ActionContext, args: Record<string, unknown> = ARGS): Promise<ConfirmableOperation> {
  const result = await executeAction({ actionName: "clockify_setup_task", args, context: ctx });
  if (result.kind !== "preview") throw new Error(`expected a preview, got ${result.kind}`);
  return result.operation;
}

describe("clockify_setup_task — single-approval task composite", () => {
  it("previews every change (resolved) and writes NOTHING until confirmed", async () => {
    const fake = createFakeWorkspace(SEED);
    const result = await executeAction({ actionName: "clockify_setup_task", args: ARGS, context: ctxWith(fake) });
    expect(result.kind).toBe("preview");
    if (result.kind !== "preview") return;
    const changes = result.preview.expectedChanges.join(" | ");
    expect(changes).toContain('Create task "Login" in project "Apollo"');
    expect(changes).toContain("Assign you");
    expect(changes).toContain('Assign "Bob"');
    expect(changes).toContain("Set the task hourly rate to $60.00");
    expect(result.preview.riskLabels).toEqual(expect.arrayContaining(["high_risk_write", "billing"]));
    expect(fake.counts.createTask ?? 0).toBe(0);
  });

  it("on confirm: creates the task in the project with assignees, then sets the task rate", async () => {
    const fake = createFakeWorkspace(SEED);
    const s = rateSpy(fake);
    const op = await previewSetup(ctxWith(fake, s.client));
    const receipt = await commitConfirmedOperation(ctxWith(fake, s.client), op);
    expect(receipt.ok).toBe(true);
    const task = fake.state.tasks.find((t) => t.name === "Login" && t.projectId === "p1");
    expect(task).toBeDefined();
    expect(task?.assigneeIds).toEqual(expect.arrayContaining(["admin-1", "u2"]));
    expect(s.rate).toHaveLength(1);
    expect(s.rate[0]).toMatchObject({ projectId: "p1", taskId: task?.id, rateKind: "HOURLY", amountMinor: 6000 });
  });

  it("reports the created task in changed.created (with projectId) so it can be one-click undone", async () => {
    const fake = createFakeWorkspace(SEED);
    const ctx = ctxWith(fake);
    const op = await previewSetup(ctx);
    const receipt = await commitConfirmedOperation(ctx, op);
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    expect(receipt.changed?.created).toEqual([
      expect.objectContaining({ type: "task", projectId: "p1" }),
    ]);

    // The created task is genuinely reversible — reverseCreation deletes it
    // (project-scoped deleteTask), removing the task and its rate.
    const undo = await reverseCreation(ctx, reversibleCreations(receipt));
    expect(undo.ok).toBe(true);
    expect(fake.state.tasks.some((t) => t.name === "Login")).toBe(false);
  });

  it("rolls back the created task when the rate step fails — nothing left behind", async () => {
    const fake = createFakeWorkspace(SEED);
    const client: WorkspaceClient = { ...fake.client, updateTaskRate: async () => { throw new Error("Clockify rejected the rate"); } };
    const op = await previewSetup(ctxWith(fake, client));
    const receipt = await commitConfirmedOperation(ctxWith(fake, client), op);
    expect(receipt.ok).toBe(false);
    if (!receipt.ok) expect(receipt.code).toBe("setup_failed");
    expect(fake.counts.createTask).toBe(1);
    expect(fake.state.deleted.some((d) => d.entityType === "task")).toBe(true); // rolled back via deleteTask
    expect(fake.state.tasks.some((t) => t.name === "Login")).toBe(false);
  });

  it("resolves the project by name; an unknown project clarifies and writes nothing", async () => {
    const fake = createFakeWorkspace(SEED);
    const ok = await executeAction({ actionName: "clockify_setup_task", args: { projectName: "Apollo", name: "X" }, context: ctxWith(fake) });
    expect(ok.kind).toBe("preview");
    const bad = await executeAction({ actionName: "clockify_setup_task", args: { projectName: "Ghost", name: "X" }, context: ctxWith(fake) });
    expect(bad.kind).toBe("clarify");
    expect(fake.counts.createTask ?? 0).toBe(0);
  });

  it("resolves assignees ('me' + names); an unknown assignee clarifies", async () => {
    const fake = createFakeWorkspace(SEED);
    const bad = await executeAction({ actionName: "clockify_setup_task", args: { projectName: "Apollo", name: "X", assignees: ["Nobody"] }, context: ctxWith(fake) });
    expect(bad.kind).toBe("clarify");
    expect(fake.counts.createTask ?? 0).toBe(0);
  });

  it("is gated: work_structure off → denied at preview; invoices off with a rate → clarifies", async () => {
    const fake = createFakeWorkspace(SEED);
    const denied = await executeAction({ actionName: "clockify_setup_task", args: ARGS, context: ctxWith(fake, fake.client, policyWith({ work_structure: "off" })) });
    if (denied.kind !== "receipt") throw new Error("expected a policy_denied receipt");
    expect(denied.receipt.ok).toBe(false);
    if (!denied.receipt.ok) expect(denied.receipt.code).toBe("policy_denied");

    const clarify = await executeAction({ actionName: "clockify_setup_task", args: ARGS, context: ctxWith(fake, fake.client, policyWith({ invoices: "off" })) });
    expect(clarify.kind).toBe("clarify");
    expect(fake.counts.createTask ?? 0).toBe(0);
  });

  it("idempotent re-confirm: confirming the same intent twice creates ONE task", async () => {
    const fake = createFakeWorkspace(SEED);
    const ctx = ctxWith(fake, fake.client, defaultAdminPolicy(), memoryLedger());
    const op = await previewSetup(ctx);
    const first = await commitConfirmedOperation(ctx, op);
    const second = await commitConfirmedOperation(ctx, op);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(fake.counts.createTask).toBe(1);
  });
});
