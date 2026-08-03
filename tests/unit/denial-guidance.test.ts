import { describe, expect, it } from "vitest";
import { formatObservations } from "../../src/assistant-v2/observations.js";

/**
 * A refusal the model cannot understand becomes a refusal it INVENTS a reason for.
 *
 * Observed in production on 737fddd: a run put a discovery call and a data call in
 * one batch, got `mixed_discovery_batch`, searched three more times trying to
 * recover, exhausted the discovery budget with `too_many_refinements`, and then
 * told the admin its "queries were too narrow or over-specified" and that
 * `mixed_discovery_batch` meant "the system wants me to first discover the right
 * API operations". Both explanations are fabrications, and it went on to assert as
 * fact that Clockify has no bulk-update endpoint — something it never checked.
 *
 * The model was not lying so much as answering an impossible question: the only
 * thing it was given was a bare snake_case code, plus an instruction to "explain
 * the refusal to the admin". These tests pin that a refusal now carries its own
 * meaning and its own next step.
 */
describe("denial observations carry meaning, not just a code", () => {
  const lineFor = (code: string): string =>
    formatObservations([{ kind: "denied", actionName: "clockify_entries_list", code }])[0]!;

  it("explains the two codes that produced the production confabulation", () => {
    const mixed = lineFor("mixed_discovery_batch");
    // The actual cause: search and act were in ONE batch. Not "discover first".
    expect(mixed).toMatch(/same batch|separate/i);
    expect(mixed).toContain("mixed_discovery_batch");

    const refinements = lineFor("too_many_refinements");
    // The actual cause: the search BUDGET is spent. Nothing to do with breadth,
    // which is what the model guessed and told the admin.
    expect(refinements).toMatch(/budget|no more searches|out of searches/i);
    expect(refinements).not.toMatch(/too narrow|over-specified/i);
  });

  it("tells the model to report the reason rather than invent one", () => {
    for (const code of ["mixed_discovery_batch", "too_many_refinements", "policy_denied"]) {
      expect(lineFor(code), code).toMatch(/do not invent|do not guess|do not speculate/i);
    }
  });

  it("stays truthful for a code it has no guidance for", () => {
    const line = lineFor("some_unmapped_future_code");
    expect(line).toContain("some_unmapped_future_code");
    // It must NOT claim to explain what it cannot explain.
    expect(line).toMatch(/no further detail|not available/i);
    expect(line).toMatch(/do not invent|do not guess|do not speculate/i);
  });

  it("still forbids repeating the identical call", () => {
    expect(lineFor("mixed_discovery_batch")).toMatch(/repeat/i);
  });

  it("leaves successful results untouched", () => {
    const line = formatObservations([
      { kind: "result", actionName: "clockify_entries_list", summary: "3 entries" },
    ])[0]!;
    expect(line).toBe("clockify_entries_list returned: 3 entries");
  });
});
