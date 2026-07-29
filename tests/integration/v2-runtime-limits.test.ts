import { describe, expect, it } from "vitest";
import { DISCOVERY_META_TOOL_NAME } from "../../src/harness/api-operation.js";
import {
  composeV2ProductionApp,
  discoverThenCall,
} from "../helpers/v2-production-composition.js";

/**
 * Closure-plan PR 7 (F11/F17/F18): the advertised runtime limits match their
 * contracts — writes count as logical API calls, discovery input passes the
 * strict runtime parser, canonical duplicate writes are rejected, and
 * provider tool-call ids are unique across the whole run.
 */

describe("v2 runtime limits", () => {
  it("a prepared write consumes a LOGICAL api call in the persisted budget (F17)", async () => {
    const c = await composeV2ProductionApp({
      script: discoverThenCall("create a project", {
        name: "clockify_projects_create",
        arguments: { name: "Limit Probe" },
      }),
    });
    await c.chat("create a project called Limit Probe");
    const run = c.store.getRun(c.getRunScope(c.activeRunId()))!;
    // The old write path checked the budget in a no-op loop and counted
    // nothing.
    expect(run.budget.apiCallsUsed).toBeGreaterThanOrEqual(1);
  });

  it("invalid discovery input is denied by the RUNTIME parser and never searches (F18)", async () => {
    const c = await composeV2ProductionApp({
      script: [
        {
          text: "",
          toolCalls: [{
            id: "tc-bad",
            name: DISCOVERY_META_TOOL_NAME,
            arguments: { query: "list", unexpected_key: true },
          }],
        },
        { text: "Understood.", toolCalls: [] },
      ],
    });
    const res = await c.chat("explore");
    expect(res.status).toBe(200);
    const events = await c.readEvents(c.latestRunId());
    const denied = events.filter((e) =>
      e.event.eventType === "tool.denied" && e.event.payload.toolCallId === "tc-bad");
    expect(denied).toHaveLength(1);
    expect(denied[0]!.event.payload.code).toBe("invalid_args");
    // The invalid call never reached the search: no discovery reservation.
    expect(events.some((e) => e.event.eventType === "api.search_started")).toBe(false);
  });

  it("two canonically-equivalent writes with reordered keys fail as duplicate_write (F11)", async () => {
    const c = await composeV2ProductionApp({
      script: [
        { text: "", toolCalls: [{ id: "tc-find", name: DISCOVERY_META_TOOL_NAME, arguments: { query: "create project" } }] },
        {
          text: "",
          toolCalls: [
            { id: "tc-1", name: "clockify_projects_create", arguments: { name: "Twin", billable: true } },
            { id: "tc-2", name: "clockify_projects_create", arguments: { billable: true, name: "Twin" } },
          ],
        },
      ],
    });
    const res = await c.chat("create the Twin project twice");
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("duplicate_write");
    // Nothing was prepared and nothing dispatched.
    expect(c.store.countPendingConfirmations(c.sessionId, new Date().toISOString())).toBe(0);
    expect(c.clockifyMutations()).toBe(0);
  });

  it("a provider tool-call id is unique across the RUN, not just one completion (PR 7)", async () => {
    const c = await composeV2ProductionApp({
      script: [
        { text: "", toolCalls: [{ id: "tc-find", name: DISCOVERY_META_TOOL_NAME, arguments: { query: "list tags" } }] },
        { text: "", toolCalls: [{ id: "tc-reuse", name: "clockify_tags_list", arguments: {} }] },
        // The SAME id again in a LATER completion of the same run.
        { text: "", toolCalls: [{ id: "tc-reuse", name: "clockify_tags_list", arguments: {} }] },
        { text: "Done.", toolCalls: [] },
      ],
      seed: { tags: [{ id: "aaaaaaaaaaaaaaaaaaaaaaa1", name: "urgent" }] as never },
    });
    const res = await c.chat("list tags twice");
    expect(res.status).toBe(200);
    const events = await c.readEvents(c.latestRunId());
    const forCall = events.filter((e) => e.event.payload.toolCallId === "tc-reuse");
    // First use completed; the run-wide reuse was denied.
    expect(forCall.some((e) => e.event.eventType === "tool.completed")).toBe(true);
    expect(forCall.some((e) =>
      e.event.eventType === "tool.denied" && e.event.payload.code === "duplicate_tool_call_id")).toBe(true);
  });

  it("read batches admit only the REMAINING logical allowance in provider order (F17)", async () => {
    // 13 reads in one completion against the 12-call ceiling: the 13th is
    // denied as budget_exhausted before dispatch.
    const reads = Array.from({ length: 13 }, (_, index) => ({
      id: `tc-r${index}`,
      name: "clockify_tags_list",
      arguments: {},
    }));
    const c = await composeV2ProductionApp({
      script: [
        { text: "", toolCalls: [{ id: "tc-find", name: DISCOVERY_META_TOOL_NAME, arguments: { query: "list tags" } }] },
        { text: "", toolCalls: reads },
        { text: "Done.", toolCalls: [] },
      ],
      seed: { tags: [{ id: "aaaaaaaaaaaaaaaaaaaaaaa1", name: "urgent" }] as never },
    });
    const res = await c.chat("list tags thirteen times");
    expect(res.status).toBe(200);
    const events = await c.readEvents(c.latestRunId());
    const denied = events.filter((e) =>
      e.event.eventType === "tool.denied" && e.event.payload.code === "budget_exhausted");
    expect(denied).toHaveLength(1);
    expect(denied[0]!.event.payload.toolCallId).toBe("tc-r12");
    const run = c.store.getRun(c.getRunScope(c.latestRunId()))!;
    expect(run.budget.apiCallsUsed).toBe(12);
  });
});
