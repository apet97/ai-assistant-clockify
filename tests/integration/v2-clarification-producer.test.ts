import { describe, expect, it } from "vitest";
import request from "supertest";
import type { Store } from "../../src/db/store.js";
import { DISCOVERY_META_TOOL_NAME } from "../../src/harness/api-operation.js";
import type { ToolCompletion } from "../../src/assistant/model-client.js";
import {
  composeV2ProductionApp,
  discoverThenCall,
  ndjsonFrames,
  type V2Composition,
} from "../helpers/v2-production-composition.js";

/**
 * CP-B: the live clarification PRODUCER, end to end over real HTTP.
 *
 * Every case drives the production composition (`composeV2ProductionApp`,
 * `assistantEngine: "v2"`), so the whole chain is the real one: chat route ->
 * v2 pipeline -> `runAssistantV2` -> `ActionExecutionService` ->
 * `executeV2Read` -> the real Clockify read action and its real name resolver.
 * Nothing here seeds a `pending_clarifications` row by hand (that is what
 * T14-D's route tests already do); the point is that the product CREATES one
 * at runtime, journals it, hydrates it, and can resolve it.
 */

const WORKSPACE_ID = "ws-1";
const ADMIN_ID = "admin-1";

// Two workspace members whose names match "Alice" EXACTLY: `matchByName`
// returns `kind: "many"`, so `resolveUserFilter` clarifies with both as
// grounded options carrying their real 24-hex ids.
const ALICE_ONE = "aaaaaaaaaaaaaaaaaaaaaaa1";
const ALICE_TWO = "aaaaaaaaaaaaaaaaaaaaaaa2";

