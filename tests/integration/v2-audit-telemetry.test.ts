import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import request from "supertest";
import {
  composeV2ProductionApp,
  discoverThenCall,
} from "../helpers/v2-production-composition.js";

/**
 * Closure-plan PR 9 (F13): canonical results drive exactly-once audit and
 * telemetry — v2 activity is visible in the established action-outcome
 * metrics, replay duplicates nothing, and every invocation records one
 * telemetry row from the persisted run budget.
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

describe("v2 audit + telemetry (F13)", () => {
  it("a read turn writes exactly one audit outcome and one telemetry row; replay adds nothing", async () => {
    const c = await composeV2ProductionApp({
      script: discoverThenCall("list time entries", { name: "clockify_entries_list", arguments: {} }),
      seed: ONE_ENTRY,
    });
    const requestId = randomUUID();
    await c.chat("what did I track?", { requestId });

    const outcomes = c.store.listActionOutcomes(c.workspaceId, c.adminUserId);
    const entryReads = outcomes.filter((o) => o.actionName === "clockify_entries_list");
    expect(entryReads).toHaveLength(1);
    const telemetry = c.store.listTurnTelemetry(c.workspaceId, c.adminUserId);
    expect(telemetry).toHaveLength(1);
    expect(telemetry[0]!.kind).toBe("chat");
    expect(telemetry[0]!.modelCalls).toBe(3);

    // Request-id replay re-serves the stored envelope — no new audit, no new
    // telemetry, no re-execution.
    await c.chat("what did I track?", { requestId });
    expect(c.store.listActionOutcomes(c.workspaceId, c.adminUserId)
      .filter((o) => o.actionName === "clockify_entries_list")).toHaveLength(1);
    expect(c.store.listTurnTelemetry(c.workspaceId, c.adminUserId)).toHaveLength(1);
  });

  it("a confirmed write audits exactly once at settlement, and settlement replay adds nothing", async () => {
    const c = await composeV2ProductionApp({
      script: discoverThenCall("create a project", {
        name: "clockify_projects_create",
        arguments: { name: "Audit Probe" },
      }),
    });
    await c.chat("create a project called Audit Probe");
    const runId = c.activeRunId();
    const events = await c.readEvents(runId);
    const control = events.find((e) =>
      (e.attachment as { kind?: string } | undefined)?.kind === "pending_confirmation")!
      .attachment as { envelope: { confirmation: { id: string; nonce: string } } };

    const confirmed = await request(c.app)
      .post(`/api/confirmations/${control.envelope.confirmation.id}/confirm`)
      .set("Cookie", c.cookie)
      .send({ nonce: control.envelope.confirmation.nonce });
    expect(confirmed.status).toBe(200);

    const writes = c.store.listActionOutcomes(c.workspaceId, c.adminUserId)
      .filter((o) => o.actionName === "clockify_projects_create");
    expect(writes).toHaveLength(1);

    // A settlement replay is a no-op — audit stays exactly-once.
    const record = c.store.getPendingConfirmation(control.envelope.confirmation.id)!;
    const replay = c.store.settleV2ConfirmationRun({ record, kind: "confirmed" });
    expect(replay.settled).toBe(false);
    expect(c.store.listActionOutcomes(c.workspaceId, c.adminUserId)
      .filter((o) => o.actionName === "clockify_projects_create")).toHaveLength(1);
  });

  it("a cancelled preview audits its no-mutation result once", async () => {
    const c = await composeV2ProductionApp({
      script: discoverThenCall("create a project", {
        name: "clockify_projects_create",
        arguments: { name: "Cancel Audit" },
      }),
    });
    await c.chat("create a project called Cancel Audit");
    const runId = c.activeRunId();
    const events = await c.readEvents(runId);
    const control = events.find((e) =>
      (e.attachment as { kind?: string } | undefined)?.kind === "pending_confirmation")!
      .attachment as { envelope: { confirmation: { id: string } } };

    await request(c.app)
      .post(`/api/confirmations/${control.envelope.confirmation.id}/cancel`)
      .set("Cookie", c.cookie)
      .send({});

    const audited = c.store.listActionOutcomes(c.workspaceId, c.adminUserId)
      .filter((o) => o.actionName === "clockify_projects_create");
    expect(audited).toHaveLength(1);
  });
});
