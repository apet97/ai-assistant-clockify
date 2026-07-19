import { describe, expect, it } from "vitest";
import { lastTurnCompletedAWrite } from "../../src/routes/consent-guard.js";

describe("lastTurnCompletedAWrite", () => {
  it("does not mistake a successful read plus failed write for an applied change", () => {
    expect(lastTurnCompletedAWrite([
      { kind: "receipt", receipt: { ok: true, action: "clockify_approvals_list", data: { rows: [] } } },
      {
        kind: "receipt",
        receipt: {
          ok: false,
          action: "clockify_approvals_approve",
          code: "intent_capability_argument_undeclared",
        },
      },
    ])).toBe(false);
  });

  it("recognizes only a successful receipt with a recorded mutation", () => {
    expect(lastTurnCompletedAWrite([
      {
        kind: "receipt",
        receipt: {
          ok: true,
          action: "clockify_start_timer",
          changed: { created: [{ type: "time_entry", id: "entry-1" }] },
        },
      },
    ])).toBe(true);
  });
});