const SEED = {
  users: [
    { id: ALICE_ONE, name: "Alice", email: "alice.one@example.com" },
    { id: ALICE_TWO, name: "Alice", email: "alice.two@example.com" },
    { id: "bbbbbbbbbbbbbbbbbbbbbbb1", name: "Bob", email: "bob@example.com" },
  ],
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

async function makeV2App(script: ToolCompletion[]): Promise<V2Composition> {
  return composeV2ProductionApp({ script, seed: SEED });
}

function clarificationRowsFor(store: Store, sessionId: string, runId: string) {
  return store.getActiveClarificationForRun({
    sessionId,
    runId,
    workspaceId: WORKSPACE_ID,
    adminUserId: ADMIN_ID,
  });
}

describe("CP-B: v2 reads produce, journal, hydrate, and resolve real clarifications", () => {
  it("creates exactly one durable pending_clarifications row from an ambiguous read", async () => {
    const c = await makeV2App(
      discoverThenCall("list time entries", {
        name: "clockify_entries_list",
        arguments: { userId: "Alice" },
      }),
    );

    const res = await c.chat("list Alice's time entries");
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const runId = c.activeRunId();
    const row = clarificationRowsFor(c.store, c.sessionId, runId);
    expect(row).toBeDefined();
    expect(row!.status).toBe("pending");
    expect(row!.originalToolName).toBe("clockify_entries_list");
    // CP-A: the exact raw-argument key, so an exact option can resolve into it.
    expect(row!.missingField).toBe("userId");
    expect(row!.partialArguments).toEqual({ userId: "Alice" });
    expect(row!.candidates).toHaveLength(2);
    expect(row!.candidates.map((cand) => cand.externalId).sort()).toEqual([ALICE_ONE, ALICE_TWO]);
    for (const candidate of row!.candidates) {
      expect(candidate.externalId).toMatch(/^[0-9a-f]{24}$/);
      expect(candidate.optionId).toBe(candidate.externalId);
      expect(candidate.label).toBe("Alice");
    }

    // The run is suspended on exactly this clarification.
    const run = c.store.getRun(c.getRunScope(runId));
    expect(run?.phase).toBe("awaiting_clarification");
    expect(run?.continuation).toEqual({ kind: "awaiting_clarification", clarificationId: row!.id });
  });

  it("journals clarification.required and hydrates a display-only pending_clarification attachment", async () => {
    const c = await makeV2App(
      discoverThenCall("list time entries", {
        name: "clockify_entries_list",
        arguments: { userId: "Alice" },
      }),
    );
    await c.chat("list Alice's entries");
    const runId = c.activeRunId();
    const row = clarificationRowsFor(c.store, c.sessionId, runId)!;

    const events = await c.readEvents(runId);
    const required = events.filter((e) => e.event.eventType === "clarification.required");
    expect(required).toHaveLength(1);
    expect(required[0]!.event.payload.clarificationId).toBe(row.id);

    const attachment = required[0]!.attachment;
    expect(attachment?.kind).toBe("pending_clarification");
    if (attachment?.kind !== "pending_clarification") throw new Error("expected a clarification attachment");
    expect(attachment.clarificationId).toBe(row.id);
    expect(attachment.status).toBe("pending");
    // The real resolver's question reaches the UI, read from the canonical
    // clarify action_results row the event links to.
    expect(attachment.question).toContain("Alice");
    expect(attachment.missingField).toBe("userId");
    expect(attachment.candidates.map((cand) => cand.optionId).sort()).toEqual([ALICE_ONE, ALICE_TWO]);
    expect(attachment.candidates.every((cand) => cand.label === "Alice")).toBe(true);
    // Display data ONLY: no externalId, no partial arguments.
    for (const candidate of attachment.candidates) {
      expect("externalId" in candidate).toBe(false);
    }
    expect(JSON.stringify(attachment)).not.toContain("partialArguments");

    // `run.suspended` still owns the phase change and is journaled after it.
    const order = events.map((e) => e.event.eventType);
    expect(order.indexOf("clarification.required")).toBeLessThan(order.indexOf("run.suspended"));
  });

  it("resolves the produced clarification by exact option id and runs the read", async () => {
    const c = await makeV2App(
      discoverThenCall("list time entries", {
        name: "clockify_entries_list",
        arguments: { userId: "Alice" },
      }),
    );
    await c.chat("list Alice's entries");
    const runId = c.activeRunId();
    const row = clarificationRowsFor(c.store, c.sessionId, runId)!;
    const scope = c.runScope(runId);

    const res = await request(c.app)
      .post(`/api/clarifications/${row.id}/resolve`)
      .set("Cookie", c.cookie)
      .send({ optionId: ALICE_TWO });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const frames = ndjsonFrames(res.text);
    expect(frames.at(-1)?.type).toBe("done");

    const settled = c.store.getPendingClarification(row.id, scope);
    expect(settled?.status).toBe("resolved");
    expect(settled?.terminalReason).toBe("selected_option");
    expect(settled?.selectedOptionId).toBe(ALICE_TWO);
    // The terminal row is scrubbed (schema trigger + store contract).
    expect(settled?.candidates).toEqual([]);
    expect(settled?.partialArguments).toEqual({});

    // The read really executed, with the CHOSEN 24-hex id — not the name.
    const stored = c.store.getActionResult(settled!.actionResultId!) as {
      kind: string;
      receipt: { ok: boolean; action: string; data?: { userId?: string } };
    };
    expect(stored.kind).toBe("receipt");
    expect(stored.receipt.ok).toBe(true);
    expect(stored.receipt.action).toBe("clockify_entries_list");
    expect(stored.receipt.data?.userId).toBe(ALICE_TWO);

    // The run advanced past the clarification (the scripted model then finished).
    expect(c.store.getActiveRunForSession(c.sessionId, WORKSPACE_ID, ADMIN_ID)).toBeUndefined();
  });

  it("stops rendering a settled clarification as live", async () => {
    const c = await makeV2App(
      discoverThenCall("list time entries", {
        name: "clockify_entries_list",
        arguments: { userId: "Alice" },
      }),
    );
    await c.chat("list Alice's entries");
    const runId = c.activeRunId();
    const row = clarificationRowsFor(c.store, c.sessionId, runId)!;

    const before = await c.readEvents(runId);
    expect(before.find((e) => e.event.eventType === "clarification.required")?.attachment).toBeDefined();

    await request(c.app)
      .post(`/api/clarifications/${row.id}/resolve`)
      .set("Cookie", c.cookie)
      .send({ optionId: ALICE_ONE });

    const after = await c.readEvents(runId);
    const required = after.find((e) => e.event.eventType === "clarification.required");
    expect(required).toBeDefined();
    expect(required!.attachment).toBeUndefined();
  });

  it("stops rendering an expired but unswept clarification as live", async () => {
    // Expiry is enforced at claim time and only LAZILY by the retention sweep,
    // so a still-`pending` row can outlive its TTL in the database. Hydrating on
    // status alone rendered live chips that 410 on click.
    const c = await makeV2App(
      discoverThenCall("list time entries", {
        name: "clockify_entries_list",
        arguments: { userId: "Alice" },
      }),
    );
    await c.chat("list Alice's entries");
    const runId = c.activeRunId();
    const row = clarificationRowsFor(c.store, c.sessionId, runId)!;
    const scope = c.runScope(runId);

    // Live at creation time.
    const live = await c.readEvents(runId);
    expect(live.find((e) => e.event.eventType === "clarification.required")?.attachment).toBeDefined();

    // Past the 5-minute TTL, with NO sweep and NO status change.
    c.setClock(new Date(Date.parse(row.expiresAt) + 1));
    expect(c.store.getPendingClarification(row.id, scope)?.status).toBe("pending");

    const after = await c.readEvents(runId);
    const required = after.find((e) => e.event.eventType === "clarification.required");
    expect(required).toBeDefined();
    expect(required!.attachment).toBeUndefined();

    // ...and the row it would have offered really is unclaimable, so nothing
    // truthful was withheld.
    expect(() => c.store.claimClarificationResolving(row.id, scope)).toThrow(/clarification_expired/);
  });

  it("creates a candidate-free row for a clarification with no single owning argument", async () => {
    // A date-range clarify (`resolveDateRange`) carries no options and no owning
    // argument, so the row stores the inert `"selection"` marker: resolve-by-option
    // can never match, and free-text continuation (T14-E) is the only answer.
    const c = await makeV2App(
      discoverThenCall("list time entries", {
        name: "clockify_entries_list",
        arguments: { start: "not-a-real-date" },
      }),
    );
    await c.chat("list entries since not-a-real-date");

    const runId = c.activeRunId();
    const row = clarificationRowsFor(c.store, c.sessionId, runId)!;
    expect(row.status).toBe("pending");
    expect(row.candidates).toEqual([]);
    expect(row.missingField).toBe("selection");

    // Exact-option resolve cannot invent a match.
    const rejected = await request(c.app)
      .post(`/api/clarifications/${row.id}/resolve`)
      .set("Cookie", c.cookie)
      .send({ optionId: ALICE_ONE });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(400);
    expect(rejected.body.code).toBe("unknown_option");
    // A rejected option leaves the clarification answerable.
    expect(clarificationRowsFor(c.store, c.sessionId, runId)?.status).toBe("pending");

    // Free-text continuation still resumes the same run.
    const continued = await c.chat("use yesterday instead", { continuationRunId: runId });
    expect(continued.status, JSON.stringify(continued.body)).toBe(200);
    const settled = c.store.getPendingClarification(row.id, c.runScope(runId));
    expect(settled?.status).toBe("continued");
    expect(settled?.terminalReason).toBe("free_text_continuation");
  });

  it("suspends on the run's one open question when a single batch produces two ambiguous reads", async () => {
    // `idx_pending_clarifications_one_active_per_run` allows exactly one active
    // row per run, and the read pool resolves EVERY call in a batch before any
    // outcome suspends the run — so the second create collides. The colliding
    // read must NOT adopt the winner's row (that would render one read's question
    // above the other read's chips — pre-T18 review MEDIUM); it reports
    // `clarification_already_active` and the run suspends on the row's real
    // owner, so exactly one question and one event exist.
    const c = await makeV2App([
      { text: "", toolCalls: [{ id: "tc-find", name: DISCOVERY_META_TOOL_NAME, arguments: { query: "list time entries" } }] },
      {
        text: "",
        toolCalls: [
          { id: "tc-a", name: "clockify_entries_list", arguments: { userId: "Alice" } },
          { id: "tc-b", name: "clockify_entries_list", arguments: { userId: "alice" } },
        ],
      },
      { text: "All done.", toolCalls: [] },
    ]);

    const res = await c.chat("list entries for Alice twice");
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const runId = c.activeRunId();
    const row = clarificationRowsFor(c.store, c.sessionId, runId);
    expect(row).toBeDefined();
    expect(row!.status).toBe("pending");

    // Exactly one clarification.required event, naming the one row that exists.
    const events = await c.readEvents(runId);
    const required = events.filter((e) => e.event.eventType === "clarification.required");
    expect(required).toHaveLength(1);
    expect(required[0]!.event.payload.clarificationId).toBe(row!.id);

    const run = c.store.getRun(c.getRunScope(runId));
    expect(run?.continuation).toEqual({ kind: "awaiting_clarification", clarificationId: row!.id });
  });

  it("journals every executed read in a batch that suspends on an earlier clarification", async () => {
    // The read pool resolves EVERY call before any outcome suspends the run, so
    // the second read below really executed and really persisted a result.
    // Returning at the first clarification erased it from the journal entirely.
    const c = await makeV2App([
      { text: "", toolCalls: [{ id: "tc-find", name: DISCOVERY_META_TOOL_NAME, arguments: { query: "list time entries" } }] },
      {
        text: "",
        toolCalls: [
          // Ambiguous: two members are named exactly "Alice".
          { id: "tc-clarify", name: "clockify_entries_list", arguments: { userId: "Alice" } },
          // Unambiguous: exactly one "Bob".
          { id: "tc-after", name: "clockify_entries_list", arguments: { userId: "Bob" } },
        ],
      },
      { text: "All done.", toolCalls: [] },
    ]);

    const res = await c.chat("list entries for Alice and Bob");
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const runId = c.activeRunId();
    const events = await c.readEvents(runId);
    const forCall = (id: string) =>
      events.filter((e) => e.event.payload.toolCallId === id).map((e) => e.event.eventType);

    // The clarifying read is requested and started; it has no terminal event
    // because it produced a question rather than a result.
    expect(forCall("tc-clarify")).toEqual(["tool.requested", "tool.started"]);
    // The read AFTER it is journaled in full — this is the regression.
    expect(forCall("tc-after")).toEqual(["tool.requested", "tool.started", "tool.completed"]);

    // Provider order is preserved, and the suspension is journaled last.
    const order = events.map((e) => e.event.eventType);
    expect(order.indexOf("tool.completed")).toBeLessThan(order.indexOf("clarification.required"));
    expect(order.indexOf("clarification.required")).toBeLessThan(order.indexOf("run.suspended"));

    // The journaled result is the real one the executed read persisted.
    const completed = events.find((e) => e.event.payload.toolCallId === "tc-after"
      && e.event.eventType === "tool.completed")!;
    const stored = c.store.getActionResult(completed.event.payload.actionResultId as string) as {
      receipt: { ok: boolean; data?: { userId?: string } };
    };
    expect(stored.receipt.ok).toBe(true);
    expect(stored.receipt.data?.userId).toBe("bbbbbbbbbbbbbbbbbbbbbbb1");

    // The run still suspends on the clarification.
    const rowAfter = clarificationRowsFor(c.store, c.sessionId, runId)!;
    expect(rowAfter.status).toBe("pending");
    expect(rowAfter.missingField).toBe("userId");
  });
});
