import { describe, expect, it } from "vitest";
import { commitConfirmedOperation, executeAction } from "../../src/harness/actions.js";
import {
  confirmPending,
  createPendingConfirmation,
  type PendingConfirmationRecord,
} from "../../src/harness/confirmations.js";
import { type AdminPolicy, defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import type { ActionContext } from "../../src/harness/action.js";

const SECRET = "session-secret";
const NOW = new Date("2026-06-05T00:00:00.000Z");

function makeContext(fake: FakeWorkspace, policy: AdminPolicy = defaultAdminPolicy()): ActionContext {
  return {
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    policy,
    clockify: fake.client,
    now: () => NOW,
  };
}

async function previewDelete(fake: FakeWorkspace, policy?: AdminPolicy) {
  const result = await executeAction({
    actionName: "clockify_delete_entity",
    args: { entityType: "project", id: "p1", name: "Acme" },
    context: makeContext(fake, policy),
  });
  if (result.kind !== "preview") throw new Error("expected a preview");
  return result;
}

describe("risky preview + confirmation", () => {
  it("delete returns a preview and does not mutate", async () => {
    const fake = createFakeWorkspace();
    const result = await previewDelete(fake);
    expect(result.preview.riskLabels).toContain("destructive");
    expect(fake.counts.deleteEntity ?? 0).toBe(0);
  });

  it("confirm executes the delete exactly once and cannot be replayed", async () => {
    const fake = createFakeWorkspace();
    const preview = await previewDelete(fake);
    const created = createPendingConfirmation({
      sessionId: "sess-1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      risk: preview.operation.risks,
      preview: preview.preview,
      operation: preview.operation,
      sessionSecret: SECRET,
      now: NOW,
    });

    const confirm = confirmPending({
      record: created.record,
      sessionId: "sess-1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      nonce: created.nonce,
      sessionSecret: SECRET,
      now: NOW,
    });
    expect(confirm.ok).toBe(true);

    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.deleteEntity).toBe(1);
    expect(fake.state.deleted).toEqual([{ entityType: "project", id: "p1" }]);

    // Replaying against the now-used record is rejected.
    const usedRecord: PendingConfirmationRecord = confirm.ok ? confirm.record : created.record;
    const replay = confirmPending({
      record: usedRecord,
      sessionId: "sess-1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      nonce: created.nonce,
      sessionSecret: SECRET,
      now: NOW,
    });
    expect(replay.ok).toBe(false);
  });

  it("a typed 'yes' is not a valid confirmation and does not execute", async () => {
    const fake = createFakeWorkspace();
    const preview = await previewDelete(fake);
    const created = createPendingConfirmation({
      sessionId: "sess-1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      risk: preview.operation.risks,
      preview: preview.preview,
      operation: preview.operation,
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
    expect(fake.counts.deleteEntity ?? 0).toBe(0);
  });

  it("an expired preview cannot be confirmed", async () => {
    const fake = createFakeWorkspace();
    const preview = await previewDelete(fake);
    const created = createPendingConfirmation({
      sessionId: "sess-1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      risk: preview.operation.risks,
      preview: preview.preview,
      operation: preview.operation,
      sessionSecret: SECRET,
      now: NOW,
      ttlMs: 5 * 60 * 1000,
    });
    const later = new Date(NOW.getTime() + 6 * 60 * 1000);
    const confirm = confirmPending({
      record: created.record,
      sessionId: "sess-1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      nonce: created.nonce,
      sessionSecret: SECRET,
      now: later,
    });
    expect(confirm.ok).toBe(false);
    if (!confirm.ok) expect(confirm.code).toBe("expired");
    expect(fake.counts.deleteEntity ?? 0).toBe(0);
  });

  it("re-checks policy at confirm time: a write disabled after preview is denied", async () => {
    const fake = createFakeWorkspace();
    const preview = await previewDelete(fake); // built under full policy
    const lowered = defaultAdminPolicy();
    lowered.groups.work_structure = "off";
    const receipt = await commitConfirmedOperation(makeContext(fake, lowered), preview.operation);
    expect(receipt.ok).toBe(false);
    if (!receipt.ok) expect(receipt.code).toBe("policy_denied");
    expect(fake.counts.deleteEntity ?? 0).toBe(0);
  });

  it("permission update requires a button save but performs no Clockify dry-run", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "assistant_update_permissions",
      args: { groups: { invoices: "off" } },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("preview");
    if (result.kind === "preview") {
      expect(result.operation.risks).toContain("permission_change");
    }
    // No Clockify calls at all — permission changes are not Clockify writes.
    expect(Object.keys(fake.counts)).toHaveLength(0);
  });
});

describe("expanded risky actions (Phase 3)", () => {
  it("update_entity previews without mutating and only mutates after confirmation", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Website" }] });
    const preview = await executeAction({
      actionName: "clockify_update_entity",
      args: { entityType: "project", id: "p1", fields: { name: "New Site" } },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.featureGroup).toBe("work_structure");
    expect(fake.counts.updateEntity ?? 0).toBe(0);

    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.updateEntity).toBe(1);
  });

  it("update_entity routes role/billing changes to high_risk and previews", async () => {
    const fake = createFakeWorkspace({ users: [{ id: "u1", name: "Ada" }] });
    const preview = await executeAction({
      actionName: "clockify_update_entity",
      args: { entityType: "user", id: "u1", fields: { role: "ADMIN" } },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.featureGroup).toBe("users_groups");
    expect(fake.counts.updateEntity ?? 0).toBe(0);
  });

  it("manage_expense (create) previews and only mutates after confirmation", async () => {
    const fake = createFakeWorkspace();
    const preview = await executeAction({
      actionName: "clockify_manage_expense",
      args: { operation: "create", name: "Taxi", amount: 20 },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(fake.counts.manageExpense ?? 0).toBe(0);

    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.manageExpense).toBe(1);
  });

  it("manage_expense (delete) previews as destructive", async () => {
    const fake = createFakeWorkspace();
    const preview = await executeAction({
      actionName: "clockify_manage_expense",
      args: { operation: "delete", id: "x1" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.preview.riskLabels).toContain("destructive");
    expect(fake.counts.manageExpense ?? 0).toBe(0);
  });

  it("manage_time_off (approve) is an external side effect requiring confirmation", async () => {
    const fake = createFakeWorkspace();
    const preview = await executeAction({
      actionName: "clockify_manage_time_off",
      args: { decision: "approve", requestId: "r1", policyId: "pol-1" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("external_side_effect");
    expect(preview.operation.featureGroup).toBe("time_off_approvals");
    expect(fake.counts.manageTimeOff ?? 0).toBe(0);

    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.manageTimeOff).toBe(1);
  });

  it("manage_schedule (publish) is an external side effect requiring confirmation", async () => {
    const fake = createFakeWorkspace();
    const preview = await executeAction({
      actionName: "clockify_manage_schedule",
      args: { operation: "publish", start: "2030-01-01T00:00:00Z", end: "2030-01-07T00:00:00Z" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("external_side_effect");
    expect(preview.operation.featureGroup).toBe("scheduling");
    expect(fake.counts.manageSchedule ?? 0).toBe(0);

    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.manageSchedule).toBe(1);
  });

  it("manage_webhook update/delete without an id is rejected as invalid_args (no preview)", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_manage_webhook",
      args: { operation: "delete" }, // missing id
      context: makeContext(fake),
    });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt") {
      expect(result.receipt.ok).toBe(false);
      if (!result.receipt.ok) expect(result.receipt.code).toBe("invalid_args");
    }
    expect(fake.counts.manageWebhook ?? 0).toBe(0);
  });

  it("manage_expense delete without an id is rejected as invalid_args (no preview)", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_manage_expense",
      args: { operation: "delete" }, // missing id
      context: makeContext(fake),
    });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt" && !result.receipt.ok) {
      expect(result.receipt.code).toBe("invalid_args");
    }
    expect(fake.counts.manageExpense ?? 0).toBe(0);
  });

  it("a new risky action re-checks policy at confirm time (expenses disabled after preview)", async () => {
    const fake = createFakeWorkspace();
    const preview = await executeAction({
      actionName: "clockify_manage_expense",
      args: { operation: "create", name: "Taxi" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    const lowered = defaultAdminPolicy();
    lowered.groups.expenses = "off";
    const receipt = await commitConfirmedOperation(makeContext(fake, lowered), preview.operation);
    expect(receipt.ok).toBe(false);
    if (!receipt.ok) expect(receipt.code).toBe("policy_denied");
    expect(fake.counts.manageExpense ?? 0).toBe(0);
  });
});
