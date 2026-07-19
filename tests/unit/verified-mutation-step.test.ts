import { describe, expect, it, vi } from "vitest";
import { createStore } from "../../src/db/store.js";
import { captureTargetSnapshot } from "../../src/harness/target-snapshots.js";
import { executeVerifiedMutationStep } from "../../src/harness/verified-mutation-step.js";
import type { MutationStepJournal } from "../../src/harness/mutation-contract.js";
import { commitSingleDurableRiskyStep } from "../../src/harness/durable-risky-write.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import type { ActionContext, ConfirmableOperation } from "../../src/harness/action.js";

describe("verified durable mutation step", () => {
  const legacyContext = (): ActionContext => ({
    workspaceId: "workspace-1",
    adminUserId: "admin-1",
    policy: defaultAdminPolicy(),
    clockify: {} as never,
  });
  const operation = (snapshots: ReturnType<typeof captureTargetSnapshot>[]): ConfirmableOperation => ({
    operationId: "legacy-operation",
    actionName: "clockify_invoices_delete",
    featureGroup: "invoices",
    risks: ["destructive", "billing"],
    payload: { id: "invoice-1" },
    targetSnapshots: snapshots,
    mutationPlan: { mode: "single", maxHostCalls: 60, steps: [{ id: "delete-invoice", kind: "primary", reconciliationStrategy: "delete" }] },
  });

  it("fails closed with a stable receipt for missing snapshots and no-journal target drift", async () => {
    const dispatch = vi.fn();
    const missing = await commitSingleDurableRiskyStep({
      ctx: legacyContext(), operation: operation([]), planStepId: "delete-invoice", name: "Delete",
      dispatch, verification: { snapshots: [], fetchSnapshot: vi.fn() },
      success: () => ({ ok: true, action: "clockify_invoices_delete" }),
    });
    expect(missing).toMatchObject({ ok: false, code: "stale_target" });

    const snapshot = captureTargetSnapshot("target", { type: "invoice", id: "invoice-1" }, { note: "before" });
    const stale = await commitSingleDurableRiskyStep({
      ctx: legacyContext(), operation: operation([snapshot]), planStepId: "delete-invoice", name: "Delete",
      dispatch,
      verification: { snapshots: [snapshot], fetchSnapshot: async () => ({ ref: snapshot.ref, projection: { note: "changed" } }) },
      success: () => ({ ok: true, action: "clockify_invoices_delete" }),
    });
    expect(stale).toMatchObject({ ok: false, code: "stale_target" });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it("persists bounded ordered snapshots before executing and blocks stale targets without host I/O", async () => {
    const store = createStore(":memory:");
    const snapshots = [captureTargetSnapshot(
      "target",
      { type: "invoice", id: "invoice-1" },
      { id: "invoice-1", number: "INV-1", note: "before" },
    )];
    const operationId = store.prepareOperationRun({
      id: "operation-1", sessionId: "session-1", workspaceId: "workspace-1", adminUserId: "admin-1",
      actionName: "clockify_invoices_delete", actionFingerprint: "af", catalogHash: "ch", operationHash: "oh",
      operation: { targetSnapshots: snapshots },
      mutationPlan: { mode: "single", maxHostCalls: 60, steps: [{ id: "delete-invoice", kind: "primary" }] },
    });
    store.markOperationExecuting(operationId);
    const dispatch = vi.fn();
    const result = await executeVerifiedMutationStep({
      journal: store.mutationStepJournal(operationId),
      operationId,
      step: { id: "delete-invoice", index: 0, name: "Delete invoice", kind: "primary" },
      snapshots,
      fetchSnapshot: async (snapshot) => ({ ref: snapshot.ref, projection: { id: "invoice-1", number: "INV-1", note: "changed" } }),
      dispatch,
    });

    expect(result.verification).toMatchObject({ ok: false, code: "stale_target" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(store.listOperationSteps(operationId)).toMatchObject([{
      status: "definitive_failed",
      detail: expect.objectContaining({ targetSnapshots: snapshots }),
    }]);
    store.close();
  });

  it("dispatches exactly once only after all exact refs and projections verify", async () => {
    const store = createStore(":memory:");
    const snapshots = [
      captureTargetSnapshot("target", { type: "task", id: "task-1" }, { id: "task-1", name: "Build" }),
      captureTargetSnapshot("parent", { type: "project", id: "project-1" }, { id: "project-1", name: "Roadmap" }),
    ];
    const operationId = store.prepareOperationRun({
      id: "operation-2", sessionId: "session-1", workspaceId: "workspace-1", adminUserId: "admin-1",
      actionName: "clockify_tasks_delete", actionFingerprint: "af", catalogHash: "ch", operationHash: "oh",
      operation: { targetSnapshots: snapshots },
      mutationPlan: { mode: "single", maxHostCalls: 60, steps: [{ id: "delete-task", kind: "primary" }] },
    });
    store.markOperationExecuting(operationId);
    const events: string[] = [];
    const base = store.mutationStepJournal(operationId);
    const journal: MutationStepJournal = {
      ...base,
      prepareOperationStep(input) {
        events.push("prepared");
        return base.prepareOperationStep(input);
      },
      markOperationStepExecuting(id) {
        events.push("executing");
        return base.markOperationStepExecuting(id);
      },
    };
    const dispatch = vi.fn(async () => { events.push("dispatch"); return { effect: { deleted: "task-1" } }; });
    const result = await executeVerifiedMutationStep({
      journal,
      operationId,
      step: { id: "delete-task", index: 0, name: "Delete task", kind: "primary" },
      snapshots,
      fetchSnapshot: async (snapshot) => {
        events.push(`fetch-${snapshot.relation}`);
        return { ref: snapshot.ref, projection: snapshot.projection };
      },
      dispatch,
    });
    expect(result.verification).toEqual({ ok: true });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["prepared", "executing", "fetch-target", "fetch-parent", "dispatch"]);
    expect(result.step.status).toBe("succeeded");
    store.close();
  });

  it("does not dispatch when a same-prefix oversized projection drifts after the stored preview", async () => {
    const store = createStore(":memory:");
    const prefix = "x".repeat(70_000);
    const snapshots = [captureTargetSnapshot(
      "target",
      { type: "invoice", id: "invoice-large" },
      { note: `${prefix}A` },
    )];
    const operationId = store.prepareOperationRun({
      id: "operation-large", sessionId: "session-1", workspaceId: "workspace-1", adminUserId: "admin-1",
      actionName: "clockify_invoices_delete", actionFingerprint: "af", catalogHash: "ch", operationHash: "oh",
    });
    store.markOperationExecuting(operationId);
    const dispatch = vi.fn();
    const result = await executeVerifiedMutationStep({
      journal: store.mutationStepJournal(operationId),
      operationId,
      step: { id: "delete-invoice", index: 0, name: "Delete invoice", kind: "primary" },
      snapshots,
      fetchSnapshot: async (snapshot) => ({ ref: snapshot.ref, projection: { note: `${prefix}B` } }),
      dispatch,
    });
    expect(result.verification).toMatchObject({ ok: false, code: "stale_target" });
    expect(dispatch).not.toHaveBeenCalled();
    store.close();
  });
});
