import { describe, expect, it } from "vitest";
import {
  WorkspaceMutationRevokedError,
  createWorkspaceMutationCoordinator,
} from "../../src/clockify/workspace-mutation-coordinator.js";

describe("WorkspaceMutationCoordinator", () => {
  it("ignores an older verified lifecycle event that finishes after a newer arrival", async () => {
    const coordinator = createWorkspaceMutationCoordinator();
    const applied: string[] = [];

    await coordinator.runLifecycle("ws-1", async () => {
      applied.push("newer");
    }, { sequence: 2, stale: () => { applied.push("newer-stale"); } });
    await coordinator.runLifecycle("ws-1", async () => {
      applied.push("older");
    }, { sequence: 1, stale: () => { applied.push("older-stale"); } });

    expect(applied).toEqual(["newer", "older-stale"]);
  });

  it("serializes lifecycle state transitions for one workspace", async () => {
    const coordinator = createWorkspaceMutationCoordinator();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const order: string[] = [];

    const first = coordinator.runLifecycle("ws-1", async () => {
      order.push("first:start");
      markFirstStarted();
      await firstGate;
      order.push("first:end");
    });
    const second = coordinator.runLifecycle("ws-1", async () => {
      order.push("second:start");
      order.push("second:end");
    });

    await firstStarted;
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("aborts queued leases immediately, then waits for already-started work to settle", async () => {
    const coordinator = createWorkspaceMutationCoordinator();
    coordinator.activate("ws-1", 1);

    const first = coordinator.acquire("ws-1", 1);
    const second = coordinator.acquire("ws-1", 1);
    expect(first.signal.aborted).toBe(false);
    expect(second.signal.aborted).toBe(false);

    const drained = coordinator.blockAndDrain("ws-1");
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);

    let finished = false;
    void drained.then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);

    first.release();
    await Promise.resolve();
    expect(finished).toBe(false);
    second.release();
    await drained;
    expect(finished).toBe(true);
  });

  it("rejects new and stale-generation work until a newer installation is activated", () => {
    const coordinator = createWorkspaceMutationCoordinator();
    coordinator.activate("ws-1", 3);
    coordinator.block("ws-1");

    expect(() => coordinator.acquire("ws-1", 3)).toThrow(WorkspaceMutationRevokedError);
    expect(() => coordinator.activate("ws-1", 3)).toThrow(WorkspaceMutationRevokedError);

    coordinator.activate("ws-1", 4);
    expect(() => coordinator.acquire("ws-1", 3)).toThrow(WorkspaceMutationRevokedError);
    const current = coordinator.acquire("ws-1", 4);
    expect(current.signal.aborted).toBe(false);
    current.release();
  });

  it("combines caller cancellation with lifecycle revocation without leaking listeners", () => {
    const coordinator = createWorkspaceMutationCoordinator();
    coordinator.activate("ws-1", 1);
    const caller = new AbortController();
    const lease = coordinator.acquire("ws-1", 1, caller.signal);

    caller.abort(new Error("client disconnected"));
    expect(lease.signal.aborted).toBe(true);
    lease.release();
    lease.release(); // idempotent settlement
  });

  it("treats a duplicate ACTIVE event for the same generation as an idempotent no-op", () => {
    const coordinator = createWorkspaceMutationCoordinator();
    coordinator.activate("ws-1", 7);
    const lease = coordinator.acquire("ws-1", 7);

    coordinator.activate("ws-1", 7);

    expect(lease.signal.aborted).toBe(false);
    lease.release();
  });

  it("does not let a newer installation generation extend the old generation's drain", async () => {
    const coordinator = createWorkspaceMutationCoordinator();
    coordinator.activate("ws-1", 1);
    const oldGeneration = coordinator.acquire("ws-1", 1);

    const drained = coordinator.blockAndDrain("ws-1");
    coordinator.activate("ws-1", 2);
    const newGeneration = coordinator.acquire("ws-1", 2);

    let oldDrainFinished = false;
    void drained.then(() => { oldDrainFinished = true; });
    oldGeneration.release();
    await Promise.resolve();

    expect(oldDrainFinished).toBe(true);
    expect(newGeneration.signal.aborted).toBe(false);
    newGeneration.release();
  });

  it("serializes duplicate deletion owners and blocks activation until durable cleanup finishes", async () => {
    const coordinator = createWorkspaceMutationCoordinator();
    coordinator.activate("ws-1", 5);
    const inFlight = coordinator.acquire("ws-1", 5);

    const deletion = coordinator.beginDeletion("ws-1");
    const duplicate = coordinator.beginDeletion("ws-1");
    expect(deletion.owner).toBe(true);
    expect(duplicate.owner).toBe(false);
    expect(() => coordinator.activate("ws-1", 6)).toThrow(WorkspaceMutationRevokedError);

    let activationUnblocked = false;
    void coordinator.waitForDeletion("ws-1")?.then(() => { activationUnblocked = true; });
    inFlight.release();
    await deletion.drained;
    await Promise.resolve();
    expect(activationUnblocked).toBe(false);

    deletion.finish();
    await duplicate.completed;
    expect(activationUnblocked).toBe(true);
    coordinator.activate("ws-1", 6);
    const fresh = coordinator.acquire("ws-1", 6);
    expect(fresh.signal.aborted).toBe(false);
    fresh.release();
  });

  it("drains dispatched leases from superseded generations before uninstall completes", async () => {
    const coordinator = createWorkspaceMutationCoordinator();
    coordinator.activate("ws-1", 1);
    const supersededInFlight = coordinator.acquire("ws-1", 1);
    coordinator.activate("ws-1", 2);
    const currentInFlight = coordinator.acquire("ws-1", 2);

    const deletion = coordinator.beginDeletion("ws-1");
    let drained = false;
    void deletion.drained.then(() => { drained = true; });

    currentInFlight.release();
    await Promise.resolve();
    expect(drained).toBe(false);

    supersededInFlight.release();
    await deletion.drained;
    expect(drained).toBe(true);
    deletion.finish();
    await deletion.completed;
  });
});
