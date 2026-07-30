import { describe, expect, it } from "vitest";
import request from "supertest";
import { DISCOVERY_META_TOOL_NAME } from "../../src/harness/api-operation.js";
import {
  composeV2ProductionApp,
  V2_COMPOSITION_NOW,
} from "../helpers/v2-production-composition.js";

/**
 * Readiness-plan A1 (defect D-1): a NEW user turn must never reach a WRITE on
 * a tool set seeded from a PRIOR turn. Every new turn mints a fresh run and
 * seeds its loaded tools from the latest catalog-compatible prior run in the
 * same scope (`seedCacheFromPriorRun`); `validateLoadedToolCall` then checks
 * only membership — nothing requires that discovery ran in the CURRENT turn.
 * In production that let a turn asking for a time entry reach a prepared
 * `clockify_stop_timer` write with zero discovery calls of its own.
 *
 * This test pins the post-A2 contract: a write called with no discovery in
 * its own turn is DENIED `tool_not_loaded` (the denial observation feeds the
 * next model request, which recovers in-run). Until A2 lands it fails by
 * showing the stale-seeded write reach write preparation.
 */

const RUNNING_ENTRY = {
  id: "entry-running",
  description: "Live work",
  start: "2026-07-25T23:00:00.000Z",
  end: null,
};

const SCRIPT = [
  // Turn 1 — the model discovers with a timer-shaped query (the index ranks
  // clockify_stop_timer for it) and then USES the write, so it is persisted in
  // the run's loaded set and guaranteed to survive seed truncation.
  {
    text: "",
    toolCalls: [
      { id: "t1-find", name: DISCOVERY_META_TOOL_NAME, arguments: { query: "stop my timer" } },
    ],
  },
  { text: "", toolCalls: [{ id: "t1-stop", name: "clockify_stop_timer", arguments: {} }] },
  // Turn 2 — a NEW user message in the SAME session; the model calls the write
  // IMMEDIATELY with NO discovery call, exactly as the production model did
  // when the stale seed made the tool look already loaded.
  { text: "", toolCalls: [{ id: "t2-stop", name: "clockify_stop_timer", arguments: {} }] },
  // Post-A2 recovery path: the denial observation reaches the next completion.
  { text: "I need to search for the right operation first.", toolCalls: [] },
];

async function pendingControl(
  c: Awaited<ReturnType<typeof composeV2ProductionApp>>,
  runId: string,
): Promise<{ id: string; nonce: string }> {
  const res = await request(c.app)
    .get(`/api/runs/${runId}/events`)
    .query({ after: 0 })
    .set("Cookie", c.cookie);
  const events = (res.body.events ?? []) as Array<{
    attachment?: { kind: string; envelope?: { confirmation?: { id: string; nonce: string } } };
  }>;
  const control = events.find((e) => e.attachment?.kind === "pending_confirmation");
  if (!control?.attachment?.envelope?.confirmation) {
    throw new Error("expected a pending_confirmation attachment on the first turn");
  }
  return control.attachment.envelope.confirmation;
}

describe("v2 stale cross-turn tool seed (readiness A1 / defect D-1)", () => {
  it("a write called with no discovery in its own turn is denied tool_not_loaded, never prepared off the stale seed", async () => {
    const c = await composeV2ProductionApp({
      fileBacked: true,
      seed: { running: RUNNING_ENTRY, entries: [RUNNING_ENTRY] },
      script: SCRIPT,
    });

    // ---- Turn 1: a discovery-backed stop-timer preview, then confirm it. ----
    const res1 = await c.chat("stop my timer");
    expect(res1.status).toBe(200);
    expect(res1.body.ok).toBe(true);
    expect(res1.body.reply.kind).toBe("preview");
    const run1 = c.activeRunId();

    // Guard against a scripting artifact: the tool turn 2 will replay really
    // was loaded by THIS turn's OWN discovery call — the seed source.
    const run1State = c.store.getRun(c.getRunScope(run1));
    expect(run1State?.budget.discoveryCallsUsed).toBe(1);
    expect(run1State?.loadedToolNames).toContain("clockify_stop_timer");

    const control = await pendingControl(c, run1);
    const confirmed = await request(c.app)
      .post(`/api/confirmations/${control.id}/confirm`)
      .set("Cookie", c.cookie)
      .send({ nonce: control.nonce });
    expect(confirmed.status).toBe(200);
    expect(c.store.getRun(c.getRunScope(run1))?.phase).toBe("completed");
    const mutationsAfterTurn1 = c.clockifyMutations();
    expect(mutationsAfterTurn1).toBeGreaterThanOrEqual(1);

    // ---- Turn 2: same session, new message, and the script SKIPS discovery. ----
    // Advance the shared clock so turn 2's run.started is strictly later than
    // turn 1's (the frozen clock would tie their createdAt timestamps).
    const turn2Now = new Date(V2_COMPOSITION_NOW.getTime() + 60_000);
    c.setClock(turn2Now);
    const res2 = await c.chat("add two hours to the Apollo project");
    expect(res2.status).toBe(200);
    const run2 = c.latestRunId();
    expect(run2).not.toBe(run1);

    // The second turn performed NO discovery of its own...
    const run2State = c.store.getRun(c.getRunScope(run2));
    expect(run2State?.budget.discoveryCallsUsed).toBe(0);

    // ...so the write must be DENIED tool_not_loaded (the post-A2 contract).
    const events2 = await c.readEvents(run2);
    const eventTypes = events2.map((e) => e.event.eventType);
    const denials = events2
      .filter((e) => e.event.eventType === "tool.denied")
      .map((e) => e.event.payload);
    expect(
      denials,
      "turn 2 must deny the stale-seeded write tool_not_loaded before preparation; " +
        `instead its run journaled: [${eventTypes.join(", ")}]`,
    ).toContainEqual(
      expect.objectContaining({ actionName: "clockify_stop_timer", code: "tool_not_loaded" }),
    );

    // And write preparation was never reached off the stale seed: no preview
    // card, no pending confirmation, no new Clockify mutation.
    expect(res2.body.reply?.kind).not.toBe("preview");
    expect(c.store.countPendingConfirmations(c.sessionId, turn2Now.toISOString())).toBe(0);
    expect(c.clockifyMutations()).toBe(mutationsAfterTurn1);
  });
});
