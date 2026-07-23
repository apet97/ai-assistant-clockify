import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  INTERNAL_ACTION_CATALOG,
  LOCAL_ASSISTANT_ACTIONS,
  MODEL_API_ACTION_CATALOG,
} from "../../src/harness/api-catalog.js";
import { ACTION_CATALOG } from "../../src/harness/catalog.js";

/**
 * Doc-vs-code guard: CLAUDE.md is this repo's stated engineering source of truth
 * and quotes a specific catalog size. `ACTION_CATALOG.length` is the authoritative
 * count; this test fails if the doc and the real catalog ever drift apart, so
 * adding or removing an action forces a doc update (mirrors env-example.test.ts).
 */
const claudeMdPath = fileURLToPath(new URL("../../CLAUDE.md", import.meta.url));

describe("catalog action count stays in sync with the docs", () => {
  it("CLAUDE.md states the real ACTION_CATALOG length", () => {
    const claudeMd = readFileSync(claudeMdPath, "utf8");
    const match = claudeMd.match(/(\d+)\s+typed catalog actions/);
    expect(match, "CLAUDE.md must state '<N> typed catalog actions'").not.toBeNull();
    expect(Number(match![1])).toBe(ACTION_CATALOG.length);
  });

  it("keeps explicit registry ownership counts derived from metadata", () => {
    expect(INTERNAL_ACTION_CATALOG.actions).toHaveLength(ACTION_CATALOG.length);
    expect(MODEL_API_ACTION_CATALOG.actions).toHaveLength(
      ACTION_CATALOG.filter((action) => action.apiExposure === "api").length,
    );
    expect(LOCAL_ASSISTANT_ACTIONS.actions).toHaveLength(
      ACTION_CATALOG.filter((action) => action.apiExposure === "local").length,
    );
  });
});
