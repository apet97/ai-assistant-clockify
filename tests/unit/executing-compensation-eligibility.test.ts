import { describe, expect, it } from "vitest";
import { createStore } from "../../src/db/store.js";
import { AmbiguousWriteOutcome, DefinitiveWriteFailure } from "../../src/clockify/write-outcome.js";
import { executeCompensationStep } from "../../src/harness/mutation-workflow.js";
import type { ExternalMutationPlan } from "../../src/harness/mutation-contract.js";

type Store = ReturnType<typeof createStore>;

const DEFAULT_PLAN: ExternalMutationPlan = {
  mode: "curated",
      maxHostCalls: 60,
  steps: [
    { id: "source", kind: "primary" },
    { id: "later", kind: "primary" },
    { id: "restore-source", kind: "compensation" },
  ],
};

function operation(store: Store, id: string, mutationPlan: ExternalMutationPlan = DEFAULT_PLAN): string {
  const operationId = store.prepareOperationRun({
    id,
    sessionId: "session",
    workspaceId: "workspace",
    adminUserId: "admin",
    actionName: "test_composed_write",
    actionFingerprint: "action",
    catalogHash: "catalog",
    operationHash: "operation",
    operation: { normalized: true },
    mutationPlan,
  });
  store.markOperationExecuting(operationId);
  return operationId;
}

function primary(
  store: Store,
  operationId: string,
  input: {
    id: string;
    index: number;
    status?: "succeeded" | "definitive_failed" | "outcome_unknown";
    targetFingerprint?: string;
  },
): string {
  const id = store.prepareOperationStep({
    id: `${operationId}-${input.id}`,
    operationId,
    planStepId: input.id,
    index: input.index,
    name: input.id,
    kind: "primary",
    ...(input.targetFingerprint ? { targetFingerprint: input.targetFingerprint } : {}),
  });
  if (input.status) {
    store.markOperationStepExecuting(id);
    store.settleOperationStep(id, input.status);
  }
  return id;
}

async function compensate(
  store: Store,
  operationId: string,
  sourceId: string,
  dispatch: () => Promise<Record<string, unknown>>,
  step: { id: string; index: number; targetFingerprint?: string } = { id: "restore-source", index: 2 },
) {
  return executeCompensationStep({
    journal: store.mutationStepJournal(operationId),
    operationId,
    step: {
      id: step.id,
      index: step.index,
      name: "Restore source",
      kind: "compensation",
      compensatesStepId: sourceId,
      ...(step.targetFingerprint ? { targetFingerprint: step.targetFingerprint } : {}),
    },
    dispatch,
  });
}

