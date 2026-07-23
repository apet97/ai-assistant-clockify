import { AsyncLocalStorage } from "node:async_hooks";

export type HostRequestKind = "read" | "mutation";

interface HostCallBudget { used: number; maximum: number }
const hostCallBudget = new AsyncLocalStorage<HostCallBudget>();
const hostCallReservation = new AsyncLocalStorage<{ remaining: number }>();

export class HostCallBudgetExceededError extends Error {
  readonly code = "host_call_budget_exceeded";

  constructor(readonly maximum: number, readonly requested: number) {
    super(`Clockify host-call budget exceeded (${maximum} per turn; requested ${requested}).`);
    this.name = "HostCallBudgetExceededError";
  }
}

/** Definitive cancellation while still queued; no external fetch began. */
export class HostRequestCancelledError extends Error {
  readonly code = "host_request_cancelled";

  constructor() {
    super("Clockify request was cancelled before dispatch.");
    this.name = "HostRequestCancelledError";
  }
}

export const HOST_CALL_BUDGET_MAXIMUM = 60;

export function withHostCallBudgetFromUsed<T>(
  operation: () => Promise<T>,
  alreadyUsed: number,
  maximum = HOST_CALL_BUDGET_MAXIMUM,
): Promise<T> {
  if (hostCallBudget.getStore()) return operation();
  const used = Math.max(0, Math.min(maximum, alreadyUsed));
  return hostCallBudget.run({ used, maximum }, operation);
}

export function withHostCallBudget<T>(
  operation: () => Promise<T>,
  maximum = HOST_CALL_BUDGET_MAXIMUM,
): Promise<T> {
  // Route authentication and the action/confirmation helpers it invokes are
  // one physical request budget. A nested helper must never reset that budget
  // (which previously let a cold role lookup sit outside a 60-call mutation).
  return withHostCallBudgetFromUsed(operation, 0, maximum);
}

/** Atomically charge a complete operation before its first mutation. Calls made
 * by that operation consume reserved slots instead of charging the turn twice. */
export function reserveHostCallBudget(count: number): void {
  const budget = hostCallBudget.getStore();
  if (!budget) return;
  if (!Number.isSafeInteger(count) || count < 0 || budget.used + count > budget.maximum) {
    throw new HostCallBudgetExceededError(budget.maximum, count);
  }
  budget.used += count;
}

export function withReservedHostCallBudget<T>(count: number, operation: () => Promise<T>): Promise<T> {
  reserveHostCallBudget(count);
  return hostCallReservation.run({ remaining: count }, operation);
}

/** Claim one physical host-call slot. Queued callers receive a refund closure
 * that is valid only until dispatch; direct callers simply discard it once the
 * fetch boundary is crossed. The operation-local reservation is enforced even
 * when an isolated caller did not install an outer turn budget. */
export function chargeHostCallBudget(): () => void {
  const budget = hostCallBudget.getStore();
  const reservation = hostCallReservation.getStore();
  let charged: "reservation" | "turn" | undefined;
  if (reservation) {
    if (reservation.remaining <= 0) {
      throw new HostCallBudgetExceededError(budget?.maximum ?? HOST_CALL_BUDGET_MAXIMUM, 1);
    }
    reservation.remaining -= 1;
    charged = "reservation";
  } else if (budget) {
    if (budget.used + 1 > budget.maximum) {
      throw new HostCallBudgetExceededError(budget.maximum, 1);
    }
    budget.used += 1;
    charged = "turn";
  }
  return () => {
    if (charged === "reservation" && reservation) reservation.remaining += 1;
    else if (charged === "turn" && budget) budget.used -= 1;
    charged = undefined;
  };
}

export interface WorkspaceRequestGovernor {
  run<T>(
    kind: HostRequestKind,
    operation: () => Promise<T>,
    options?: {
      signal?: AbortSignal;
      /** Runs exactly once after dequeue and immediately before the external operation. */
      onDispatch?: () => void | Promise<void>;
    },
  ): Promise<T>;
  /** Pause new dispatches after a host 429. Existing requests finish normally. */
  noteRateLimited(delayMs: number): void;
}

export interface WorkspaceRequestGovernorOptions {
  requestsPerSecond?: number;
  burst?: number;
  concurrency?: number;
  now?: () => number;
}

interface PendingRequest {
  kind: HostRequestKind;
  dispatch(): void;
}

/**
 * Per-workspace FIFO governor. It stays below Clockify's documented add-on
 * ceiling while also making external writes single-flight. The queue is kept
 * outside the REST adapter so every short-lived workspace client shares it.
 */
