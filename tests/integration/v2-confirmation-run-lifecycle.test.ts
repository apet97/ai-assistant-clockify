import { describe, expect, it } from "vitest";
import request from "supertest";
import {
  composeV2ProductionApp,
  discoverThenCall,
  V2_COMPOSITION_NOW,
} from "../helpers/v2-production-composition.js";

/**
 * Closure-plan PR 4 (F02): confirming, cancelling, or letting a v2 preview
 * expire SETTLES the assistant run — the operation lifecycle events exist
 * exactly once, the receipt is linked, and the session's next ordinary
 * message always succeeds. The chat can never be permanently blocked.
 */

const PREVIEW_SCRIPT = [
  ...discoverThenCall("create a project", {
    name: "clockify_projects_create",
    arguments: { name: "Lifecycle Probe" },
  }),
];

async function streamedControl(c: Awaited<ReturnType<typeof composeV2ProductionApp>>, runId: string) {
  const res = await request(c.app)
    .get(`/api/runs/${runId}/events`)
    .query({ after: 0 })
    .set("Cookie", c.cookie);
  const events = (res.body.events ?? []) as Array<{
    attachment?: { kind: string; envelope?: { confirmation?: { id: string; nonce: string } } };
  }>;
  const control = events.find((e) => e.attachment?.kind === "pending_confirmation");
  return control!.attachment!.envelope!.confirmation!;
}

describe("v2 confirmation run lifecycle", () => {
  it("confirm terminalizes the run with the full operation event sequence, and the next message works", async () => {
    const c = await composeV2ProductionApp({ script: PREVIEW_SCRIPT });
    await c.chat("create a project called Lifecycle Probe");
    const runId = c.activeRunId();
    const control = await streamedControl(c, runId);

    const confirmed = await request(c.app)
      .post(`/api/confirmations/${control.id}/confirm`)
      .set("Cookie", c.cookie)
      .send({ nonce: control.nonce });
    expect(confirmed.status).toBe(200);
    expect(c.clockifyMutations()).toBeGreaterThanOrEqual(1);

    // The run is TERMINAL with the exact lifecycle sequence, exactly once.
    expect(c.store.getActiveRunForSession(c.sessionId, c.workspaceId, c.adminUserId)).toBeUndefined();
    const run = c.store.getRun(c.getRunScope(runId));
    expect(run?.phase).toBe("completed");
    expect(run?.continuation).toEqual({ kind: "none" });
    const types = (await c.readEvents(runId)).map((e) => e.event.eventType);
    const wanted = ["operation.confirmed", "operation.started", "operation.completed", "run.completed"];
    for (const type of wanted) {
      expect(types.filter((t) => t === type)).toHaveLength(1);
    }
    expect(types.indexOf("operation.confirmed")).toBeLessThan(types.indexOf("operation.started"));
    expect(types.indexOf("operation.started")).toBeLessThan(types.indexOf("operation.completed"));
    expect(types.at(-1)).toBe("run.completed");
    // The receipt is LINKED into run state (resume feedback + presentation).
    expect(run?.completedResults.some((r) => r.toolCallId === `confirmation-${control.id}`)).toBe(true);

    // The chat is immediately usable.
    const next = await c.chat("hello again");
    expect(next.status).toBe(200);
  });

  it("cancel terminalizes the run with a canonical no-mutation result, and the next message works", async () => {
    const c = await composeV2ProductionApp({ script: PREVIEW_SCRIPT });
    await c.chat("create a project called Lifecycle Probe");
    const runId = c.activeRunId();
    const control = await streamedControl(c, runId);
    const operationId = c.store.getPendingConfirmation(control.id)!.operationId;

    const cancelled = await request(c.app)
      .post(`/api/confirmations/${control.id}/cancel`)
      .set("Cookie", c.cookie)
      .send({});
    expect(cancelled.status).toBe(200);
    expect(c.clockifyMutations()).toBe(0);

    const run = c.store.getRun(c.getRunScope(runId));
    expect(run?.phase).toBe("completed");
    // The canonical no-mutation result is linked and honest.
    const link = run?.completedResults.find((r) => r.toolCallId === `confirmation-${control.id}`);
    expect(link).toBeDefined();
    const stored = c.store.getActionResult(link!.actionResultId) as {
      receipt: { ok: boolean; code: string };
    };
    expect(stored.receipt.ok).toBe(false);
    expect(stored.receipt.code).toBe("preview_cancelled");
    // The prepared operation cannot be executed anymore.
    expect(c.store.getOperationRun(operationId)?.status).toBe("definitive_failed");
    // Confirming after cancel is refused and dispatches nothing.
    const late = await request(c.app)
      .post(`/api/confirmations/${control.id}/confirm`)
      .set("Cookie", c.cookie)
      .send({ nonce: control.nonce });
    expect(late.status).toBeGreaterThanOrEqual(400);
    expect(c.clockifyMutations()).toBe(0);

    const next = await c.chat("hello again");
    expect(next.status).toBe(200);
  });

  it("an expired preview reconciles at the next message instead of wedging the session", async () => {
    const c = await composeV2ProductionApp({ script: PREVIEW_SCRIPT });
    await c.chat("create a project called Lifecycle Probe");
    const runId = c.activeRunId();

    // Past the 5-minute confirmation TTL with no sweep having run.
    c.setClock(new Date(V2_COMPOSITION_NOW.getTime() + 6 * 60 * 1000));

    const next = await c.chat("list something else instead");
    expect(next.status).toBe(200);
    expect(next.body.code).not.toBe("run_awaiting_confirmation");

    // The lapsed run is terminal and the session moved on to a NEW run.
    const lapsed = c.store.getRun(c.getRunScope(runId));
    expect(lapsed?.phase === "completed" || lapsed?.phase === "failed").toBe(true);
    expect(c.clockifyMutations()).toBe(0);
  });

  it("settlement is replay-safe: a second settle appends nothing", async () => {
    const c = await composeV2ProductionApp({ script: PREVIEW_SCRIPT });
    await c.chat("create a project called Lifecycle Probe");
    const runId = c.activeRunId();
    const control = await streamedControl(c, runId);
    const record = c.store.getPendingConfirmation(control.id)!;

    const first = c.store.settleV2ConfirmationRun({ record, kind: "cancelled" });
    expect(first.settled).toBe(true);
    const second = c.store.settleV2ConfirmationRun({ record, kind: "cancelled" });
    expect(second.settled).toBe(false);

    const types = (await c.readEvents(runId)).map((e) => e.event.eventType);
    expect(types.filter((t) => t === "run.completed")).toHaveLength(1);
    expect(types.filter((t) => t === "operation.completed")).toHaveLength(1);
  });
});
