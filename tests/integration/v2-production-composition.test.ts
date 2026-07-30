import { describe, expect, it } from "vitest";
import request from "supertest";
import {
  composeV2ProductionApp,
  discoverThenCall,
  V2_COMPOSITION_NOW,
} from "../helpers/v2-production-composition.js";
import { DISCOVERY_META_TOOL_NAME } from "../../src/harness/api-operation.js";

/**
 * PR 1 (closure plan): characterization proof that the production-composition
 * harness drives the REAL v2 vertical — createApp, real SQLite, production
 * catalog/index, scripted native-tool model, fake Clockify — and that its
 * counters and inspection handles are trustworthy. Later PRs add their own
 * red→green suites on this helper; nothing here pins behavior that the closure
 * plan is about to change (transcript, results delivery, run settlement).
 */

const TWO_ALICES = {
  users: [
    { id: "aaaaaaaaaaaaaaaaaaaaaaa1", name: "Alice", email: "alice.one@example.com" },
    { id: "aaaaaaaaaaaaaaaaaaaaaaa2", name: "Alice", email: "alice.two@example.com" },
  ],
};

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

describe("v2 production composition harness", () => {
  it("drives a real read run to completion with the model's own answer and a canonical result", async () => {
    const c = await composeV2ProductionApp({
      script: discoverThenCall(
        "list time entries",
        { name: "clockify_entries_list", arguments: {} },
        "You tracked one hour of spec work.",
      ),
      seed: ONE_ENTRY,
    });

    const res = await c.chat("what did I track yesterday?");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.reply.kind).toBe("final");
    // The model's real answer reaches the admin — not a canned "Completed.".
    expect(res.body.reply.text).toBe("You tracked one hour of spec work.");

    // The run is terminal, findable, and its persisted budget matches the work.
    expect(c.store.getActiveRunForSession(c.sessionId, c.workspaceId, c.adminUserId)).toBeUndefined();
    const runId = c.latestRunId();
    const run = c.store.getRun(c.getRunScope(runId));
    expect(run?.phase).toBe("completed");
    expect(run?.budget.modelCallsUsed).toBe(3);
    expect(run?.budget.discoveryCallsUsed).toBe(1);
    expect(run?.budget.apiCallsUsed).toBe(1);

    // The journal has the full shape, in order, ending terminal.
    const events = await c.readEvents(runId);
    const order = events.map((e) => e.event.eventType);
    expect(order[0]).toBe("run.started");
    expect(order.at(-1)).toBe("run.completed");
    for (const required of ["model.started", "api.search_started", "tool.requested", "tool.started", "tool.completed"]) {
      expect(order).toContain(required);
    }

    // The executed read persisted a REAL canonical action result.
    const completed = events.find((e) => e.event.eventType === "tool.completed")!;
    const stored = c.store.getActionResult(completed.event.payload.actionResultId as string) as {
      kind: string;
      receipt: { ok: boolean; action: string };
    };
    expect(stored.kind).toBe("receipt");
    expect(stored.receipt.ok).toBe(true);
    expect(stored.receipt.action).toBe("clockify_entries_list");

    // Counter contract: three provider calls, at least one Clockify read, no writes.
    expect(c.providerCalls()).toBe(3);
    expect(c.clockifyCalls()).toBeGreaterThanOrEqual(1);
    expect(c.clockifyMutations()).toBe(0);
  });

  it("prepares a write preview with ZERO Clockify mutations and a durable pending confirmation", async () => {
    const c = await composeV2ProductionApp({
      script: discoverThenCall("create a project", {
        name: "clockify_projects_create",
        arguments: { name: "Harness Probe" },
      }),
    });

    const res = await c.chat("create a project called Harness Probe");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.reply.kind).toBe("preview");

    // Suspended awaiting the button; nothing reached Clockify.
    const active = c.store.getActiveRunForSession(c.sessionId, c.workspaceId, c.adminUserId);
    expect(active?.phase).toBe("awaiting_confirmation");
    expect(c.clockifyMutations()).toBe(0);
    expect(
      c.store.countPendingConfirmations(c.sessionId, V2_COMPOSITION_NOW.toISOString()),
    ).toBe(1);
    // The run suspended before a third completion was requested.
    expect(c.providerCalls()).toBe(2);
  });

  it("journals every admitted write request before its prepared operation (M2)", async () => {
    // Fake fidelity: only provider completions and Clockify I/O use their
    // production injection seams. The app, runner, SQLite journal, action
    // execution service, and operation preparation service are all real.
    const c = await composeV2ProductionApp({
      script: [
        {
          text: "",
          toolCalls: [{
            id: "tc-find",
            name: DISCOVERY_META_TOOL_NAME,
            arguments: { query: "create tags" },
          }],
        },
        {
          text: "",
          toolCalls: [
            { id: "tc-tag", name: "clockify_tags_create", arguments: { name: "Journal Tag" } },
            { id: "tc-project", name: "clockify_projects_create", arguments: { name: "Journal Project" } },
          ],
        },
      ],
    });

    const response = await c.chat("create a tag named Journal Tag and a project named Journal Project");
    expect(response.status).toBe(200);
    expect(response.body.reply.kind).toBe("preview");

    const events = await c.readEvents(c.activeRunId());
    const requested = events.filter((entry) => entry.event.eventType === "tool.requested");
    expect(requested.map((entry) => entry.event.payload)).toEqual([
      expect.objectContaining({ toolCallId: "tc-tag", actionName: "clockify_tags_create" }),
      expect.objectContaining({ toolCallId: "tc-project", actionName: "clockify_projects_create" }),
    ]);

    const preparedByAction = new Map<string, number>();
    for (const [index, entry] of events.entries()) {
      if (entry.event.eventType !== "operation.prepared") continue;
      const operation = c.store.getOperationRun(String(entry.event.payload.operationId));
      expect(operation).toBeDefined();
      preparedByAction.set(operation!.actionName, index);
    }
    expect([...preparedByAction.keys()]).toEqual([
      "clockify_tags_create",
      "clockify_projects_create",
    ]);
    for (const entry of requested) {
      const requestedAt = events.indexOf(entry);
      const preparedAt = preparedByAction.get(String(entry.event.payload.actionName));
      expect(preparedAt).toBeDefined();
      expect(requestedAt).toBeLessThan(preparedAt!);
    }
  });

  it("persists an intentional suspension across a real store reopen (file-backed)", async () => {
    const c = await composeV2ProductionApp({
      script: discoverThenCall("list time entries", {
        name: "clockify_entries_list",
        arguments: { userId: "Alice" },
      }),
      seed: TWO_ALICES,
      fileBacked: true,
    });

    await c.chat("list Alice's entries");
    const runId = c.activeRunId();
    const scope = c.runScope(runId);
    const before = c.store.getActiveClarificationForRun(scope);
    expect(before?.status).toBe("pending");

    // Restart: a fresh store on the same file. Open-time orphan recovery must
    // leave the INTENTIONALLY suspended run and its clarification untouched.
    const reopened = c.reopenStore();
    const run = reopened.getRun(c.getRunScope(runId));
    expect(run?.phase).toBe("awaiting_clarification");
    const after = reopened.getActiveClarificationForRun(scope);
    expect(after?.status).toBe("pending");
    expect(after?.id).toBe(before!.id);
  });

  it("blocks unmocked network calls while open and restores fetch on close", async () => {
    const original = globalThis.fetch;
    const c = await composeV2ProductionApp({});
    expect(globalThis.fetch).not.toBe(original);
    expect(() => globalThis.fetch("https://example.com/should-never-happen")).toThrow(
      /unmocked network call blocked/,
    );
    c.close();
    expect(globalThis.fetch).toBe(original);
    // close() is idempotent (onTestFinished will call it again).
    c.close();
    expect(globalThis.fetch).toBe(original);
  });

  it("mints independent additional sessions that can drive their own turns", async () => {
    const c = await composeV2ProductionApp({
      script: [{ text: "Hello from the second session.", toolCalls: [] }],
    });
    const second = c.mintSession();
    expect(second.sessionId).not.toBe(c.sessionId);

    const res = await request(c.app)
      .post("/api/chat/messages")
      .set("Cookie", second.cookie)
      .send({ message: "hello" });
    expect(res.status).toBe(200);
    expect(res.body.reply.kind).toBe("final");
    expect(res.body.reply.text).toBe("Hello from the second session.");
  });
});
