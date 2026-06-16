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

  it("includes the STEP-1b multi-step / cross-area / multi-read cases", () => {
    const want = [
      "agentic.count_projects_and_clients", // multi-independent-read
      "agentic.list_categories_and_tags", // cross-group recall + verbatim listing
      "agentic.tag_per_client", // multi-step read-then-act (one read → many writes)
      "agentic.rename_client_and_tag", // cross-entity multi-risky updates
    ];
    const ids = new Set(AGENTIC_CASES.map((c) => c.id));
    for (const id of want) expect(ids.has(id), id).toBe(true);
    // The corpus must keep at least one case per area the flip is certified against.
    const areas = new Set(AGENTIC_CASES.map((c) => c.area));
    for (const a of ["read_answer", "read_then_act", "single_risky", "multi_risky", "clarify"] as const) {
      expect(areas.has(a), a).toBe(true);
    }
  });
});

/**
 * The new STEP-1b checks must ACCEPT a correct terminal outcome, not merely reject
 * the blank one — an inverted/typo'd assertion would otherwise pass the corpus pins
 * yet silently fail every real run. Each builder constructs a fresh fake and REPLACES
 * the relevant state arrays (never mutates the shared seed objects) to model success.
 */
describe("AGENTIC_CASES new-case checks accept a correct outcome", () => {
  const caseById = (id: string) => {
    const c = AGENTIC_CASES.find((x) => x.id === id);
    if (!c) throw new Error(`missing case ${id}`);
    return c;
  };

  it("count_projects_and_clients: both counts in a final answer pass; a missing count fails", () => {
    const c = caseById("agentic.count_projects_and_clients");
    const base: AgenticOutcome = {
      kind: "final",
      finalText: "You have 3 projects and 2 clients.",
      executed: ["clockify_list_entities"],
      committed: [],
      interrupts: 0,
      fake: createFakeWorkspace(c.seed),
    };
    expect(c.check(base)).toEqual([]);
    expect(c.check({ ...base, finalText: "You have 3 projects." })).not.toEqual([]); // client count missing
    expect(c.check({ ...base, interrupts: 1 })).not.toEqual([]); // a read must not preview
  });

  it("list_categories_and_tags: verbatim names in a final listing pass; an omitted name fails", () => {
    const c = caseById("agentic.list_categories_and_tags");
    const base: AgenticOutcome = {
      kind: "final",
      finalText: "Categories: Travel, Software. Tags: billable.",
      executed: ["clockify_list_entities"],
      committed: [],
      interrupts: 0,
      fake: createFakeWorkspace(c.seed),
    };
    expect(c.check(base)).toEqual([]);
    expect(c.check({ ...base, finalText: "Categories: Travel, Software." })).not.toEqual([]); // tag omitted
  });

  it("tag_per_client: a tag per client created passes; a missing one fails", () => {
    const c = caseById("agentic.tag_per_client");
    const fake = createFakeWorkspace(c.seed);
    fake.state.tags = [{ id: "t-1", name: "Globex" }, { id: "t-2", name: "Initech" }];
    const base: AgenticOutcome = {
      kind: "final",
      finalText: "Created tags Globex and Initech.",
      executed: ["clockify_list_entities", "clockify_tags_create", "clockify_tags_create"],
      committed: [],
      interrupts: 0,
      fake,
    };
    expect(c.check(base)).toEqual([]);
    const partial = createFakeWorkspace(c.seed);
    partial.state.tags = [{ id: "t-1", name: "Globex" }];
    expect(c.check({ ...base, fake: partial })).not.toEqual([]); // Initech missing
  });

  it("rename_client_and_tag: both renames committed pass; a leftover old name fails", () => {
    const c = caseById("agentic.rename_client_and_tag");
    const fake = createFakeWorkspace(c.seed);
    fake.state.clients = [{ id: "cl1", name: "Initech" }];
    fake.state.tags = [{ id: "t1", name: "critical" }, { id: "t2", name: "keep" }];
    const base: AgenticOutcome = {
      kind: "final",
      finalText: "Both renames are done.",
      executed: [],
      committed: ["clockify_clients_update", "clockify_tags_update"],
      interrupts: 2,
      fake,
    };
    expect(c.check(base)).toEqual([]);
    expect(c.check({ ...base, committed: ["clockify_clients_update"] })).not.toEqual([]); // only one confirmed
    const stale = createFakeWorkspace(c.seed);
    stale.state.clients = [{ id: "cl1", name: "Globex" }]; // rename never applied
    stale.state.tags = [{ id: "t1", name: "critical" }, { id: "t2", name: "keep" }];
    expect(c.check({ ...base, fake: stale })).not.toEqual([]);
  });
});
