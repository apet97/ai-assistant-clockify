import { describe, expect, it } from "vitest";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import { DISCOVERY_META_TOOL_NAME } from "../../src/harness/api-operation.js";
import { toolsForV2LoadedSet } from "../../src/harness/tools.js";

/**
 * Closure-plan PR 10 (F09): the model is offered only features with a
 * complete runtime path. `referenceId` had a producer/resolver that no
 * production code ever invoked, so advertising it made the model call a
 * feature that always failed validation. No offered schema may mention it
 * until the vertical exists.
 */

describe("v2 tool schemas advertise no entity references (F09)", () => {
  it("no schema in the FULL catalog mentions referenceId", () => {
    const everyName = new Set([
      DISCOVERY_META_TOOL_NAME,
      ...MODEL_API_ACTION_CATALOG.actions.map((action) => action.name),
    ]);
    const tools = toolsForV2LoadedSet(MODEL_API_ACTION_CATALOG, everyName);
    expect(tools.length).toBeGreaterThan(100);
    for (const tool of tools) {
      expect(JSON.stringify(tool), tool.name).not.toContain("referenceId");
    }
  });
});
