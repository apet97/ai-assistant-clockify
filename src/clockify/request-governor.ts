import { AsyncLocalStorage } from "node:async_hooks";

export type HostRequestKind = "read" | "mutation";

interface HostCallBudget { used: number; maximum: number }
const hostCallBudget = new AsyncLocalStorage<HostCallBudget>();

export function withHostCallBudget<T>(operation: () => Promise<T>, maximum = 60): Promise<T> {
  return hostCallBudget.run({ used: 0, maximum }, operation);
}

export interface WorkspaceRequestGovernor {
  run<T>(kind: HostRequestKind, operation: () => Promise<T>): Promise<T>;
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
    run<T>(kind: HostRequestKind, operation: () => Promise<T>): Promise<T> {
      const budget = hostCallBudget.getStore();
      if (budget) {
        budget.used += 1;
        if (budget.used > budget.maximum) {
          return Promise.reject(new Error(`Clockify host-call budget exceeded (${budget.maximum} per turn).`));
        }
      }
      return new Promise<T>((resolve, reject) => {
        queue.push({
          kind,
          dispatch() {
            void operation().then(resolve, reject).finally(() => {
              active -= 1;
              if (kind === "mutation") mutationActive = false;
              drain();
            });
          },
        });
        drain();
      });
    },

    noteRateLimited(delayMs) {
      cooldownUntil = Math.max(cooldownUntil, now() + Math.max(0, delayMs));
      if (queue.length > 0) schedule(cooldownUntil - now());
    },
  };
}
