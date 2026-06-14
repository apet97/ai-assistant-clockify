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
    const fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Acme" }] });
    const result = await previewDelete(fake);
    expect(result.preview.riskLabels).toContain("destructive");
    expect(fake.counts.deleteEntity ?? 0).toBe(0);
  });

  it("confirm executes the delete exactly once and cannot be replayed", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Acme" }] });
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
    const fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Acme" }] });
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
    const fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Acme" }] });
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
    const fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Acme" }] });
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

  it("permission update accepts the flat {group: level} shape the planner emits", async () => {
    const fake = createFakeWorkspace();
    const flat = await executeAction({
      actionName: "assistant_update_permissions",
      args: { invoices: "read" },
      context: makeContext(fake),
    });
    expect(flat.kind).toBe("preview");
    if (flat.kind === "preview") {
      expect((flat.operation.payload as { groups: Record<string, string> }).groups.invoices).toBe("read");
    }

    const groupLevel = await executeAction({
      actionName: "assistant_update_permissions",
      args: { group: "reports", level: "read" },
      context: makeContext(fake),
    });
    expect(groupLevel.kind).toBe("preview");
    if (groupLevel.kind === "preview") {
      expect((groupLevel.operation.payload as { groups: Record<string, string> }).groups.reports).toBe("read");
    }
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

  it("update_entity resolves a NAME in the id slot for its generic types (live item 091: a client rename via the GENERIC action failed at commit)", async () => {
    const fake = createFakeWorkspace({ clients: [{ id: "c1", name: "Acme" }] });
    const preview = await executeAction({
      actionName: "clockify_update_entity",
      args: { entityType: "client", id: "Acme", name: "Acme Corp" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error(`expected a preview, got ${preview.kind}`);
    expect((preview.operation.payload as { id: string }).id).toBe("c1");
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.updateEntity).toBe(1);
  });

  it("update_entity clarifies on an unknown name instead of previewing a doomed commit", async () => {
    const fake = createFakeWorkspace({ clients: [{ id: "c1", name: "Acme" }] });
    const result = await executeAction({
      actionName: "clockify_update_entity",
      args: { entityType: "client", id: "Acmee", name: "Acme Corp" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    expect(fake.counts.updateEntity ?? 0).toBe(0);
  });

  it("delete_entity resolves a NAME in the id slot — including an ARCHIVED entity (items 091/305 class)", async () => {
    const fake = createFakeWorkspace({ tags: [{ id: "t9", name: "Old Tag", archived: true }] });
    const preview = await executeAction({
      actionName: "clockify_delete_entity",
      args: { entityType: "tag", id: "Old Tag" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error(`expected a preview, got ${preview.kind}`);
    expect((preview.operation.payload as { id: string }).id).toBe("t9");
  });

  it("delete_entity clarifies on an unknown project name instead of sending it to the wire", async () => {
    const fake = createFakeWorkspace({ projects: [{ id: "p1", name: "Website" }] });
    const result = await executeAction({
      actionName: "clockify_delete_entity",
      args: { entityType: "project", id: "AIASSIST_LOOP_NOPE" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    expect(fake.counts.deleteEntity ?? 0).toBe(0);
  });

  it("update_entity CLARIFIES at preview for entity types its adapter can't update — never preview-then-fail-at-commit (live: a confirmed time_entry update died with 'update not supported')", async () => {
    const fake = createFakeWorkspace({ entries: [{ id: "e1", start: "2026-06-01T09:00:00Z" }] });
    const result = await executeAction({
      actionName: "clockify_update_entity",
      args: { entityType: "time_entry", id: "e1", fields: { billable: true } },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    if (result.kind === "clarify") expect(result.message).toContain("clockify_fix_entry");
    expect(fake.counts.updateEntity ?? 0).toBe(0);
  });

  it("update_entity redirects a user-role change to the typed role action at preview (the generic commit never supported users)", async () => {
    const fake = createFakeWorkspace({ users: [{ id: "u1", name: "Ada" }] });
    const result = await executeAction({
      actionName: "clockify_update_entity",
      args: { entityType: "user", id: "u1", fields: { role: "ADMIN" } },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    if (result.kind === "clarify") expect(result.message).toContain("clockify_users_role_update");
    expect(fake.counts.updateEntity ?? 0).toBe(0);
  });

  it("expenses_create previews and only mutates after confirmation", async () => {
    // The category must exist — an unknown category now clarifies at preview (FIX 1).
    const fake = createFakeWorkspace({ expenseCategories: [{ id: "c1", name: "Travel" }] });
    const preview = await executeAction({
      actionName: "clockify_expenses_create",
      args: { amount: 20, date: "2026-06-06", categoryId: "c1", notes: "Taxi" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(fake.counts.createExpense ?? 0).toBe(0);

    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.createExpense).toBe(1);
  });

  // clockify_fix_entry EDITS an existing time entry (description/project/task/tags/
  // billable). Editing existing data — including the billing-relevant `billable`
  // flag — is high_risk_write: it previews + requires confirmation like every other
  // *_update action (it had been the lone safe_write outlier, and an update has no
  // undo). [product decision: editing an existing entry must be confirmed]
  it("fix_entry previews an edit and only mutates after confirmation", async () => {
    const fake = createFakeWorkspace({
      entries: [{ id: "e1", start: "2026-06-05T09:00:00.000Z", description: "old" }],
    });
    const preview = await executeAction({
      actionName: "clockify_fix_entry",
      args: { id: "e1", description: "new" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("high_risk_write");
    expect(preview.operation.featureGroup).toBe("time_tracking");
    expect(fake.counts.updateTimeEntry ?? 0).toBe(0); // nothing mutated on preview

    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.updateTimeEntry).toBe(1);
    expect(fake.state.timeEntries.find((e) => e.id === "e1")?.description).toBe("new");
  });

  it("fix_entry flipping billable previews first, then flips only on confirmation", async () => {
    const fake = createFakeWorkspace({
      entries: [{ id: "e1", start: "2026-06-05T09:00:00.000Z", description: "work", billable: false }],
    });
    const preview = await executeAction({
      actionName: "clockify_fix_entry",
      args: { id: "e1", billable: true },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(fake.state.timeEntries.find((e) => e.id === "e1")?.billable).toBe(false); // not flipped yet

    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.state.timeEntries.find((e) => e.id === "e1")?.billable).toBe(true);
  });

  it("fix_entry resolves projectName/taskName at PREVIEW time and commits the resolved ids", async () => {
    const fake = createFakeWorkspace({
      projects: [{ id: "p-acme", name: "Acme Corp" }],
      tasks: [{ id: "t-design", name: "Design", projectId: "p-acme" }],
      entries: [{ id: "e1", start: "2026-06-05T09:00:00.000Z", description: "work" }],
    });
    const preview = await executeAction({
      actionName: "clockify_fix_entry",
      args: { id: "e1", projectName: "Acme Corp", taskName: "Design" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(fake.counts.updateTimeEntry ?? 0).toBe(0);

    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    const entry = fake.state.timeEntries.find((e) => e.id === "e1");
    expect(entry?.projectId).toBe("p-acme");
    expect(entry?.taskId).toBe("t-design");
  });

  it("fix_entry resolves a project NAME placed in the projectId SLOT (preview → commit)", async () => {
    const fake = createFakeWorkspace({
      projects: [{ id: "p-acme", name: "Acme Corp" }],
      entries: [{ id: "e1", start: "2026-06-05T09:00:00.000Z", description: "work" }],
    });
    const preview = await executeAction({
      actionName: "clockify_fix_entry",
      args: { id: "e1", projectId: "Acme Corp" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.state.timeEntries.find((e) => e.id === "e1")?.projectId).toBe("p-acme");
  });

  it("fix_entry clarifies on an unknown project name and writes NOTHING (resolution at preview)", async () => {
    const fake = createFakeWorkspace({
      projects: [{ id: "p-acme", name: "Acme Corp" }],
      entries: [{ id: "e1", start: "2026-06-05T09:00:00.000Z", description: "work" }],
    });
    const result = await executeAction({
      actionName: "clockify_fix_entry",
      args: { id: "e1", projectName: "Acme Crp" },
      context: makeContext(fake),
    });
    expect(result.kind).toBe("clarify");
    expect(fake.counts.updateTimeEntry ?? 0).toBe(0);
  });

  it("fix_entry is blocked when time_tracking is read-only (no preview, no mutation)", async () => {
    const fake = createFakeWorkspace({ entries: [{ id: "e1", start: "x", description: "old" }] });
    const policy = defaultAdminPolicy();
    policy.groups.time_tracking = "read";
    const result = await executeAction({
      actionName: "clockify_fix_entry",
      args: { id: "e1", description: "new" },
      context: makeContext(fake, policy),
    });
    if (result.kind !== "receipt") throw new Error("expected a policy_denied receipt");
    expect(result.receipt.ok).toBe(false);
    expect(fake.counts.updateTimeEntry ?? 0).toBe(0);
  });

  it("expenses_delete previews as destructive", async () => {
    const fake = createFakeWorkspace();
    const preview = await executeAction({
      actionName: "clockify_expenses_delete",
      args: { id: "x1" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.preview.riskLabels).toContain("destructive");
    expect(fake.counts.deleteExpense ?? 0).toBe(0);
  });

  it("time_off_approve is an external side effect requiring confirmation", async () => {
    const fake = createFakeWorkspace();
    const preview = await executeAction({
      actionName: "clockify_time_off_approve",
      args: { requestId: "r1", policyId: "pol-1" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("external_side_effect");
    expect(preview.operation.featureGroup).toBe("time_off_approvals");
    expect(fake.counts.setTimeOffRequestStatus ?? 0).toBe(0);

    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.setTimeOffRequestStatus).toBe(1);
  });

  it("scheduling_publish is an external side effect requiring confirmation", async () => {
    const fake = createFakeWorkspace();
    const preview = await executeAction({
      actionName: "clockify_scheduling_publish",
      args: { start: "2030-01-01T00:00:00Z", end: "2030-01-07T00:00:00Z" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    expect(preview.operation.risks).toContain("external_side_effect");
    expect(preview.operation.featureGroup).toBe("scheduling");
    expect(fake.counts.publishSchedule ?? 0).toBe(0);

    const receipt = await commitConfirmedOperation(makeContext(fake), preview.operation);
    expect(receipt.ok).toBe(true);
    expect(fake.counts.publishSchedule).toBe(1);
  });

  it("webhooks_create without a url is rejected as invalid_args (no preview)", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_webhooks_create",
      args: { name: "Hook", webhookEvent: "NEW_TIME_ENTRY" }, // missing url
      context: makeContext(fake),
    });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt") {
      expect(result.receipt.ok).toBe(false);
      if (!result.receipt.ok) expect(result.receipt.code).toBe("invalid_args");
    }
    expect(fake.counts.createWebhook ?? 0).toBe(0);
  });

  it("expenses_delete without an id is rejected as invalid_args (no preview)", async () => {
    const fake = createFakeWorkspace();
    const result = await executeAction({
      actionName: "clockify_expenses_delete",
      args: {}, // missing id
      context: makeContext(fake),
    });
    expect(result.kind).toBe("receipt");
    if (result.kind === "receipt" && !result.receipt.ok) {
      expect(result.receipt.code).toBe("invalid_args");
    }
    expect(fake.counts.deleteExpense ?? 0).toBe(0);
  });

  it("a new risky action re-checks policy at confirm time (expenses disabled after preview)", async () => {
    const fake = createFakeWorkspace({ expenseCategories: [{ id: "c1", name: "Travel" }] });
    const preview = await executeAction({
      actionName: "clockify_expenses_create",
      args: { amount: 20, date: "2026-06-06", categoryId: "c1", notes: "Taxi" },
      context: makeContext(fake),
    });
    if (preview.kind !== "preview") throw new Error("expected a preview");
    const lowered = defaultAdminPolicy();
    lowered.groups.expenses = "off";
    const receipt = await commitConfirmedOperation(makeContext(fake, lowered), preview.operation);
    expect(receipt.ok).toBe(false);
    if (!receipt.ok) expect(receipt.code).toBe("policy_denied");
    expect(fake.counts.createExpense ?? 0).toBe(0);
  });
});
