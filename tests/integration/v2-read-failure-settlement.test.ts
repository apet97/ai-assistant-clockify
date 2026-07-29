import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { computeRequestHash } from "../../src/assistant-v2/state.js";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import { DISCOVERY_META_TOOL_NAME } from "../../src/harness/api-operation.js";
import { composeV2ProductionApp } from "../helpers/v2-production-composition.js";

/**
 * Closure-plan PR 5 (F03): a throwing Clockify read settles as a typed,
 * journaled failure — every started sibling drains, the run terminalizes, and
 * the session's next message works without a restart. Stranded active runs
 * (a request that died mid-flight, or a process crash) are failed WITH their
 * `run.failed` event at the next request or at startup recovery.
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

const MIXED_BATCH_SCRIPT = [
  { text: "", toolCalls: [{ id: "tc-find", name: DISCOVERY_META_TOOL_NAME, arguments: { query: "list entries and projects" } }] },
  {
    text: "",
    toolCalls: [
      { id: "tc-ok", name: "clockify_entries_list", arguments: {} },
      { id: "tc-boom", name: "clockify_projects_list", arguments: {} },
    ],
  },
  { text: "Here is what I could read.", toolCalls: [] },
];

describe("v2 read failure settlement (F03)", () => {
  it("a throwing read becomes a typed journaled failure; siblings settle and the run completes", async () => {
    const c = await composeV2ProductionApp({ script: MIXED_BATCH_SCRIPT, seed: ONE_ENTRY });
    // Simulate a Clockify transport failure on ONE read only.
    (c.workspace.client as { listProjects: unknown }).listProjects = async () => {
      throw new Error("ECONNRESET: socket hang up");
    };

    const res = await c.chat("list my entries and projects");
    expect(res.status).toBe(200);
    expect(res.body.reply.kind).toBe("final");

    // The run is TERMINAL — not stranded at executing_reads.
    expect(c.store.getActiveRunForSession(c.sessionId, c.workspaceId, c.adminUserId)).toBeUndefined();
    const runId = c.latestRunId();
    expect(c.store.getRun(c.getRunScope(runId))?.phase).toBe("completed");

    const events = await c.readEvents(runId);
    const forCall = (id: string) =>
      events.filter((e) => e.event.payload.toolCallId === id).map((e) => e.event.eventType);
    // The healthy sibling settled fully.
    expect(forCall("tc-ok")).toEqual(["tool.requested", "tool.started", "tool.completed"]);
    // The throwing read is journaled as a denial WITH its canonical failure
    // result linked (F22's link half), never silently dropped.
    expect(forCall("tc-boom")).toEqual(["tool.requested", "tool.started", "tool.denied"]);
    const denied = events.find((e) =>
      e.event.eventType === "tool.denied" && e.event.payload.toolCallId === "tc-boom")!;
    const linkedId = denied.event.payload.actionResultId as string;
    expect(typeof linkedId).toBe("string");
    const stored = c.store.getActionResult(linkedId) as { receipt: { ok: boolean; code: string } };
    expect(stored.receipt.ok).toBe(false);
    expect(stored.receipt.code).toBe("read_failed");

    // The session is immediately usable.
    const next = await c.chat("thanks");
    expect(next.status).toBe(200);
  });

  it("a stranded ACTIVE run is failed with its run.failed event at the next message", async () => {
    const c = await composeV2ProductionApp({ script: [{ text: "Fresh answer.", toolCalls: [] }] });
    // A prior request died mid-flight, leaving an active `model`-phase run.
    const strandedRunId = randomUUID();
    c.store.startRunWithEvent({
      scope: c.getRunScope(strandedRunId),
      originalRequest: "the request that died",
      requestHash: computeRequestHash("the request that died"),
      catalogHash: MODEL_API_ACTION_CATALOG.hash(),
      loadedToolNames: [],
      intentHash: strandedRunId,
    });
    expect(c.store.getActiveRunForSession(c.sessionId, c.workspaceId, c.adminUserId)?.phase).toBe("model");

    const res = await c.chat("hello again");
    expect(res.status).toBe(200);
    expect(res.body.reply.text).toBe("Fresh answer.");

    // The stranded run failed DURABLY, with the event in its journal.
    expect(c.store.getRun(c.getRunScope(strandedRunId))?.phase).toBe("failed");
    const events = await c.readEvents(strandedRunId);
    const failed = events.filter((e) => e.event.eventType === "run.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.event.payload.code).toBe("stranded_active_run");
  });

  it("startup recovery appends run.failed for orphaned active runs", async () => {
    const c = await composeV2ProductionApp({ fileBacked: true });
    const orphanRunId = randomUUID();
    c.store.startRunWithEvent({
      scope: c.getRunScope(orphanRunId),
      originalRequest: "interrupted by a crash",
      requestHash: computeRequestHash("interrupted by a crash"),
      catalogHash: MODEL_API_ACTION_CATALOG.hash(),
      loadedToolNames: [],
      intentHash: orphanRunId,
    });

    // "Crash": reopen the database — open-time recovery runs.
    const reopened = c.reopenStore();
    expect(reopened.getRun(c.getRunScope(orphanRunId))?.phase).toBe("failed");
    const page = reopened.listRunEvents({ scope: c.getRunScope(orphanRunId), after: 0, limit: 50 });
    const failed = page.events.filter((e) => e.event.eventType === "run.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]!.event.payload).toEqual({ code: "interrupted_before_durable_completion" });
  });
});
