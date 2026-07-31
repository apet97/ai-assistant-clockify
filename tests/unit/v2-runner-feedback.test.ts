import { describe, expect, it, vi } from "vitest";
import { runAssistantV2 } from "../../src/assistant-v2/runner.js";
import { boundedDenialCode } from "../../src/assistant-v2/observations.js";
import { runEventPayloadSchemas } from "../../src/assistant-v2/events.js";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import { DISCOVERY_META_TOOL_NAME } from "../../src/harness/api-operation.js";
import type { ModelMessage, ToolCall } from "../../src/assistant/model-client.js";
import type { RunnerDependencies, RunScope } from "../../src/assistant-v2/protocol.js";
import type { RunState } from "../../src/assistant-v2/state.js";

/**
 * The v2 tool-result feedback channel.
 *
 * `buildFreshMessages` rebuilds the provider request from durable state on every
 * model call — deliberately, so no provider transcript is ever persisted. But a
 * run that executed tools and then rebuilds the request from the ORIGINAL
 * REQUEST ALONE hands the model byte-identical input on every iteration: it can
 * neither answer from what a read returned nor react to a denial. The loop then
 * burns `V2_LIMITS.maxModelCalls` and reports `budget_exhausted`
 * (`runner.ts:201`), which is a livelock, not a budget problem.
 *
 * These tests pin the contract that makes progress possible: whatever the run
 * durably learned in iteration N is visible to the model in iteration N+1.
 */

function baseScope(): RunScope {
  return {
    sessionId: "session-1",
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    installationGeneration: 1,
    authClass: "addon",
  };
}

/** A prior run in the same scope, mirroring the real store: the eligibility
 * query (`findLatestEligibleRunForCache`) returns whole prior runs whose
 * loaded/used lists may name ANY tool — it does not filter by kind. The REAL
 * `seedCacheFromPriorRun` then runs on this fake's return value, and post-A2
 * (defect D-1) it seeds only READ tools: a read under test is loaded before
 * its first call, while a WRITE named here is deliberately dropped and must be
 * loaded by the current run's own discovery call (`discoveryLoading` below),
 * exactly as production requires. */
