import { describe, expect, it, vi } from "vitest";
import {
  createWorkspaceRequestGovernor,
  HostRequestCancelledError,
  HostCallBudgetExceededError,
  reserveHostCallBudget,
  withHostCallBudget,
  withReservedHostCallBudget,
} from "../../src/clockify/request-governor.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

describe("workspace request governor", () => {
  it("limits total host concurrency and serializes mutations", async () => {
    const governor = createWorkspaceRequestGovernor({ requestsPerSecond: 100, burst: 100, concurrency: 2 });
    let active = 0;
    let maxActive = 0;
    let activeWrites = 0;
    let maxActiveWrites = 0;
    const gates = Array.from({ length: 4 }, deferred);
    const started = Array.from({ length: 4 }, deferred);
    const run = (index: number, kind: "read" | "mutation") => governor.run(kind, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (kind === "mutation") {
        activeWrites += 1;
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      }
      started[index].resolve();
      await gates[index].promise;
      active -= 1;
      if (kind === "mutation") activeWrites -= 1;
      return index;
    });

    const tasks = [run(0, "mutation"), run(1, "mutation"), run(2, "read"), run(3, "read")];
    await started[0].promise;
    expect(active).toBe(1);
    gates[0].resolve();
    await Promise.all([started[1].promise, started[2].promise]);
    expect(active).toBe(2);
    gates[1].resolve();
    gates[2].resolve();
    gates[3].resolve();
    await expect(Promise.all(tasks)).resolves.toEqual([0, 1, 2, 3]);
    expect(maxActive).toBe(2);
    expect(maxActiveWrites).toBe(1);
  });

  it("enforces a turn-scoped host-call ceiling", async () => {
    const governor = createWorkspaceRequestGovernor({ requestsPerSecond: 100, burst: 100, concurrency: 4 });
    await expect(withHostCallBudget(
      () => Promise.all(Array.from({ length: 4 }, () => governor.run("read", async () => "ok"))),
      3,
    )).rejects.toThrow("host-call budget exceeded");
  });

  it("keeps one outer request budget across nested route and commit helpers", async () => {
    const governor = createWorkspaceRequestGovernor({ requestsPerSecond: 100, burst: 100, concurrency: 4 });
    const dispatched: string[] = [];

    await withHostCallBudget(async () => {
      await governor.run("read", async () => { dispatched.push("route-auth"); });
      await expect(withHostCallBudget(async () => {
        await governor.run("read", async () => { dispatched.push("commit-role"); });
        await governor.run("mutation", async () => { dispatched.push("mutation"); });
      }, 99)).rejects.toBeInstanceOf(HostCallBudgetExceededError);
    }, 2);

    expect(dispatched).toEqual(["route-auth", "commit-role"]);
  });

  it("atomically reserves a complete batch before interleaved work can partially dispatch it", async () => {
    const governor = createWorkspaceRequestGovernor({ requestsPerSecond: 100, burst: 100, concurrency: 4 });
    let mutations = 0;

    await withHostCallBudget(async () => {
      await governor.run("read", async () => "used by earlier planning");
      expect(() => reserveHostCallBudget(3)).toThrow(HostCallBudgetExceededError);
      await expect(governor.run("mutation", async () => { mutations += 1; }))
        .resolves.toBeUndefined();
    }, 3);

    expect(mutations).toBe(1);
  });

  it("keeps reserved slots scoped to their own async branch", async () => {
    const governor = createWorkspaceRequestGovernor({ requestsPerSecond: 100, burst: 100, concurrency: 4 });
    const gate = deferred();
    const calls: string[] = [];

    await withHostCallBudget(async () => {
      const reserved = withReservedHostCallBudget(2, async () => {
        await gate.promise;
        await governor.run("read", async () => { calls.push("reserved-1"); });
        await governor.run("mutation", async () => { calls.push("reserved-2"); });
      });
      await governor.run("read", async () => { calls.push("unrelated"); });
      gate.resolve();
      await reserved;
    }, 3);

    expect(calls).toEqual(["unrelated", "reserved-1", "reserved-2"]);
  });

  it("never borrows unreserved turn slots after an operation exhausts its bound", async () => {
    const governor = createWorkspaceRequestGovernor({ requestsPerSecond: 100, burst: 100, concurrency: 4 });
    const dispatched: string[] = [];

    await withHostCallBudget(async () => {
      await expect(withReservedHostCallBudget(1, async () => {
        await governor.run("read", async () => { dispatched.push("within-bound"); });
        await governor.run("mutation", async () => { dispatched.push("past-bound"); });
      })).rejects.toBeInstanceOf(HostCallBudgetExceededError);
    }, 10);

    expect(dispatched).toEqual(["within-bound"]);
  });

  it("definitively cancels a queued write and never invokes its dispatch hook or operation", async () => {
    const governor = createWorkspaceRequestGovernor({ requestsPerSecond: 100, burst: 100, concurrency: 2 });
    const firstGate = deferred();
    const firstStarted = deferred();
    const events: string[] = [];
    const first = governor.run("mutation", async () => {
      firstStarted.resolve();
      await firstGate.promise;
    });
    await firstStarted.promise;

    const controller = new AbortController();
    const queued = governor.run(
      "mutation",
      async () => { events.push("operation"); },
      { signal: controller.signal, onDispatch: () => { events.push("dispatch"); } },
    );
    controller.abort();

    await expect(queued).rejects.toBeInstanceOf(HostRequestCancelledError);
    expect(events).toEqual([]);
    firstGate.resolve();
    await first;
  });

  it("definitively cancels while asynchronous pre-dispatch authorization is still pending", async () => {
    const governor = createWorkspaceRequestGovernor({ requestsPerSecond: 100, burst: 100, concurrency: 1 });
    const preDispatchStarted = deferred();
    const releasePreDispatch = deferred();
    const controller = new AbortController();
    let operationCalls = 0;

    const result = governor.run(
      "mutation",
      async () => {
        operationCalls += 1;
        return "must-not-run";
      },
      {
        signal: controller.signal,
        onDispatch: async () => {
          preDispatchStarted.resolve();
          await releasePreDispatch.promise;
        },
      },
    );

    await preDispatchStarted.promise;
    controller.abort();
    releasePreDispatch.resolve();

    await expect(result).rejects.toBeInstanceOf(HostRequestCancelledError);
    expect(operationCalls).toBe(0);
  });

  it("releases workspace capacity when a cancelled pre-dispatch hook never settles", async () => {
    const governor = createWorkspaceRequestGovernor({ requestsPerSecond: 100, burst: 100, concurrency: 1 });
    const preDispatchStarted = deferred();
    const controller = new AbortController();
    const neverSettles = new Promise<void>(() => undefined);

    const cancelled = governor.run(
      "mutation",
      async () => "must-not-run",
      {
        signal: controller.signal,
        onDispatch: async () => {
          preDispatchStarted.resolve();
          await neverSettles;
        },
      },
    );
    await preDispatchStarted.promise;
    controller.abort();
    await expect(cancelled).rejects.toBeInstanceOf(HostRequestCancelledError);

    let nextStarted = false;
    const next = governor.run("mutation", async () => {
      nextStarted = true;
      return "settled";
    });
    // Dispatch is synchronous once capacity exists; no timer or race is needed.
    expect(nextStarted).toBe(true);
    await expect(next).resolves.toBe("settled");
  });

  it("fires onDispatch at the exact boundary and ignores cancellation after dispatch starts", async () => {
    const governor = createWorkspaceRequestGovernor({ requestsPerSecond: 100, burst: 100, concurrency: 1 });
    const operationGate = deferred();
    const dispatched = deferred();
    const controller = new AbortController();
    const events: string[] = [];
    const result = governor.run(
      "mutation",
      async () => {
        events.push("operation");
        await operationGate.promise;
        return "settled";
      },
      {
        signal: controller.signal,
        onDispatch: () => {
          events.push("dispatch");
          dispatched.resolve();
        },
      },
    );
    await dispatched.promise;
    controller.abort();
    operationGate.resolve();
    await expect(result).resolves.toBe("settled");
    expect(events).toEqual(["dispatch", "operation"]);
  });

  it("holds a queued request until the explicit 429 cooldown expires", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      const governor = createWorkspaceRequestGovernor({
        requestsPerSecond: 100,
        burst: 100,
        concurrency: 1,
      });
      const dispatched = deferred();
      let dispatchCount = 0;

      governor.noteRateLimited(250);
      const result = governor.run(
        "read",
        async () => "settled",
        {
          onDispatch: () => {
            dispatchCount += 1;
            dispatched.resolve();
          },
        },
      );

      expect(dispatchCount).toBe(0);
      await vi.advanceTimersByTimeAsync(249);
      expect(dispatchCount).toBe(0);

      await vi.advanceTimersByTimeAsync(1);
      await dispatched.promise;
      expect(dispatchCount).toBe(1);
      await expect(result).resolves.toBe("settled");
    } finally {
      vi.useRealTimers();
    }
  });
});
