import { describe, expect, it } from "vitest";
import request from "supertest";
import { DISCOVERY_META_TOOL_NAME } from "../../src/harness/api-operation.js";
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

describe("v2 confirmation BATCH run lifecycle", () => {
  const BATCH_SCRIPT = [
    { text: "", toolCalls: [{ id: "tc-find", name: DISCOVERY_META_TOOL_NAME, arguments: { query: "create tags" } }] },
    {
      text: "",
      toolCalls: [
        { id: "tc-a", name: "clockify_tags_create", arguments: { name: "alpha" } },
        { id: "tc-b", name: "clockify_projects_create", arguments: { name: "Beta Project" } },
      ],
    },
    { text: "All done.", toolCalls: [] },
  ];

  async function batchControls(c: Awaited<ReturnType<typeof composeV2ProductionApp>>, runId: string) {
    const res = await request(c.app)
      .get(`/api/runs/${runId}/events`)
      .query({ after: 0 })
      .set("Cookie", c.cookie);
    const events = (res.body.events ?? []) as Array<{
      attachment?: { kind: string; envelope?: { confirmation?: { id: string; nonce: string } } };
    }>;
    return events
      .filter((e) => e.attachment?.kind === "pending_confirmation")
      .map((e) => e.attachment!.envelope!.confirmation!);
  }

  it("per-item cancel of a batch member is refused; the aggregate cancel settles everything", async () => {
    const c = await composeV2ProductionApp({ script: BATCH_SCRIPT });
    await c.chat("create tags alpha and beta");
    const runId = c.activeRunId();
    const run = c.store.getRun(c.getRunScope(runId))!;
    expect(run.phase).toBe("awaiting_confirmation");
    if (run.continuation.kind !== "awaiting_operations") throw new Error("expected operations continuation");
    const batchId = run.continuation.batchId!;
    expect(batchId).toBeTruthy();
    const controls = await batchControls(c, runId);
    expect(controls).toHaveLength(2);

    // Per-item cancel is rejected — the batch is one unit.
    const perItem = await request(c.app)
      .post(`/api/confirmations/${controls[0]!.id}/cancel`)
      .set("Cookie", c.cookie)
      .send({});
    expect(perItem.status).toBe(400);
    expect(perItem.body.code).toBe("batch_cancel_required");

    // ONE aggregate cancel: both members terminal, batch cancelled, run
    // completed, zero mutations, chat usable.
    const cancelled = await request(c.app)
      .post(`/api/confirmation-batches/${batchId}/cancel`)
      .set("Cookie", c.cookie)
      .send({});
    expect(cancelled.status).toBe(200);
    expect(c.clockifyMutations()).toBe(0);
    expect(c.store.getConfirmationBatch(batchId)?.status).toBe("cancelled");
    for (const control of controls) {
      const record = c.store.getPendingConfirmation(control.id);
      expect(record?.status).toBe("cancelled");
    }
    expect(c.store.getRun(c.getRunScope(runId))?.phase).toBe("completed");
    const next = await c.chat("hello again");
    expect(next.status).toBe(200);
  });

  it("batch confirm commits every member and settles the run once", async () => {
    const c = await composeV2ProductionApp({ script: BATCH_SCRIPT });
    await c.chat("create tags alpha and beta");
    const runId = c.activeRunId();
    const run = c.store.getRun(c.getRunScope(runId))!;
    if (run.continuation.kind !== "awaiting_operations") throw new Error("expected operations continuation");
    const batchId = run.continuation.batchId!;
    const controls = await batchControls(c, runId);

    const confirmed = await request(c.app)
      .post(`/api/confirmation-batches/${batchId}/confirm`)
      .set("Cookie", c.cookie)
      .send({ items: controls.map((control) => ({ confirmationId: control.id, nonce: control.nonce })) });
    expect(confirmed.status, confirmed.text).toBe(200);
    expect(confirmed.body.status, confirmed.text).toBe("succeeded");
    expect(c.clockifyMutations()).toBeGreaterThanOrEqual(2);

    // The run settled once with one terminal event set.
    expect(c.store.getRun(c.getRunScope(runId))?.phase).toBe("completed");
    const types = (await c.readEvents(runId)).map((e) => e.event.eventType);
    expect(types.filter((t) => t === "run.completed")).toHaveLength(1);
    expect(types.filter((t) => t === "operation.completed")).toHaveLength(2);
    const next = await c.chat("hello again");
    expect(next.status).toBe(200);
  });
});
