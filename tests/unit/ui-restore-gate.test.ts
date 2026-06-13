import { describe, expect, it } from "vitest";
import { createRestoreGate } from "../../src/ui/shared.js";

/**
 * r1-new-session-restore-04: on a slow history fetch (cold dyno), a message
 * typed DURING the restore round-trip must not jump ahead of the replayed
 * conversation. The restore gate makes a live send WAIT until restore settles
 * (resolves OR rejects — best-effort restore must never wedge the composer),
 * so the DOM/log order is always [restored history…, new user turn].
 */
describe("createRestoreGate (live sends wait for restore to settle)", () => {
  it("blocks a send started before restore settles, releasing it after settle()", async () => {
    const gate = createRestoreGate();
    const log: string[] = [];

    // A live send begins while restore is still in flight.
    const send = gate.waitUntilSettled().then(() => log.push("live-send"));

    // Restore appends its replayed history, THEN opens the gate.
    log.push("restored-history");
    gate.settle();

    await send;
    expect(log).toEqual(["restored-history", "live-send"]);
  });

  it("a send started AFTER settle proceeds immediately (no permanent block)", async () => {
    const gate = createRestoreGate();
    gate.settle();
    await expect(gate.waitUntilSettled()).resolves.toBeUndefined();
  });

  it("settle() is idempotent — a second settle never re-blocks or throws", async () => {
    const gate = createRestoreGate();
    gate.settle();
    gate.settle();
    await expect(gate.waitUntilSettled()).resolves.toBeUndefined();
  });

  it("a restore FAILURE still settles the gate (the composer is never wedged)", async () => {
    const gate = createRestoreGate();
    const log: string[] = [];
    const send = gate.waitUntilSettled().then(() => log.push("live-send"));
    // restoreHistory's catch path must still settle so the composer stays usable.
    log.push("restore-failed");
    gate.settle();
    await send;
    expect(log).toEqual(["restore-failed", "live-send"]);
  });
});