export function createWorkspaceRequestGovernor(
  options: WorkspaceRequestGovernorOptions = {},
): WorkspaceRequestGovernor {
  const requestsPerSecond = options.requestsPerSecond ?? 10;
  const burst = options.burst ?? 10;
  const concurrency = options.concurrency ?? 4;
  const now = options.now ?? Date.now;
  if (requestsPerSecond <= 0 || burst <= 0 || concurrency <= 0) {
    throw new Error("Request-governor limits must be positive.");
  }

  const queue: PendingRequest[] = [];
  const starts: number[] = [];
  let active = 0;
  let mutationActive = false;
  let cooldownUntil = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (delayMs: number): void => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      drain();
    }, Math.max(1, delayMs));
    timer.unref?.();
  };

  const pruneStarts = (timestamp: number): void => {
    while (starts.length > 0 && starts[0] <= timestamp - 1_000) starts.shift();
  };

  const drain = (): void => {
    if (queue.length === 0 || active >= concurrency) return;
    const timestamp = now();
    if (timestamp < cooldownUntil) {
      schedule(cooldownUntil - timestamp);
      return;
    }
    pruneStarts(timestamp);
    const rateCap = Math.min(requestsPerSecond, burst);
    if (starts.length >= rateCap) {
      schedule(starts[0] + 1_000 - timestamp);
      return;
    }

    const next = queue[0];
    if (next.kind === "mutation" && mutationActive) return;
    queue.shift();
    active += 1;
    if (next.kind === "mutation") mutationActive = true;
    starts.push(timestamp);
    next.dispatch();
    drain();
  };

  return {
    run<T>(
      kind: HostRequestKind,
      operation: () => Promise<T>,
      options?: { signal?: AbortSignal; onDispatch?: () => void | Promise<void> },
    ): Promise<T> {
      if (options?.signal?.aborted) return Promise.reject(new HostRequestCancelledError());
      let refund: () => void;
      try {
        refund = chargeHostCallBudget();
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      return new Promise<T>((resolve, reject) => {
        let state: "queued" | "pre_dispatch" | "cancelled" | "dispatched" | "settled" = "queued";
        let activeReleased = false;
        let budgetRefunded = false;
        let promiseSettled = false;

        const refundBeforeDispatch = (): void => {
          if (budgetRefunded) return;
          budgetRefunded = true;
          refund();
        };
        const rejectOnce = (error: unknown): void => {
          if (promiseSettled) return;
          promiseSettled = true;
          reject(error instanceof Error ? error : new Error(String(error)));
        };
        const releaseActive = (): void => {
          if (activeReleased) return;
          activeReleased = true;
          active -= 1;
          if (kind === "mutation") mutationActive = false;
          drain();
        };
        const cancelBeforeDispatch = (): void => {
          if (state !== "queued" && state !== "pre_dispatch") return;
          const wasQueued = state === "queued";
          state = "cancelled";
          if (wasQueued) {
            const index = queue.indexOf(pending);
            if (index >= 0) queue.splice(index, 1);
          }
          options?.signal?.removeEventListener("abort", onAbort);
          refundBeforeDispatch();
          rejectOnce(new HostRequestCancelledError());
          // An asynchronous pre-dispatch gate may never settle. Release its
          // active/mutation slot immediately on cancellation; the eventual hook
          // callbacks are state-aware and releaseActive is idempotent.
          if (wasQueued) drain();
          else releaseActive();
        };
        const failBeforeDispatch = (error: unknown): void => {
          if (state === "cancelled") {
            releaseActive();
            return;
          }
          state = "settled";
          options?.signal?.removeEventListener("abort", onAbort);
          refundBeforeDispatch();
          rejectOnce(error instanceof Error ? error : new Error(String(error)));
          releaseActive();
        };
        const startExternalOperation = (): void => {
          if (state === "cancelled") {
            releaseActive();
            return;
          }
          if (options?.signal?.aborted) {
            cancelBeforeDispatch();
            releaseActive();
            return;
          }
          state = "dispatched";
          options?.signal?.removeEventListener("abort", onAbort);
          let dispatched: Promise<T>;
          try {
            // Invoke synchronously at the boundary. REST persists dispatched_at
            // and calls fetch before this stack unwinds, so cancellation can
            // never observe a journaled dispatch whose fetch has not started.
            dispatched = operation();
          } catch (error) {
            state = "settled";
            rejectOnce(error);
            releaseActive();
            return;
          }
          void Promise.resolve(dispatched)
            .then(
              (value) => {
                state = "settled";
                if (!promiseSettled) {
                  promiseSettled = true;
                  resolve(value);
                }
              },
              (error: unknown) => {
                state = "settled";
                rejectOnce(error);
              },
            )
            .finally(releaseActive);
        };
        const pending: PendingRequest = {
          kind,
          dispatch() {
            state = "pre_dispatch";
            let hookResult: void | Promise<void>;
            try {
              hookResult = options?.onDispatch?.();
            } catch (error) {
              failBeforeDispatch(error);
              return;
            }
            // Preserve the synchronous boundary: once a synchronous dispatch
            // hook returns and the signal is still live, cancellation no longer
            // suppresses the external operation. An asynchronous authorization
            // hook remains definitively cancellable until it resolves.
            if (hookResult && typeof (hookResult as PromiseLike<void>).then === "function") {
              void Promise.resolve(hookResult).then(startExternalOperation, failBeforeDispatch);
            } else {
              startExternalOperation();
            }
          },
        };
        const onAbort = (): void => {
          cancelBeforeDispatch();
        };
        queue.push(pending);
        options?.signal?.addEventListener("abort", onAbort, { once: true });
        // Close the add-listener race when a signal aborts between the initial
        // check and queue insertion.
        if (options?.signal?.aborted) onAbort();
        drain();
      });
    },

    noteRateLimited(delayMs) {
      cooldownUntil = Math.max(cooldownUntil, now() + Math.max(0, delayMs));
      if (queue.length > 0) schedule(cooldownUntil - now());
    },
  };
}
