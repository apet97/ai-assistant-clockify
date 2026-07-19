import { describe, expect, it, vi } from "vitest";
import { runStartupReconciliation } from "../../src/harness/startup-reconciliation.js";
import { runStoreStartupReconciliation } from "../../src/harness/startup-reconciliation.js";
import { createStore } from "../../src/db/store.js";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashOperation } from "../../src/harness/confirmations.js";
import {
  hasProductionStartupReconciliationHandler,
  reconcileWithProductionRegistry,
  runProductionStartupReconciliation,
} from "../../src/harness/startup-reconciliation-registry.js";
import { APPROVAL_STARTUP_RECONCILIATION } from "../../src/harness/workflows/approvals.js";
import { SCHEDULING_STARTUP_RECONCILIATION } from "../../src/harness/workflows/scheduling.js";
import { WEBHOOK_STARTUP_RECONCILIATION } from "../../src/harness/workflows/webhooks.js";
import { USER_GROUP_STARTUP_RECONCILIATION } from "../../src/harness/workflows/users.js";
import { STRUCTURE_STARTUP_RECONCILIATION } from "../../src/harness/workflows/structure-startup-reconciliation.js";
import { LEAVE_BILLING_STARTUP_RECONCILIATION } from "../../src/harness/workflows/leave-billing-startup-reconciliation.js";
import { sanitizedFingerprint } from "../../src/harness/safe-json.js";

