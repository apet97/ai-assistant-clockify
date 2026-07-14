import { describe, expect, it } from "vitest";
import { createStore } from "../../src/db/store.js";
import { actionFingerprint, catalogHash } from "../../src/harness/catalog.js";
import { commitConfirmedOperation, executeAction } from "../../src/harness/actions.js";
import { isPartialCommitResult, type ActionContext, type ConfirmableOperation } from "../../src/harness/action.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import { AmbiguousWriteOutcome, DefinitiveWriteFailure } from "../../src/clockify/write-outcome.js";
import { hashOperation } from "../../src/harness/confirmations.js";

const seed = () => ({
  users: [
    { id: "admin-1", name: "Me", email: "me@example.com", status: "ACTIVE" },
    { id: "u2", name: "Bob", email: "bob@example.com", status: "ACTIVE" },
    { id: "u3", name: "Ann", email: "ann@example.com", status: "ACTIVE" },
  ],
  groups: [{ id: "g1", name: "Devs", userIds: ["u3"] }],
  projects: [{ id: "p1", name: "Apollo" }],
  assignments: [{ id: "a1", userId: "u2", projectId: "p1", start: "2026-06-01", end: "2026-06-07", hoursPerDay: 8, published: false }],
  approvals: [{ id: "ap1", userId: "u2", state: "PENDING", periodStart: "2026-06-01T00:00:00Z" }],
  webhooks: [{ id: "w1", name: "Hook", url: "https://x.example/h", webhookEvent: "NEW_TIME_ENTRY", triggerSource: ["ws-1"], triggerSourceType: "WORKSPACE_ID" }],
});

function context(fake: FakeWorkspace): ActionContext {
  return {
    workspaceId: "ws-1", adminUserId: "admin-1", policy: defaultAdminPolicy(), clockify: fake.client,
    now: () => new Date("2026-06-06T00:00:00.000Z"), timeZone: "UTC", weekStartsOn: 1,
  };
}

async function prepare(fake: FakeWorkspace, actionName: string, args: unknown) {
  const preview = await executeAction({ actionName, args, context: context(fake) });
  if (preview.kind !== "preview") throw new Error(`expected preview for ${actionName}, got ${preview.kind}`);
  const operation = preview.operation;
  const store = createStore(":memory:");
  store.prepareOperationRun({
    id: operation.operationId, confirmationId: `confirmation-${operation.operationId}`, sessionId: "s", workspaceId: "ws-1", adminUserId: "admin-1",
    actionName, actionFingerprint: actionFingerprint(actionName)!, catalogHash: catalogHash(),
    operationHash: hashOperation(operation), operation, mutationPlan: operation.mutationPlan,
  });
  store.markOperationExecuting(operation.operationId);
  return { operation, store, commitContext: { ...context(fake), mutationJournal: store.mutationStepJournal(operation.operationId) } };
}

async function commit(fake: FakeWorkspace, actionName: string, args: unknown) {
  const prepared = await prepare(fake, actionName, args);
  const result = await commitConfirmedOperation(prepared.commitContext, prepared.operation);
  const steps = prepared.store.listOperationSteps(prepared.operation.operationId).map((step) => [step.planStepId, step.status]);
  prepared.store.close();
  return { result, operation: prepared.operation, steps };
}

