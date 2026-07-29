import { describe, expect, it } from "vitest";
import request from "supertest";
import {
  composeV2ProductionApp,
  discoverThenCall,
  ndjsonFrames,
} from "../helpers/v2-production-composition.js";

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
});
