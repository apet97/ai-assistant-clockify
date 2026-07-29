import { describe, expect, it } from "vitest";
import request from "supertest";
import {
  composeV2ProductionApp,
  discoverThenCall,
} from "../helpers/v2-production-composition.js";

/**
 * Closure-plan PR 3 (F06): a v2 pending preview has ONE live-control source —
 * its run-event page. History restore is passive for v2 (no second nonce, no
 * duplicate card), one event page rotates the nonce at most once, and a stale
 * nonce re-arms by re-fetching rather than dead-ending.
 */

const PREVIEW_SCRIPT = discoverThenCall("create a project", {
  name: "clockify_projects_create",
  arguments: { name: "Restore Probe" },
});

type EventRow = {
  event: { eventType: string; payload: Record<string, unknown> };
  attachment?: {
    kind: string;
    envelope?: { confirmation?: { id: string; nonce: string } };
  };
};

async function fetchEvents(
  c: Awaited<ReturnType<typeof composeV2ProductionApp>>,
  runId: string,
): Promise<EventRow[]> {
  const res = await request(c.app)
    .get(`/api/runs/${runId}/events`)
    .query({ after: 0 })
    .set("Cookie", c.cookie);
  expect(res.status).toBe(200);
  return (res.body.events ?? []) as EventRow[];
}

function pendingControls(events: EventRow[]): Array<{ id: string; nonce: string }> {
  return events
    .filter((e) => e.attachment?.kind === "pending_confirmation")
    .map((e) => e.attachment!.envelope!.confirmation!);
}

describe("v2 restore control source", () => {
  it("serves ONE control from ONE source on reload, and that control confirms", async () => {
    const c = await composeV2ProductionApp({ script: PREVIEW_SCRIPT });
    await c.chat("create a project called Restore Probe");
    const runId = c.activeRunId();

    // Reload step 1: history is PASSIVE for v2 — no preview, no nonce; it
    // hands the UI the active run to hydrate instead.
    const history = await request(c.app).get("/api/chat/history").set("Cookie", c.cookie);
    expect(history.status).toBe(200);
    expect(history.body.pendingPreviews).toEqual([]);
    expect(history.body.activeRun?.runId).toBe(runId);

    // Reload step 2: the run-event page carries EXACTLY one control with one
    // fresh nonce.
    const controls = pendingControls(await fetchEvents(c, runId));
    expect(controls).toHaveLength(1);

    const confirmed = await request(c.app)
      .post(`/api/confirmations/${controls[0]!.id}/confirm`)
      .set("Cookie", c.cookie)
      .send({ nonce: controls[0]!.nonce });
    expect(confirmed.status).toBe(200);
    expect(c.clockifyMutations()).toBeGreaterThanOrEqual(1);
  });

  it("rotates once per page: a second fetch kills the first nonce and the fresh one re-arms", async () => {
    const c = await composeV2ProductionApp({ script: PREVIEW_SCRIPT });
    await c.chat("create a project called Restore Probe");
    const runId = c.activeRunId();

    const first = pendingControls(await fetchEvents(c, runId));
    const second = pendingControls(await fetchEvents(c, runId));
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0]!.nonce).not.toBe(first[0]!.nonce);

    // The stale first-tab nonce fails WITHOUT burning the preview...
    const stale = await request(c.app)
      .post(`/api/confirmations/${first[0]!.id}/confirm`)
      .set("Cookie", c.cookie)
      .send({ nonce: first[0]!.nonce });
    expect(stale.status).toBe(400);
    expect(c.clockifyMutations()).toBe(0);

    // ...and the freshly served nonce still confirms (re-arm, not dead-end).
    const confirmed = await request(c.app)
      .post(`/api/confirmations/${second[0]!.id}/confirm`)
      .set("Cookie", c.cookie)
      .send({ nonce: second[0]!.nonce });
    expect(confirmed.status).toBe(200);
    expect(c.clockifyMutations()).toBeGreaterThanOrEqual(1);
  });
});
