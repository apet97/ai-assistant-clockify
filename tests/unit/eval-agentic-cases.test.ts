import { describe, expect, it } from "vitest";
import { AGENTIC_CASES, type AgenticOutcome } from "../../scripts/eval/agentic-cases.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";

/**
 * Pins for the multi-step (agentic) eval corpus: every case must have a valid
 * seed and a check that actually asserts something — a blank "nothing happened"
 * outcome must fail every case, so a broken runner can't report a pass.
 */
describe("AGENTIC_CASES corpus", () => {
  it("has a meaningful corpus with unique ids", () => {
    expect(AGENTIC_CASES.length).toBeGreaterThanOrEqual(6);
    const ids = AGENTIC_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of AGENTIC_CASES) expect(c.message.length).toBeGreaterThan(0);
  });

  it("every seed builds a fake workspace", () => {
    for (const c of AGENTIC_CASES) {
      expect(() => createFakeWorkspace(c.seed)).not.toThrow();
    }
  });

  it("every check fails a blank 'nothing happened' outcome", () => {
    for (const c of AGENTIC_CASES) {
      const blank: AgenticOutcome = {
        kind: "error",
        finalText: "",
        executed: [],
        committed: [],
        interrupts: 0,
        fake: createFakeWorkspace(c.seed),
      };
      expect(c.check(blank), c.id).not.toEqual([]);
    }
  });

  it("includes the headline acceptance case (invoice for qwen) requiring an interrupt", () => {
    const headline = AGENTIC_CASES.find((c) => c.id === "agentic.invoice_for_named_client");
    expect(headline).toBeDefined();
    expect(headline!.message.toLowerCase()).toContain("qwen");
  });
});
