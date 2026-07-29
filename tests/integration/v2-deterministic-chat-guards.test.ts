import { describe, expect, it } from "vitest";
import request from "supertest";
import {
  GUARD_CONSENT_IDLE_REPLY,
  GUARD_CONSENT_PENDING_REPLY,
  GUARD_EMPTY_MESSAGE_REPLY,
} from "../../src/routes/chat-guards.js";
import {
  composeV2ProductionApp,
  discoverThenCall,
  V2_COMPOSITION_NOW,
} from "../helpers/v2-production-composition.js";

/**
 * Closure-plan PR 2 (F20): the deterministic chat guards fire for the v2
 * engine at the shared post-claim/pre-provider boundary. Every guarded input
 * causes ZERO provider calls, ZERO Clockify calls, and ZERO run rows, and the
 * deterministic reply is settled into the durable transcript.
 */

const TWO_ALICES = {
  users: [
    { id: "aaaaaaaaaaaaaaaaaaaaaaa1", name: "Alice", email: "alice.one@example.com" },
    { id: "aaaaaaaaaaaaaaaaaaaaaaa2", name: "Alice", email: "alice.two@example.com" },
  ],
};

describe("v2 deterministic chat guards", () => {
  it("answers a whitespace-only message deterministically with zero provider or Clockify calls", async () => {
    const c = await composeV2ProductionApp({});
    const res = await c.chat("   ");
    expect(res.status).toBe(200);
    expect(res.body.reply.kind).toBe("answer");
    expect(res.body.reply.text).toBe(GUARD_EMPTY_MESSAGE_REPLY);

    expect(c.providerCalls()).toBe(0);
    // The mandatory fail-closed role recheck on every authenticated request is
    // one Clockify read; the guard itself dispatches nothing.
    expect(c.clockifyMutations()).toBe(0);
    expect(c.store.getActiveRunForSession(c.sessionId, c.workspaceId, c.adminUserId)).toBeUndefined();
    expect(() => c.latestRunId()).toThrow(/to have started a run/);

    // Both sides of the guarded turn are in the durable transcript.
    const history = await request(c.app).get("/api/chat/history").set("Cookie", c.cookie);
    expect(history.body.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
  });

  it("points typed consent at the pending preview's button without touching the run", async () => {
    const c = await composeV2ProductionApp({
      script: discoverThenCall("create a project", {
        name: "clockify_projects_create",
        arguments: { name: "Guard Probe" },
      }),
    });
    await c.chat("create a project called Guard Probe");
    const providerCallsAfterPreview = c.providerCalls();
    expect(c.store.getActiveRunForSession(c.sessionId, c.workspaceId, c.adminUserId)?.phase)
      .toBe("awaiting_confirmation");

    const res = await c.chat("yes");
    expect(res.status).toBe(200);
    expect(res.body.reply.kind).toBe("answer");
    expect(res.body.reply.text).toBe(GUARD_CONSENT_PENDING_REPLY);

    // No provider call, no mutation, and the suspended run + preview survive.
    expect(c.providerCalls()).toBe(providerCallsAfterPreview);
    expect(c.clockifyMutations()).toBe(0);
    expect(c.store.getActiveRunForSession(c.sessionId, c.workspaceId, c.adminUserId)?.phase)
      .toBe("awaiting_confirmation");
    expect(c.store.countPendingConfirmations(c.sessionId, V2_COMPOSITION_NOW.toISOString())).toBe(1);
  });

  it("answers idle typed consent deterministically when nothing is pending", async () => {
    const c = await composeV2ProductionApp({});
    const res = await c.chat("confirm");
    expect(res.status).toBe(200);
    expect(res.body.reply.text).toBe(GUARD_CONSENT_IDLE_REPLY);
    expect(c.providerCalls()).toBe(0);
  });

  it("lets a bare affirmative with no just-completed write reach the model", async () => {
    const c = await composeV2ProductionApp({
      script: [{ text: "Hello there.", toolCalls: [] }],
    });
    const res = await c.chat("great");
    expect(res.status).toBe(200);
    expect(res.body.reply.kind).toBe("final");
    expect(res.body.reply.text).toBe("Hello there.");
    expect(c.providerCalls()).toBe(1);
  });

  it("keeps a pending clarification alive through a guarded turn instead of superseding it", async () => {
    const c = await composeV2ProductionApp({
      script: discoverThenCall("list time entries", {
        name: "clockify_entries_list",
        arguments: { userId: "Alice" },
      }),
      seed: TWO_ALICES,
    });
    await c.chat("list Alice's entries");
    const runId = c.activeRunId();
    const before = c.store.getActiveClarificationForRun(c.runScope(runId));
    expect(before?.status).toBe("pending");

    const res = await c.chat("   ");
    expect(res.status).toBe(200);
    expect(res.body.reply.text).toBe(GUARD_EMPTY_MESSAGE_REPLY);

    // The clarification and its suspended run are untouched.
    expect(c.store.getActiveRunForSession(c.sessionId, c.workspaceId, c.adminUserId)?.runId).toBe(runId);
    expect(c.store.getActiveClarificationForRun(c.runScope(runId))?.id).toBe(before!.id);
  });
});
