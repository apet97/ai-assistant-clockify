import { describe, expect, it, vi } from "vitest";
import * as coreModule from "../../src/clockify/rest/core.js";
import { createRestCore, PAGE_SIZE, withMutationPlanStep } from "../../src/clockify/rest/core.js";
import {
  createWorkspaceRequestGovernor,
  HostCallBudgetExceededError,
  withHostCallBudget,
} from "../../src/clockify/request-governor.js";
import { createStore } from "../../src/db/store.js";
import type { ExternalMutationPlan } from "../../src/harness/mutation-contract.js";
import { executeCompensationStep, executeMutationWorkflow, executeStep } from "../../src/harness/mutation-workflow.js";
import { errorReceipt, successReceipt, type ErrorReceipt } from "../../src/harness/receipts.js";

type ScopeInput<T = unknown> = {
  actionName: string;
  plan: ExternalMutationPlan;
  authorizeDispatch?(step: { id: string; kind: "primary" | "compensation" }):
    Promise<ErrorReceipt | undefined> | ErrorReceipt | undefined | void;
  onDispatch?(step: { id: string; kind: "primary" | "compensation" }): Promise<void> | void;
  compensationEligible?(stepId: string): boolean;
  authoritativelyReconciled?(stepId: string): boolean;
  requiresComplete?(result: T): boolean;
};
type WithMutationPlanScope = <T>(input: ScopeInput<T>, run: () => Promise<T>) => Promise<T>;

function scopeFunction(): WithMutationPlanScope {
  const fn = (coreModule as unknown as { withMutationPlanScope?: WithMutationPlanScope }).withMutationPlanScope;
  expect(fn).toBeTypeOf("function");
  return fn!;
}

function rest(fetchImpl: typeof fetch) {
  return createRestCore({
    apiBase: "https://api.clockify.me/api/v1",
    auth: { addonToken: "secret" },
    fetchImpl,
    enforceMutationScope: true,
  });
}

function successfulReceiptRequiresComplete(result: unknown): boolean {
  return typeof result === "object" && result !== null &&
    (result as { ok?: unknown }).ok === true;
}

function twoStepOperation(store: ReturnType<typeof createStore>, plan: ExternalMutationPlan): string {
  const operationId = store.prepareOperationRun({
    id: `operation-${Math.random()}`,
    sessionId: "session",
    workspaceId: "workspace",
    adminUserId: "admin",
    actionName: "clockify_test_curated",
    actionFingerprint: "action",
    catalogHash: "catalog",
    operationHash: "operation",
    operation: { normalized: true },
    mutationPlan: plan,
  });
  store.markOperationExecuting(operationId);
  return operationId;
}

function callbacks(action = "clockify_test_curated") {
  return {
    onSuccess: () => successReceipt({ action, entity: "test" }),
    onPartial: () => ({
      kind: "partial" as const,
      receipt: successReceipt({ action, entity: "test" }),
      message: "A later authorized step was blocked.",
      recovery: { hint: "Inspect the retained first change.", retryable: false },
    }),
    onJournalDegraded: () => { throw new Error("unexpected degraded journal"); },
    onFailure: () => errorReceipt({ action, code: "write_failed", message: "No change was applied." }),
  };
}

