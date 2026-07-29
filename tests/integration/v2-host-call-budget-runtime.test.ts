import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { computeRequestHash } from "../../src/assistant-v2/state.js";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import {
  HostCallBudgetExceededError,
  withRunScopedHostCallBudget,
} from "../../src/clockify/request-governor.js";
import {
  composeV2ProductionApp,
  discoverThenCall,
} from "../helpers/v2-production-composition.js";

/**
 * Closure-plan PR 6 (F04): ONE persisted run-scoped host-call ledger. Every
 * physical call charges `used + reserved < 60` atomically at the pre-dispatch
 * boundary; the charge survives restart; call 61 is denied BEFORE dispatch.
 * (The review proved 120 physical calls with `hostCallsUsed: 0` — this suite
 * pins the reversal.)
 */

const ONE_ENTRY = {
  entries: [
    {
      id: "e1",
      description: "spec work",
      start: "2026-07-25T09:00:00Z",
      end: "2026-07-25T10:00:00Z",
      billable: true,
    },
  ] as never,
};

function seedRun(c: Awaited<ReturnType<typeof composeV2ProductionApp>>): string {
  const runId = randomUUID();
  c.store.startRunWithEvent({
    scope: c.getRunScope(runId),
    originalRequest: "budget probe",
    requestHash: computeRequestHash("budget probe"),
    catalogHash: MODEL_API_ACTION_CATALOG.hash(),
    loadedToolNames: [],
    intentHash: runId,
  });
  return runId;
}

describe("v2 durable host-call ledger (F04)", () => {
  it("charges are conditional and exact: 60 succeed, 61 is refused", async () => {
    const c = await composeV2ProductionApp({});
    const runId = seedRun(c);
    const scope = c.getRunScope(runId);

    for (let call = 1; call <= 60; call += 1) {
      expect(c.store.chargeRunHostCall(scope), `call ${call}`).toBe(true);
    }
    expect(c.store.chargeRunHostCall(scope)).toBe(false);
    expect(c.store.getRun(scope)?.budget.hostCallsUsed).toBe(60);

    // A durable refund reopens exactly one slot.
    c.store.refundRunHostCall(scope);
    expect(c.store.chargeRunHostCall(scope)).toBe(true);
    expect(c.store.chargeRunHostCall(scope)).toBe(false);
  });

  it("a real read turn PERSISTS its physical host calls in the run budget", async () => {
    const c = await composeV2ProductionApp({
      script: discoverThenCall("list time entries", { name: "clockify_entries_list", arguments: {} }),
      seed: ONE_ENTRY,
    });
    const res = await c.chat("what did I track?");
    expect(res.status).toBe(200);

    const run = c.store.getRun(c.getRunScope(c.latestRunId()));
    // The review's smoking gun was hostCallsUsed: 0 after 120 physical calls.
    expect(run?.budget.hostCallsUsed).toBeGreaterThanOrEqual(1);
  });

  it("denies the next physical call BEFORE dispatch once the ledger is exhausted", async () => {
    const c = await composeV2ProductionApp({ seed: ONE_ENTRY });
    const runId = seedRun(c);
    const scope = c.getRunScope(runId);
    // Exhaust all but one slot.
    for (let call = 1; call <= 59; call += 1) c.store.chargeRunHostCall(scope);

    const callsBefore = c.clockifyCalls();
    await expect(withRunScopedHostCallBudget(async () => {
      await c.workspace.client.listTags();
      // Slot 60 was consumed above; this SECOND fake call must be refused
      // before it reaches the client.
      await c.workspace.client.listClients();
    }, {
      charge: () => c.store.chargeRunHostCall(scope),
      refund: () => c.store.refundRunHostCall(scope),
    })).rejects.toThrow(HostCallBudgetExceededError);

    // Exactly ONE call reached the fake; the denied one never dispatched.
    expect(c.clockifyCalls()).toBe(callsBefore + 1);
    expect(c.store.getRun(scope)?.budget.hostCallsUsed).toBe(60);
  });

  it("a confirmed write CONVERTS its reservation to used calls at dispatch", async () => {
    const c = await composeV2ProductionApp({
      script: discoverThenCall("create a project", {
        name: "clockify_projects_create",
        arguments: { name: "Ledger Probe" },
      }),
    });
    await c.chat("create a project called Ledger Probe");
    const runId = c.activeRunId();
    const suspended = c.store.getRun(c.getRunScope(runId))!;
    expect(suspended.budget.hostCallsReserved).toBeGreaterThanOrEqual(1);

    const events = await c.readEvents(runId);
    const control = events.find((e) =>
      (e.attachment as { kind?: string } | undefined)?.kind === "pending_confirmation")!
      .attachment as { envelope: { confirmation: { id: string; nonce: string } } };
    const confirmed = await request(c.app)
      .post(`/api/confirmations/${control.envelope.confirmation.id}/confirm`)
      .set("Cookie", c.cookie)
      .send({ nonce: control.envelope.confirmation.nonce });
    expect(confirmed.status).toBe(200);

    const terminal = c.store.getRun(c.getRunScope(runId))!;
    expect(terminal.phase).toBe("completed");
    // The dispatch converted reservation to USED; settlement released the rest.
    expect(terminal.budget.hostCallsUsed).toBeGreaterThanOrEqual(1);
    expect(terminal.budget.hostCallsReserved).toBe(0);
  });

  it("the persisted ledger survives a process restart", async () => {
    const c = await composeV2ProductionApp({
      script: discoverThenCall("list time entries", { name: "clockify_entries_list", arguments: {} }),
      seed: ONE_ENTRY,
      fileBacked: true,
    });
    await c.chat("what did I track?");
    const runId = c.latestRunId();
    const usedBefore = c.store.getRun(c.getRunScope(runId))!.budget.hostCallsUsed;
    expect(usedBefore).toBeGreaterThanOrEqual(1);

    const reopened = c.reopenStore();
    expect(reopened.getRun(c.getRunScope(runId))?.budget.hostCallsUsed).toBe(usedBefore);
  });
});
