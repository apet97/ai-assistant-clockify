import { describe, expect, it } from "vitest";
import { createApiDiscoveryService } from "../../src/services/api-discovery-service.js";
import { formatObservations } from "../../src/assistant-v2/observations.js";

/**
 * A search that loads nothing new has to SAY it loaded nothing new.
 *
 * Production journal for run 562f149d (2026-08-03), request "update all time
 * entries for all users ... to DESC":
 *
 *   seq 10  api.search_started    {access:"write", groups:["time_tracking"]}
 *   seq 11  api.operations_loaded  12 ops — including entries_list, users_list,
 *                                  entries_update: everything the request needed
 *   seq 14  api.search_started    {access:"write", groups:["time_tracking"]}  ← identical
 *   seq 15  api.operations_loaded  the SAME 12 ops, merely reordered
 *   seq 18  tool.denied           too_many_refinements
 *
 * The model already had every operation it needed and searched again anyway,
 * because a successful search pushed NO observation at all — `observations` was
 * appended only on denial. Its only feedback was the same operation list it got
 * the previous time, which reads as new information.
 *
 * The budget is 4 searches. Two of them were spent re-fetching an unchanged set.
 */

const SCOPE = {
  sessionId: "s1",
  workspaceId: "ws-1",
  adminUserId: "admin-1",
  installationGeneration: 1,
  authClass: "addon" as const,
};

function harness(loaded: string[]) {
  const state = {
    runId: "run-1",
    ...SCOPE,
    loadedToolNames: [...loaded],
    usedToolNames: [] as string[],
    budget: { discoveryCallsUsed: 0, modelCallsUsed: 0 },
  } as never;
  const events = {
    denyTool: () => undefined,
    reserveDiscoveryCall: () => undefined,
    loadOperations: () => undefined,
  };
  return createApiDiscoveryService({
    eventService: events as never,
    runStore: { getRun: () => state } as never,
    discovery: {
      // Always "finds" the same two operations.
      search: async () => ({
        kind: "matches" as const,
        query: "time entries",
        access: "any" as const,
        operations: [
          { toolName: "clockify_entries_list" },
          { toolName: "clockify_entries_update" },
        ],
      }),
    } as never,
  });
}

const CALL = [{ id: "c1", name: "assistant_find_api_operations", arguments: { query: "time entries" } }];

describe("a discovery search reports what it actually changed", () => {
  it("says nothing new was loaded when every match was already loaded", async () => {
    const service = harness(["clockify_entries_list", "clockify_entries_update"]);
    const result = await service.executeDiscoveryBatch(
      { runId: "run-1", ...SCOPE, loadedToolNames: ["clockify_entries_list", "clockify_entries_update"], usedToolNames: [], budget: { discoveryCallsUsed: 0 } } as never,
      CALL as never,
      SCOPE as never,
    );

    expect(result.observations.length).toBeGreaterThan(0);
    const line = formatObservations(result.observations).join(" ");
    expect(line).toMatch(/no new operations/i);
    // And the actionable half: stop searching, use what you have.
    expect(line).toMatch(/already loaded|call them|stop searching/i);
  });

  it("names the operations a productive search added", async () => {
    const service = harness([]);
    const result = await service.executeDiscoveryBatch(
      { runId: "run-1", ...SCOPE, loadedToolNames: [], usedToolNames: [], budget: { discoveryCallsUsed: 0 } } as never,
      CALL as never,
      SCOPE as never,
    );

    const line = formatObservations(result.observations).join(" ");
    expect(line).toContain("clockify_entries_list");
    expect(line).toContain("clockify_entries_update");
    expect(line).not.toMatch(/no new operations/i);
  });
});
