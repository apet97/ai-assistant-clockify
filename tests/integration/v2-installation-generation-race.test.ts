import { describe, expect, it } from "vitest";
import { DISCOVERY_META_TOOL_NAME } from "../../src/harness/api-operation.js";
import { composeV2ProductionApp } from "../helpers/v2-production-composition.js";

/**
 * Closure-plan PR 8 (F07): installation authority is rechecked at every await
 * boundary, not once per invocation. A replacement generation arriving while
 * the provider is thinking stops the run before further dispatch, result
 * persistence, or write preparation — with a real store-backed guard, never a
 * permissive stub.
 */

const SEED = { tags: [{ id: "aaaaaaaaaaaaaaaaaaaaaaa1", name: "urgent" }] as never };

describe("v2 installation generation race", () => {
  it("a generation replaced during a provider await fails the run before any read dispatch", async () => {
    const c = await composeV2ProductionApp({
      script: [
        { text: "", toolCalls: [{ id: "tc-find", name: DISCOVERY_META_TOOL_NAME, arguments: { query: "list tags" } }] },
        { text: "", toolCalls: [{ id: "tc-read", name: "clockify_tags_list", arguments: {} }] },
        { text: "Done.", toolCalls: [] },
      ],
      seed: SEED,
    });
    // Rotate the installation token DURING the second provider await —
    // exactly the window the single at-start check could never see.
    const original = c.model.completeWithTools;
    let calls = 0;
    c.model.completeWithTools = (async (messages, tools) => {
      calls += 1;
      if (calls === 2) {
        c.store.saveInstallation({
          workspaceId: c.workspaceId,
          addonId: "addon-1",
          addonUserId: "addon-user-1",
          addonToken: "rotated-token",
        });
      }
      return original(messages, tools);
    }) as typeof original;

    const res = await c.chat("list my tags");
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("installation_changed");

    // The run failed durably and the requested read NEVER dispatched (the
    // only Clockify traffic is the route's mandatory role recheck).
    const runId = c.latestRunId();
    expect(c.store.getRun({ ...c.getRunScope(runId), installationGeneration: 1 })?.phase).toBe("failed");
    expect(c.workspace.counts.listTags).toBeUndefined();
    expect(c.clockifyMutations()).toBe(0);
  });

  it("a revoked generation denies write preparation before any operation row exists", async () => {
    const c = await composeV2ProductionApp({
      script: [
        { text: "", toolCalls: [{ id: "tc-find", name: DISCOVERY_META_TOOL_NAME, arguments: { query: "create project" } }] },
        { text: "", toolCalls: [{ id: "tc-w", name: "clockify_projects_create", arguments: { name: "Race" } }] },
        { text: "Done.", toolCalls: [] },
      ],
    });
    // Replace the generation just before the write-preparation completion.
    const original = c.model.completeWithTools;
    let calls = 0;
    c.model.completeWithTools = (async (messages, tools) => {
      calls += 1;
      const completion = await original(messages, tools);
      if (calls === 2) {
        c.store.saveInstallation({
          workspaceId: c.workspaceId,
          addonId: "addon-1",
          addonUserId: "addon-user-1",
          addonToken: "rotated-token",
        });
      }
      return completion;
    }) as typeof original;

    const res = await c.chat("create the Race project");
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("installation_changed");
    // No operation or confirmation row was created after the boundary.
    expect(c.store.countPendingConfirmations(c.sessionId, new Date().toISOString())).toBe(0);
    expect(c.clockifyMutations()).toBe(0);
  });
});
