import { describe, expect, it } from "vitest";
import { createStore } from "../../src/db/store.js";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("durable operation runs", () => {
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
    expect(store.markOperationStepCompensating(compensationId)).toBe(true);
    expect(store.listOperationSteps(operationId)).toMatchObject([
      { id: primaryId, status: "compensating" },
      { id: compensationId, status: "executing" },
    ]);
    store.settleCompensationStep(compensationId, "compensated", { deleted: "tag-1" });
    expect(store.listOperationSteps(operationId)).toMatchObject([
      { id: primaryId, status: "compensated" },
      { id: compensationId, status: "compensated", detail: { deleted: "tag-1" } },
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
});