function priorRunSeeding(toolName: string): RunState {
  return {
    version: 2,
    runId: "run-0",
    ...baseScope(),
    originalRequest: "earlier turn",
    requestHash: "hash-0",
    phase: "completed",
    registryId: "v2-api",
    catalogHash: MODEL_API_ACTION_CATALOG.hash(),
    loadedToolNames: [toolName],
    usedToolNames: [toolName],
    completedResults: [],
    pendingOperationIds: [],
    unfinishedOperations: [],
    continuation: { kind: "none" },
    budget: {
      modelCallsUsed: 0,
      discoveryCallsUsed: 0,
      apiCallsUsed: 0,
      hostCallsUsed: 0,
      promptTokensUsed: 0,
      completionTokensUsed: 0,
      activeWallMsUsed: 0,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as unknown as RunState;
}

/** Mirrors the real store: `tool.completed` appends to `completedResults`
 * (`db/store/run-events.ts:433-443`) and the runner reloads the persisted row.
 * The unit fakes in `v2-runner.test.ts` return `undefined` from `getRun`, which
 * keeps `completedResults` permanently empty and hides this entire class of bug. */
function statefulDeps(
  completeWithTools: RunnerDependencies["modelClient"]["completeWithTools"],
  seedToolName: string,
  overrides: Partial<RunnerDependencies> = {},
): { deps: RunnerDependencies; state: { current?: RunState } } {
  const held: { current?: RunState } = {};
  let sequence = 0;
  const seq = () => ({
    runId: "run-1",
    sequence: ++sequence,
    event: { eventType: "e", payload: {}, createdAt: new Date().toISOString() },
  });

  // Every event command carries the runner's current state, so the holder can be
  // seeded from the very first event rather than only once `callModel`'s
  // `saveRun` has run — otherwise the first reservation is silently dropped.
  const patch = (input: { state?: RunState }, fn: (s: RunState) => RunState) => {
    const base = held.current ?? input.state;
    if (base) held.current = fn(base);
    return seq();
  };

  const eventService = {
    startRun: vi.fn((input: { state?: RunState }) => {
      void input;
      return seq();
    }),
    // The real store increments the reservation as part of the same
    // transaction that writes `model.started`; without it `canReserveModelCall`
    // never trips and the loop runs far past `V2_LIMITS.maxModelCalls`.
    reserveModelCall: vi.fn((input: { state?: RunState; payload: { providerAttempt: 1 | 2 } }) =>
      patch(input, (s) =>
        input.payload.providerAttempt === 2
          ? s
          : { ...s, budget: { ...s.budget, modelCallsUsed: s.budget.modelCallsUsed + 1 } },
      ),
    ),
    completeModelCall: vi.fn(() => seq()),
    // Like `reserveModelCall`, the real store increments this inside the same
    // transaction that writes `api.search_started`. Without it
    // `canReserveDiscoveryCall` never trips and the budget is untestable.
    reserveDiscoveryCall: vi.fn((input: { state?: RunState }) =>
      patch(input, (s) => ({
        ...s,
        budget: { ...s.budget, discoveryCallsUsed: s.budget.discoveryCallsUsed + 1 },
      })),
    ),
    loadOperations: vi.fn(() => seq()),
    requestTool: vi.fn(() => seq()),
    denyTool: vi.fn(() => seq()),
    startTool: vi.fn(() => seq()),
    completeTool: vi.fn((input: { state?: RunState; payload: { toolCallId: string; actionName: string; actionResultId: string } }) =>
      patch(input, (s) => ({
        ...s,
        completedResults: s.completedResults.some((r) => r.toolCallId === input.payload.toolCallId)
          ? s.completedResults
          : [
              ...s.completedResults,
              {
                toolCallId: input.payload.toolCallId,
                actionName: input.payload.actionName,
                actionResultId: input.payload.actionResultId,
                sequence: s.completedResults.length,
              },
            ],
      })),
    ),
    requireClarification: vi.fn(() => seq()),
    suspendRun: vi.fn(() => seq()),
    completeRun: vi.fn(() => seq()),
    failRun: vi.fn(() => seq()),
  };

  const deps = {
    modelClient: { complete: vi.fn(), completeWithTools },
    runStore: {
      startRunWithTurn: vi.fn(),
      startRunWithEvent: vi.fn(),
      getRun: vi.fn(() => held.current),
      saveRun: vi.fn((s: RunState) => {
        held.current = s;
      }),
      getLastRunEventSequence: vi.fn(() => sequence),
      findLatestEligibleRunForCache: vi.fn(() => priorRunSeeding(seedToolName)),
      failActiveRunsForSession: vi.fn(() => 0),
    },
    eventService,
    eventViews: { list: vi.fn(() => ({ runId: "run-1", events: [], nextAfter: 0, hasMore: false, lastSequence: 0 })) },
    actionRegistry: MODEL_API_ACTION_CATALOG,
    discovery: { search: vi.fn(async () => ({ kind: "matches" as const, query: "x", access: "any" as const, operations: [] })) },
    reads: { execute: vi.fn(async () => ({ kind: "succeeded" as const, actionResultId: "result-1" })) },
    preparations: {
      prepare: vi.fn(async () => ({ kind: "denied" as const, code: "policy_denied", actionResultId: "prep-1" })),
    },
    installationGuard: { assertCurrent: vi.fn() },
    requestGovernor: {
      runRead: vi.fn(async (_scope: unknown, op: () => Promise<unknown>) => op()),
      remainingHostCalls: vi.fn(() => 60),
      persistHostCallAllowance: vi.fn(),
    },
    clock: { now: () => new Date(), monotonicMs: () => 0 },
    ...overrides,
  } as unknown as RunnerDependencies;

  return { deps, state: held };
}

const READ_CALL: ToolCall = { id: "call-1", name: "clockify_projects_list", arguments: {} };

const DISCOVER_CALL: ToolCall = {
  id: "find-1",
  name: DISCOVERY_META_TOOL_NAME,
  arguments: { query: "create a project" },
};

/** An in-run discovery result that loads the write under test. Post-A2 a write
 * is never seeded across turns, so these tests load it the way production does
 * — through the current run's own `assistant_find_api_operations` search. The
 * descriptor mirrors the real index's ranked output (`toolName` is the only
 * field `refineLoadedToolSet` reads). */
function discoveryLoading(toolName: string): RunnerDependencies["discovery"] {
  return {
    search: vi.fn(async () => ({
      kind: "matches" as const,
      query: "x",
      access: "any" as const,
      operations: [{ toolName }],
    })),
  } as unknown as RunnerDependencies["discovery"];
}

describe("denial codes stay inside the event payload bound", () => {
  it("keeps a code built from a thrown exception message persistable", () => {
    // Surfacing the real cause is worthless if writing it down throws: the
    // `tool.denied` payload bounds `code` at 256 UTF-8 bytes, and a raw
    // exception message routinely exceeds that.
    const raw = `write_port_not_ready: ${"SqliteError: no such table: assistant_runs ".repeat(20)}`;
    const bounded = boundedDenialCode(raw);

    expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(256);
    expect(bounded.startsWith("write_port_not_ready:")).toBe(true);
    expect(() =>
      runEventPayloadSchemas["tool.denied"].parse({
        toolCallId: "call-1",
        actionName: "clockify_projects_create",
        code: bounded,
      }),
    ).not.toThrow();
  });

  it("does not cut a multi-byte character into a replacement glyph", () => {
    const bounded = boundedDenialCode("é".repeat(400));

    expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(256);
    expect(bounded).not.toContain("�");
  });

  it("leaves an ordinary short code byte-identical", () => {
    expect(boundedDenialCode("policy_denied")).toBe("policy_denied");
  });
});

describe("v2 tool-result feedback", () => {
  it("shows the model what a completed read returned, so the next iteration can differ", async () => {
    const seen: ModelMessage[][] = [];
    const completeWithTools = vi.fn(async (messages: ModelMessage[]) => {
      seen.push(structuredClone(messages));
      // A real provider handed byte-identical input has no reason to change its
      // answer. Script exactly that: the same read, every time.
      return { text: "", toolCalls: [READ_CALL] };
    });

    const { deps } = statefulDeps(completeWithTools as never, "clockify_projects_list", {
      reads: {
        execute: vi.fn(async () => ({
          kind: "succeeded" as const,
          actionResultId: "result-1",
          modelSummary: 'Projects: "Apollo", "Borealis"',
        })),
      } as unknown as RunnerDependencies["reads"],
    });

    await runAssistantV2({ runId: "run-1", scope: baseScope(), originalRequest: "list my projects" }, deps);

    expect(seen.length).toBeGreaterThanOrEqual(2);
    const first = JSON.stringify(seen[0]);
    const second = JSON.stringify(seen[1]);
    expect(second).not.toBe(first);
    expect(second).toContain("Apollo");
  });

  it("shows the model why a write was denied instead of silently repeating the request", async () => {
    const seen: ModelMessage[][] = [];
    let call = 0;
    const completeWithTools = vi.fn(async (messages: ModelMessage[]) => {
      seen.push(structuredClone(messages));
      call += 1;
      // Post-A2 the write is not seeded from the prior run: the model loads it
      // with an in-run discovery call first, then the denied preparation's
      // code must reach the next request.
      if (call === 1) return { text: "", toolCalls: [DISCOVER_CALL] };
      return {
        text: "",
        toolCalls: [{ id: "call-w", name: "clockify_projects_create", arguments: { name: "asdasdsa" } }],
      };
    });

    const { deps } = statefulDeps(completeWithTools as never, "clockify_projects_create", {
      discovery: discoveryLoading("clockify_projects_create"),
    });

    await runAssistantV2({ runId: "run-1", scope: baseScope(), originalRequest: "Create a project named asdasdsa" }, deps);

    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(seen[2])).toContain("policy_denied");
  });

  it("reports the real denial code, never a bogus budget_exhausted", async () => {
    let call = 0;
    const completeWithTools = vi.fn(async () => {
      call += 1;
      if (call === 1) return { text: "", toolCalls: [DISCOVER_CALL] };
      return {
        text: "",
        toolCalls: [{ id: "call-w", name: "clockify_projects_create", arguments: { name: "asdasdsa" } }],
      };
    });

    const { deps } = statefulDeps(completeWithTools as never, "clockify_projects_create", {
      discovery: discoveryLoading("clockify_projects_create"),
    });

    const outcome = await runAssistantV2(
      { runId: "run-1", scope: baseScope(), originalRequest: "Create a project named asdasdsa" },
      deps,
    );

    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") {
      expect(outcome.code).not.toBe("budget_exhausted");
      expect(outcome.code).toContain("policy_denied");
    }
  });

  it("denies a third discovery search instead of destroying the whole run", async () => {
    // Every other budget in v2 denies the individual call and lets the run
    // continue; only discovery was fatal, so a compound request that explored
    // one search too many ("create a tag and apply it to all entries") lost
    // everything to `too_many_refinements` — including tools already loaded.
    const seen: ModelMessage[][] = [];
    let call = 0;
    const completeWithTools = vi.fn(async (messages: ModelMessage[]) => {
      seen.push(structuredClone(messages));
      call += 1;
      if (call <= 3) {
        return {
          text: "",
          toolCalls: [{
            id: `search-${call}`,
            name: DISCOVERY_META_TOOL_NAME,
            arguments: { query: `attempt ${call}` },
          }],
        };
      }
      return { text: "Here is what I found.", toolCalls: [] };
    });

    const { deps } = statefulDeps(completeWithTools as never, "clockify_tags_create");
    const outcome = await runAssistantV2(
      { runId: "run-1", scope: baseScope(), originalRequest: "create a tag and apply it to all entries" },
      deps,
    );

    expect(outcome.kind).toBe("completed");
    // The over-budget search is reported back so the model stops searching.
    expect(JSON.stringify(seen[3] ?? [])).toContain("too_many_refinements");
  });

  it("carries the model's own answer out of the run, not a canned string", async () => {
    // A read's deliverable IS the model's prose. `v2OutcomeToTurn` used to
    // substitute "Completed." unconditionally, so a run that executed a read
    // and answered from it rendered as though nothing had happened.
    const completeWithTools = vi.fn(async () => ({
      text: "You tracked 3h 20m today on Apollo.",
      toolCalls: [],
    }));

    const { deps } = statefulDeps(completeWithTools as never, "clockify_entries_list");
    const outcome = await runAssistantV2(
      { runId: "run-1", scope: baseScope(), originalRequest: "What did I track today?" },
      deps,
    );

    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") throw new Error("expected completion");
    expect(outcome.replyText).toBe("You tracked 3h 20m today on Apollo.");
  });

  it("omits an empty or whitespace-only model answer rather than showing a blank reply", async () => {
    const completeWithTools = vi.fn(async () => ({ text: "   \n ", toolCalls: [] }));
    const { deps } = statefulDeps(completeWithTools as never, "clockify_entries_list");
    const outcome = await runAssistantV2(
      { runId: "run-1", scope: baseScope(), originalRequest: "hello" },
      deps,
    );

    expect(outcome.kind).toBe("completed");
    if (outcome.kind !== "completed") throw new Error("expected completion");
    // Absent, so the caller's deterministic fallback applies.
    expect(outcome.replyText).toBeUndefined();
  });

  it("does not burn the whole model-call budget on a provably unchanged request", async () => {
    let call = 0;
    const completeWithTools = vi.fn(async () => {
      call += 1;
      if (call === 1) return { text: "", toolCalls: [DISCOVER_CALL] };
      return {
        text: "",
        toolCalls: [{ id: "call-w", name: "clockify_projects_create", arguments: { name: "asdasdsa" } }],
      };
    });

    const { deps } = statefulDeps(completeWithTools as never, "clockify_projects_create", {
      discovery: discoveryLoading("clockify_projects_create"),
    });

    await runAssistantV2(
      { runId: "run-1", scope: baseScope(), originalRequest: "Create a project named asdasdsa" },
      deps,
    );

    // 6 identical provider round-trips producing nothing is the production
    // failure this whole file exists to prevent.
    expect(completeWithTools.mock.calls.length).toBeLessThan(6);
  });
});
