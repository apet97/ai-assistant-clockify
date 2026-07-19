/**
 * Process-local settlement barrier for one Clockify workspace.
 *
 * The persistent installation row remains the source of truth. This coordinator
 * supplies the missing concurrency primitive: lifecycle revocation synchronously
 * aborts work that has not dispatched yet, while uninstall can await every action
 * that may already have crossed the host boundary before erasing its journal.
 */

export class WorkspaceMutationRevokedError extends Error {
  constructor(
    readonly workspaceId: string,
    readonly expectedGeneration: number,
    message = "The Clockify installation changed before this mutation could run.",
  ) {
    super(message);
    this.name = "WorkspaceMutationRevokedError";
  }
}

export interface WorkspaceMutationLease {
  /** Aborts only not-yet-dispatched work. REST deliberately ignores it after dispatch. */
  signal: AbortSignal;
  /** Idempotently marks the action settled so uninstall may finish erasure. */
  release(): void;
}

export interface WorkspaceDeletionLease {
  /** Only the owner persists the tombstone and erases workspace data. */
  owner: boolean;
  /** Resolves once every lease from the revoked generation has settled. */
  drained: Promise<void>;
  /** Resolves after the owner has completed (or abandoned) durable cleanup. */
  completed: Promise<void>;
  /** Idempotently releases the lifecycle barrier after durable cleanup. */
  finish(): void;
}

export interface WorkspaceMutationCoordinator {
  /** Serialize lifecycle persistence for one workspace, closing install/delete
   * check-then-act gaps while allowing unrelated workspaces to proceed. */
  runLifecycle<T>(
    workspaceId: string,
    operation: () => Promise<T>,
    ordering?: {
      /** Process-local request-arrival sequence captured before token verification. */
      sequence: number;
      /** Idempotent response for a verified event superseded by a newer arrival. */
      stale: () => Promise<T> | T;
    },
  ): Promise<T>;
  activate(workspaceId: string, generation: number): void;
  /** Observe one installation generation without joining the mutation-settlement
   * drain. Lifecycle revocation aborts the returned signal immediately, while an
   * uncooperative provider can still be rejected by the caller's durable gate. */
  observe(workspaceId: string, generation: number, callerSignal?: AbortSignal): AbortSignal;
  acquire(workspaceId: string, generation: number, callerSignal?: AbortSignal): WorkspaceMutationLease;
  block(workspaceId: string): void;
  blockAndDrain(workspaceId: string): Promise<void>;
  beginDeletion(workspaceId: string): WorkspaceDeletionLease;
  /** Undefined is an intentional synchronous fast path with no await gap. */
  waitForDeletion(workspaceId: string): Promise<void> | undefined;
}

interface WorkspaceState {
  generation: number;
  blocked: boolean;
  revocation: AbortController;
  leases: Set<number>;
  drainWaiters: Set<() => void>;
  nextLease: number;
}

function activeState(generation: number): WorkspaceState {
  return {
    generation,
    blocked: false,
    revocation: new AbortController(),
    leases: new Set(),
    drainWaiters: new Set(),
    nextLease: 1,
  };
}

