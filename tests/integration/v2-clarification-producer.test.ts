import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/server.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import { signSessionCookie } from "../../src/auth/sessions.js";
import { buildSessionCookie } from "../../src/routes/deps.js";
import { DISCOVERY_META_TOOL_NAME } from "../../src/harness/api-operation.js";
import type { RunEventAttachment } from "../../src/assistant-v2/events.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";
import { makeTestConfig } from "../helpers/config.js";
import { testKeys } from "../helpers/test-keys.js";
import { scriptedToolModel } from "../helpers/scripted-model.js";
import type { ToolCompletion } from "../../src/assistant/model-client.js";

/**
 * CP-B: the live clarification PRODUCER, end to end over real HTTP.
 *
 * Every case drives `createApp` with `assistantEngine: "v2"`, so the whole
 * chain is the real one: chat route -> v2 pipeline -> `runAssistantV2` ->
 * `ActionExecutionService` -> `executeV2Read` -> the real Clockify read action
 * and its real name resolver. Nothing here seeds a `pending_clarifications`
 * row by hand (that is what T14-D's route tests already do); the point is that
 * the product now CREATES one at runtime, journals it, hydrates it, and can
 * resolve it.
 */

const NOW = new Date("2026-07-26T00:00:00.000Z");
const ADDON_KEY = "addon-key";
const WORKSPACE_ID = "ws-1";
const ADMIN_ID = "admin-1";

// Two workspace members whose names match "Alice" EXACTLY: `matchByName`
// returns `kind: "many"`, so `resolveUserFilter` clarifies with both as
// grounded options carrying their real 24-hex ids.
const ALICE_ONE = "aaaaaaaaaaaaaaaaaaaaaaa1";
const ALICE_TWO = "aaaaaaaaaaaaaaaaaaaaaaa2";

