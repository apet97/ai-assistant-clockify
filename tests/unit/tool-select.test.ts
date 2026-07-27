import { describe, expect, it } from "vitest";
import {
  selectActionsForMessage,
  selectionDroppedGroups,
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
const ALL_ACTION_NAMES = ACTION_CATALOG.map((action) => action.name);

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

  it("fails open to the full catalog when nothing matches", () => {
    const sel = selectActionsForMessage("zzzq wbbn hello", fakeOpts);
    expect(sel).toEqual(FAKE_CATALOG.map((action) => action.name));
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
  const ALL = ALL_ACTION_NAMES;

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

  it("gibberish fails open to the full catalog", () => {
    expect(selectActionsForMessage("xqz pllk nnnn")).toEqual(ALL);
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

  it("routes a compound new-project setup exclusively through the setup composite", () => {
    const selected = selectActionsForMessage(
      "creaate a project named adjaslkdjadjkasda add me to it make the project private and assign men project member rate 15",
    );

    expect(selected).toContain("clockify_setup_project");
    expect(selected).not.toContain("clockify_projects_list");
    expect(selected).not.toContain("clockify_projects_get");
    expect(selected).not.toContain("clockify_projects_create");
    expect(selected).not.toContain("clockify_projects_memberships_update");
    expect(selected).not.toContain("clockify_projects_rate_update");
    expect(selected).not.toContain("clockify_create_work_package");

    expect(selectActionsForMessage(
      "reaate a project named Atlas, make the project private, add me, and set my member rate to 15",
    )).toEqual(["clockify_setup_project"]);
    expect(selectActionsForMessage(
      "creeeaate a project named Atlas, make the project private, add me, and set my member rate to 15",
    )).not.toEqual(["clockify_setup_project"]);
    expect(selectActionsForMessage(
      "create a project named Atlas\nmake the project private, add me, and set my member rate to 15",
    )).not.toEqual(["clockify_setup_project"]);
  });

  it.each([
    ["existing-project edit", "make the existing project Apollo private and add me"],
    ["negated creation", "do not create a project named Apollo or make it private"],
    ["hypothetical", "if I create a project and make it private, what happens?"],
    ["task creation", "create a task named Apollo and make it private"],
  ])("does not force the setup-project composite for a %s", (_label, message) => {
    expect(selectActionsForMessage(message)).not.toEqual(["clockify_setup_project"]);
  });

  it("gives a bare proper-noun command a generic entity tool (core safety net)", () => {
    // "delete Beacon" has no lexical area signal → full fail-open catalog, which
    // necessarily retains the generic delete safety net.
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

  it("does NOT pull the invoices area into non-invoice requests (only when asked)", () => {
    // The invoices group owns rate-update actions whose names contain "project"/"task";
    // a topic word must not drag the whole billing area into unrelated turns.
    for (const msg of ["list my projects", "log 2 hours on apollo", "show my expenses", "add a task to apollo"]) {
      const sel = selectActionsForMessage(msg);
      expect(sel).not.toContain("clockify_invoices_create");
    }
    // ...but a genuine invoice request still gets it.
    expect(selectActionsForMessage("create an invoice for acme")).toContain("clockify_invoices_create");
  });
});

describe("selectionDroppedGroups (telemetry for requests beyond the clamp)", () => {
  it("is false for single/dual-area requests (the clamp keeps every matched group)", () => {
    for (const msg of [
      "delete the urgent tag",
      "create an invoice for qwen for 1000",
      "rename the client Globex to Initech, and rename the tag urgent to critical",
      "how many projects and how many clients do I have",
    ]) {
      expect(selectionDroppedGroups(msg), msg).toBe(false);
    }
  });

  it("is true for a request spanning MORE areas than the 3-group clamp keeps", () => {
    const fourArea = "deactivate John, log a travel expense of 200, schedule Mary next week, and create an invoice for Acme";
    expect(selectionDroppedGroups(fourArea)).toBe(true);
    // Recall safety is immediate now: the selector itself fails open, so both the
    // initial turn and any resume receive every requested domain.
    expect(selectActionsForMessage(fourArea)).toEqual(ALL_ACTION_NAMES);
  });
});

describe("selectActionsForMessage — fail-open language boundary", () => {
  const ALL = ALL_ACTION_NAMES;

  it("fails open when a removed ASCII Serbian token is the only area signal", () => {
    expect(selectActionsForMessage("obrisi projekat Apollo")).toEqual(ALL);
  });

  it.each([
    ["Latin multibyte workspace data", "delete project Čukarica"],
    ["Cyrillic workspace data", "delete project Београд"],
  ])("returns the full catalog for %s", (_label, message) => {
    expect(selectActionsForMessage(message)).toEqual(ALL);
  });
});