export function createWorkspaceMutationCoordinator(): WorkspaceMutationCoordinator {
  const states = new Map<string, WorkspaceState>();
  const retiredStates = new Map<string, Set<WorkspaceState>>();
  const deletions = new Map<string, {
    drained: Promise<void>;
    completed: Promise<void>;
    resolveCompleted: () => void;
  }>();
  const lifecycleTails = new Map<string, Promise<void>>();
  const latestLifecycleSequences = new Map<string, number>();

  const reject = (workspaceId: string, generation: number): never => {
    throw new WorkspaceMutationRevokedError(workspaceId, generation);
  };

  const resolveDrain = (state: WorkspaceState): void => {
    if (state.leases.size !== 0) return;
    for (const resolve of state.drainWaiters) resolve();
    state.drainWaiters.clear();
  };

  const stateDrain = (state: WorkspaceState): Promise<void> => {
    if (state.leases.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => state.drainWaiters.add(resolve));
  };

  const workspaceDrain = (workspaceId: string): Promise<void> => {
    const current = states.get(workspaceId);
    const epochs = [
      ...(current ? [current] : []),
      ...(retiredStates.get(workspaceId) ?? []),
    ];
    if (epochs.length === 0) return Promise.resolve();
    if (epochs.length === 1) return stateDrain(epochs[0]!);
    return Promise.all(epochs.map(stateDrain)).then(() => undefined);
  };

  const block = (workspaceId: string): void => {
    const state = states.get(workspaceId);
    if (!state) {
      const blocked = activeState(0);
      blocked.blocked = true;
      blocked.revocation.abort(new WorkspaceMutationRevokedError(workspaceId, 0));
      states.set(workspaceId, blocked);
      return;
    }
    state.blocked = true;
    if (!state.revocation.signal.aborted) {
      state.revocation.abort(new WorkspaceMutationRevokedError(workspaceId, state.generation));
    }
    resolveDrain(state);
  };

  return {
    runLifecycle<T>(
      workspaceId: string,
      operation: () => Promise<T>,
      ordering?: { sequence: number; stale: () => Promise<T> | T },
    ): Promise<T> {
      if (ordering && (!Number.isSafeInteger(ordering.sequence) || ordering.sequence < 1)) {
        return Promise.reject(new Error("invalid_lifecycle_request_sequence"));
      }
      const previous = lifecycleTails.get(workspaceId) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => { release = resolve; });
      const tail = previous.catch(() => undefined).then(() => current);
      lifecycleTails.set(workspaceId, tail);
      return previous
        .catch(() => undefined)
        .then(async () => {
          if (ordering) {
            const latest = latestLifecycleSequences.get(workspaceId) ?? 0;
            if (ordering.sequence < latest) return ordering.stale();
            latestLifecycleSequences.set(workspaceId, ordering.sequence);
          }
          return operation();
        })
        .finally(() => {
          release();
          void tail.finally(() => {
            if (lifecycleTails.get(workspaceId) === tail) lifecycleTails.delete(workspaceId);
          });
        });
    },

    activate(workspaceId, generation) {
      if (!Number.isSafeInteger(generation) || generation < 1) {
        throw new Error("Installation generation must be a positive safe integer.");
      }
      if (deletions.has(workspaceId)) {
        return reject(workspaceId, generation);
      }
      const current = states.get(workspaceId);
      if (current && generation < current.generation) {
        throw new Error("Installation generation cannot move backwards.");
      }
      if (!current) {
        states.set(workspaceId, activeState(generation));
        return;
      }
      if (generation === current.generation && !current.blocked) return;
      if (generation === current.generation) return reject(workspaceId, generation);
      // Reinstall/token rotation revokes queued work from the old generation,
      // but an already-dispatched lease remains counted until truthful settlement.
      if (!current.revocation.signal.aborted) {
        current.revocation.abort(new WorkspaceMutationRevokedError(workspaceId, current.generation));
      }
      // A generation owns an independent settlement epoch. Do not mutate the
      // old state in place: its already-dispatched leases and drain waiters must
      // settle independently, while fresh work belongs only to the new install.
      // Retain the old state explicitly so a later uninstall also waits for a
      // write dispatched before token replacement. It is dropped as soon as its
      // final lease truthfully settles.
      if (current.leases.size > 0) {
        const retired = retiredStates.get(workspaceId) ?? new Set<WorkspaceState>();
        retired.add(current);
        retiredStates.set(workspaceId, retired);
      }
      states.set(workspaceId, activeState(generation));
    },

    observe(workspaceId, generation, callerSignal) {
      let state = states.get(workspaceId);
      // Like mutation acquisition, a process restarted with an already-active
      // installation seeds its in-memory generation lazily from durable state.
      if (!state) {
        state = activeState(generation);
        states.set(workspaceId, state);
      }
      if (state.blocked || state.generation !== generation) {
        return reject(workspaceId, generation);
      }
      return callerSignal
        ? AbortSignal.any([callerSignal, state.revocation.signal])
        : state.revocation.signal;
    },

    acquire(workspaceId, generation, callerSignal) {
      let state = states.get(workspaceId);
      // Existing active installations are loaded lazily after a process restart;
      // the persisted generation supplied by the caller seeds the process state.
      if (!state) {
        state = activeState(generation);
        states.set(workspaceId, state);
      }
      if (state.blocked || state.generation !== generation) {
        return reject(workspaceId, generation);
      }
      const leaseId = state.nextLease++;
      state.leases.add(leaseId);
      const signal = callerSignal
        ? AbortSignal.any([callerSignal, state.revocation.signal])
        : state.revocation.signal;
      let released = false;
      return {
        signal,
        release() {
          if (released) return;
          released = true;
          state.leases.delete(leaseId);
          resolveDrain(state);
          if (state.leases.size === 0 && states.get(workspaceId) !== state) {
            const retired = retiredStates.get(workspaceId);
            retired?.delete(state);
            if (retired?.size === 0) retiredStates.delete(workspaceId);
          }
        },
      };
    },

    block,

    blockAndDrain(workspaceId) {
      block(workspaceId);
      return workspaceDrain(workspaceId);
    },

    beginDeletion(workspaceId) {
      const existing = deletions.get(workspaceId);
      if (existing) {
        return {
          owner: false,
          drained: existing.drained,
          completed: existing.completed,
          finish() {},
        };
      }
      block(workspaceId);
      const drained = workspaceDrain(workspaceId);
      let resolveCompleted!: () => void;
      const completed = new Promise<void>((resolve) => { resolveCompleted = resolve; });
      const deletion = { drained, completed, resolveCompleted };
      deletions.set(workspaceId, deletion);
      let finished = false;
      return {
        owner: true,
        drained,
        completed,
        finish() {
          if (finished) return;
          finished = true;
          // Never reopen activation while an old-generation lease can still be
          // settling, even if a caller exits its deletion path exceptionally.
          void drained.then(() => {
            if (deletions.get(workspaceId) === deletion) deletions.delete(workspaceId);
            resolveCompleted();
          });
        },
      };
    },

    waitForDeletion(workspaceId) {
      return deletions.get(workspaceId)?.completed;
    },
  };
}
