import { describe, expect, it } from "vitest";
import { toolsForModel } from "../../src/harness/tools.js";
import { ACTION_CATALOG, catalogForModel } from "../../src/harness/catalog.js";
import { INTERNAL_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import { selectActionsForMessage } from "../../src/harness/tool-select.js";

describe("toolsForModel subsetting", () => {
  it("returns the full memoized list (same reference) when no filter is given", () => {
    expect(toolsForModel(INTERNAL_ACTION_CATALOG)).toHaveLength(ACTION_CATALOG.length);
    expect(toolsForModel(INTERNAL_ACTION_CATALOG)).toBe(toolsForModel(INTERNAL_ACTION_CATALOG)); // memoized — no rebuild, byte-identical
  });

  it("filters to the named subset, in catalog order", () => {
    const names = new Set(["clockify_status", "clockify_invoices_create"]);
    const subset = toolsForModel(INTERNAL_ACTION_CATALOG, names);
    expect(subset.map((t) => t.name).sort()).toEqual([...names].sort());
    const order = ACTION_CATALOG.map((a) => a.name).filter((n) => names.has(n));
    expect(subset.map((t) => t.name)).toEqual(order); // preserves catalog order
  });

  it("integrates with selectActionsForMessage to shrink the menu", () => {
    const names = new Set(selectActionsForMessage("create an invoice for qwen for 1000"));
    const subset = toolsForModel(INTERNAL_ACTION_CATALOG, names);
    expect(subset.length).toBeLessThan(ACTION_CATALOG.length); // genuinely smaller
    const subsetNames = subset.map((t) => t.name);
    expect(subsetNames).toContain("clockify_invoices_create");
    expect(subsetNames).not.toContain("clockify_start_timer");
  });
});

describe("catalogForModel subsetting", () => {
  it("returns the full memoized view when no filter is given", () => {
    expect(catalogForModel(INTERNAL_ACTION_CATALOG)).toHaveLength(ACTION_CATALOG.length);
    expect(catalogForModel(INTERNAL_ACTION_CATALOG)).toBe(catalogForModel(INTERNAL_ACTION_CATALOG));
  });

  it("filters to the named subset", () => {
    const subset = catalogForModel(INTERNAL_ACTION_CATALOG, new Set(["clockify_status"]));
    expect(subset).toHaveLength(1);
    expect(subset[0].name).toBe("clockify_status");
  });
});
