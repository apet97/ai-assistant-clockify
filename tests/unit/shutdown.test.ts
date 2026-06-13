import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createShutdownHandler } from "../../src/server.js";

/**
 * Railway sends SIGTERM on every redeploy, then SIGKILL after a grace period.
 * The handler must drain (server.close), close the store, and exit 0 — with an
 * unref'd force-exit so an in-flight 120s model call can't outlive the grace.
 * Pure fakes only: no sockets, no signals, injected exit.
 */
function makeDeps(opts: { drainCompletes?: boolean } = {}) {
  const order: string[] = [];
  const deps = {
    server: {
      closeIdleConnections: vi.fn(() => order.push("closeIdle")),
      close: vi.fn((cb: (err?: Error) => void) => {
        order.push("close");
        if (opts.drainCompletes !== false) queueMicrotask(() => cb());
      }),
    },
    store: { close: vi.fn(() => order.push("storeClose")) },
    pruneTimer: setInterval(() => {}, 1_000_000),
    exit: vi.fn((code: number) => order.push(`exit(${code})`)),
    log: vi.fn(),
    forceExitAfterMs: 10_000,
  };
  return { deps, order };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createShutdownHandler", () => {
  it("drains, closes the store, exits 0 — in order — and clears the prune timer", async () => {
    const { deps, order } = makeDeps();
    const shutdown = createShutdownHandler(deps);
    shutdown("SIGTERM");
    await vi.runAllTimersAsync();
    expect(order).toEqual(["closeIdle", "close", "storeClose", "exit(0)"]);
    clearInterval(deps.pruneTimer);
  });

  it("force-exits 1 (closing the store) when the drain hangs past the deadline", async () => {
    const { deps, order } = makeDeps({ drainCompletes: false });
    const shutdown = createShutdownHandler(deps);
    shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(10_001);
    expect(order).toContain("storeClose");
    expect(order).toContain("exit(1)");
    expect(order).not.toContain("exit(0)");
    clearInterval(deps.pruneTimer);
  });

  it("is idempotent: a second signal is a no-op", async () => {
    const { deps } = makeDeps();
    const shutdown = createShutdownHandler(deps);
    shutdown("SIGTERM");
    shutdown("SIGINT");
    await vi.runAllTimersAsync();
    expect(deps.server.close).toHaveBeenCalledTimes(1);
    expect(deps.store.close).toHaveBeenCalledTimes(1);
    clearInterval(deps.pruneTimer);
  });

  it("a store.close throw on the force path still exits 1", async () => {
    const { deps } = makeDeps({ drainCompletes: false });
    deps.store.close.mockImplementation(() => {
      throw new Error("db busy");
    });
    const shutdown = createShutdownHandler(deps);
    shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(10_001);
    expect(deps.exit).toHaveBeenCalledWith(1);
    clearInterval(deps.pruneTimer);
  });

  it("a store.close throw on the clean-drain path still exits (no hang)", async () => {
    const { deps } = makeDeps({ drainCompletes: true });
    deps.store.close.mockImplementation(() => {
      throw new Error("db busy");
    });
    const shutdown = createShutdownHandler(deps);
    shutdown("SIGTERM");
    await vi.runAllTimersAsync();
    expect(deps.exit).toHaveBeenCalled();
    clearInterval(deps.pruneTimer);
  });
});
