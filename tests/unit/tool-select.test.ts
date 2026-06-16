import { describe, expect, it } from "vitest";
import {
  selectActionsForMessage,
  CORE_ACTION_NAMES,
  type SelectableAction,
} from "../../src/harness/tool-select.js";
import { ACTION_CATALOG } from "../../src/harness/catalog.js";

/** A tiny synthetic catalog so the group-selection logic is asserted in isolation. */
const FAKE_CATALOG: SelectableAction[] = [
  { name: "t_start", description: "start a timer", featureGroup: "time_tracking" },
  { name: "t_stop", description: "stop the running timer", featureGroup: "time_tracking" },
  { name: "inv_create", description: "create an invoice for a client", featureGroup: "invoices" },
  { name: "inv_pay", description: "record a payment on an invoice", featureGroup: "invoices" },
  { name: "proj_create", description: "create a project", featureGroup: "work_structure" },
  { name: "meta", description: "recap of recent actions", featureGroup: "audit_log" },
];
const FAKE_CORE = new Set(["meta"]);
const fakeOpts = { catalog: FAKE_CATALOG, alwaysInclude: FAKE_CORE };

describe("selectActionsForMessage — isolated group logic", () => {
  it("selects only the matched group's actions plus the always-on core", () => {
    const sel = new Set(selectActionsForMessage("please start the timer", fakeOpts));
    expect(sel.has("t_start")).toBe(true);
    expect(sel.has("t_stop")).toBe(true);
    expect(sel.has("meta")).toBe(true); // core always present
    expect(sel.has("inv_create")).toBe(false); // unrelated group excluded
    expect(sel.has("proj_create")).toBe(false);
  });

  it("routes an invoice request to the invoices group, not time tracking", () => {
    const sel = new Set(selectActionsForMessage("create an invoice for Acme", fakeOpts));
    expect(sel.has("inv_create")).toBe(true);
    expect(sel.has("inv_pay")).toBe(true);
    expect(sel.has("t_start")).toBe(false);
  });

  it("falls back to ONLY the core when nothing matches (smalltalk / gibberish)", () => {
    const sel = selectActionsForMessage("zzzq wbbn hello", fakeOpts);
    expect(new Set(sel)).toEqual(FAKE_CORE);
  });

  it("is deterministic — identical input yields an identical array", () => {
    const a = selectActionsForMessage("create an invoice for Acme", fakeOpts);
    const b = selectActionsForMessage("create an invoice for Acme", fakeOpts);
    expect(a).toEqual(b);
  });

  it("matches via synonyms, not just literal words (track/bill)", () => {
    expect(new Set(selectActionsForMessage("track my hours", fakeOpts)).has("t_start")).toBe(true);
    expect(new Set(selectActionsForMessage("bill the client", fakeOpts)).has("inv_create")).toBe(true);
  });

  it("never returns a name outside the catalog ∪ core", () => {
    const allowed = new Set([...FAKE_CATALOG.map((a) => a.name), ...FAKE_CORE]);
    for (const name of selectActionsForMessage("create an invoice and start a timer", fakeOpts)) {
      expect(allowed.has(name)).toBe(true);
    }
  });
});

describe("selectActionsForMessage — against the real catalog", () => {
  const ALL = ACTION_CATALOG.map((a) => a.name);

  it("CORE_ACTION_NAMES are all real catalog actions (no drift)", () => {
    for (const name of CORE_ACTION_NAMES) expect(ALL).toContain(name);
  });

  it("a timer request surfaces start_timer and stays well under the full catalog", () => {
    const sel = selectActionsForMessage("start a timer on the Apollo project");
    expect(sel).toContain("clockify_start_timer");
    expect(sel.length).toBeLessThan(ALL.length); // it is a SUBSET, the whole point
    expect(sel).not.toContain("clockify_invoices_create");
  });

  it("an invoice request surfaces invoices_create, not the timer", () => {
    const sel = selectActionsForMessage("create an invoice for qwen for 1000");
    expect(sel).toContain("clockify_invoices_create");
    expect(sel).not.toContain("clockify_start_timer");
  });

  it("gibberish collapses to exactly the always-on core", () => {
    expect(new Set(selectActionsForMessage("xqz pllk nnnn"))).toEqual(CORE_ACTION_NAMES);
  });

  it("the curated intents + assistant meta are ALWAYS present", () => {
    const sel = new Set(selectActionsForMessage("delete the tag named urgent"));
    expect(sel.has("clockify_period_report")).toBe(true);
    expect(sel.has("assistant_recent_outcomes")).toBe(true);
    expect(sel.has("clockify_status")).toBe(true);
  });
});

// Pins the exact recall misses the live matrix surfaced (DeepSeek pro 100%→94%
// under the first subsetting cut) so they can never silently return.
describe("selectActionsForMessage — matrix regression guards", () => {
  it("routes 'list my projects' to the projects area (not invoices via description noise)", () => {
    expect(selectActionsForMessage("list my projects")).toContain("clockify_projects_list");
  });

  it("shows the create primitive for 'create a project called X'", () => {
    expect(selectActionsForMessage("create a project called Zenith")).toContain("clockify_projects_create");
  });

  it("gives a bare proper-noun command a generic entity tool (core safety net)", () => {
    // "delete Beacon" has no lexical area signal → core only; it must still carry a delete tool.
    expect(new Set(selectActionsForMessage("delete Beacon")).has("clockify_delete_entity")).toBe(true);
  });

  it("keeps the generic entity CRUD ops in the always-on core", () => {
    for (const name of [
      "clockify_delete_entity",
      "clockify_update_entity",
      "clockify_get_entity",
      "clockify_list_entities",
      "clockify_create_work_package",
    ]) {
      expect(CORE_ACTION_NAMES.has(name)).toBe(true);
    }
  });
});
