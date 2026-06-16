import { describe, expect, it } from "vitest";
import { ACTION_CATALOG } from "../../src/harness/catalog.js";
import { requiresConfirmation } from "../../src/harness/risk.js";

/**
 * Safety invariant (CLAUDE.md): "every *_update action ... is high_risk_write. An
 * update overwrites live data (and has no undo, which only reverses creations), so it
 * goes through preview→button-confirm." This was documented but UNPINNED — the audit
 * found clockify_holidays_update shipping as safe_write (immediate, no confirm). This
 * catalog-wide guard makes the whole class regression-proof.
 */
describe("safety invariant: every *_update action is confirm-gated", () => {
  const updates = ACTION_CATALOG.filter((a) => a.name.endsWith("_update"));

  it("there are update actions to check", () => {
    expect(updates.length).toBeGreaterThan(0);
  });

  for (const action of updates) {
    it(`${action.name} requires confirmation (overwriting live data is high_risk_write)`, () => {
      expect(requiresConfirmation(action.risks)).toBe(true);
    });
  }
});