describe("phase 5 control domains use durable host steps", () => {
  it("journals scheduling assignment create as one prepared atomic step", async () => {
    const fake = createFakeWorkspace(seed() as any);
    const store = createStore(":memory:");
    let operationId = "";
    const result = await executeAction({
      actionName: "clockify_scheduling_assignments_create",
      args: {
        userId: "u2",
        projectId: "p1",
        start: "2026-06-08",
        end: "2026-06-12",
        hoursPerDay: 6,
        note: "Focus",
      },
      context: {
        ...context(fake),
        operationJournal: {
          prepare(actionName, operation, mutationPlan) {
            operationId = store.prepareOperationRun({
              id: "safe-scheduling-create",
              sessionId: "s",
              workspaceId: "ws-1",
              adminUserId: "admin-1",
              actionName,
              actionFingerprint: actionFingerprint(actionName)!,
              catalogHash: catalogHash(),
              operationHash: "safe-scheduling-create",
              operation,
              mutationPlan,
            });
            return operationId;
          },
          markExecuting(id) {
            if (!store.markOperationExecuting(id)) throw new Error("operation_not_prepared");
          },
          scope: (id) => store.mutationStepJournal(id),
          settle: (id, status, settledResult) => store.settleOperationResult(id, status, settledResult),
        },
      },
    });

    expect(result).toMatchObject({ kind: "receipt", receipt: { ok: true } });
    expect(fake.counts.createAssignmentAtomic).toBe(1);
    expect(store.getOperationRun(operationId)).toMatchObject({
      status: "succeeded",
      operation: {
        input: {
          userId: "u2",
          projectId: "p1",
          hoursPerDay: 6,
          note: "Focus",
        },
        targetSnapshots: [
          { relation: "parent", ref: { type: "user", id: "u2" } },
          { relation: "parent", ref: { type: "project", id: "p1" } },
        ],
      },
      mutationPlan: {
        mode: "single",
        steps: [{ id: "create-assignment", kind: "primary", reconciliationStrategy: "create" }],
      },
    });
    expect(store.listOperationSteps(operationId)).toMatchObject([
      { planStepId: "create-assignment", status: "succeeded", externalId: expect.any(String) },
    ]);
    store.close();
  });

  it("rejects scheduling assignment parent drift immediately before dispatch", async () => {
    const fake = createFakeWorkspace(seed() as any);
    const result = await executeAction({
      actionName: "clockify_scheduling_assignments_create",
      args: { userId: "u2", projectId: "p1", start: "2026-06-08", end: "2026-06-12", hoursPerDay: 8 },
      context: {
        ...context(fake),
        authorizeWrite: async () => {
          fake.state.projects[0]!.name = "Drifted after preparation";
          return undefined;
        },
      },
    });

    expect(result).toMatchObject({ kind: "receipt", receipt: { ok: false } });
    expect(fake.counts.createAssignmentAtomic ?? 0).toBe(0);
  });

  it("reconciles one exact scheduling assignment after an ambiguous create without retry", async () => {
    const fake = createFakeWorkspace(seed() as any);
    let calls = 0;
    fake.client.createAssignmentAtomic = async (input) => {
      calls += 1;
      fake.state.assignments.push({ id: "a-created", ...input, published: false });
      throw new AmbiguousWriteOutcome("POST", "/scheduling/assignments/recurring", "socket closed");
    };

    const result = await executeAction({
      actionName: "clockify_scheduling_assignments_create",
      args: { userId: "u2", projectId: "p1", start: "2026-06-08", end: "2026-06-12", hoursPerDay: 8 },
      context: context(fake),
    });

    expect(result).toMatchObject({
      kind: "receipt",
      receipt: { ok: true, changed: { created: [{ type: "assignment", id: "a-created" }] } },
    });
    expect(calls).toBe(1);
  });

  it("keeps scheduling assignment create unknown when ambiguity has multiple exact matches", async () => {
    const fake = createFakeWorkspace(seed() as any);
    let calls = 0;
    fake.client.createAssignmentAtomic = async (input) => {
      calls += 1;
      fake.state.assignments.push(
        { id: "a-created-1", ...input, published: false },
        { id: "a-created-2", ...input, published: false },
      );
      throw new AmbiguousWriteOutcome("POST", "/scheduling/assignments/recurring", "socket closed");
    };

    const result = await executeAction({
      actionName: "clockify_scheduling_assignments_create",
      args: { userId: "u2", projectId: "p1", start: "2026-06-08", end: "2026-06-12", hoursPerDay: 8 },
      context: context(fake),
    });

    expect(result).toMatchObject({ kind: "receipt", receipt: { ok: false, code: "commit_outcome_unknown" } });
    expect(calls).toBe(1);
  });

  it.each([
    ["clockify_approvals_submit", { periodStart: "2026-06-08" }, "submitApprovalAtomic", (fake: FakeWorkspace) => fake.state.approvals.push({ id: "concurrent", state: "PENDING", periodStart: "2026-07-01T00:00:00Z" })],
    ["clockify_webhooks_create", { name: "New", url: "https://new.example/h", webhookEvent: "NEW_TASK" }, "createWebhookAtomic", (fake: FakeWorkspace) => fake.state.webhooks.push({ id: "concurrent", name: "Other", url: "https://other.example/h", webhookEvent: "TIMER_STOPPED" })],
    ["clockify_users_invite", { email: "new@example.com" }, "inviteUserAtomic", (fake: FakeWorkspace) => fake.state.users.push({ id: "concurrent", name: "Other", email: "other@example.com" })],
    ["clockify_groups_create", { name: "QA" }, "createGroupAtomic", (fake: FakeWorkspace) => fake.state.groups.push({ id: "concurrent", name: "Other", userIds: [] })],
  ] as const)("rejects concurrent create-baseline drift for %s before mutation", async (action, args, countKey, drift) => {
    const fake = createFakeWorkspace(seed() as any);
    const prepared = await prepare(fake, action, args);
    drift(fake);
    const result = await commitConfirmedOperation(prepared.commitContext, prepared.operation);
    expect(result).toMatchObject({ ok: false });
    expect(fake.counts[countKey] ?? 0).toBe(0);
    prepared.store.close();
  });

  it.each([
    ["clockify_approvals_submit", { periodStart: "2026-06-08" }, "submitApprovalAtomic"],
    ["clockify_webhooks_create", { name: "New", url: "https://new.example/h", webhookEvent: "NEW_TASK" }, "createWebhookAtomic"],
    ["clockify_users_invite", { email: "new@example.com" }, "inviteUserAtomic"],
    ["clockify_groups_create", { name: "QA" }, "createGroupAtomic"],
  ] as const)("reconciles exactly one applied ambiguous create for %s", async (action, args, method) => {
    const fake = createFakeWorkspace(seed() as any);
    const prepared = await prepare(fake, action, args);
    const original = (fake.client as any)[method].bind(fake.client);
    let calls = 0;
    (fake.client as any)[method] = async (...wireArgs: unknown[]) => {
      calls += 1;
      await original(...wireArgs);
      throw new AmbiguousWriteOutcome("POST", "/create", "socket closed");
    };
    const result = await commitConfirmedOperation(prepared.commitContext, prepared.operation);
    expect(result).toMatchObject({ ok: true });
    expect(calls).toBe(1);
    prepared.store.close();
  });

  it.each([
    ["clockify_scheduling_assignments_update", { id: "a1", hoursPerDay: 6 }, "updateAssignmentAtomic"],
    ["clockify_scheduling_assignments_delete", { id: "a1" }, "deleteAssignmentAtomic"],
    ["clockify_scheduling_publish", { start: "2026-06-01", end: "2026-06-07" }, "publishScheduleAtomic"],
    ["clockify_approvals_approve", { id: "ap1" }, "setApprovalStateAtomic"],
    ["clockify_approvals_reject", { id: "ap1" }, "setApprovalStateAtomic"],
    ["clockify_approvals_withdraw", { id: "ap1" }, "setApprovalStateAtomic"],
    ["clockify_approvals_resubmit", { week: "this_week" }, "resubmitApprovalAtomic"],
    ["clockify_webhooks_update", { id: "w1", name: "Renamed" }, "updateWebhookAtomic"],
    ["clockify_webhooks_delete", { id: "w1" }, "deleteWebhookAtomic"],
    ["clockify_users_role_update", { userId: "u2", role: "TEAM_MANAGER", groupId: "g1" }, "updateUserRoleAtomic"],
    ["clockify_users_rate_update", { userId: "u2", rateKind: "HOURLY", amount: 50 }, "updateWorkspaceMemberRateAtomic"],
    ["clockify_users_deactivate", { userId: "u2" }, "deactivateUserAtomic"],
    ["clockify_groups_update", { id: "g1", name: "Engineering" }, "updateGroupAtomic"],
    ["clockify_groups_delete", { id: "g1" }, "deleteGroupAtomic"],
    ["clockify_groups_add_user", { groupId: "g1", userId: "u2" }, "addUserToGroupAtomic"],
    ["clockify_groups_remove_user", { groupId: "g1", userId: "u3" }, "removeUserFromGroupAtomic"],
  ] as const)("authoritatively reconciles an applied ambiguous %s dispatch", async (action, args, method) => {
    const fake = createFakeWorkspace(seed() as any);
    const prepared = await prepare(fake, action, args);
    const original = (fake.client as any)[method].bind(fake.client);
    let calls = 0;
    (fake.client as any)[method] = async (...wireArgs: unknown[]) => {
      calls += 1;
      await original(...wireArgs);
      throw new AmbiguousWriteOutcome("POST", "/mutation", "socket closed");
    };
    const result = await commitConfirmedOperation(prepared.commitContext, prepared.operation);
    expect(result).toMatchObject({ ok: true });
    expect(calls).toBe(1);
    prepared.store.close();
  });

  it("preserves scheduling startTime in replacement intent and target evidence", async () => {
    const fake = createFakeWorkspace({
      ...seed(),
      assignments: [{ ...seed().assignments[0]!, startTime: "09:30" }],
    } as any);
    const prepared = await prepare(fake, "clockify_scheduling_assignments_update", { id: "a1", hoursPerDay: 6 });
    expect(prepared.operation.payload).toMatchObject({ body: { startTime: "09:30" } });
    expect(prepared.operation.targetSnapshots).toMatchObject([{ projection: { startTime: "09:30" } }]);
    prepared.store.close();
  });

  it("captures exact scoped role and rate state in snapshots and re-reads it", async () => {
    const fake = createFakeWorkspace({
      ...seed(),
      userRoleAssignments: { u2: [{ role: "MEMBER", entityId: "g1", sourceType: "USER_GROUP" }] },
      workspaceMemberRates: { u2: { HOURLY: { amountMinor: 2500, since: "2026-01-01" } } },
    } as any);
    const role = await prepare(fake, "clockify_users_role_update", { userId: "u2", role: "TEAM_MANAGER", groupId: "g1" });
    expect(role.operation.targetSnapshots?.[0]?.projection).toMatchObject({ scopedRole: { role: "MEMBER", entityId: "g1", sourceType: "USER_GROUP" } });
    role.store.close();
    const rate = await prepare(fake, "clockify_users_rate_update", { userId: "u2", rateKind: "HOURLY", amount: 50 });
    expect(rate.operation.targetSnapshots?.[0]?.projection).toMatchObject({ scopedRate: { amountMinor: 2500, since: "2026-01-01" } });
    rate.store.close();
    expect(fake.counts.listUserRoleAssignments).toBeGreaterThan(0);
    expect(fake.counts.getWorkspaceMemberRate).toBeGreaterThan(0);
  });

  it.each(["stale", "definitive", "ambiguous"] as const)("returns partial when a later group add is %s after an earlier success", async (fault) => {
    const fake = createFakeWorkspace(seed() as any);
    const prepared = await prepare(fake, "clockify_groups_add_user", { groupId: "g1", members: ["Bob", "me"] });
    const original = fake.client.addUserToGroupAtomic.bind(fake.client);
    let calls = 0;
    fake.client.addUserToGroupAtomic = async (groupId, userId) => {
      calls += 1;
      if (calls === 1) {
        await original(groupId, userId);
        if (fault === "stale") fake.state.groups[0]!.userIds = [...(fake.state.groups[0]!.userIds ?? []), "intruder"];
        return;
      }
      if (fault === "definitive") throw new DefinitiveWriteFailure("POST", "/membership", "rejected", 400);
      throw new AmbiguousWriteOutcome("POST", "/membership", "socket closed");
    };
    const result = await commitConfirmedOperation(prepared.commitContext, prepared.operation);
    expect(result).toMatchObject({
      kind: "partial",
      receipt: { ok: true },
      recovery: { retryable: false },
    });
    if (!isPartialCommitResult(result)) throw new Error("expected partial group-add result");
    expect(result.message).toMatch(/1 of 2/i);
    expect(calls).toBe(fault === "stale" ? 1 : 2);
    prepared.store.close();
  });

  it("keeps an ambiguous approval create unknown with zero matching candidates", async () => {
    const fake = createFakeWorkspace(seed() as any);
    const prepared = await prepare(fake, "clockify_approvals_submit", { periodStart: "2026-06-08" });
    fake.client.submitApprovalAtomic = async () => { throw new AmbiguousWriteOutcome("POST", "/approval", "socket closed"); };
    const result = await commitConfirmedOperation(prepared.commitContext, prepared.operation);
    expect(result).toMatchObject({ ok: false, code: "commit_outcome_unknown" });
    prepared.store.close();
  });

  it("keeps an ambiguous webhook create unknown with multiple exact candidates", async () => {
    const fake = createFakeWorkspace(seed() as any);
    const prepared = await prepare(fake, "clockify_webhooks_create", { name: "New", url: "https://new.example/h", webhookEvent: "NEW_TASK" });
    fake.client.createWebhookAtomic = async (input) => {
      fake.state.webhooks.push(
        { id: "new-1", ...input, triggerSource: ["ws-1"], triggerSourceType: "WORKSPACE_ID" },
        { id: "new-2", ...input, triggerSource: ["ws-1"], triggerSourceType: "WORKSPACE_ID" },
      );
      throw new AmbiguousWriteOutcome("POST", "/webhooks", "socket closed");
    };
    const result = await commitConfirmedOperation(prepared.commitContext, prepared.operation);
    expect(result).toMatchObject({ ok: false, code: "commit_outcome_unknown" });
    prepared.store.close();
  });

  it("keeps an ambiguous invite unknown when post-dispatch evidence is truncated", async () => {
    const fake = createFakeWorkspace(seed() as any);
    const prepared = await prepare(fake, "clockify_users_invite", { email: "new@example.com" });
    const originalAtomic = fake.client.inviteUserAtomic.bind(fake.client);
    const originalList = fake.client.listUsers.bind(fake.client);
    let listCalls = 0;
    fake.client.listUsers = async () => {
      listCalls += 1;
      const listed = await originalList();
      return { ...listed, truncated: listCalls >= 2 };
    };
    fake.client.inviteUserAtomic = async (...args) => {
      await originalAtomic(...args);
      throw new AmbiguousWriteOutcome("POST", "/users", "socket closed");
    };
    const result = await commitConfirmedOperation(prepared.commitContext, prepared.operation);
    expect(result).toMatchObject({ ok: false, code: "commit_outcome_unknown" });
    prepared.store.close();
  });

  it.each([
    ["update mismatch", "clockify_webhooks_update", { id: "w1", name: "Renamed" }, "updateWebhookAtomic", (fake: FakeWorkspace) => { fake.client.updateWebhookAtomic = async () => { throw new AmbiguousWriteOutcome("PUT", "/webhook", "socket closed"); }; }],
    ["delete truncated", "clockify_groups_delete", { id: "g1" }, "deleteGroupAtomic", (fake: FakeWorkspace) => {
      const original = fake.client.deleteGroupAtomic.bind(fake.client);
      const originalList = fake.client.listGroups.bind(fake.client);
      let reads = 0;
      fake.client.deleteGroupAtomic = async (id) => { await original(id); throw new AmbiguousWriteOutcome("DELETE", "/group", "socket closed"); };
      fake.client.listGroups = async () => { reads += 1; const listed = await originalList(); return { ...listed, truncated: reads >= 2 }; };
    }],
    ["state read failure", "clockify_approvals_approve", { id: "ap1" }, "setApprovalStateAtomic", (fake: FakeWorkspace) => {
      const original = fake.client.setApprovalStateAtomic.bind(fake.client);
      const originalGet = fake.client.getApproval.bind(fake.client);
      let reads = 0;
      fake.client.setApprovalStateAtomic = async (...args) => { await original(...args); throw new AmbiguousWriteOutcome("PATCH", "/approval", "socket closed"); };
      fake.client.getApproval = async (id) => { reads += 1; if (reads >= 2) throw new Error("read failed"); return originalGet(id); };
    }],
  ] as const)("leaves $0 authoritative reconciliation unknown", async (_label, action, args, _method, inject) => {
    const fake = createFakeWorkspace(seed() as any);
    const prepared = await prepare(fake, action, args);
    inject(fake);
    const result = await commitConfirmedOperation(prepared.commitContext, prepared.operation);
    expect(result).toMatchObject({ ok: false, code: "commit_outcome_unknown" });
    prepared.store.close();
  });

  it.each([
    ["clockify_scheduling_assignments_update", { id: "a1", hoursPerDay: 6 }, "update-assignment", "updateAssignmentAtomic"],
    ["clockify_scheduling_assignments_delete", { id: "a1" }, "delete-assignment", "deleteAssignmentAtomic"],
    ["clockify_scheduling_publish", { start: "2026-06-01", end: "2026-06-07" }, "publish-schedule", "publishScheduleAtomic"],
    ["clockify_approvals_submit", { periodStart: "2026-06-08" }, "submit-approval", "submitApprovalAtomic"],
    ["clockify_approvals_approve", { id: "ap1" }, "set-approval-state", "setApprovalStateAtomic"],
    ["clockify_approvals_reject", { id: "ap1" }, "set-approval-state", "setApprovalStateAtomic"],
    ["clockify_approvals_withdraw", { id: "ap1" }, "withdraw-approval", "setApprovalStateAtomic"],
    ["clockify_approvals_resubmit", { week: "this_week" }, "resubmit-approval", "resubmitApprovalAtomic"],
    ["clockify_webhooks_create", { name: "New", url: "https://new.example/h", webhookEvent: "NEW_TASK" }, "create-webhook", "createWebhookAtomic"],
    ["clockify_webhooks_update", { id: "w1", name: "Renamed" }, "update-webhook", "updateWebhookAtomic"],
    ["clockify_webhooks_delete", { id: "w1" }, "delete-webhook", "deleteWebhookAtomic"],
    ["clockify_users_invite", { email: "new@example.com" }, "invite-user", "inviteUserAtomic"],
    ["clockify_users_role_update", { userId: "u2", role: "TEAM_MANAGER", groupId: "g1" }, "update-user-role", "updateUserRoleAtomic"],
    ["clockify_users_rate_update", { userId: "u2", rateKind: "HOURLY", amount: 50 }, "update-user-rate", "updateWorkspaceMemberRateAtomic"],
    ["clockify_users_deactivate", { userId: "u2" }, "deactivate-user", "deactivateUserAtomic"],
    ["clockify_groups_create", { name: "QA" }, "create-group", "createGroupAtomic"],
    ["clockify_groups_update", { id: "g1", name: "Engineering" }, "update-group", "updateGroupAtomic"],
    ["clockify_groups_delete", { id: "g1" }, "delete-group", "deleteGroupAtomic"],
    ["clockify_groups_add_user", { groupId: "g1", userId: "u2" }, "add-user-to-group-0", "addUserToGroupAtomic"],
    ["clockify_groups_remove_user", { groupId: "g1", userId: "u3" }, "remove-user-from-group", "removeUserFromGroupAtomic"],
  ] as const)("journals %s as a real atomic step", async (action, args, stepId, countKey) => {
    const fake = createFakeWorkspace(seed() as any);
    const result = await commit(fake, action, args);
    expect(result.result).toMatchObject({ ok: true });
    expect(result.steps).toEqual([[stepId, "succeeded"]]);
    expect(fake.counts[countKey]).toBe(1);
  });

  it("journals a multi-member group add in exact order", async () => {
    const fake = createFakeWorkspace(seed() as any);
    const result = await commit(fake, "clockify_groups_add_user", { groupId: "g1", members: ["Bob", "me"] });
    expect(result.result).toMatchObject({ ok: true });
    expect(result.steps).toEqual([
      ["add-user-to-group-0", "succeeded"],
      ["add-user-to-group-1", "succeeded"],
    ]);
    expect(result.operation.mutationPlan?.mode).toBe("batch");
    expect(fake.counts.addUserToGroupAtomic).toBe(2);
  });

  it("persists each group-add step with its exact declared target fingerprint", async () => {
    const fake = createFakeWorkspace(seed() as any);
    const prepared = await prepare(fake, "clockify_groups_add_user", { groupId: "g1", members: ["Bob", "me"] });

    const result = await commitConfirmedOperation(prepared.commitContext, prepared.operation);
    expect(result).toMatchObject({ ok: true });

    const declared = prepared.operation.mutationPlan?.steps.map((step) => [step.id, step.targetFingerprint]);
    const journaled = prepared.store.listOperationSteps(prepared.operation.operationId)
      .map((step) => [step.planStepId, step.targetFingerprint]);
    expect(journaled).toEqual(declared);
    expect(journaled.every(([, fingerprint]) => typeof fingerprint === "string" && fingerprint.length > 0)).toBe(true);
    prepared.store.close();
  });

  it.each([
    ["PROJECT_MANAGER with a user-group scope", { userId: "u2", role: "PROJECT_MANAGER", groupId: "g1" }],
    ["TEAM_MANAGER with a project scope", { userId: "u2", role: "TEAM_MANAGER", projectId: "p1" }],
  ] as const)("rejects hostile role/scope combination: %s", async (_label, args) => {
    const fake = createFakeWorkspace(seed() as any);
    const result = await executeAction({ actionName: "clockify_users_role_update", args, context: context(fake) });

    expect(result).toMatchObject({ kind: "receipt", receipt: { ok: false, code: "invalid_args" } });
    expect(fake.counts.updateUserRoleAtomic ?? 0).toBe(0);
  });

  it.each([
    ["target drift", "clockify_webhooks_delete", { id: "w1" }, (fake: FakeWorkspace) => { fake.state.webhooks[0]!.name = "Drifted"; }, "deleteWebhookAtomic", "stale_target"],
    ["parent drift", "clockify_users_role_update", { userId: "u2", role: "TEAM_MANAGER", groupId: "g1" }, (fake: FakeWorkspace) => { fake.state.groups[0]!.name = "Drifted"; }, "updateUserRoleAtomic", "stale_parent"],
    ["membership drift", "clockify_groups_add_user", { groupId: "g1", userId: "u2" }, (fake: FakeWorkspace) => { fake.state.groups[0]!.userIds = ["u3", "u2"]; }, "addUserToGroupAtomic", "stale_parent"],
  ] as const)("rejects $0 immediately before dispatch", async (_label, action, args, drift, countKey, code) => {
    const fake = createFakeWorkspace(seed() as any);
    const prepared = await prepare(fake, action, args);
    drift(fake);
    const result = await commitConfirmedOperation(prepared.commitContext, prepared.operation);
    expect(result).toMatchObject({ ok: false, code });
    expect(fake.counts[countKey] ?? 0).toBe(0);
    prepared.store.close();
  });

  it.each([
    ["ambiguous", () => new AmbiguousWriteOutcome("PATCH", "/approval", "socket closed"), "outcome_unknown", "commit_outcome_unknown"],
    ["definitive", () => new DefinitiveWriteFailure("PATCH", "/approval", "rejected", 400), "definitive_failed", "write_failed"],
  ] as const)("classifies a $0 state-command dispatch without retry", async (_label, fault, status, code) => {
    const fake = createFakeWorkspace(seed() as any);
    const prepared = await prepare(fake, "clockify_approvals_approve", { id: "ap1" });
    let calls = 0;
    fake.client.setApprovalStateAtomic = async () => { calls += 1; throw fault(); };
    const result = await commitConfirmedOperation(prepared.commitContext, prepared.operation);
    expect(result).toMatchObject({ ok: false, code });
    expect(calls).toBe(1);
    expect(prepared.store.listOperationSteps(prepared.operation.operationId)).toMatchObject([{ status }]);
    if (status === "outcome_unknown") {
      prepared.store.settleOperationRun(prepared.operation.operationId, "outcome_unknown");
      expect(prepared.store.listStartupReconciliationCandidates()).toMatchObject([{
        id: prepared.operation.operationId,
        steps: [{ planStepId: "set-approval-state", strategy: "state-command" }],
      }]);
    }
    prepared.store.close();
  });

  it("keeps persisted operations nonsecret", async () => {
    const fake = createFakeWorkspace(seed() as any);
    const prepared = await prepare(fake, "clockify_webhooks_update", { id: "w1", name: "Renamed" });
    expect(JSON.stringify(prepared.operation)).not.toMatch(/authToken|authorization|x-addon-token/i);
    prepared.store.close();
  });

  it.each([
    ["clockify_scheduling_assignments_create", { userId: "u2", projectId: "p1", start: "2026-06-08", end: "2026-06-12", hoursPerDay: 8 }, "listAssignments"],
    ["clockify_webhooks_create", { name: "New", url: "https://new.example/h", webhookEvent: "NEW_TASK" }, "listWebhooks"],
    ["clockify_users_invite", { email: "new@example.com" }, "listUsers"],
    ["clockify_groups_create", { name: "QA" }, "listGroups"],
    ["clockify_approvals_submit", { periodStart: "2026-06-08" }, "listApprovals"],
  ] as const)("refuses %s when its create baseline is truncated", async (actionName, args, listKey) => {
    const fake = createFakeWorkspace({ ...seed(), listTruncated: { [listKey]: true } } as any);
    const result = await executeAction({ actionName, args, context: context(fake) });
    expect(result.kind).toBe("clarify");
  });

  it.each([
    ["clockify_scheduling_assignments_update", { id: "missing", hoursPerDay: 6 }, "updateAssignmentAtomic"],
    ["clockify_approvals_approve", { id: "missing" }, "setApprovalStateAtomic"],
    ["clockify_webhooks_update", { id: "missing", name: "Renamed" }, "updateWebhookAtomic"],
    ["clockify_groups_update", { id: "missing", name: "Renamed" }, "updateGroupAtomic"],
  ] as const)("rejects an unverified direct target for %s before mutation", async (actionName, args, countKey) => {
    const fake = createFakeWorkspace(seed() as any);
    const result = await executeAction({ actionName, args, context: context(fake) });
    expect(result.kind).toBe("clarify");
    expect(fake.counts[countKey] ?? 0).toBe(0);
  });

  it("stops a group-add batch after the first ambiguous membership dispatch", async () => {
    const fake = createFakeWorkspace(seed() as any);
    const prepared = await prepare(fake, "clockify_groups_add_user", { groupId: "g1", members: ["Bob", "me"] });
    let calls = 0;
    fake.client.addUserToGroupAtomic = async () => { calls += 1; throw new AmbiguousWriteOutcome("POST", "/membership", "socket closed"); };
    const result = await commitConfirmedOperation(prepared.commitContext, prepared.operation);
    expect(result).toMatchObject({ ok: false, code: "commit_outcome_unknown", recovery: { retryable: false } });
    expect(calls).toBe(1);
    expect(prepared.store.listOperationSteps(prepared.operation.operationId).map((step) => [step.planStepId, step.status]))
      .toEqual([["add-user-to-group-0", "outcome_unknown"]]);
    prepared.store.close();
  });
});