describe("startup reconciliation", () => {
  it("has a production read handler for every domain-declared action/step binding", () => {
    for (const metadata of [
      APPROVAL_STARTUP_RECONCILIATION,
      SCHEDULING_STARTUP_RECONCILIATION,
      WEBHOOK_STARTUP_RECONCILIATION,
      USER_GROUP_STARTUP_RECONCILIATION,
      STRUCTURE_STARTUP_RECONCILIATION,
      LEAVE_BILLING_STARTUP_RECONCILIATION,
    ]) {
      for (const [actionName, steps] of Object.entries(metadata)) {
        for (const planStepId of Object.keys(steps)) {
          expect(hasProductionStartupReconciliationHandler(actionName, planStepId), `${actionName}/${planStepId}`).toBe(true);
        }
      }
    }
    expect(hasProductionStartupReconciliationHandler("clockify_groups_add_user", "add-user-to-group-19")).toBe(true);
    expect(hasProductionStartupReconciliationHandler("clockify_onboard_user", "invite-user")).toBe(true);
    expect(hasProductionStartupReconciliationHandler("clockify_onboard_user", "add-user-to-group-3")).toBe(true);
    expect(hasProductionStartupReconciliationHandler("clockify_setup_project", "set-project-rate-4")).toBe(true);
    expect(hasProductionStartupReconciliationHandler("clockify_invoices_create", "add-invoice-item-5")).toBe(true);
  });

  it("reconciles onboarding invite and group steps from complete reads without exposing mutations", async () => {
    const mutation = vi.fn();
    const candidateBase = {
      id: "onboard", status: "outcome_unknown" as const, sessionId: "s", workspaceId: "w", adminUserId: "a",
      operationHash: "oh", actionName: "clockify_onboard_user", actionFingerprint: "af", catalogHash: "ch",
      targetSnapshots: [],
    };
    const inviteStep = {
      id: "invite-step", status: "outcome_unknown" as const, kind: "primary" as const,
      planStepId: "invite-user", strategy: "create" as const, evidence: {},
    };
    const inviteBinding = {
      operationId: "onboard", stepId: inviteStep.id, planStepId: inviteStep.planStepId,
      strategy: inviteStep.strategy, actionName: candidateBase.actionName, actionFingerprint: "af", catalogHash: "ch",
    };
    const invite = await reconcileWithProductionRegistry({
      binding: inviteBinding,
      candidate: {
        ...candidateBase,
        operation: { payload: { baselineUserIds: ["old"], email: " New@Example.com " } },
        mutationPlan: { mode: "curated", maxHostCalls: 60, steps: [{ id: "invite-user", kind: "primary", reconciliationStrategy: "create" }] },
        steps: [inviteStep],
      },
      step: inviteStep,
      clockify: {
        listUsers: vi.fn(async () => ({ rows: [{ id: "old", email: "old@example.com" }, { id: "new", email: "new@example.com" }], truncated: false })),
        inviteUserAtomic: mutation,
      } as never,
    });
    expect(invite).toMatchObject({ authoritative: true, reason: "authoritative_match" });

    const groupStep = {
      id: "group-step", status: "outcome_unknown" as const, kind: "primary" as const,
      planStepId: "add-user-to-group-0", strategy: "update" as const,
      evidence: { groupId: "group-1", expectedUserIds: ["existing", "new"] },
    };
    const group = await reconcileWithProductionRegistry({
      binding: {
        operationId: "onboard", stepId: groupStep.id, planStepId: groupStep.planStepId,
        strategy: groupStep.strategy, actionName: candidateBase.actionName, actionFingerprint: "af", catalogHash: "ch",
      },
      candidate: {
        ...candidateBase,
        operation: { payload: { email: "new@example.com" } },
        mutationPlan: { mode: "curated", maxHostCalls: 60, steps: [{ id: groupStep.planStepId, kind: "primary", reconciliationStrategy: "update" }] },
        steps: [groupStep],
      },
      step: groupStep,
      clockify: {
        listGroups: vi.fn(async () => ({ rows: [{ id: "group-1", userIds: ["new", "existing"] }], truncated: false })),
        addUsersToGroupAtomic: mutation,
      } as never,
    });
    expect(group).toMatchObject({ authoritative: true, reason: "authoritative_match" });
    expect(mutation).not.toHaveBeenCalled();
  });
  it("exposes complete bounded normalized intent, plan, snapshots, and prepared evidence to the read-only pass", () => {
    const store = createStore(":memory:");
    const mutationPlan = {
      mode: "single" as const,
      maxHostCalls: 60,
      steps: [{ id: "set-approval-state", kind: "primary" as const, targetFingerprint: "target-fp", reconciliationStrategy: "state-command" as const }],
    };
    const operation = {
      operationId: "candidate-data", actionName: "clockify_approvals_approve",
      payload: { id: "approval-1", state: "APPROVED" },
      targetSnapshots: [{ relation: "target", ref: { type: "approval", id: "approval-1" }, projection: { state: "PENDING" }, fingerprint: "target-fp" }],
      mutationPlan,
    };
    store.prepareOperationRun({
      id: operation.operationId, confirmationId: "confirmation", sessionId: "s", workspaceId: "w", adminUserId: "a",
      actionName: operation.actionName, actionFingerprint: "af", catalogHash: "ch",
      operationHash: hashOperation(operation), operation, mutationPlan,
    });
    store.markOperationExecuting(operation.operationId);
    const stepId = store.prepareOperationStep({
      operationId: operation.operationId, planStepId: "set-approval-state", index: 0, name: "Approve", kind: "primary",
      targetFingerprint: "target-fp", preparedDetail: { request: { state: "APPROVED" } },
    });
    store.markOperationStepExecuting(stepId);
    store.settleOperationStep(stepId, "outcome_unknown");
    store.settleOperationRun(operation.operationId, "outcome_unknown");

    expect(store.listStartupReconciliationCandidates()).toEqual([expect.objectContaining({
      id: operation.operationId,
      workspaceId: "w", adminUserId: "a", sessionId: "s",
      operationHash: hashOperation(operation), operation, mutationPlan,
      targetSnapshots: operation.targetSnapshots,
      steps: [expect.objectContaining({
        id: stepId, targetFingerprint: "target-fp", evidence: { request: { state: "APPROVED" } },
      })],
    })]);
    store.close();
  });

  it("omits oversized startup intent instead of reconciling from a truncated preview", () => {
    const store = createStore(":memory:");
    const plan = { mode: "single" as const, maxHostCalls: 60, steps: [{ id: "write", kind: "primary" as const, reconciliationStrategy: "create" as const }] };
    const operation = { value: "x".repeat(70_000) };
    store.prepareOperationRun({
      id: "oversized-startup", sessionId: "s", workspaceId: "w", adminUserId: "a", actionName: "safe_action",
      actionFingerprint: "af", catalogHash: "ch",
      operationHash: hashOperation({ actionName: "safe_action", operation, mutationPlan: plan }), operation, mutationPlan: plan,
    });
    store.markOperationExecuting("oversized-startup");
    const step = store.prepareOperationStep({ operationId: "oversized-startup", planStepId: "write", index: 0, name: "Write", kind: "primary" });
    store.markOperationStepExecuting(step);
    store.settleOperationStep(step, "outcome_unknown");
    store.settleOperationRun("oversized-startup", "outcome_unknown");
    expect(store.listStartupReconciliationCandidates()).toEqual([]);
    store.close();
  });

  it("atomically settles an authoritative startup result and creates exactly one canonical result", () => {
    const store = createStore(":memory:");
    const plan = { mode: "single" as const, maxHostCalls: 60, steps: [{ id: "write", kind: "primary" as const, reconciliationStrategy: "update" as const }] };
    store.prepareOperationRun({
      id: "authoritative", sessionId: "s", workspaceId: "w", adminUserId: "a", actionName: "safe_action",
      actionFingerprint: "af", catalogHash: "ch", operationHash: hashOperation({ actionName: "safe_action", operation: { id: "x" }, mutationPlan: plan }),
      operation: { id: "x" }, mutationPlan: plan,
    });
    store.markOperationExecuting("authoritative");
    const stepId = store.prepareOperationStep({ operationId: "authoritative", planStepId: "write", index: 0, name: "Write", kind: "primary" });
    store.markOperationStepExecuting(stepId);
    store.settleOperationStep(stepId, "outcome_unknown");
    store.settleOperationRun("authoritative", "outcome_unknown");
    const result = {
      authoritative: true, reason: "authoritative_match",
      binding: { operationId: "authoritative", stepId, planStepId: "write", strategy: "update" as const, actionName: "safe_action", actionFingerprint: "af", catalogHash: "ch" },
      evidence: { complete: true, candidates: [{ ref: { type: "entity", id: "x" } }] },
    };

    const ref = store.settleStartupReconciliation("authoritative", stepId, result);
    expect(ref).toMatchObject({ kind: "succeeded", id: expect.any(String) });
    expect(store.getOperationRun("authoritative")).toMatchObject({ status: "succeeded", actionResultId: ref.id });
    expect(store.listOperationSteps("authoritative")).toMatchObject([{ status: "succeeded", settledAt: expect.any(String) }]);
    expect(store.getActionResult(ref.id)).toMatchObject({ kind: "receipt", receipt: { ok: true, action: "safe_action" } });
    expect(() => store.settleStartupReconciliation("authoritative", stepId, result)).toThrow(/reconciliation/);
    expect(store.getOperationRun("authoritative")?.actionResultId).toBe(ref.id);
    store.close();
  });

  it("reports partial when an authoritative step applied but later planned primaries were never dispatched", () => {
    const store = createStore(":memory:");
    const plan = { mode: "curated" as const, maxHostCalls: 60, steps: [
      { id: "first", kind: "primary" as const, reconciliationStrategy: "update" as const },
      { id: "later", kind: "primary" as const, reconciliationStrategy: "update" as const },
    ] };
    const operation = { id: "x" };
    store.prepareOperationRun({
      id: "partial-startup", sessionId: "s", workspaceId: "w", adminUserId: "a", actionName: "safe_action",
      actionFingerprint: "af", catalogHash: "ch",
      operationHash: hashOperation({ actionName: "safe_action", operation, mutationPlan: plan }), operation, mutationPlan: plan,
    });
    store.markOperationExecuting("partial-startup");
    const stepId = store.prepareOperationStep({ operationId: "partial-startup", planStepId: "first", index: 0, name: "First", kind: "primary" });
    store.markOperationStepExecuting(stepId);
    store.settleOperationStep(stepId, "outcome_unknown");
    store.settleOperationRun("partial-startup", "outcome_unknown");
    const ref = store.settleStartupReconciliation("partial-startup", stepId, {
      authoritative: true, reason: "authoritative_match",
      binding: { operationId: "partial-startup", stepId, planStepId: "first", strategy: "update", actionName: "safe_action", actionFingerprint: "af", catalogHash: "ch" },
      evidence: { complete: true, candidates: [{ ref: { type: "entity", id: "x" } }] },
    });
    expect(ref.kind).toBe("partial");
    expect(store.getOperationRun("partial-startup")?.status).toBe("partial");
    expect(store.getActionResult(ref.id)).toMatchObject({ kind: "partial", recovery: { retryable: false } });
    expect(store.listOperationSteps("partial-startup")).toMatchObject([{ status: "succeeded", externalId: "x" }]);
    store.close();
  });

  it.each([
    [[], false, "non_unique_or_missing"],
    [[{ id: "a" }, { id: "b" }], false, "non_unique_or_missing"],
    [[{ id: "a" }], true, "incomplete_evidence"],
  ] as const)("keeps 0/2/truncated startup matches unknown and never mutates", async (rows, truncated, reason) => {
    const mutation = vi.fn();
    const binding = { operationId: "op", stepId: "step", planStepId: "submit-approval", strategy: "create" as const, actionName: "clockify_approvals_submit", actionFingerprint: "af", catalogHash: "ch" };
    const result = await reconcileWithProductionRegistry({
      binding,
      candidate: {
        id: "op", status: "outcome_unknown", sessionId: "s", workspaceId: "w", adminUserId: "a", operationHash: "oh",
        actionName: binding.actionName, actionFingerprint: "af", catalogHash: "ch",
        operation: { payload: { baselineIds: [], finalFingerprint: "never" } },
        mutationPlan: { mode: "single", maxHostCalls: 60, steps: [{ id: "submit-approval", kind: "primary", reconciliationStrategy: "create" }] },
        targetSnapshots: [], steps: [{ id: "step", status: "outcome_unknown", kind: "primary", planStepId: "submit-approval", strategy: "create", evidence: {} }],
      },
      step: { id: "step", status: "outcome_unknown", kind: "primary", planStepId: "submit-approval", strategy: "create", evidence: {} },
      clockify: { listApprovals: vi.fn(async () => ({ rows, truncated })), submitApprovalAtomic: mutation } as never,
    });
    expect(result).toMatchObject({ authoritative: false, reason });
    expect(mutation).not.toHaveBeenCalled();
  });

  it("uses only the owning active installation, settles one authoritative match, and never exposes a mutation", async () => {
    const store = createStore(":memory:");
    store.saveInstallation({ workspaceId: "w", addonId: "addon", addonUserId: "addon-user", addonToken: "SECRET", status: "active" });
    const plan = { mode: "single" as const, maxHostCalls: 60, steps: [{ id: "submit-approval", kind: "primary" as const, reconciliationStrategy: "create" as const }] };
    const operation = {
      operationId: "startup-supported", actionName: "clockify_approvals_submit",
      payload: { baselineIds: ["old"], finalFingerprint: sanitizedFingerprint({ state: "PENDING", periodStart: "2026-07-14" }) },
      mutationPlan: plan,
    };
    store.prepareOperationRun({
      id: operation.operationId, confirmationId: "confirmation", sessionId: "s", workspaceId: "w", adminUserId: "a",
      actionName: operation.actionName, actionFingerprint: "af", catalogHash: "ch", operationHash: hashOperation(operation), operation, mutationPlan: plan,
    });
    store.markOperationExecuting(operation.operationId);
    const stepId = store.prepareOperationStep({ operationId: operation.operationId, planStepId: "submit-approval", index: 0, name: "Submit", kind: "primary" });
    store.markOperationStepExecuting(stepId);
    store.markOperationStepDispatched(stepId);
    store.recoverOrphanedRuns();
    const unknownResultId = store.getOperationRun(operation.operationId)?.actionResultId;
    expect(unknownResultId).toEqual(expect.any(String));
    expect(store.getActionResult(unknownResultId!)).toMatchObject({ kind: "receipt", receipt: { ok: false, code: "commit_outcome_unknown" } });
    const mutation = vi.fn();
    const factory = vi.fn((installation: { workspaceId: string; addonToken: string }) => {
      expect(installation).toMatchObject({ workspaceId: "w", addonToken: "SECRET" });
      return {
        listApprovals: vi.fn(async () => ({ rows: [{ id: "old" }, { id: "new", state: "PENDING", periodStart: "2026-07-14" }], truncated: false })),
        submitApprovalAtomic: mutation,
      } as never;
    });
    const result = await runProductionStartupReconciliation({
      store,
      currentActionFingerprint: () => "af",
      currentCatalogHash: () => "ch",
      clockifyForWorkspace: factory,
    });
    expect(result).toEqual({ considered: 1, reconciled: 1, authoritative: 1, persistenceFailures: 0 });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(mutation).not.toHaveBeenCalled();
    expect(store.getOperationRun(operation.operationId)).toMatchObject({ status: "succeeded", actionResultId: unknownResultId });
    expect(store.getOperationRun(operation.operationId)).not.toHaveProperty("operation");
    expect(store.getOperationRun(operation.operationId)).not.toHaveProperty("mutationPlan");
    expect(store.listOperationSteps(operation.operationId)).toMatchObject([{ status: "succeeded", externalId: "new" }]);
    expect(store.getActionResult(unknownResultId!)).toMatchObject({ kind: "receipt", receipt: { ok: true, action: operation.actionName } });
    store.close();
  });

  it.each([
    ["handler", "handler_missing"],
    ["installation", "installation_unavailable"],
    ["drift", "action_fingerprint_drift"],
    ["read", "read_failed"],
  ] as const)("keeps %s startup failures unknown and creates no mutation client when avoidable", async (mode, reason) => {
    const store = createStore(":memory:");
    if (mode !== "installation") {
      store.saveInstallation({ workspaceId: "w", addonId: "addon", addonUserId: "u", addonToken: "secret", status: "active" });
    }
    const actionName = mode === "handler" ? "clockify_unknown_write" : "clockify_approvals_submit";
    const stepName = mode === "handler" ? "unknown-step" : "submit-approval";
    const plan = { mode: "single" as const, maxHostCalls: 60, steps: [{ id: stepName, kind: "primary" as const, reconciliationStrategy: "create" as const }] };
    const operation = { operationId: `failure-${mode}`, actionName, payload: { baselineIds: [], finalFingerprint: "x" }, mutationPlan: plan };
    store.prepareOperationRun({
      id: operation.operationId, confirmationId: "c", sessionId: "s", workspaceId: "w", adminUserId: "a",
      actionName, actionFingerprint: "af", catalogHash: "ch", operationHash: hashOperation(operation), operation, mutationPlan: plan,
    });
    store.markOperationExecuting(operation.operationId);
    const stepId = store.prepareOperationStep({ operationId: operation.operationId, planStepId: stepName, index: 0, name: "Write", kind: "primary" });
    store.markOperationStepExecuting(stepId);
    store.settleOperationStep(stepId, "outcome_unknown");
    store.settleOperationRun(operation.operationId, "outcome_unknown");
    const factory = vi.fn(() => ({
      listApprovals: mode === "read" ? vi.fn(async () => { throw new Error("offline"); }) : vi.fn(async () => ({ rows: [], truncated: false })),
    }) as never);
    await runProductionStartupReconciliation({
      store,
      currentActionFingerprint: () => mode === "drift" ? "changed" : "af",
      currentCatalogHash: () => "ch",
      clockifyForWorkspace: factory,
    });
    expect(store.getOperationRun(operation.operationId)).toMatchObject({
      status: "outcome_unknown",
      reconciliation: { authoritative: false, result: { reason } },
    });
    expect(store.listOperationSteps(operation.operationId)).toMatchObject([{ status: "outcome_unknown" }]);
    if (mode === "handler" || mode === "installation" || mode === "drift") expect(factory).not.toHaveBeenCalled();
    else expect(factory).toHaveBeenCalledTimes(1);
    store.close();
  });
  it("reconciles only dispatched unknown compatible operations and never exposes mutation capabilities", async () => {
    const records = [
      { id: "unknown", status: "outcome_unknown", actionName: "a", actionFingerprint: "af", catalogHash: "ch", steps: [{ id: "step", planStepId: "create", kind: "primary", strategy: "create", status: "outcome_unknown" }] },
      { id: "prepared", status: "prepared", actionName: "a", actionFingerprint: "af", catalogHash: "ch", steps: [{ id: "prepared-step", planStepId: "create", kind: "primary", strategy: "create", status: "prepared" }] },
    ] as const;
    const persist = vi.fn();
    const reconcile = vi.fn(async (input: { operationId: string; stepId: string }) => ({
      authoritative: false as const,
      reason: "not_found",
      binding: { ...input, actionName: "a", actionFingerprint: "af", catalogHash: "ch" },
      evidence: { complete: true },
    }));
    const result = await runStartupReconciliation({
      listCandidates: () => records,
      currentActionFingerprint: () => "af",
      currentCatalogHash: () => "ch",
      reconcile,
      persist,
    });

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ operationId: "unknown", stepId: "step" }));
    expect(reconcile.mock.calls[0]?.[0]).not.toHaveProperty("dispatch");
    expect(reconcile.mock.calls[0]?.[0]).not.toHaveProperty("compensate");
    expect(persist).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ considered: 1, reconciled: 1, authoritative: 0, persistenceFailures: 0 });
  });

  it("rejects action/catalog drift without reads and leaves persistence failure unknown", async () => {
    const candidate = {
      id: "unknown", status: "outcome_unknown" as const, actionName: "a",
      actionFingerprint: "old-af", catalogHash: "old-ch",
      steps: [{ id: "step", planStepId: "create", kind: "primary" as const, strategy: "create" as const, status: "outcome_unknown" as const }],
    };
    const reconcile = vi.fn();
    const persist = vi.fn().mockRejectedValue(new Error("disk full"));
    const result = await runStartupReconciliation({
      listCandidates: () => [candidate],
      currentActionFingerprint: () => "new-af",
      currentCatalogHash: () => "new-ch",
      reconcile,
      persist,
    });
    expect(reconcile).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalledWith("unknown", "step", expect.objectContaining({ authoritative: false, reason: "action_fingerprint_drift" }));
    expect(result.persistenceFailures).toBe(1);
  });

  it.each([
    ["operationId", "other-operation"],
    ["stepId", "other-step"],
    ["planStepId", "other-plan-step"],
    ["strategy", "delete"],
  ] as const)("rejects a reconciliation callback with mismatched %s binding", async (field, value) => {
    const persisted: unknown[] = [];
    await runStartupReconciliation({
      listCandidates: () => [{
        id: "operation", status: "outcome_unknown", actionName: "a", actionFingerprint: "af", catalogHash: "ch",
        steps: [{ id: "step", planStepId: "write", kind: "primary", strategy: "create", status: "outcome_unknown" }],
      }],
      currentActionFingerprint: () => "af",
      currentCatalogHash: () => "ch",
      reconcile: async (input) => ({
        authoritative: true,
        reason: "authoritative_match",
        binding: { ...input, [field]: value },
        evidence: { complete: true },
      }),
      persist: (_operationId, _stepId, result) => { persisted.push(result); },
    });
    expect(persisted[0]).toMatchObject({ authoritative: false, reason: "binding_mismatch" });
  });

  it("runs after real Store recovery, leaves prepared undispatched, persists once, and skips the second startup pass", async () => {
    const path = join(tmpdir(), `startup-reconcile-${randomUUID()}.sqlite`);
    try {
      const before = createStore(path);
      const mutationPlan = { mode: "single" as const, maxHostCalls: 60, steps: [{ id: "create-tag", kind: "primary" as const, reconciliationStrategy: "create" as const }] };
      const operationHash = hashOperation({ actionName: "clockify_tags_create", mutationPlan });
      before.prepareOperationRun({
        id: "executing-op", sessionId: "s1", workspaceId: "w1", adminUserId: "a1",
        actionName: "clockify_tags_create", actionFingerprint: "af", catalogHash: "ch", operationHash,
        mutationPlan,
      });
      before.markOperationExecuting("executing-op");
      const executingStep = before.prepareOperationStep({ operationId: "executing-op", planStepId: "create-tag", index: 0, name: "Create", kind: "primary" });
      before.markOperationStepExecuting(executingStep);
      before.markOperationStepDispatched(executingStep);
      before.prepareOperationRun({
        id: "prepared-op", sessionId: "s1", workspaceId: "w1", adminUserId: "a1",
        actionName: "clockify_tags_create", actionFingerprint: "af", catalogHash: "ch", operationHash,
        mutationPlan,
      });
      const preparedStep = before.prepareOperationStep({ operationId: "prepared-op", planStepId: "create-tag", index: 0, name: "Create", kind: "primary" });
      before.close();

      const after = createStore(path);
      const events: string[] = [];
      const reconcile = vi.fn(async (input: { operationId: string; stepId: string; actionName: string; actionFingerprint: string; catalogHash: string }) => {
        events.push(`${after.getOperationRun(input.operationId)?.status}:${after.listOperationSteps(input.operationId)[0]?.status}`);
        return {
          authoritative: false as const,
          reason: "not_found",
          binding: input,
          evidence: { complete: true },
        };
      });
      const first = await runStoreStartupReconciliation({
        store: after,
        currentActionFingerprint: () => "af",
        currentCatalogHash: () => "ch",
        reconcile,
      });
      expect(events).toEqual(["outcome_unknown:outcome_unknown"]);
      expect(first).toEqual({ considered: 1, reconciled: 1, authoritative: 0, persistenceFailures: 0 });
      expect(after.getOperationRun("prepared-op")?.status).toBe("prepared");
      expect(after.listOperationSteps("prepared-op")).toMatchObject([{ id: preparedStep, status: "prepared" }]);
      expect(after.listOperationSteps("executing-op")).toHaveLength(1);

      const second = await runStoreStartupReconciliation({
        store: after,
        currentActionFingerprint: () => "af",
        currentCatalogHash: () => "ch",
        reconcile,
      });
      expect(second.considered).toBe(0);
      expect(reconcile).toHaveBeenCalledTimes(1);
      after.close();
    } finally {
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });

  it("rejects tampered safe and confirmed plans before any reconciliation read", async () => {
    const store = createStore(":memory:");
    const originalPlan = { mode: "single" as const, maxHostCalls: 60, steps: [{ id: "write", kind: "primary" as const, reconciliationStrategy: "create" as const }] };
    const tamperedPlan = { mode: "single" as const, maxHostCalls: 60, steps: [{ id: "write", kind: "primary" as const, reconciliationStrategy: "delete" as const }] };
    const makeUnknown = (id: string, input: Parameters<typeof store.prepareOperationRun>[0]) => {
      store.prepareOperationRun({ ...input, id });
      store.markOperationExecuting(id);
      const step = store.prepareOperationStep({ operationId: id, planStepId: "write", index: 0, name: "Write", kind: "primary" });
      store.markOperationStepExecuting(step);
      store.settleOperationStep(step, "outcome_unknown");
      store.settleOperationRun(id, "outcome_unknown");
    };
    makeUnknown("safe-tampered", {
      sessionId: "s", workspaceId: "w", adminUserId: "a", actionName: "safe_action",
      actionFingerprint: "af", catalogHash: "ch",
      operationHash: hashOperation({ actionName: "safe_action", operation: { value: 1 }, mutationPlan: originalPlan }),
      operation: { value: 1 }, mutationPlan: tamperedPlan,
    });
    const confirmedOperation = { operationId: "confirmed-tampered", actionName: "confirmed_action", mutationPlan: originalPlan };
    makeUnknown("confirmed-tampered", {
      confirmationId: "confirmation-1", sessionId: "s", workspaceId: "w", adminUserId: "a", actionName: "confirmed_action",
      actionFingerprint: "af", catalogHash: "ch", operationHash: hashOperation(confirmedOperation),
      operation: confirmedOperation, mutationPlan: tamperedPlan,
    });
    const wrongIdentity = { operationId: "different-operation", actionName: "confirmed_action", mutationPlan: originalPlan };
    makeUnknown("confirmed-wrong-identity", {
      confirmationId: "confirmation-2", sessionId: "s", workspaceId: "w", adminUserId: "a", actionName: "confirmed_action",
      actionFingerprint: "af", catalogHash: "ch", operationHash: hashOperation(wrongIdentity),
      operation: wrongIdentity, mutationPlan: originalPlan,
    });

    const reconcile = vi.fn();
    const result = await runStoreStartupReconciliation({
      store,
      currentActionFingerprint: () => "af",
      currentCatalogHash: () => "ch",
      reconcile,
    });
    expect(result.considered).toBe(0);
    expect(reconcile).not.toHaveBeenCalled();
    store.close();
  });

  it("skips legacy no-plan and adversarial plan bindings while retaining a valid safe candidate", () => {
    const store = createStore(":memory:");
    const makeUnknown = (input: Parameters<typeof store.prepareOperationRun>[0], planStepId = "write", index = 0) => {
      const id = store.prepareOperationRun(input);
      store.markOperationExecuting(id);
      const step = store.prepareOperationStep({ operationId: id, planStepId, index, name: "Write", kind: "primary" });
      store.markOperationStepExecuting(step);
      store.settleOperationStep(step, "outcome_unknown");
      store.settleOperationRun(id, "outcome_unknown");
    };
    const validPlan = { mode: "single" as const, maxHostCalls: 60, steps: [{ id: "write", kind: "primary" as const, reconciliationStrategy: "create" as const }] };
    const safeOperation = { operationId: "admin-authored-value", actionName: "not-the-catalog-action", value: 1 };
    makeUnknown({
      id: "valid", sessionId: "s", workspaceId: "w", adminUserId: "a", actionName: "safe_action",
      actionFingerprint: "af", catalogHash: "ch",
      operationHash: hashOperation({ actionName: "safe_action", operation: safeOperation, mutationPlan: validPlan }),
      operation: safeOperation, mutationPlan: validPlan,
    });
    const legacyOperation = { operationId: "legacy", actionName: "confirmed_action" };
    makeUnknown({
      id: "legacy", confirmationId: "confirmation-legacy", sessionId: "s", workspaceId: "w", adminUserId: "a",
      actionName: "confirmed_action", actionFingerprint: "af", catalogHash: "ch",
      operationHash: hashOperation(legacyOperation), operation: legacyOperation,
    });
    const duplicatePlan = { mode: "batch" as const, maxHostCalls: 60, steps: [
      { id: "write", kind: "primary" as const, reconciliationStrategy: "create" as const },
      { id: "write", kind: "primary" as const, reconciliationStrategy: "delete" as const },
    ] };
    expect(() => makeUnknown({
      id: "duplicate", sessionId: "s", workspaceId: "w", adminUserId: "a", actionName: "safe_action",
      actionFingerprint: "af", catalogHash: "ch",
      operationHash: hashOperation({ actionName: "safe_action", operation: {}, mutationPlan: duplicatePlan }),
      operation: {}, mutationPlan: duplicatePlan,
    })).toThrow("invalid_mutation_plan");
    makeUnknown({
      id: "wrong-index", sessionId: "s", workspaceId: "w", adminUserId: "a", actionName: "safe_action",
      actionFingerprint: "af", catalogHash: "ch",
      operationHash: hashOperation({ actionName: "safe_action", operation: {}, mutationPlan: validPlan }),
      operation: {}, mutationPlan: validPlan,
    }, "write", 1);
    const compositePlan = { mode: "curated" as const, maxHostCalls: 60, steps: [
      { id: "create-invoice", kind: "primary" as const },
      { id: "enrich-invoice", kind: "primary" as const, reconciliationStrategy: "update" as const },
    ] };
    makeUnknown({
      id: "composite-base", sessionId: "s", workspaceId: "w", adminUserId: "a", actionName: "clockify_invoices_create",
      actionFingerprint: "af", catalogHash: "ch",
      operationHash: hashOperation({ actionName: "clockify_invoices_create", operation: {}, mutationPlan: compositePlan }),
      operation: {}, mutationPlan: compositePlan,
    }, "create-invoice", 0);

    expect(store.listStartupReconciliationCandidates()).toMatchObject([{ id: "valid", steps: [{ planStepId: "write", strategy: "create" }] }]);
    expect(store.listStartupReconciliationCandidates()).toHaveLength(1);
    expect(store.getOperationRun("duplicate")).toBeUndefined();
    store.close();
  });

  it("leaves operation and step unknown when the real store persistence seam fails", async () => {
    const store = createStore(":memory:");
    const plan = { mode: "single" as const, maxHostCalls: 60, steps: [{ id: "write", kind: "primary" as const, reconciliationStrategy: "create" as const }] };
    store.prepareOperationRun({
      id: "persistence-failure", sessionId: "s", workspaceId: "w", adminUserId: "a", actionName: "safe_action",
      actionFingerprint: "af", catalogHash: "ch",
      operationHash: hashOperation({ actionName: "safe_action", operation: {}, mutationPlan: plan }),
      operation: {}, mutationPlan: plan,
    });
    store.markOperationExecuting("persistence-failure");
    const stepId = store.prepareOperationStep({ operationId: "persistence-failure", planStepId: "write", index: 0, name: "Write", kind: "primary" });
    store.markOperationStepExecuting(stepId);
    store.settleOperationStep(stepId, "outcome_unknown");
    store.settleOperationRun("persistence-failure", "outcome_unknown");

    const result = await runStoreStartupReconciliation({
      store: {
        listStartupReconciliationCandidates: () => store.listStartupReconciliationCandidates(),
        recordOperationReconciliation: () => { throw new Error("disk full"); },
      },
      currentActionFingerprint: () => "af",
      currentCatalogHash: () => "ch",
      reconcile: async (input) => ({ authoritative: false, reason: "not_found", binding: input, evidence: { complete: true } }),
    });
    expect(result.persistenceFailures).toBe(1);
    expect(store.getOperationRun("persistence-failure")?.status).toBe("outcome_unknown");
    expect(store.listOperationSteps("persistence-failure")[0]?.status).toBe("outcome_unknown");
    expect(store.listStartupReconciliationCandidates()).toHaveLength(1);
    store.close();
  });
});
