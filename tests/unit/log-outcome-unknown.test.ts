import { describe, expect, it } from "vitest";
import { logOutcomeUnknown, logOutcomeUnknownRecovered } from "../../src/log-outcome-unknown.js";

/**
 * D2: `outcome_unknown` is a real terminal state the UI already renders
 * (`src/ui/render.ts`) and that `DEPLOYMENT.md` requires alerting on, but no
 * operator could see one happen. The emitter carries the action name, the
 * server-minted operation id, and an HMAC workspace ALIAS where one is
 * reachable — never a raw workspace id, and never payload.
 */
describe("outcome-unknown operator line", () => {
  function capture(): { lines: string[]; log: (line: string) => void } {
    const lines: string[] = [];
    return { lines, log: (line) => lines.push(line) };
  }

  it("emits one line carrying only the action name and operation id", () => {
    const { lines, log } = capture();
    logOutcomeUnknown({
      action: "clockify_tags_update",
      operationId: "2b0f7c6e-7b1e-4f8a-9a1d-2c3d4e5f6a7b",
      log,
    });
    expect(lines).toEqual([
      "[write-outcome] event=outcome_unknown action=clockify_tags_update operation=2b0f7c6e-7b1e-4f8a-9a1d-2c3d4e5f6a7b",
    ]);
  });

  it("appends the workspace ALIAS as a suffix, keeping the match prefix stable", () => {
    const { lines, log } = capture();
    logOutcomeUnknown({
      action: "undo",
      operationId: "op-1",
      workspaceAlias: "ws-aliasedvalue",
      log,
    });
    expect(lines).toEqual([
      "[write-outcome] event=outcome_unknown action=undo operation=op-1 workspace=ws-aliasedvalue",
    ]);
    // D3 matches on the prefix, so the optional suffix must not disturb it.
    expect(lines[0]!.startsWith("[write-outcome] event=outcome_unknown ")).toBe(true);
  });

  it("emits once per settlement so a repeated ambiguity is countable, never folded", () => {
    const { lines, log } = capture();
    for (const operationId of ["op-one", "op-two"]) {
      logOutcomeUnknown({ action: "clockify_invoices_create", operationId, log });
    }
    expect(lines).toEqual([
      "[write-outcome] event=outcome_unknown action=clockify_invoices_create operation=op-one",
      "[write-outcome] event=outcome_unknown action=clockify_invoices_create operation=op-two",
    ]);
  });

  it("reports restart recovery as ONE aggregate line, sharing the match prefix", () => {
    const { lines, log } = capture();
    logOutcomeUnknownRecovered({ steps: 3, operations: 2, log });
    expect(lines).toEqual([
      "[write-outcome] event=outcome_unknown_recovered steps=3 operations=2",
    ]);
    // One operator match string has to catch settlement AND restart recovery.
    expect(lines[0]!.startsWith("[write-outcome] event=outcome_unknown")).toBe(true);
  });
});