describe("compensation eligibility before route settlement", () => {
  it("rejects a persisted legacy plan that lacks its host-call bound", () => {
    const store = createStore(":memory:");
    const legacyPlan = {
      mode: "curated",
      steps: DEFAULT_PLAN.steps,
    } as unknown as ExternalMutationPlan;
    expect(() => operation(store, "missing-host-call-bound", legacyPlan)).toThrow("invalid_mutation_plan");
    expect(store.getOperationRun("missing-host-call-bound")).toBeUndefined();
    store.close();
  });

  it.each([
    {
      name: "success",
      dispatch: async () => ({ externalId: "target", effect: { restored: true } }),
      expected: "compensated",
      source: "compensated",
    },
    {
      name: "definitive rejection",
      dispatch: async () => { throw new DefinitiveWriteFailure("PUT", "/target", "rejected", 409); },
      expected: "compensation_failed",
      source: "succeeded",
    },
    {
      name: "ambiguous outcome",
      dispatch: async () => { throw new AmbiguousWriteOutcome("PUT", "/target", "socket closed"); },
      expected: "outcome_unknown",
      source: "succeeded",
    },
  ])("allows declared compensation after a later durable failure and journals $name truthfully", async ({ dispatch, expected, source }) => {
    const store = createStore(":memory:");
    const operationId = operation(store, `executing-compensation-${expected}`);
    const sourceId = primary(store, operationId, { id: "source", index: 0, status: "succeeded" });
    primary(store, operationId, { id: "later", index: 1, status: "definitive_failed" });

    const result = await compensate(store, operationId, sourceId, dispatch);

    expect(result.status).toBe(expected);
    expect(store.listOperationSteps(operationId).map((step) => [step.planStepId, step.status])).toEqual([
      ["source", source],
      ["later", "definitive_failed"],
      ["restore-source", expected],
    ]);
    expect(store.getOperationRun(operationId)?.status).toBe("executing");
    expect(store.getOperationRun(operationId)?.actionResultId).toBeUndefined();
    store.close();
  });

  it.each([
    { name: "unknown", later: "outcome_unknown" as const },
    { name: "prepared", later: undefined },
  ])("denies compensation after a later $name step", async ({ later }) => {
    const store = createStore(":memory:");
    const operationId = operation(store, `denied-${later ?? "prepared"}`);
    const sourceId = primary(store, operationId, { id: "source", index: 0, status: "succeeded" });
    primary(store, operationId, { id: "later", index: 1, status: later });
    let dispatches = 0;

    await expect(compensate(store, operationId, sourceId, async () => {
      dispatches += 1;
      return {};
    })).rejects.toThrow("compensation_not_eligible");

    expect(dispatches).toBe(0);
    expect(store.listOperationSteps(operationId)).toHaveLength(2);
    store.close();
  });

  it("denies an unrelated definitive failure that occurred before the source step", async () => {
    const store = createStore(":memory:");
    const operationId = operation(store, "denied-earlier-failure");
    primary(store, operationId, { id: "earlier", index: 0, status: "definitive_failed" });
    const sourceId = primary(store, operationId, { id: "source", index: 1, status: "succeeded" });
    let dispatches = 0;

    await expect(compensate(store, operationId, sourceId, async () => {
      dispatches += 1;
      return {};
    })).rejects.toThrow("compensation_not_eligible");

    expect(dispatches).toBe(0);
    store.close();
  });

  it("denies a cross-operation source even when this operation has a definitive failure", async () => {
    const store = createStore(":memory:");
    const sourceOperation = operation(store, "source-operation");
    const sourceId = primary(store, sourceOperation, { id: "source", index: 0, status: "succeeded" });
    const failingOperation = operation(store, "failing-operation");
    primary(store, failingOperation, { id: "later", index: 1, status: "definitive_failed" });
    let dispatches = 0;

    await expect(compensate(store, failingOperation, sourceId, async () => {
      dispatches += 1;
      return {};
    })).rejects.toThrow("compensation_not_eligible");

    expect(dispatches).toBe(0);
    store.close();
  });

  it("denies compensation when the source succeeded but no later step failed", async () => {
    const store = createStore(":memory:");
    const operationId = operation(store, "denied-no-later-failure");
    const sourceId = primary(store, operationId, { id: "source", index: 0, status: "succeeded" });
    let dispatches = 0;

    await expect(compensate(store, operationId, sourceId, async () => {
      dispatches += 1;
      return {};
    })).rejects.toThrow("compensation_not_eligible");

    expect(dispatches).toBe(0);
    store.close();
  });

  it.each([
    {
      name: "source id not declared at its stored index",
      plan: DEFAULT_PLAN,
      source: { id: "undeclared-source", index: 0 },
      later: { id: "later", index: 1 },
      compensation: { id: "restore-source", index: 2 },
    },
    {
      name: "source uses the wrong stored index",
      plan: DEFAULT_PLAN,
      source: { id: "source", index: 1 },
      later: { id: "later", index: 3 },
      compensation: { id: "restore-source", index: 2 },
    },
    {
      name: "source descriptor is declared as compensation",
      plan: {
        mode: "curated" as const,
      maxHostCalls: 60,
        steps: [
          { id: "source", kind: "compensation" as const },
          { id: "later", kind: "primary" as const },
          { id: "restore-source", kind: "compensation" as const },
        ],
      },
      source: { id: "source", index: 0 },
      later: { id: "later", index: 1 },
      compensation: { id: "restore-source", index: 2 },
    },
    {
      name: "later failure id not declared at its stored index",
      plan: DEFAULT_PLAN,
      source: { id: "source", index: 0 },
      later: { id: "undeclared-later", index: 1 },
      compensation: { id: "restore-source", index: 2 },
    },
    {
      name: "later failure uses the wrong stored index",
      plan: DEFAULT_PLAN,
      source: { id: "source", index: 0 },
      later: { id: "later", index: 3 },
      compensation: { id: "restore-source", index: 2 },
    },
    {
      name: "later failure descriptor is declared as compensation",
      plan: {
        mode: "curated" as const,
      maxHostCalls: 60,
        steps: [
          { id: "source", kind: "primary" as const },
          { id: "later", kind: "compensation" as const },
          { id: "restore-source", kind: "compensation" as const },
        ],
      },
      source: { id: "source", index: 0 },
      later: { id: "later", index: 1 },
      compensation: { id: "restore-source", index: 2 },
    },
    {
      name: "compensation id not declared at its requested index",
      plan: DEFAULT_PLAN,
      source: { id: "source", index: 0 },
      later: { id: "later", index: 1 },
      compensation: { id: "undeclared-compensation", index: 2 },
    },
    {
      name: "compensation uses the wrong declared index",
      plan: DEFAULT_PLAN,
      source: { id: "source", index: 0 },
      later: { id: "later", index: 1 },
      compensation: { id: "restore-source", index: 1 },
    },
    {
      name: "requested compensation descriptor is declared as primary",
      plan: {
        mode: "curated" as const,
      maxHostCalls: 60,
        steps: [
          { id: "source", kind: "primary" as const },
          { id: "later", kind: "primary" as const },
          { id: "restore-source", kind: "primary" as const },
        ],
      },
      source: { id: "source", index: 0 },
      later: { id: "later", index: 1 },
      compensation: { id: "restore-source", index: 2 },
    },
  ])("denies $name without creating or dispatching compensation", async ({ plan, source, later, compensation }) => {
    const store = createStore(":memory:");
    const operationId = operation(store, `plan-binding-${source.id}-${later.id}-${compensation.id}-${compensation.index}`, plan);
    const sourceId = primary(store, operationId, { ...source, status: "succeeded" });
    primary(store, operationId, { ...later, status: "definitive_failed" });
    const before = store.listOperationSteps(operationId).length;
    let dispatches = 0;

    await expect(compensate(store, operationId, sourceId, async () => {
      dispatches += 1;
      return {};
    }, compensation)).rejects.toThrow("compensation_not_eligible");

    expect(dispatches).toBe(0);
    expect(store.listOperationSteps(operationId)).toHaveLength(before);
    expect(store.listOperationSteps(operationId).every((step) => step.kind === "primary")).toBe(true);
    store.close();
  });

  it.each([
    {
      name: "missing plan",
      plan: undefined,
    },
    {
      name: "duplicate plan ids",
      plan: {
        mode: "curated",
      maxHostCalls: 60,
        steps: [
          { id: "source", kind: "primary" },
          { id: "source", kind: "primary" },
          { id: "restore-source", kind: "compensation" },
        ],
      },
    },
    {
      name: "malformed plan kind",
      plan: {
        mode: "curated",
      maxHostCalls: 60,
        steps: [
          { id: "source", kind: "primary" },
          { id: "later", kind: "mutation" },
          { id: "restore-source", kind: "compensation" },
        ],
      },
    },
  ])("denies a $name before compensation persistence or dispatch", async ({ name, plan }) => {
    const store = createStore(":memory:");
    if (plan !== undefined) {
      expect(() => store.prepareOperationRun({
        id: `invalid-plan-${name.replaceAll(" ", "-")}`,
        sessionId: "session",
        workspaceId: "workspace",
        adminUserId: "admin",
        actionName: "test_composed_write",
        actionFingerprint: "action",
        catalogHash: "catalog",
        operationHash: "operation",
        operation: { normalized: true },
        mutationPlan: plan as never,
      })).toThrow("invalid_mutation_plan");
      expect(store.getOperationRun(`invalid-plan-${name.replaceAll(" ", "-")}`)).toBeUndefined();
      store.close();
      return;
    }
    const operationId = store.prepareOperationRun({
      id: `invalid-plan-${name.replaceAll(" ", "-")}`,
      sessionId: "session",
      workspaceId: "workspace",
      adminUserId: "admin",
      actionName: "test_composed_write",
      actionFingerprint: "action",
      catalogHash: "catalog",
      operationHash: "operation",
      operation: { normalized: true },
    });
    store.markOperationExecuting(operationId);
    const sourceId = primary(store, operationId, { id: "source", index: 0, status: "succeeded" });
    primary(store, operationId, { id: "later", index: 1, status: "definitive_failed" });
    let dispatches = 0;

    await expect(compensate(store, operationId, sourceId, async () => {
      dispatches += 1;
      return {};
    })).rejects.toThrow("compensation_not_eligible");

    expect(dispatches).toBe(0);
    expect(store.listOperationSteps(operationId)).toHaveLength(2);
    store.close();
  });

  it("rejects reuse of an already prepared compensation descriptor without another row or dispatch", async () => {
    const store = createStore(":memory:");
    const operationId = operation(store, "duplicate-compensation-plan-step");
    const sourceId = primary(store, operationId, { id: "source", index: 0, status: "succeeded" });
    primary(store, operationId, { id: "later", index: 1, status: "definitive_failed" });
    const first = store.prepareCompensationStep({
      operationId,
      planStepId: "restore-source",
      index: 2,
      name: "Restore source",
      compensatesStepId: sourceId,
    });
    let dispatches = 0;

    await expect(compensate(store, operationId, sourceId, async () => {
      dispatches += 1;
      return {};
    })).rejects.toThrow("compensation_not_eligible");

    expect(first).toEqual(expect.any(String));
    expect(dispatches).toBe(0);
    expect(store.listOperationSteps(operationId)).toHaveLength(3);
    expect(store.listOperationSteps(operationId).filter((step) => step.kind === "compensation")).toHaveLength(1);
    store.close();
  });

  it("applies plan binding to terminal-operation eligibility", async () => {
    const store = createStore(":memory:");
    const operationId = operation(store, "terminal-binding");
    const sourceId = primary(store, operationId, { id: "undeclared-source", index: 0, status: "succeeded" });
    store.settleOperationRun(operationId, "definitive_failed");
    let dispatches = 0;

    await expect(compensate(store, operationId, sourceId, async () => {
      dispatches += 1;
      return {};
    })).rejects.toThrow("compensation_not_eligible");

    expect(dispatches).toBe(0);
    expect(store.listOperationSteps(operationId)).toHaveLength(1);
    store.close();
  });

  it("applies plan binding to authoritative-reconciliation eligibility", async () => {
    const store = createStore(":memory:");
    const operationId = operation(store, "reconciliation-binding");
    const sourceId = primary(store, operationId, { id: "source", index: 0, status: "outcome_unknown" });
    const journal = store.mutationStepJournal(operationId);
    journal.recordReconciliation(sourceId, { matches: 1 }, true);
    journal.settleReconciledStep(sourceId, "succeeded");
    let dispatches = 0;

    await expect(compensate(store, operationId, sourceId, async () => {
      dispatches += 1;
      return {};
    }, { id: "undeclared-compensation", index: 2 })).rejects.toThrow("compensation_not_eligible");

    expect(dispatches).toBe(0);
    expect(store.listOperationSteps(operationId)).toHaveLength(1);
    store.close();
  });

  it.each([
    {
      name: "source",
      sourceFingerprint: "wrong-source-fp",
      laterFingerprint: "later-fp",
      compensationFingerprint: "restore-fp",
    },
    {
      name: "later definitive failure",
      sourceFingerprint: "source-fp",
      laterFingerprint: "wrong-later-fp",
      compensationFingerprint: "restore-fp",
    },
    {
      name: "requested compensation",
      sourceFingerprint: "source-fp",
      laterFingerprint: "later-fp",
      compensationFingerprint: "wrong-restore-fp",
    },
    {
      name: "requested compensation with a missing stored fingerprint",
      sourceFingerprint: "source-fp",
      laterFingerprint: "later-fp",
      compensationFingerprint: undefined,
    },
  ])("denies a $name fingerprint mismatch without a compensation row or dispatch", async ({
    name,
    sourceFingerprint,
    laterFingerprint,
    compensationFingerprint,
  }) => {
    const store = createStore(":memory:");
    const operationId = operation(store, `fingerprint-mismatch-${name.replaceAll(" ", "-")}`, {
      mode: "curated",
      maxHostCalls: 60,
      steps: [
        { id: "source", kind: "primary", targetFingerprint: "source-fp" },
        { id: "later", kind: "primary", targetFingerprint: "later-fp" },
        { id: "restore-source", kind: "compensation", targetFingerprint: "restore-fp" },
      ],
    });
    const sourceId = primary(store, operationId, {
      id: "source",
      index: 0,
      status: "succeeded",
      targetFingerprint: sourceFingerprint,
    });
    primary(store, operationId, {
      id: "later",
      index: 1,
      status: "definitive_failed",
      targetFingerprint: laterFingerprint,
    });
    let dispatches = 0;

    await expect(compensate(store, operationId, sourceId, async () => {
      dispatches += 1;
      return {};
    }, {
      id: "restore-source",
      index: 2,
      ...(compensationFingerprint ? { targetFingerprint: compensationFingerprint } : {}),
    })).rejects.toThrow("compensation_not_eligible");

    expect(dispatches).toBe(0);
    expect(store.listOperationSteps(operationId)).toHaveLength(2);
    expect(store.listOperationSteps(operationId).every((step) => step.kind === "primary")).toBe(true);
    store.close();
  });

  it.each([
    {
      name: "binds exact declared fingerprints",
      plan: {
        mode: "curated" as const,
      maxHostCalls: 60,
        steps: [
          { id: "source", kind: "primary" as const, targetFingerprint: "source-fp" },
          { id: "later", kind: "primary" as const, targetFingerprint: "later-fp" },
          { id: "restore-source", kind: "compensation" as const, targetFingerprint: "restore-fp" },
        ],
      },
      sourceFingerprint: "source-fp",
      laterFingerprint: "later-fp",
      compensationFingerprint: "restore-fp",
    },
    {
      name: "keeps fingerprints optional when descriptors omit them",
      plan: DEFAULT_PLAN,
      sourceFingerprint: "row-only-source-fp",
      laterFingerprint: "row-only-later-fp",
      compensationFingerprint: "row-only-restore-fp",
    },
  ])("$name", async ({ name, plan, sourceFingerprint, laterFingerprint, compensationFingerprint }) => {
    const store = createStore(":memory:");
    const operationId = operation(store, `fingerprint-positive-${name.replaceAll(" ", "-")}`, plan);
    const sourceId = primary(store, operationId, {
      id: "source",
      index: 0,
      status: "succeeded",
      targetFingerprint: sourceFingerprint,
    });
    primary(store, operationId, {
      id: "later",
      index: 1,
      status: "definitive_failed",
      targetFingerprint: laterFingerprint,
    });

    const result = await compensate(store, operationId, sourceId, async () => ({ effect: { restored: true } }), {
      id: "restore-source",
      index: 2,
      targetFingerprint: compensationFingerprint,
    });

    expect(result).toMatchObject({ status: "compensated", targetFingerprint: compensationFingerprint });
    expect(store.listOperationSteps(operationId)).toHaveLength(3);
    store.close();
  });
});
