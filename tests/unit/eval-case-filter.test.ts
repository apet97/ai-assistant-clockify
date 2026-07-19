import { describe, expect, it } from "vitest";
import { AGENTIC_CASES } from "../../scripts/eval/agentic-cases.js";
import { selectEvalCases } from "../../scripts/eval/case-filter.js";

describe("selectEvalCases", () => {
  it("prefers one exact case id over longer ids with the same prefix", () => {
    expect(selectEvalCases(AGENTIC_CASES, "agentic.count_projects").map(({ id }) => id)).toEqual([
      "agentic.count_projects",
    ]);
  });

  it("preserves the documented partial-selector behavior when no id is exact", () => {
    expect(selectEvalCases(AGENTIC_CASES, "count_projects").map(({ id }) => id)).toEqual([
      "agentic.count_projects",
      "agentic.count_projects_and_clients",
    ]);
  });

  it("returns every case when no selector is supplied", () => {
    expect(selectEvalCases(AGENTIC_CASES)).toEqual(AGENTIC_CASES);
  });
});
