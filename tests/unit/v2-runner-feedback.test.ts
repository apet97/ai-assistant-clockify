import { describe, expect, it, vi } from "vitest";
import { runAssistantV2 } from "../../src/assistant-v2/runner.js";
import { boundedDenialCode } from "../../src/assistant-v2/observations.js";
import { runEventPayloadSchemas } from "../../src/assistant-v2/events.js";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
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

/** A prior run in the same scope, so the exact-scope cache seed loads the tool
 * under test. Without it every call is denied `tool_not_loaded` before it can
 * reach the read or preparation port. */
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
    reserveDiscoveryCall: vi.fn(() => seq()),
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
      recoverOrphanedActiveRuns: vi.fn(() => 0),
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
    const completeWithTools = vi.fn(async (messages: ModelMessage[]) => {
      seen.push(structuredClone(messages));
      return {
        text: "",
        toolCalls: [{ id: "call-w", name: "clockify_projects_create", arguments: { name: "asdasdsa" } }],
      };
    });

    const { deps } = statefulDeps(completeWithTools as never, "clockify_projects_create");

    await runAssistantV2({ runId: "run-1", scope: baseScope(), originalRequest: "Create a project named asdasdsa" }, deps);

    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(seen[1])).toContain("policy_denied");
  });

  it("reports the real denial code, never a bogus budget_exhausted", async () => {
    const completeWithTools = vi.fn(async () => ({
      text: "",
      toolCalls: [{ id: "call-w", name: "clockify_projects_create", arguments: { name: "asdasdsa" } }],
    }));

    const { deps } = statefulDeps(completeWithTools as never, "clockify_projects_create");

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

  it("does not burn the whole model-call budget on a provably unchanged request", async () => {
    const completeWithTools = vi.fn(async () => ({
      text: "",
      toolCalls: [{ id: "call-w", name: "clockify_projects_create", arguments: { name: "asdasdsa" } }],
    }));

    const { deps } = statefulDeps(completeWithTools as never, "clockify_projects_create");

    await runAssistantV2(
      { runId: "run-1", scope: baseScope(), originalRequest: "Create a project named asdasdsa" },
      deps,
    );

    // 6 identical provider round-trips producing nothing is the production
    // failure this whole file exists to prevent.
    expect(completeWithTools.mock.calls.length).toBeLessThan(6);
  });
});
