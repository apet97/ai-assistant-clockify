import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import request from "supertest";
import {
  composeV2ProductionApp,
  discoverThenCall,
  ndjsonFrames,
} from "../helpers/v2-production-composition.js";

function rawRows(databaseFile: string, sql: string, ...params: unknown[]): Array<Record<string, unknown>> {
  const db = new Database(databaseFile, { readonly: true });
  try {
    return db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

/**
 * Closure-plan PR 3 (F01's delivery half): a v2 turn delivers its canonical
 * cards and its live pending-confirmation control ON THE ORIGINAL TURN via
 * hydrated `run_event` stream frames — the admin no longer needs a reload to
 * reach the Confirm button, and the frames carry server-derived presentation
 * (human title, status, facts), never fabricated success.
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

const TWO_ALICES = {
  users: [
    { id: "aaaaaaaaaaaaaaaaaaaaaaa1", name: "Alice", email: "alice.one@example.com" },
    { id: "aaaaaaaaaaaaaaaaaaaaaaa2", name: "Alice", email: "alice.two@example.com" },
  ],
};

type Frame = Record<string, unknown> & {
  type: string;
  attachment?: {
    kind: string;
    envelope?: {
      presentation?: { status?: string; title?: string; facts?: unknown[] };
      confirmation?: { id: string; nonce: string; expiresAt: string };
    };
  };
};

async function streamChat(
  c: Awaited<ReturnType<typeof composeV2ProductionApp>>,
  message: string,
): Promise<Frame[]> {
  const res = await request(c.app)
    .post("/api/chat/stream")
    .set("Cookie", c.cookie)
    .send({ message });
  expect(res.status).toBe(200);
  return ndjsonFrames(res.text) as Frame[];
}

/**
 * Drive the NDJSON chat stream and return its parsed frames in order.
 *
 * The T07 stream-replay test called this and it did not exist — the file
 * referenced a helper that was never written, so that test threw
 * `streamChat2 is not defined` rather than asserting anything.
 */
async function streamChat2(
  c: Awaited<ReturnType<typeof composeV2ProductionApp>>,
  message: string,
  requestId: string,
): Promise<Array<{ type: string; text?: string; attachment?: { kind?: string } }>> {
  const res = await request(c.app)
    .post("/api/chat/stream")
    .set("Cookie", c.cookie)
    .send({ message, requestId });
  expect(res.status).toBe(200);
  return res.text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { type: string; text?: string; attachment?: { kind?: string } });
}

describe("v2 turn delivery", () => {
  it("streams the live Confirm control on the ORIGINAL preview turn, and its nonce really confirms", async () => {
    const c = await composeV2ProductionApp({
      script: discoverThenCall("create a project", {
        name: "clockify_projects_create",
        arguments: { name: "Delivery Probe" },
      }),
    });

    const frames = await streamChat(c, "create a project called Delivery Probe");
    const pending = frames.find((f) => f.type === "run_event" && f.attachment?.kind === "pending_confirmation");
    expect(pending).toBeDefined();
    const envelope = pending!.attachment!.envelope!;
    // Server-derived presentation: a human label with real facts, not a UUID.
    expect(envelope.presentation!.status).toBe("pending_confirmation");
    expect(envelope.presentation!.title!.length).toBeGreaterThan(0);
    expect(envelope.presentation!.title).not.toMatch(/^[0-9a-f-]{36}$/);
    // The ONE live control, freshly rotated.
    const confirmation = envelope.confirmation!;
    expect(confirmation.nonce.length).toBeGreaterThan(0);
    // The reply frame stays the deterministic preview copy, after the events.
    const reply = frames.find((f) => f.type === "reply");
    expect(reply?.kind).toBe("preview");
    expect(frames.at(-1)?.type).toBe("done");
    expect(c.clockifyMutations()).toBe(0);

    // The streamed control is REAL: confirming with it commits the write.
    const confirmed = await request(c.app)
      .post(`/api/confirmations/${confirmation.id}/confirm`)
      .set("Cookie", c.cookie)
      .send({ nonce: confirmation.nonce });
    expect(confirmed.status).toBe(200);
    expect(c.clockifyMutations()).toBeGreaterThanOrEqual(1);
  });

  it("streams the canonical result card for a read on the original turn", async () => {
    const c = await composeV2ProductionApp({
      script: discoverThenCall(
        "list time entries",
        { name: "clockify_entries_list", arguments: {} },
        "You tracked one hour of spec work.",
      ),
      seed: ONE_ENTRY,
    });

    const frames = await streamChat(c, "what did I track yesterday?");
    const card = frames.find((f) => f.type === "run_event" && f.attachment?.kind === "presented_result");
    expect(card).toBeDefined();
    const presentation = card!.attachment!.envelope!.presentation!;
    expect(presentation.status).toBe("succeeded");
    expect(presentation.title).not.toBe("clockify_entries_list");
    const reply = frames.find((f) => f.type === "reply");
    expect(reply?.text).toBe("You tracked one hour of spec work.");
  });

  it("feeds the resumed model the bounded canonical receipt, not an opaque result id", async () => {
    const c = await composeV2ProductionApp({
      script: discoverThenCall("list time entries", {
        name: "clockify_entries_list",
        arguments: { userId: "Alice" },
      }),
      seed: TWO_ALICES,
    });
    await c.chat("list Alice's entries");
    const runId = c.activeRunId();
    const clarification = c.store.getActiveClarificationForRun(c.runScope(runId))!;

    const resolved = await request(c.app)
      .post(`/api/clarifications/${clarification.id}/resolve`)
      .set("Cookie", c.cookie)
      .send({ optionId: "aaaaaaaaaaaaaaaaaaaaaaa2" });
    expect(resolved.status).toBe(200);

    // The post-resume model request carries the read's actual content.
    const lastCall = c.model.calls.at(-1)!;
    const transcript = JSON.stringify(lastCall.messages);
    expect(transcript).toContain("clockify_entries_list returned:");
    expect(transcript).not.toMatch(/completed \(result [0-9a-f-]{36}\)/);
  });

  it("T07: a same-requestId JSON replay carries runId + an equivalent event page and a FRESH nonce", async () => {
    const c = await composeV2ProductionApp({
      script: discoverThenCall("create a project", {
        name: "clockify_projects_create",
        arguments: { name: "Replay Probe" },
      }),
      fileBacked: true,
    });
    const requestId = randomUUID();

    const first = await c.chat("create a project called Replay Probe", { requestId });
    expect(first.status).toBe(200);
    expect(typeof first.body.runId).toBe("string");
    expect(first.body.runEvents).toBeDefined();
    expect(first.body.runEvents.runId).toBe(first.body.runId);
    expect(Array.isArray(first.body.runEvents.events)).toBe(true);
    expect(first.body.runEvents.events.length).toBeGreaterThan(0);
    const firstConfirmationEvent = first.body.runEvents.events.find(
      (e: { attachment?: { kind?: string } }) => e.attachment?.kind === "pending_confirmation",
    );
    expect(firstConfirmationEvent).toBeDefined();
    const firstNonce = firstConfirmationEvent.attachment.envelope.confirmation.nonce;
    const confirmationId = firstConfirmationEvent.attachment.envelope.confirmation.id;

    // Same requestId, same intent: a durable-identity replay, not a new turn.
    const replay = await c.chat("create a project called Replay Probe", { requestId });
    expect(replay.status).toBe(200);
    expect(replay.body.runId).toBe(first.body.runId);
    expect(replay.body.runEvents).toBeDefined();
    expect(replay.body.runEvents.runId).toBe(first.body.runId);
    expect(replay.body.runEvents.events.length).toBeGreaterThan(0);
    const replayConfirmationEvent = replay.body.runEvents.events.find(
      (e: { attachment?: { kind?: string } }) => e.attachment?.kind === "pending_confirmation",
    );
    expect(replayConfirmationEvent).toBeDefined();
    const replayNonce = replayConfirmationEvent.attachment.envelope.confirmation.nonce;
    expect(replayConfirmationEvent.attachment.envelope.confirmation.id).toBe(confirmationId);
    // The nonce is FRESH on replay, never the original re-served.
    expect(replayNonce).not.toBe(firstNonce);

    // The old nonce from the first response is dead; only the freshly rotated
    // replay nonce can confirm.
    const staleConfirm = await request(c.app)
      .post(`/api/confirmations/${confirmationId}/confirm`)
      .set("Cookie", c.cookie)
      .send({ nonce: firstNonce });
    expect(staleConfirm.status).not.toBe(200);

    const realConfirm = await request(c.app)
      .post(`/api/confirmations/${confirmationId}/confirm`)
      .set("Cookie", c.cookie)
      .send({ nonce: replayNonce });
    expect(realConfirm.status).toBe(200);
    expect(c.clockifyMutations()).toBeGreaterThanOrEqual(1);

    // The persisted envelope retains the run id but stores neither hydrated
    // run events nor a plaintext nonce.
    const rows = rawRows(
      c.databaseFile!,
      "SELECT response_envelope_json FROM turn_runs WHERE request_id = ?",
      requestId,
    );
    expect(rows).toHaveLength(1);
    const envelopeJson = rows[0]!.response_envelope_json as string;
    const envelope = JSON.parse(envelopeJson) as { body?: Record<string, unknown> };
    expect(envelope.body?.runId).toBe(first.body.runId);
    expect(envelope.body).not.toHaveProperty("runEvents");
    expect(envelope.body).not.toHaveProperty("results");
    expect(envelopeJson).not.toContain(firstNonce);
    expect(envelopeJson).not.toContain(replayNonce);
  });

  it("T07: a v2 replay whose run-event page is gone preserves the reply but omits controls/results", async () => {
    const c = await composeV2ProductionApp({
      script: discoverThenCall(
        "list time entries",
        { name: "clockify_entries_list", arguments: {} },
        "You tracked one hour of spec work.",
      ),
      seed: ONE_ENTRY,
      fileBacked: true,
    });
    const requestId = randomUUID();

    const first = await c.chat("what did I track yesterday?", { requestId });
    expect(first.status).toBe(200);
    const runId = first.body.runId as string;
    expect(typeof runId).toBe("string");

    // Simulate the page having become unreachable by deleting the run's
    // journaled events directly (retention/expiry surface in production).
    const db = new Database(c.databaseFile!);
    db.prepare("DELETE FROM run_events WHERE run_id = ?").run(runId);
    db.close();

    const replay = await c.chat("what did I track yesterday?", { requestId });
    expect(replay.status).toBe(200);
    expect(replay.body.reply?.text).toBe("You tracked one hour of spec work.");
    expect(replay.body.runEvents).toBeUndefined();
    expect(replay.body.results).toEqual([]);
  });

  it("T07: stream replay emits replayed run_event frames before reply and done", async () => {
    const c = await composeV2ProductionApp({
      script: discoverThenCall(
        "list time entries",
        { name: "clockify_entries_list", arguments: {} },
        "You tracked one hour of spec work.",
      ),
      seed: ONE_ENTRY,
    });
    const requestId = randomUUID();

    const first = await streamChat2(c, "what did I track yesterday?", requestId);
    const firstCard = first.find((f) => f.type === "run_event" && f.attachment?.kind === "presented_result");
    expect(firstCard).toBeDefined();
    expect(first.at(-2)?.type).toBe("reply");
    expect(first.at(-1)?.type).toBe("done");

    const replay = await streamChat2(c, "what did I track yesterday?", requestId);
    const replayedFrameTypes = replay.map((f) => f.type);
    const replayCard = replay.find((f) => f.type === "run_event" && f.attachment?.kind === "presented_result");
    expect(replayCard).toBeDefined();
    // run_event frame(s) precede reply, which precedes done.
    const runEventIndex = replayedFrameTypes.indexOf("run_event");
    const replyIndex = replayedFrameTypes.indexOf("reply");
    const doneIndex = replayedFrameTypes.indexOf("done");
    expect(runEventIndex).toBeGreaterThanOrEqual(0);
    expect(runEventIndex).toBeLessThan(replyIndex);
    expect(replyIndex).toBeLessThan(doneIndex);
    expect(replay.find((f) => f.type === "reply")?.text).toBe("You tracked one hour of spec work.");
  });
  /**
   * T09 scenarios 4 and 5, plus the equivalence T09 scenario 2 actually asks
   * for.
   *
   * The replay window is read from the STORED watermark, not from 0. A
   * continuation turn's page begins at the sequence that turn started from, so
   * replaying from 0 would hand back events the original response never
   * carried — "equivalent cards" would quietly become "more cards". The
   * clarification-continuation replay test in `v2-clarification-route.test.ts`
   * is the case that proves it: it compares whole bodies and passes only
   * because the window matches.
   */
  it("T09: a replay reproduces the ORIGINAL event window and dispatches nothing again", async () => {
    const c = await composeV2ProductionApp({
      script: discoverThenCall(
        "list time entries",
        { name: "clockify_entries_list", arguments: {} },
        "You tracked one hour.",
      ),
      seed: {
        entries: [{
          id: "e1",
          description: "spec work",
          start: "2026-07-25T09:00:00Z",
          end: "2026-07-25T10:00:00Z",
          billable: true,
        }] as never,
      },
    });
    const requestId = randomUUID();

    const first = await c.chat("what did I track?", { requestId });
    expect(first.status).toBe(200);
    const clockifyAfterFirst = c.clockifyCalls();
    const providerAfterFirst = c.providerCalls();
    const firstSequences = (first.body.runEvents?.events ?? []).map((e: { sequence: number }) => e.sequence);
    expect(firstSequences.length).toBeGreaterThan(0);

    const replay = await c.chat("what did I track?", { requestId });
    expect(replay.status).toBe(200);
    expect(replay.body.runId).toBe(first.body.runId);

    // The SAME window — not a superset drawn from sequence 0.
    const replaySequences = (replay.body.runEvents?.events ?? []).map((e: { sequence: number }) => e.sequence);
    expect(replaySequences).toEqual(firstSequences);

    // Scenario 5: a replay is a re-read, never a re-execution.
    expect(c.clockifyCalls()).toBe(clockifyAfterFirst);
    expect(c.providerCalls()).toBe(providerAfterFirst);
  });

  it("T09: the same request id with a DIFFERENT intent is still a conflict, not a replay", async () => {
    const c = await composeV2ProductionApp({
      script: discoverThenCall(
        "list time entries",
        { name: "clockify_entries_list", arguments: {} },
        "You tracked one hour.",
      ),
      seed: { entries: [] as never },
    });
    const requestId = randomUUID();

    const first = await c.chat("what did I track?", { requestId });
    expect(first.status).toBe(200);

    const conflicting = await c.chat("delete everything instead", { requestId });
    expect(conflicting.status).toBe(409);
    expect(conflicting.body.code).toBe("operation_id_conflict");
    // A conflict must not leak a replay handle for someone else's run.
    expect(conflicting.body.runEvents).toBeUndefined();
  });
});
