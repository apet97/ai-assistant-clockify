import { describe, expect, it } from "vitest";
import { createStore } from "../../src/db/store.js";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeStep } from "../../src/harness/mutation-workflow.js";
import { DefinitiveWriteFailure } from "../../src/clockify/write-outcome.js";
import type { MutationStepJournal } from "../../src/harness/mutation-contract.js";

describe("durable operation runs", () => {
  it("persists and reloads ordered target snapshots inside the hashed confirmable operation", () => {
    const store = createStore(":memory:");
    const targetSnapshots = [
      { relation: "target" as const, ref: { type: "task", id: "task-1" }, projection: { name: "Task" }, fingerprint: "t" },
      { relation: "parent" as const, ref: { type: "project", id: "project-1" }, projection: { name: "Project" }, fingerprint: "p" },
    ];
    const operation = { operationId: "op-snapshots", actionName: "clockify_tasks_delete", featureGroup: "work_structure", risks: ["destructive"], payload: { id: "task-1" }, targetSnapshots };
    store.prepareOperationRun({
      id: operation.operationId, sessionId: "s1", workspaceId: "w1", adminUserId: "a1",
      actionName: operation.actionName, actionFingerprint: "af", catalogHash: "ch", operationHash: "oh", operation,
    });
    expect(store.getOperationRun(operation.operationId)?.operation).toEqual(operation);
    store.close();
  });
  it.each([
    { token: "SECRET" },
    { headers: { Authorization: "Bearer SECRET" } },
    { attachment: new Uint8Array([1, 2]) },
  ])("rejects nonsecret-contract violations before creating an operation row", (operation) => {
    const store = createStore(":memory:");
    expect(() => store.prepareOperationRun({
      id: "unsafe-operation", sessionId: "s", workspaceId: "w", adminUserId: "a",
      actionName: "clockify_test", actionFingerprint: "af", catalogHash: "ch", operationHash: "oh",
      operation,
    })).toThrow(/durable_evidence_(sensitive|binary)/);
    expect(store.getOperationRun("unsafe-operation")).toBeUndefined();
    store.close();
  });
  it("marks dispatched orphan steps unknown on restart without creating compensation", () => {
    const path = join(tmpdir(), `operation-recovery-${randomUUID()}.sqlite`);
    try {
      const before = createStore(path);
      const operationId = before.prepareOperationRun({
        id: "operation-restart",
        sessionId: "s1",
        workspaceId: "w1",
        adminUserId: "a1",
        actionName: "clockify_tags_create",
        actionFingerprint: "af",
        catalogHash: "ch",
        operationHash: "oh",
      });
      const stepId = before.prepareOperationStep({
        operationId,
        planStepId: "create-tag",
        index: 0,
        name: "Create tag",
        kind: "primary",
      });
      before.markOperationExecuting(operationId);
      before.markOperationStepExecuting(stepId);
      before.close();

      const after = createStore(path);
      expect(after.getOperationRun(operationId)?.status).toBe("outcome_unknown");
      expect(after.listOperationSteps(operationId)).toMatchObject([
        { id: stepId, status: "outcome_unknown", kind: "primary" },
      ]);
      expect(after.listOperationSteps(operationId)).toHaveLength(1);
      after.close();
    } finally {
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });

  it("journals prepared -> executing -> outcome_unknown without losing the canonical result", () => {
    const store = createStore(":memory:");
    const id = store.prepareOperationRun({
      requestId: "r1",
      sessionId: "s1",
      workspaceId: "w1",
      adminUserId: "a1",
      actionName: "clockify_tags_create",
      actionFingerprint: "af",
      catalogHash: "ch",
      operationHash: "oh",
    });
    expect(store.getOperationRun(id)?.status).toBe("prepared");
    store.markOperationExecuting(id);
    expect(store.getOperationRun(id)?.status).toBe("executing");
    store.settleOperationRun(id, "outcome_unknown", "result-1");
    expect(store.getOperationRun(id)).toMatchObject({ status: "outcome_unknown", actionResultId: "result-1" });
    store.close();
  });

  it("persists normalized nonsecret operation intent before dispatch and exposes ordered durable steps", () => {
    const store = createStore(":memory:");
    const id = store.prepareOperationRun({
      id: "operation-1",
      sessionId: "s1",
      workspaceId: "w1",
      adminUserId: "a1",
      actionName: "clockify_tags_create",
      actionFingerprint: "af",
      catalogHash: "ch",
      operationHash: "oh",
      operation: { name: "Normalized tag" },
      mutationPlan: { mode: "single", steps: [{ id: "create-tag", kind: "primary" }] },
    });

    expect(store.getOperationRun(id)).toMatchObject({
      status: "prepared",
      operation: { name: "Normalized tag" },
      mutationPlan: { mode: "single", steps: [{ id: "create-tag", kind: "primary" }] },
    });
    const stepId = store.prepareOperationStep({
      operationId: id,
      planStepId: "create-tag",
      index: 0,
      name: "Create tag",
      kind: "primary",
      targetFingerprint: "target-1",
    });
    expect(store.listOperationSteps(id)).toMatchObject([
      { id: stepId, planStepId: "create-tag", status: "prepared", kind: "primary" },
    ]);
    expect(store.markOperationExecuting(id)).toBe(true);
    expect(store.markOperationStepExecuting(stepId)).toBe(true);
    store.settleOperationStep(stepId, "succeeded", {
      externalId: "tag-1",
      effect: { created: [{ type: "tag", id: "tag-1" }] },
    });
    expect(store.listOperationSteps(id)).toMatchObject([
      {
        status: "succeeded",
        externalId: "tag-1",
        effect: { created: [{ type: "tag", id: "tag-1" }] },
        dispatchedAt: expect.any(String),
        settledAt: expect.any(String),
      },
    ]);
    store.close();
  });

  it("a scoped journal cannot dispatch or settle a step owned by another operation", () => {
    const store = createStore(":memory:");
    const prepareRun = (id: string) => store.prepareOperationRun({
      id,
      sessionId: "s1",
      workspaceId: "w1",
      adminUserId: "a1",
      actionName: "clockify_tags_create",
      actionFingerprint: "af",
      catalogHash: "ch",
      operationHash: id,
    });
    const operationA = prepareRun("operation-a");
    const operationB = prepareRun("operation-b");
    store.markOperationExecuting(operationA);
    store.markOperationExecuting(operationB);
    const stepB = store.prepareOperationStep({
      operationId: operationB,
      planStepId: "create-tag",
      index: 0,
      name: "Create tag",
      kind: "primary",
    });
    const journalA = store.mutationStepJournal(operationA);
    const journalB = store.mutationStepJournal(operationB);

    expect(journalA.markOperationStepExecuting(stepB)).toBe(false);
    expect(store.listOperationSteps(operationB)[0]?.status).toBe("prepared");
    expect(journalB.markOperationStepExecuting(stepB)).toBe(true);
    expect(() => journalA.settleOperationStep(stepB, "succeeded"))
      .toThrow(/operation_step_not_executing/);
    expect(store.listOperationSteps(operationB)[0]?.status).toBe("executing");
    journalB.settleOperationStep(stepB, "succeeded");
    store.close();
  });

  it("permits compensation only after a definitive failure or authoritative reconciliation", () => {
    const store = createStore(":memory:");
    const operationId = store.prepareOperationRun({
      id: "operation-compensation",
      sessionId: "s1",
      workspaceId: "w1",
      adminUserId: "a1",
      actionName: "clockify_tags_create",
      actionFingerprint: "af",
      catalogHash: "ch",
      operationHash: "oh",
      operation: { name: "Tag" },
      mutationPlan: {
        mode: "curated",
        steps: [
          { id: "create", kind: "primary" },
          { id: "delete-created", kind: "compensation" },
        ],
      },
    });
    const primaryId = store.prepareOperationStep({
      operationId,
      planStepId: "create",
      index: 0,
      name: "Create",
      kind: "primary",
    });
    store.markOperationExecuting(operationId);
    store.markOperationStepExecuting(primaryId);
    store.settleOperationStep(primaryId, "succeeded", { externalId: "tag-1" });

    expect(() => store.prepareOperationStep({
      operationId,
      planStepId: "bypass-compensation-eligibility",
      index: 1,
      name: "Bypass",
      kind: "compensation",
      compensatesStepId: primaryId,
    })).toThrow(/compensation_requires_eligibility/);

    expect(() => store.prepareCompensationStep({
      operationId,
      planStepId: "delete-created",
      index: 1,
      name: "Delete created tag",
      compensatesStepId: primaryId,
    })).toThrow(/compensation_not_eligible/);

    store.settleOperationRun(operationId, "definitive_failed");
    const compensationId = store.prepareCompensationStep({
      operationId,
      planStepId: "delete-created",
      index: 1,
      name: "Delete created tag",
      compensatesStepId: primaryId,
    });
    expect(store.listOperationSteps(operationId).at(-1)).toMatchObject({
      id: compensationId,
      kind: "compensation",
      compensatesStepId: primaryId,
      status: "prepared",
    });
    expect(store.listOperationSteps(operationId)[0]).toMatchObject({
      id: primaryId,
      status: "succeeded",
    });
    const otherOperationId = store.prepareOperationRun({
      id: "operation-compensation-other",
      sessionId: "s1",
      workspaceId: "w1",
      adminUserId: "a1",
      actionName: "clockify_tags_create",
      actionFingerprint: "af",
      catalogHash: "ch",
      operationHash: "other",
    });
    expect(store.mutationStepJournal(otherOperationId).markOperationStepCompensating(compensationId))
      .toBe(false);
    expect(store.markOperationStepCompensating(compensationId)).toBe(true);
    expect(store.listOperationSteps(operationId)).toMatchObject([
      { id: primaryId, status: "compensating" },
      { id: compensationId, status: "executing" },
    ]);
    store.settleCompensationStep(compensationId, "compensated", { effect: { deleted: "tag-1" } });
    expect(store.listOperationSteps(operationId)).toMatchObject([
      { id: primaryId, status: "compensated" },
      { id: compensationId, status: "compensated", effect: { deleted: "tag-1" } },
    ]);
    store.close();
  });

  it("preserves a known source and an undispatched prepared compensation across restart", () => {
    const path = join(tmpdir(), `prepared-compensation-${randomUUID()}.sqlite`);
    try {
      const before = createStore(path);
      const operationId = before.prepareOperationRun({
        id: "operation-prepared-compensation",
        sessionId: "s1",
        workspaceId: "w1",
        adminUserId: "a1",
        actionName: "clockify_tags_create",
        actionFingerprint: "af",
        catalogHash: "ch",
        operationHash: "oh",
        mutationPlan: {
          mode: "curated",
          steps: [
            { id: "create", kind: "primary" },
            { id: "delete-created", kind: "compensation" },
          ],
        },
      });
      const sourceId = before.prepareOperationStep({
        operationId,
        planStepId: "create",
        index: 0,
        name: "Create",
        kind: "primary",
      });
      before.markOperationExecuting(operationId);
      before.markOperationStepExecuting(sourceId);
      before.settleOperationStep(sourceId, "succeeded", { externalId: "tag-1" });
      before.settleOperationRun(operationId, "definitive_failed");
      const compensationId = before.prepareCompensationStep({
        operationId,
        planStepId: "delete-created",
        index: 1,
        name: "Delete created tag",
        compensatesStepId: sourceId,
      });
      before.close();

      const after = createStore(path);
      expect(after.listOperationSteps(operationId)).toMatchObject([
        { id: sourceId, status: "succeeded" },
        { id: compensationId, status: "prepared", kind: "compensation" },
      ]);
      after.close();
    } finally {
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });

  it("marks only a dispatched compensation unknown on restart and restores its known source", () => {
    const path = join(tmpdir(), `executing-compensation-${randomUUID()}.sqlite`);
    try {
      const before = createStore(path);
      const operationId = before.prepareOperationRun({
        id: "operation-executing-compensation",
        sessionId: "s1",
        workspaceId: "w1",
        adminUserId: "a1",
        actionName: "clockify_tags_create",
        actionFingerprint: "af",
        catalogHash: "ch",
        operationHash: "oh",
        mutationPlan: {
          mode: "curated",
          steps: [
            { id: "create", kind: "primary" },
            { id: "delete-created", kind: "compensation" },
          ],
        },
      });
      before.markOperationExecuting(operationId);
      const sourceId = before.prepareOperationStep({
        operationId,
        planStepId: "create",
        index: 0,
        name: "Create",
        kind: "primary",
      });
      before.markOperationStepExecuting(sourceId);
      before.settleOperationStep(sourceId, "succeeded", { externalId: "tag-1" });
      before.settleOperationRun(operationId, "definitive_failed");
      const compensationId = before.prepareCompensationStep({
        operationId,
        planStepId: "delete-created",
        index: 1,
        name: "Delete created tag",
        compensatesStepId: sourceId,
      });
      before.markOperationStepCompensating(compensationId);
      before.close();

      const after = createStore(path);
      expect(after.listOperationSteps(operationId)).toMatchObject([
        { id: sourceId, status: "succeeded", externalId: "tag-1" },
        { id: compensationId, status: "outcome_unknown", kind: "compensation" },
      ]);
      after.close();
    } finally {
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });

  it("keeps scoped operation listings isolated across independently constructed stores", () => {
    const a = createStore(":memory:");
    const b = createStore(":memory:");
    const prepare = (store: ReturnType<typeof createStore>, actionName: string) => store.prepareOperationRun({
      id: "shared-id", sessionId: "shared-session", workspaceId: "shared-workspace", adminUserId: "shared-admin",
      actionName, actionFingerprint: "af", catalogHash: "ch", operationHash: "oh",
    });
    prepare(a, "clockify_store_a");
    prepare(b, "clockify_store_b");

    expect(a.listScopedOperationRuns("shared-workspace", "shared-admin", "shared-session"))
      .toMatchObject([{ id: "shared-id", actionName: "clockify_store_a" }]);
    expect(b.listScopedOperationRuns("shared-workspace", "shared-admin", "shared-session"))
      .toMatchObject([{ id: "shared-id", actionName: "clockify_store_b" }]);
    expect(a.getScopedOperationRun("shared-id", "shared-workspace", "shared-admin", "shared-session")?.actionName)
      .toBe("clockify_store_a");
    a.close();
    b.close();
  });

  it("bounds and sanitizes prepared evidence once and preserves that bound after settlement and reopen", async () => {
    const path = join(tmpdir(), `bounded-step-${randomUUID()}.sqlite`);
    try {
      const before = createStore(path);
      const operationId = before.prepareOperationRun({
        id: "bounded-operation", sessionId: "s1", workspaceId: "w1", adminUserId: "a1",
        actionName: "clockify_test", actionFingerprint: "af", catalogHash: "ch", operationHash: "oh",
      });
      before.markOperationExecuting(operationId);
      const baselineIds = Array.from({ length: 180 }, (_, index) => `invoice-${index}`);
      await executeStep({
        journal: before.mutationStepJournal(operationId),
        operationId,
        step: {
          id: "write", index: 0, name: "Write", kind: "primary",
          preparedDetail: {
            preDispatch: { strategy: "invoice_create_baseline", ids: baselineIds, truncated: false },
          },
        },
        dispatch: async () => ({ detail: { response: "ok" } }),
      });
      const terminal = before.listOperationSteps(operationId)[0]!;
      expect(terminal.status).toBe("succeeded");
      expect(Buffer.byteLength(JSON.stringify(terminal.detail), "utf8")).toBeLessThanOrEqual(65_536);
      expect(terminal.detail).toMatchObject({ preDispatch: { ids: baselineIds, truncated: false } });
      before.close();

      const after = createStore(path);
      const reopened = after.listOperationSteps(operationId)[0]!;
      expect(reopened.status).toBe("succeeded");
      expect(Buffer.byteLength(JSON.stringify(reopened.detail), "utf8")).toBeLessThanOrEqual(65_536);
      expect(reopened.detail).toMatchObject({ preDispatch: { ids: baselineIds, truncated: false } });
      after.close();
    } finally {
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });

  it.each([
    [{ preDispatch: { ids: ["x"], token: "SECRET" } }, "sensitive"],
    [{ preDispatch: { ids: new Uint8Array([1, 2]) } }, "binary"],
    [{ preDispatch: { ids: ["x".repeat(70_000)] } }, "oversized"],
  ] as const)("fails closed before step creation or dispatch for %s prepared evidence", async (preparedDetail, _label) => {
    const store = createStore(":memory:");
    const operationId = store.prepareOperationRun({
      id: randomUUID(), sessionId: "s1", workspaceId: "w1", adminUserId: "a1",
      actionName: "clockify_test", actionFingerprint: "af", catalogHash: "ch", operationHash: "oh",
    });
    store.markOperationExecuting(operationId);
    let dispatches = 0;
    await expect(executeStep({
      journal: store.mutationStepJournal(operationId),
      operationId,
      step: { id: "write", index: 0, name: "Write", kind: "primary", preparedDetail },
      dispatch: async () => { dispatches += 1; return {}; },
    })).rejects.toThrow(/durable_evidence_/);
    expect(dispatches).toBe(0);
    expect(store.listOperationSteps(operationId)).toEqual([]);
    store.close();
  });

  it("preserves near-cap exact prepared evidence when dispatch fails with terminal detail", async () => {
    const store = createStore(":memory:");
    const operationId = store.prepareOperationRun({
      id: "near-cap", sessionId: "s1", workspaceId: "w1", adminUserId: "a1",
      actionName: "clockify_test", actionFingerprint: "af", catalogHash: "ch", operationHash: "oh",
    });
    store.markOperationExecuting(operationId);
    const ids = Array.from({ length: 180 }, (_, index) => `payment-${index}`);
    const note = "x".repeat(49_000);
    const step = await executeStep({
      journal: store.mutationStepJournal(operationId),
      operationId,
      step: { id: "write", index: 0, name: "Write", kind: "primary", preparedDetail: { preDispatch: { ids, note } } },
      dispatch: async () => { throw new DefinitiveWriteFailure("POST", "/payments", "rejected"); },
    });
    expect(step.status).toBe("definitive_failed");
    expect(step.detail).toMatchObject({ preDispatch: { ids, note }, dispatch: { type: "DefinitiveWriteFailure" } });
    expect(Buffer.byteLength(JSON.stringify(step.detail), "utf8")).toBeLessThanOrEqual(65_536);
    store.close();
  });

  it("preserves complete prepared baselines through degraded settlement fallback", async () => {
    const store = createStore(":memory:");
    const operationId = store.prepareOperationRun({
      id: "degraded-baseline", sessionId: "s1", workspaceId: "w1", adminUserId: "a1",
      actionName: "clockify_test", actionFingerprint: "af", catalogHash: "ch", operationHash: "oh",
    });
    store.markOperationExecuting(operationId);
    const base = store.mutationStepJournal(operationId);
    const journal: MutationStepJournal = {
      ...base,
      settleOperationStep() { throw new Error("full settlement unavailable"); },
    };
    const ids = Array.from({ length: 180 }, (_, index) => `invoice-${index}`);
    const step = await executeStep({
      journal,
      operationId,
      step: { id: "write", index: 0, name: "Write", kind: "primary", preparedDetail: { preDispatch: { ids } } },
      dispatch: async () => ({ externalId: "created" }),
    });
    expect(step.status).toBe("succeeded");
    expect(step.detail).toMatchObject({ preDispatch: { ids }, journalDegraded: true, fullEffectPersisted: false });
    expect(store.listOperationSteps(operationId)[0]?.detail)
      .toMatchObject({ preDispatch: { ids }, journalDegraded: true, fullEffectPersisted: false });
    store.close();
  });

  it("stores only bounded reconciliation evidence and stable reason codes", () => {
    const store = createStore(":memory:");
    const operationId = store.prepareOperationRun({
      id: "reconciliation-evidence", sessionId: "s1", workspaceId: "w1", adminUserId: "a1",
      actionName: "clockify_test", actionFingerprint: "af", catalogHash: "ch", operationHash: "oh",
    });
    store.markOperationExecuting(operationId);
    const stepId = store.prepareOperationStep({ operationId, planStepId: "write", index: 0, name: "Write", kind: "primary" });
    store.markOperationStepExecuting(stepId);
    store.settleOperationStep(stepId, "outcome_unknown");
    store.recordOperationReconciliation(operationId, stepId, {
      authoritative: false,
      reason: "Authorization: Bearer REASON_SECRET",
      binding: { operationId, stepId, token: "BINDING_SECRET" },
      evidence: { complete: true, token: "EVIDENCE_SECRET", note: "x".repeat(200_000) },
    }, false);
    const persisted = store.getOperationRun(operationId)?.reconciliation;
    expect(persisted).toMatchObject({ result: { reason: "invalid_reconciliation_reason" } });
    expect(Buffer.byteLength(JSON.stringify(persisted), "utf8")).toBeLessThanOrEqual(65_536);
    expect(JSON.stringify(persisted)).not.toContain("SECRET");
    store.close();
  });
});