const stores: Store[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function seededWorkspace() {
  return createFakeWorkspace({
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
  });
}

async function makeV2App(script: ToolCompletion[]): Promise<{
  app: Express;
  store: Store;
  cookie: string;
  session: ReturnType<Store["createSession"]>;
  /** Advance the one shared store + app clock. This ages an existing row exactly
   * the way wall-clock time does in production, without waiting or touching the
   * row. */
  setClock: (value: Date) => void;
}> {
  const keys = await testKeys();
  const config = makeTestConfig({
    clockifyAddonPublicKeyPem: keys.pem,
    clockifyAddonKey: ADDON_KEY,
    assistantEngine: "v2",
  });
  // ONE clock for the store and the app, as in production. Left unset the app
  // clock defaults to the REAL wall clock while the store writes rows at the
  // fixed `NOW`, so every row is born "expired" — the same skew class as the
  // T15-E session-cookie bug.
  let clock = NOW;
  const store = createStore(":memory:", { encryptionKey: "test-key", now: () => clock });
  stores.push(store);
  store.saveInstallation({
    workspaceId: WORKSPACE_ID,
    addonId: "addon-1",
    addonUserId: "addon-user-1",
    addonToken: "addon-token",
  });
  const fake = seededWorkspace();
  const app = createApp({
    config,
    store,
    parser: createSignatureParser(ADDON_KEY, keys.pem),
    modelClient: scriptedToolModel(script),
    clockifyForWorkspace: () => fake.client,
    now: () => clock,
  });
  const session = store.createSession({ workspaceId: WORKSPACE_ID, adminUserId: ADMIN_ID });
  // `verifySessionCookie` checks expiry against the REAL wall clock, so the
  // cookie carries a fixed far-future expiry (the store's own `expiresAt`,
  // which is session bookkeeping rather than auth, is untouched).
  const value = signSessionCookie(
    {
      sessionId: session.id,
      workspaceId: WORKSPACE_ID,
      adminUserId: ADMIN_ID,
      workspaceRole: "ADMIN",
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
    config.sessionSecret,
  );
  return {
    app,
    store,
    session,
    cookie: buildSessionCookie(value, false).split(";")[0]!,
    setClock: (value_: Date) => {
      clock = value_;
    },
  };
}

/** The v2 runner's first completion may only call the discovery meta-tool; the
 * requested read tool becomes callable in the NEXT completion. */
function discoverThenCall(query: string, call: { name: string; arguments: Record<string, unknown> }): ToolCompletion[] {
  return [
    { text: "", toolCalls: [{ id: "tc-find", name: DISCOVERY_META_TOOL_NAME, arguments: { query } }] },
    { text: "", toolCalls: [{ id: "tc-read", name: call.name, arguments: call.arguments }] },
    { text: "All done.", toolCalls: [] },
  ];
}

async function activeRunId(store: Store, sessionId: string): Promise<string> {
  const active = store.getActiveRunForSession(sessionId, WORKSPACE_ID, ADMIN_ID);
  if (!active) throw new Error("expected an active run");
  return active.runId;
}

function clarificationRowsFor(store: Store, sessionId: string, runId: string) {
  return store.getActiveClarificationForRun({
    sessionId,
    runId,
    workspaceId: WORKSPACE_ID,
    adminUserId: ADMIN_ID,
  });
}

function ndjsonFrames(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

type EventRow = {
  event: { eventType: string; payload: Record<string, unknown> };
  attachment?: RunEventAttachment;
};

async function readEvents(app: Express, cookie: string, runId: string): Promise<EventRow[]> {
  const res = await request(app)
    .get(`/api/runs/${runId}/events`)
    .query({ after: 0 })
    .set("Cookie", cookie);
  expect(res.status).toBe(200);
  return (res.body.events ?? res.body.data?.events) as EventRow[];
}

describe("CP-B: v2 reads produce, journal, hydrate, and resolve real clarifications", () => {
  it("creates exactly one durable pending_clarifications row from an ambiguous read", async () => {
    const { app, store, cookie, session } = await makeV2App(
      discoverThenCall("list time entries", {
        name: "clockify_entries_list",
        arguments: { userId: "Alice" },
      }),
    );

    const res = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "list Alice's time entries" });
    expect(res.status).toBe(200);

    const runId = await activeRunId(store, session.id);
    const row = clarificationRowsFor(store, session.id, runId);
    expect(row).toBeDefined();
    expect(row!.status).toBe("pending");
    expect(row!.originalToolName).toBe("clockify_entries_list");
    // CP-A: the exact raw-argument key, so an exact option can resolve into it.
    expect(row!.missingField).toBe("userId");
    expect(row!.partialArguments).toEqual({ userId: "Alice" });
    expect(row!.candidates).toHaveLength(2);
    expect(row!.candidates.map((c) => c.externalId).sort()).toEqual([ALICE_ONE, ALICE_TWO]);
    for (const candidate of row!.candidates) {
      expect(candidate.externalId).toMatch(/^[0-9a-f]{24}$/);
      expect(candidate.optionId).toBe(candidate.externalId);
      expect(candidate.label).toBe("Alice");
    }

    // The run is suspended on exactly this clarification.
    const run = store.getRun({
      sessionId: session.id,
      runId,
      workspaceId: WORKSPACE_ID,
      adminUserId: ADMIN_ID,
      installationGeneration: 1,
      authClass: "addon",
    });
    expect(run?.phase).toBe("awaiting_clarification");
    expect(run?.continuation).toEqual({ kind: "awaiting_clarification", clarificationId: row!.id });
  });

  it("journals clarification.required and hydrates a display-only pending_clarification attachment", async () => {
    const { app, store, cookie, session } = await makeV2App(
      discoverThenCall("list time entries", {
        name: "clockify_entries_list",
        arguments: { userId: "Alice" },
      }),
    );
    await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "list Alice's entries" });
    const runId = await activeRunId(store, session.id);
    const row = clarificationRowsFor(store, session.id, runId)!;

    const events = await readEvents(app, cookie, runId);
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
    expect(attachment.candidates.map((c) => c.optionId).sort()).toEqual([ALICE_ONE, ALICE_TWO]);
    expect(attachment.candidates.every((c) => c.label === "Alice")).toBe(true);
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
    const { app, store, cookie, session } = await makeV2App(
      discoverThenCall("list time entries", {
        name: "clockify_entries_list",
        arguments: { userId: "Alice" },
      }),
    );
    await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "list Alice's entries" });
    const runId = await activeRunId(store, session.id);
    const row = clarificationRowsFor(store, session.id, runId)!;
    const scope = { sessionId: session.id, runId, workspaceId: WORKSPACE_ID, adminUserId: ADMIN_ID };

    const res = await request(app)
      .post(`/api/clarifications/${row.id}/resolve`)
      .set("Cookie", cookie)
      .send({ optionId: ALICE_TWO });
    expect(res.status).toBe(200);
    const frames = ndjsonFrames(res.text);
    expect(frames.at(-1)?.type).toBe("done");

    const settled = store.getPendingClarification(row.id, scope);
    expect(settled?.status).toBe("resolved");
    expect(settled?.terminalReason).toBe("selected_option");
    expect(settled?.selectedOptionId).toBe(ALICE_TWO);
    // The terminal row is scrubbed (schema trigger + store contract).
    expect(settled?.candidates).toEqual([]);
    expect(settled?.partialArguments).toEqual({});

    // The read really executed, with the CHOSEN 24-hex id — not the name.
    const stored = store.getActionResult(settled!.actionResultId!) as {
      kind: string;
      receipt: { ok: boolean; action: string; data?: { userId?: string } };
    };
    expect(stored.kind).toBe("receipt");
    expect(stored.receipt.ok).toBe(true);
    expect(stored.receipt.action).toBe("clockify_entries_list");
    expect(stored.receipt.data?.userId).toBe(ALICE_TWO);

    // The run advanced past the clarification (the scripted model then finished).
    expect(store.getActiveRunForSession(session.id, WORKSPACE_ID, ADMIN_ID)).toBeUndefined();
  });

  it("stops rendering a settled clarification as live", async () => {
    const { app, store, cookie, session } = await makeV2App(
      discoverThenCall("list time entries", {
        name: "clockify_entries_list",
        arguments: { userId: "Alice" },
      }),
    );
    await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "list Alice's entries" });
    const runId = await activeRunId(store, session.id);
    const row = clarificationRowsFor(store, session.id, runId)!;

    const before = await readEvents(app, cookie, runId);
    expect(before.find((e) => e.event.eventType === "clarification.required")?.attachment).toBeDefined();

    await request(app)
      .post(`/api/clarifications/${row.id}/resolve`)
      .set("Cookie", cookie)
      .send({ optionId: ALICE_ONE });

    const after = await readEvents(app, cookie, runId);
    const required = after.find((e) => e.event.eventType === "clarification.required");
    expect(required).toBeDefined();
    expect(required!.attachment).toBeUndefined();
  });

  it("stops rendering an expired but unswept clarification as live", async () => {
    // Expiry is enforced at claim time and only LAZILY by the retention sweep,
    // so a still-`pending` row can outlive its TTL in the database. Hydrating on
    // status alone rendered live chips that 410 on click.
    const { app, store, cookie, session, setClock } = await makeV2App(
      discoverThenCall("list time entries", {
        name: "clockify_entries_list",
        arguments: { userId: "Alice" },
      }),
    );
    await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "list Alice's entries" });
    const runId = await activeRunId(store, session.id);
    const row = clarificationRowsFor(store, session.id, runId)!;
    const scope = { sessionId: session.id, runId, workspaceId: WORKSPACE_ID, adminUserId: ADMIN_ID };

    // Live at creation time.
    const live = await readEvents(app, cookie, runId);
    expect(live.find((e) => e.event.eventType === "clarification.required")?.attachment).toBeDefined();

    // Past the 5-minute TTL, with NO sweep and NO status change.
    setClock(new Date(Date.parse(row.expiresAt) + 1));
    expect(store.getPendingClarification(row.id, scope)?.status).toBe("pending");

    const after = await readEvents(app, cookie, runId);
    const required = after.find((e) => e.event.eventType === "clarification.required");
    expect(required).toBeDefined();
    expect(required!.attachment).toBeUndefined();

    // ...and the row it would have offered really is unclaimable, so nothing
    // truthful was withheld.
    expect(() => store.claimClarificationResolving(row.id, scope)).toThrow(/clarification_expired/);
  });

  it("creates a candidate-free row for a clarification with no single owning argument", async () => {
    // A date-range clarify (`resolveDateRange`) carries no options and no owning
    // argument, so the row stores the inert `"selection"` marker: resolve-by-option
    // can never match, and free-text continuation (T14-E) is the only answer.
    const { app, store, cookie, session } = await makeV2App(
      discoverThenCall("list time entries", {
        name: "clockify_entries_list",
        arguments: { start: "not-a-real-date" },
      }),
    );
    await request(app).post("/api/chat/messages").set("Cookie", cookie).send({ message: "list entries since not-a-real-date" });

    const runId = await activeRunId(store, session.id);
    const row = clarificationRowsFor(store, session.id, runId)!;
    expect(row.status).toBe("pending");
    expect(row.candidates).toEqual([]);
    expect(row.missingField).toBe("selection");

    // Exact-option resolve cannot invent a match.
    const rejected = await request(app)
      .post(`/api/clarifications/${row.id}/resolve`)
      .set("Cookie", cookie)
      .send({ optionId: ALICE_ONE });
    expect(rejected.status).toBe(400);
    expect(rejected.body.code).toBe("unknown_option");
    // A rejected option leaves the clarification answerable.
    expect(clarificationRowsFor(store, session.id, runId)?.status).toBe("pending");

    // Free-text continuation still resumes the same run.
    const continued = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "use yesterday instead", continuationRunId: runId });
    expect(continued.status).toBe(200);
    const settled = store.getPendingClarification(row.id, {
      sessionId: session.id,
      runId,
      workspaceId: WORKSPACE_ID,
      adminUserId: ADMIN_ID,
    });
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
    const { app, store, cookie, session } = await makeV2App([
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

    const res = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "list entries for Alice twice" });
    expect(res.status).toBe(200);

    const runId = await activeRunId(store, session.id);
    const row = clarificationRowsFor(store, session.id, runId);
    expect(row).toBeDefined();
    expect(row!.status).toBe("pending");

    // Exactly one clarification.required event, naming the one row that exists.
    const events = await readEvents(app, cookie, runId);
    const required = events.filter((e) => e.event.eventType === "clarification.required");
    expect(required).toHaveLength(1);
    expect(required[0]!.event.payload.clarificationId).toBe(row!.id);

    const run = store.getRun({
      sessionId: session.id,
      runId,
      workspaceId: WORKSPACE_ID,
      adminUserId: ADMIN_ID,
      installationGeneration: 1,
      authClass: "addon",
    });
    expect(run?.continuation).toEqual({ kind: "awaiting_clarification", clarificationId: row!.id });
  });

  it("journals every executed read in a batch that suspends on an earlier clarification", async () => {
    // The read pool resolves EVERY call before any outcome suspends the run, so
    // the second read below really executed and really persisted a result.
    // Returning at the first clarification erased it from the journal entirely.
    const { app, store, cookie, session } = await makeV2App([
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

    const res = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "list entries for Alice and Bob" });
    expect(res.status).toBe(200);

    const runId = await activeRunId(store, session.id);
    const events = await readEvents(app, cookie, runId);
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
    const stored = store.getActionResult(completed.event.payload.actionResultId as string) as {
      receipt: { ok: boolean; data?: { userId?: string } };
    };
    expect(stored.receipt.ok).toBe(true);
    expect(stored.receipt.data?.userId).toBe("bbbbbbbbbbbbbbbbbbbbbbb1");

    // The run still suspends on the clarification.
    const row = clarificationRowsFor(store, session.id, runId)!;
    expect(row.status).toBe("pending");
    expect(row.missingField).toBe("userId");
  });
});