describe("Phase 6 exact external mutation scope", () => {
  it("rejects a legacy persisted plan with no bound host-call reservation", async () => {
    let ran = false;
    await expect(coreModule.withMutationPlanScope({
      actionName: "clockify_test",
      plan: { mode: "single", steps: [{ id: "write", kind: "primary" }] },
    } as unknown as Parameters<typeof coreModule.withMutationPlanScope>[0], async () => {
      ran = true;
    })).rejects.toThrow("mutation_plan_host_call_budget_required");
    expect(ran).toBe(false);
  });

  it("rejects a completed primary step whose callback dispatched no physical mutation", async () => {
    const plan: ExternalMutationPlan = {
      mode: "single",
      maxHostCalls: 1,
      steps: [{ id: "write", kind: "primary" }],
    };

    await expect(scopeFunction()({
      actionName: "clockify_test",
      plan,
      requiresComplete: successfulReceiptRequiresComplete,
    }, () => withMutationPlanStep(
      { id: "write", index: 0, kind: "primary" },
      async () => ({ ok: true }),
    ))).rejects.toThrow("mutation_step_incomplete_dispatch:write");
  });

  it("does not retry a pre-dispatch GET inside a reserved mutation operation", async () => {
    const governor = createWorkspaceRequestGovernor({ requestsPerSecond: 100, burst: 100, concurrency: 4 });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('{"message":"temporary"}', { status: 503 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const core = createRestCore({
      apiBase: "https://api.clockify.me/api/v1",
      auth: { addonToken: "secret" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      requestGovernor: governor,
      enforceMutationScope: true,
    });

    await expect(withHostCallBudget(() => coreModule.withMutationPlanScope({
      actionName: "clockify_test",
      plan: { mode: "single", maxHostCalls: 1, steps: [{ id: "write", kind: "primary" }] },
    }, () => core.call("api", "GET", "/workspaces/ws/users"))))
      .rejects.toThrow(/503/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("bounds a mutation-scope pagination read to one call and reports truncation", async () => {
    const governor = createWorkspaceRequestGovernor({ requestsPerSecond: 100, burst: 100, concurrency: 4 });
    const fullPage = Array.from({ length: PAGE_SIZE }, (_, index) => ({ id: `row-${index}` }));
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(fullPage), { status: 200 }));
    const core = createRestCore({
      apiBase: "https://api.clockify.me/api/v1",
      auth: { addonToken: "secret" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      requestGovernor: governor,
      enforceMutationScope: true,
    });

    const result = await withHostCallBudget(() => coreModule.withMutationPlanScope({
      actionName: "clockify_test",
      plan: { mode: "single", maxHostCalls: 1, steps: [{ id: "write", kind: "primary" }] },
    }, () => core.paginate("api", "/workspaces/ws/users")));
    expect(result).toEqual({ rows: fullPage, truncated: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("enforces the reserved physical-call ceiling without a queue governor", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const core = createRestCore({
      apiBase: "https://api.clockify.me/api/v1",
      auth: { addonToken: "secret" },
      fetchImpl,
      enforceMutationScope: true,
    });

    await expect(coreModule.withMutationPlanScope({
      actionName: "clockify_test",
      plan: { mode: "single", maxHostCalls: 1, steps: [{ id: "write", kind: "primary" }] },
    }, async () => {
      await core.call("api", "GET", "/workspaces/ws/users/first");
      await core.call("api", "GET", "/workspaces/ws/users/second");
    })).rejects.toBeInstanceOf(HostCallBudgetExceededError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps a typed exhausted-budget denial pre-dispatch instead of wrapping it as ambiguous", async () => {
    let calls = 0;
    const core = rest(async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    });
    const plan: ExternalMutationPlan = {
      mode: "single",
      maxHostCalls: 2,
      steps: [{ id: "write", kind: "primary" }],
    };

    await expect(withHostCallBudget(() => scopeFunction()({ actionName: "clockify_test", plan }, async () => {
      await withMutationPlanStep(
        { id: "write", index: 0, kind: "primary" },
        () => core.mutate("api", "POST", "/write"),
      );
    }), 1)).rejects.toBeInstanceOf(HostCallBudgetExceededError);
    expect(calls).toBe(0);
  });

  it("cancels a governor-queued durable write definitively before fetch and preserves queue evidence", async () => {
    const governor = createWorkspaceRequestGovernor({ requestsPerSecond: 100, burst: 100, concurrency: 1 });
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const blocker = governor.run("mutation", async () => {
      firstStarted();
      await firstGate;
    });
    await started;

    const controller = new AbortController();
    let fetchCalls = 0;
    const core = createRestCore({
      apiBase: "https://api.clockify.me/api/v1",
      auth: { addonToken: "secret" },
      requestGovernor: governor,
      signal: controller.signal,
      enforceMutationScope: true,
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response("{}", { status: 200 });
      },
    });
    const plan: ExternalMutationPlan = { mode: "single", maxHostCalls: 60, steps: [{ id: "write", kind: "primary" }] };
    const store = createStore(":memory:");
    const operationId = twoStepOperation(store, plan);
    const journal = store.mutationStepJournal(operationId);

    const queued = scopeFunction()({
      actionName: "clockify_test",
      plan,
      onDispatch: (step) => {
        const row = journal.listOperationSteps().find((candidate) => candidate.planStepId === step.id);
        if (!row || !journal.markOperationStepDispatched(row.id)) throw new Error("dispatch_journal_failed");
      },
    }, () => executeStep({
      journal,
      operationId,
      step: { id: "write", index: 0, name: "Write", kind: "primary" },
      dispatch: async () => {
        await core.mutate("api", "POST", "/write");
        return {};
      },
    }));
    await vi.waitFor(() => expect(journal.listOperationSteps()[0]).toMatchObject({ status: "executing" }));
    controller.abort();
    releaseFirst();

    const cancelled = await queued;
    expect(cancelled).toMatchObject({
      status: "definitive_failed",
      queuedAt: expect.any(String),
      detail: { code: "host_request_cancelled" },
    });
    expect(cancelled).not.toHaveProperty("dispatchedAt");
    expect(fetchCalls).toBe(0);
    await blocker;
    store.close();
  });

  it("starts fetch in the same boundary that persists dispatched_at", async () => {
    const governor = createWorkspaceRequestGovernor({ requestsPerSecond: 100, burst: 100, concurrency: 1 });
    const controller = new AbortController();
    let journaled!: () => void;
    const journalBoundary = new Promise<void>((resolve) => { journaled = resolve; });
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => { releaseFetch = resolve; });
    let fetchCalls = 0;
    const core = createRestCore({
      apiBase: "https://api.clockify.me/api/v1",
      auth: { addonToken: "secret" },
      requestGovernor: governor,
      signal: controller.signal,
      enforceMutationScope: true,
      fetchImpl: async () => {
        fetchCalls += 1;
        await fetchGate;
        return new Response("{}", { status: 200 });
      },
    });
    const plan: ExternalMutationPlan = { mode: "single", maxHostCalls: 1, steps: [{ id: "write", kind: "primary" }] };
    const store = createStore(":memory:");
    const operationId = twoStepOperation(store, plan);
    const journal = store.mutationStepJournal(operationId);

    const result = scopeFunction()({
      actionName: "clockify_test",
      plan,
      onDispatch: (step) => {
        const row = journal.listOperationSteps().find((candidate) => candidate.planStepId === step.id);
        if (!row || !journal.markOperationStepDispatched(row.id)) throw new Error("dispatch_journal_failed");
        journaled();
      },
    }, () => executeStep({
      journal,
      operationId,
      step: { id: "write", index: 0, name: "Write", kind: "primary" },
      dispatch: async () => {
        await core.mutate("api", "POST", "/write");
        return {};
      },
    }));

    await journalBoundary;
    controller.abort();
    expect(fetchCalls).toBe(1);
    releaseFetch();
    await expect(result).resolves.toMatchObject({ status: "succeeded", dispatchedAt: expect.any(String) });
    store.close();
  });

  it("rejects an unscoped mutation before the network", async () => {
    let calls = 0;
    const core = rest(async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    });

    await expect(core.mutate("api", "POST", "/workspaces/ws/tags", { name: "x" }))
      .rejects.toThrow("mutation_scope_required");
    expect(calls).toBe(0);
  });

  it("rejects repeated and excess host calls within one declared step", async () => {
    let calls = 0;
    const core = rest(async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    });
    const plan: ExternalMutationPlan = { mode: "single", maxHostCalls: 60, steps: [{ id: "create-tag", kind: "primary" }] };
    const store = createStore(":memory:");
    const operationId = twoStepOperation(store, plan);

    const result = await scopeFunction()({ actionName: "clockify_tags_create", plan }, () => executeMutationWorkflow({
      journal: store.mutationStepJournal(operationId),
      operationId,
      actionName: "clockify_tags_create",
      steps: [{
        id: "create-tag", index: 0, name: "Create tag", kind: "primary",
        dispatch: async () => {
          await core.mutate("api", "POST", "/workspaces/ws/tags", { name: "x" });
          await core.mutate("api", "POST", "/workspaces/ws/tags", { name: "y" });
          return {};
        },
      }],
      ...callbacks("clockify_tags_create"),
    }));

    expect(result).toMatchObject({ ok: false, code: "mutation_plan_violation" });
    expect(calls).toBe(1);
    store.close();
  });

  it("rejects out-of-order and undeclared steps before the network", async () => {
    let calls = 0;
    const core = rest(async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    });
    const plan: ExternalMutationPlan = {
      mode: "curated",
      maxHostCalls: 60,
      steps: [{ id: "first", kind: "primary" }, { id: "second", kind: "primary" }],
    };
    const store = createStore(":memory:");
    const operationId = twoStepOperation(store, plan);

    const result = await scopeFunction()({ actionName: "clockify_test_curated", plan }, () => executeMutationWorkflow({
      journal: store.mutationStepJournal(operationId),
      operationId,
      actionName: "clockify_test_curated",
      steps: [{
        id: "second", index: 1, name: "Second", kind: "primary",
        dispatch: async () => { await core.mutate("api", "POST", "/second"); return {}; },
      }],
      ...callbacks(),
    }));

    expect(result).toMatchObject({ ok: false, code: "mutation_plan_violation" });
    expect(calls).toBe(0);
    store.close();
  });

  it("dispatches an exact curated plan once and in declared order", async () => {
    const paths: string[] = [];
    const core = rest(async (request) => {
      paths.push(typeof request === "string" ? request : request instanceof URL ? request.href : request.url);
      return new Response("{}", { status: 200 });
    });
    const plan: ExternalMutationPlan = {
      mode: "curated",
      maxHostCalls: 60,
      steps: [{ id: "base", kind: "primary" }, { id: "enrich", kind: "primary" }],
    };
    const store = createStore(":memory:");
    const operationId = twoStepOperation(store, plan);
    const result = await scopeFunction()({ actionName: "clockify_test_curated", plan }, () => executeMutationWorkflow({
      journal: store.mutationStepJournal(operationId), operationId, actionName: "clockify_test_curated",
      steps: plan.steps.map((step, index) => ({
        ...step, index, name: step.id,
        dispatch: async () => { await core.mutate("api", "POST", `/${step.id}`); return {}; },
      })),
      ...callbacks(),
    }));

    expect(result).toMatchObject({ ok: true });
    expect(paths.map((path) => new URL(path).pathname)).toEqual(["/api/v1/base", "/api/v1/enrich"]);
    store.close();
  });

  it("rejects a successful result when a later persisted primary remains pending", async () => {
    let calls = 0;
    const core = rest(async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    });
    const plan: ExternalMutationPlan = {
      mode: "curated",
      maxHostCalls: 60,
      steps: [{ id: "first", kind: "primary" }, { id: "second", kind: "primary" }],
    };

    await expect(scopeFunction()({
      actionName: "clockify_test_curated",
      plan,
      requiresComplete: successfulReceiptRequiresComplete,
    }, async () => {
      await withMutationPlanStep(
        { id: "first", index: 0, kind: "primary" },
        () => core.mutate("api", "POST", "/first"),
      );
      return successReceipt({ action: "clockify_test_curated", entity: "test" });
    })).rejects.toThrow("mutation_plan_incomplete:second");

    expect(calls).toBe(1);
  });

  it("accepts a successful result only after every persisted primary completes", async () => {
    const paths: string[] = [];
    const core = rest(async (request) => {
      paths.push(new URL(typeof request === "string" ? request : request instanceof URL ? request.href : request.url).pathname);
      return new Response("{}", { status: 200 });
    });
    const plan: ExternalMutationPlan = {
      mode: "curated",
      maxHostCalls: 60,
      steps: [{ id: "first", kind: "primary" }, { id: "second", kind: "primary" }],
    };

    const result = await scopeFunction()({
      actionName: "clockify_test_curated",
      plan,
      requiresComplete: successfulReceiptRequiresComplete,
    }, async () => {
      for (const [index, step] of plan.steps.entries()) {
        await withMutationPlanStep(
          { ...step, index },
          () => core.mutate("api", "POST", `/${step.id}`),
        );
      }
      return successReceipt({ action: "clockify_test_curated", entity: "test" });
    });

    expect(result).toMatchObject({ ok: true });
    expect(paths).toEqual(["/api/v1/first", "/api/v1/second"]);
  });

  it("accepts a successful result after an ambiguous dispatch is authoritatively reconciled", async () => {
    let calls = 0;
    const core = rest(async () => {
      calls += 1;
      throw new TypeError("socket closed after apply");
    });
    const plan: ExternalMutationPlan = {
      mode: "single",
      maxHostCalls: 60,
      steps: [{ id: "write", kind: "primary" }],
    };

    const result = await scopeFunction()({
      actionName: "clockify_test",
      plan,
      requiresComplete: successfulReceiptRequiresComplete,
      authoritativelyReconciled: (stepId) => stepId === "write",
    }, async () => {
      try {
        await withMutationPlanStep(
          { id: "write", index: 0, kind: "primary" },
          () => core.mutate("api", "POST", "/write"),
        );
      } catch {
        // The durable workflow performs a complete read-only reconciliation and
        // settles this exact unknown step before it reports success.
      }
      return successReceipt({ action: "clockify_test", entity: "test" });
    });

    expect(result).toMatchObject({ ok: true });
    expect(calls).toBe(1);
  });

  it("does not let authoritative reconciliation override dispatch denial or a plan violation", async () => {
    const plan: ExternalMutationPlan = {
      mode: "single",
      maxHostCalls: 60,
      steps: [{ id: "write", kind: "primary" }],
    };
    let deniedCalls = 0;
    const deniedCore = rest(async () => {
      deniedCalls += 1;
      return new Response("{}", { status: 200 });
    });

    await expect(scopeFunction()({
      actionName: "clockify_test",
      plan,
      requiresComplete: successfulReceiptRequiresComplete,
      authoritativelyReconciled: () => true,
      authorizeDispatch: () => errorReceipt({
        action: "clockify_test",
        code: "admin_required",
        message: "Admin access was removed.",
      }),
    }, async () => {
      try {
        await withMutationPlanStep(
          { id: "write", index: 0, kind: "primary" },
          () => deniedCore.mutate("api", "POST", "/write"),
        );
      } catch {
        // A hostile workflow cannot turn a denied dispatch into success.
      }
      return successReceipt({ action: "clockify_test", entity: "test" });
    })).rejects.toThrow("mutation_plan_incomplete:write");
    expect(deniedCalls).toBe(0);

    let calls = 0;
    const core = rest(async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    });
    await expect(scopeFunction()({
      actionName: "clockify_test",
      plan,
      requiresComplete: successfulReceiptRequiresComplete,
      authoritativelyReconciled: () => true,
    }, async () => {
      try {
        await withMutationPlanStep(
          { id: "write", index: 0, kind: "primary" },
          async () => {
            await core.mutate("api", "POST", "/write");
            await core.mutate("api", "POST", "/excess");
          },
        );
      } catch {
        // A hostile workflow cannot turn an excess dispatch into success.
      }
      return successReceipt({ action: "clockify_test", entity: "test" });
    })).rejects.toThrow("mutation_plan_incomplete:write");
    expect(calls).toBe(1);
  });

  it("preserves truthful non-success and partial results with later primaries pending", async () => {
    const cases: unknown[] = [
      errorReceipt({ action: "clockify_test_curated", code: "write_failed", message: "Rejected." }),
      callbacks().onPartial(),
      { kind: "definitive_failed", summary: { code: "write_failed" } },
      { kind: "outcome_unknown", summary: { code: "commit_outcome_unknown" } },
    ];
    let calls = 0;
    const core = rest(async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    });
    const plan: ExternalMutationPlan = {
      mode: "curated",
      maxHostCalls: 60,
      steps: [{ id: "first", kind: "primary" }, { id: "second", kind: "primary" }],
    };

    for (const expected of cases) {
      const result = await scopeFunction()({
        actionName: "clockify_test_curated",
        plan,
        requiresComplete: successfulReceiptRequiresComplete,
      }, async () => {
        await withMutationPlanStep(
          { id: "first", index: 0, kind: "primary" },
          () => core.mutate("api", "POST", "/first"),
        );
        return expected;
      });
      expect(result).toBe(expected);
    }

    expect(calls).toBe(cases.length);
  });

  it("does not require an unused compensation descriptor for successful completion", async () => {
    let calls = 0;
    const core = rest(async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    });
    const plan: ExternalMutationPlan = {
      mode: "curated",
      maxHostCalls: 60,
      steps: [{ id: "create", kind: "primary" }, { id: "undo-create", kind: "compensation" }],
    };

    const result = await scopeFunction()({
      actionName: "clockify_test_curated",
      plan,
      requiresComplete: successfulReceiptRequiresComplete,
      compensationEligible: () => false,
    }, async () => {
      await withMutationPlanStep(
        { id: "create", index: 0, kind: "primary" },
        () => core.mutate("api", "POST", "/create"),
      );
      return successReceipt({ action: "clockify_test_curated", entity: "test" });
    });

    expect(result).toMatchObject({ ok: true });
    expect(calls).toBe(1);
  });

  it("rechecks role before every primary dispatch and returns partial after mid-plan demotion", async () => {
    let calls = 0;
    const checked: string[] = [];
    const core = rest(async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    });
    const plan: ExternalMutationPlan = {
      mode: "curated",
      maxHostCalls: 60,
      steps: [{ id: "first", kind: "primary" }, { id: "second", kind: "primary" }],
    };
    const store = createStore(":memory:");
    const operationId = twoStepOperation(store, plan);
    const result = await scopeFunction()({
      actionName: "clockify_test_curated",
      plan,
      async authorizeDispatch(step) {
        checked.push(step.id);
        return step.id === "second"
          ? errorReceipt({ action: "clockify_test_curated", code: "admin_required", message: "Admin access was removed." })
          : undefined;
      },
    }, () => executeMutationWorkflow({
      journal: store.mutationStepJournal(operationId), operationId, actionName: "clockify_test_curated",
      steps: plan.steps.map((step, index) => ({
        ...step, index, name: step.id,
        dispatch: async () => { await core.mutate("api", "POST", `/${step.id}`); return {}; },
      })),
      ...callbacks(),
    }));

    expect(checked).toEqual(["first", "second"]);
    expect(calls).toBe(1);
    expect(result).toMatchObject({ kind: "partial", receipt: { ok: true } });
    store.close();
  });

  it("fails closed before the first dispatch when role verification is unavailable", async () => {
    let calls = 0;
    const core = rest(async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    });
    const plan: ExternalMutationPlan = { mode: "single", maxHostCalls: 60, steps: [{ id: "write", kind: "primary" }] };
    const store = createStore(":memory:");
    const operationId = twoStepOperation(store, plan);
    const result = await scopeFunction()({
      actionName: "clockify_test",
      plan,
      authorizeDispatch: async () => errorReceipt({
        action: "clockify_test",
        code: "role_verification_unavailable",
        message: "Role verification failed.",
      }),
    }, () => executeMutationWorkflow({
      journal: store.mutationStepJournal(operationId), operationId, actionName: "clockify_test",
      steps: [{ id: "write", index: 0, name: "Write", kind: "primary", dispatch: async () => {
        await core.mutate("api", "POST", "/write"); return {};
      } }],
      ...callbacks("clockify_test"),
    }));

    expect(calls).toBe(0);
    expect(result).toMatchObject({ ok: false, code: "role_verification_unavailable" });
    store.close();
  });

  it("poisons the scope when a caught first-step denial tries to continue to a later primary", async () => {
    let calls = 0;
    const checked: string[] = [];
    const core = rest(async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    });
    const plan: ExternalMutationPlan = {
      mode: "curated",
      maxHostCalls: 60,
      steps: [{ id: "first", kind: "primary" }, { id: "second", kind: "primary" }],
    };

    await scopeFunction()({
      actionName: "clockify_test_curated",
      plan,
      authorizeDispatch(step) {
        checked.push(step.id);
        return step.id === "first"
          ? errorReceipt({ action: "clockify_test_curated", code: "admin_required", message: "Demoted." })
          : undefined;
      },
    }, async () => {
      try {
        await withMutationPlanStep(
          { id: "first", index: 0, kind: "primary" },
          () => core.mutate("api", "POST", "/first"),
        );
      } catch {
        // Adversarial workflow swallows the denial and attempts to continue.
      }
      await expect(withMutationPlanStep(
        { id: "second", index: 1, kind: "primary" },
        () => core.mutate("api", "POST", "/second"),
      )).rejects.toThrow("mutation_scope_poisoned");
    });

    expect(checked).toEqual(["first"]);
    expect(calls).toBe(0);
  });

  it("poisons the scope after a caught invalid primary descriptor", async () => {
    let calls = 0;
    const core = rest(async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    });
    const plan: ExternalMutationPlan = {
      mode: "curated",
      maxHostCalls: 60,
      steps: [{ id: "first", kind: "primary" }, { id: "second", kind: "primary" }],
    };

    await scopeFunction()({ actionName: "clockify_test_curated", plan }, async () => {
      try {
        await withMutationPlanStep(
          { id: "invented", index: 0, kind: "primary" },
          () => core.mutate("api", "POST", "/invented"),
        );
      } catch {
        // Adversarial workflow retries with a real descriptor after probing one.
      }
      await expect(withMutationPlanStep(
        { id: "first", index: 0, kind: "primary" },
        () => core.mutate("api", "POST", "/first"),
      )).rejects.toThrow("mutation_scope_poisoned");
    });

    expect(calls).toBe(0);
  });

  it("does not let a compensation descriptor dispatch without durable eligibility", async () => {
    let calls = 0;
    const core = rest(async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    });
    const plan: ExternalMutationPlan = {
      mode: "curated",
      maxHostCalls: 60,
      steps: [{ id: "create", kind: "primary" }, { id: "undo-create", kind: "compensation" }],
    };
    let status: "compensating" | "compensation_failed" = "compensating";
    const now = new Date().toISOString();
    const journal = {
      operationId: "operation",
      getOperationStatus: () => "partial" as const,
      prepareOperationStep: () => "unused",
      markOperationStepExecuting: () => false,
      markOperationStepDispatched: () => false,
      cancelOperationStepBeforeDispatch: () => false,
      settleOperationStep: () => undefined,
      settleOperationStepDegraded: () => undefined,
      settleReconciledStep: () => undefined,
      prepareCompensationStep: () => "compensation",
      markOperationStepCompensating: () => true,
      settleCompensationStep: (_id: string, next: "compensated" | "compensation_failed" | "outcome_unknown") => {
        status = next === "compensated" ? "compensating" : "compensation_failed";
      },
      settleCompensationStepDegraded: () => undefined,
      listOperationSteps: () => [{
        id: "compensation", operationId: "operation", planStepId: "undo-create", index: 1,
        name: "Undo", kind: "compensation" as const, status, compensatesStepId: "source",
        createdAt: now, updatedAt: now,
      }],
      recordReconciliation: () => undefined,
    };

    const result = await scopeFunction()({
      actionName: "clockify_test",
      plan,
      compensationEligible: () => false,
    }, () => executeCompensationStep({
      journal,
      operationId: "operation",
      step: { id: "undo-create", index: 1, name: "Undo", kind: "compensation", compensatesStepId: "source" },
      dispatch: async () => { await core.mutate("api", "DELETE", "/created"); return {}; },
    }));

    expect(calls).toBe(0);
    expect(result.status).toBe("compensation_failed");
  });

  it("orders compensation after a failed primary and rechecks role before its dispatch", async () => {
    const checked: string[] = [];
    const paths: string[] = [];
    let primaryFailed = false;
    const core = rest(async (request) => {
      const path = new URL(typeof request === "string" ? request : request instanceof URL ? request.href : request.url).pathname;
      paths.push(path);
      return path.endsWith("/create")
        ? new Response("rejected", { status: 400 })
        : new Response("{}", { status: 200 });
    });
    const plan: ExternalMutationPlan = {
      mode: "curated",
      maxHostCalls: 60,
      steps: [{ id: "create", kind: "primary" }, { id: "undo-create", kind: "compensation" }],
    };

    await scopeFunction()({
      actionName: "clockify_test_curated",
      plan,
      authorizeDispatch(step) { checked.push(step.id); },
      compensationEligible: () => primaryFailed,
    }, async () => {
      await expect(withMutationPlanStep(
        { id: "undo-create", index: 1, kind: "compensation" },
        () => core.mutate("api", "DELETE", "/undo-create"),
      )).rejects.toThrow("mutation_step_out_of_order");
      await expect(withMutationPlanStep(
        { id: "create", index: 0, kind: "primary" },
        () => core.mutate("api", "POST", "/create"),
      )).rejects.toThrow();
      primaryFailed = true;
      await withMutationPlanStep(
        { id: "undo-create", index: 1, kind: "compensation" },
        () => core.mutate("api", "DELETE", "/undo-create"),
      );
    });

    expect(checked).toEqual(["create", "undo-create"]);
    expect(paths).toEqual(["/api/v1/create", "/api/v1/undo-create"]);
  });
});
