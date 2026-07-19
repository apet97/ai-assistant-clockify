import { describe, expect, it } from "vitest";
import {
  AGENTIC_CASES,
  RELEASE_INTENT_PATH_ACTION,
  RELEASE_INTENT_PATH_CASE_ID,
  RELEASE_INTENT_PATH_MESSAGE,
  RELEASE_INTENT_PATH_PROJECT_NAME,
  type AgenticOutcome,
} from "../../scripts/eval/agentic-cases.js";
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

  it("pins the exact live public-project regression as a full intent-capability safe write", () => {
    const regression = AGENTIC_CASES.find((c) => c.id === RELEASE_INTENT_PATH_CASE_ID);
    expect(regression).toMatchObject({
      area: "safe_write",
      message: RELEASE_INTENT_PATH_MESSAGE,
      intentCapabilityAction: RELEASE_INTENT_PATH_ACTION,
    });
  });

  it("includes the STEP-1b multi-step / cross-area / multi-read cases", () => {
    const want = [
      "agentic.count_projects_and_clients", // multi-independent-read
      "agentic.list_categories_and_tags", // cross-group recall + verbatim listing
      "agentic.approve_all_pending", // server-resolved read-then-act batch with one bound preview
      "agentic.rename_client_and_tag", // cross-entity multi-risky updates
    ];
    const ids = new Set(AGENTIC_CASES.map((c) => c.id));
    for (const id of want) expect(ids.has(id), id).toBe(true);
    // The corpus must keep at least one case per area the flip is certified against.
    const areas = new Set(AGENTIC_CASES.map((c) => c.area));
    for (const a of ["read_answer", "read_then_act", "safe_write", "single_risky", "multi_risky", "clarify"] as const) {
      expect(areas.has(a), a).toBe(true);
    }
  });

  it("uses distinct action grants for the bounded multi-risky delete/archive case", () => {
    expect(AGENTIC_CASES).toHaveLength(12);
    expect(AGENTIC_CASES.some((c) => c.id === "agentic.delete_two_tags")).toBe(false);
    const multi = AGENTIC_CASES.find((c) => c.id === "agentic.delete_tag_and_archive_project");
    expect(multi).toMatchObject({ area: "multi_risky" });
    expect(multi?.intentAllowedActions).toEqual(expect.arrayContaining([
      "clockify_tags_delete",
      "clockify_projects_archive",
    ]));
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

  it("approve_all_pending: one bound batch approval passes; a remaining pending item fails", () => {
    const c = caseById("agentic.approve_all_pending");
    const fake = createFakeWorkspace(c.seed);
    fake.state.approvals = fake.state.approvals.map((approval) => ({ ...approval, state: "APPROVED" }));
    fake.counts.setApprovalStateAtomic = 2;
    const base: AgenticOutcome = {
      kind: "final",
      finalText: "The two pending timesheets were approved from the button-bound preview.",
      executed: [],
      committed: ["clockify_approvals_approve_pending"],
      interrupts: 1,
      fake,
    };
    expect(c.check(base)).toEqual([]);
    const partial = createFakeWorkspace(c.seed);
    partial.state.approvals[0]!.state = "APPROVED";
    partial.counts.setApprovalStateAtomic = 1;
    expect(c.check({ ...base, fake: partial })).not.toEqual([]);
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

  it("exact public project: one full-path safe write passes; missing dispatch, duplicate, or previewed output fails", () => {
    const c = caseById(RELEASE_INTENT_PATH_CASE_ID);
    const fake = createFakeWorkspace(c.seed);
    fake.state.projects = [{
      id: "project-1",
      name: RELEASE_INTENT_PATH_PROJECT_NAME,
      isPublic: true,
    }];
    fake.counts.createProjectAtomic = 1;
    const base: AgenticOutcome = {
      kind: "final",
      finalText: "Project created.",
      executed: [RELEASE_INTENT_PATH_ACTION],
      committed: [],
      interrupts: 0,
      fake,
    };
    expect(c.check(base)).toEqual([]);
    expect(c.check({ ...base, interrupts: 1 })).not.toEqual([]);
    const noDispatch = createFakeWorkspace(c.seed);
    noDispatch.state.projects = [{ id: "project-1", name: RELEASE_INTENT_PATH_PROJECT_NAME }];
    expect(c.check({ ...base, fake: noDispatch })).not.toEqual([]);
    const duplicated = createFakeWorkspace(c.seed);
    duplicated.state.projects = [fake.state.projects[0]!, { ...fake.state.projects[0]!, id: "project-2" }];
    duplicated.counts.createProjectAtomic = 1;
    expect(c.check({ ...base, fake: duplicated })).not.toEqual([]);
  });
});
