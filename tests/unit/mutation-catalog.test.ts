import { describe, expect, it } from "vitest";
import { ACTION_CATALOG } from "../../src/harness/catalog.js";
import {
  EXTERNAL_MUTATION_COMPATIBILITY_EXCEPTIONS,
  mutationCatalogCoverage,
} from "../../src/harness/mutation-compatibility.js";

describe("durable external-mutation catalog coverage", () => {
  it("names every compatibility exception and its migration destination", () => {
    const coverage = mutationCatalogCoverage(ACTION_CATALOG);
    expect(coverage.uncovered).toEqual([]);
    expect(coverage.invalidExceptions).toEqual([]);
    expect(new Set(EXTERNAL_MUTATION_COMPATIBILITY_EXCEPTIONS.map((entry) => entry.actionName)).size)
      .toBe(EXTERNAL_MUTATION_COMPATIBILITY_EXCEPTIONS.length);
    expect(EXTERNAL_MUTATION_COMPATIBILITY_EXCEPTIONS.every((entry) => entry.migrateIn.length > 0)).toBe(true);
  });

  it("detects an external write without a journaled path or explicit migration exception", () => {
    const synthetic = {
      ...ACTION_CATALOG[0],
      name: "clockify_unjournaled_test_write",
      risks: ["safe_write" as const],
      prepareSafeWrite: undefined,
      executeSafeWrite: undefined,
      mutationWorkflow: undefined,
    };
    const coverage = mutationCatalogCoverage([...ACTION_CATALOG, synthetic]);
    expect(coverage.uncovered).toEqual(["clockify_unjournaled_test_write"]);
  });

  it("does not mistake a prepare/execute split for durable step journaling", () => {
    const synthetic = {
      ...ACTION_CATALOG[0],
      name: "clockify_metadata_only_safe_write",
      risks: ["safe_write" as const],
      prepareSafeWrite: async () => ({
        operation: { name: "metadata only" },
        mutationPlan: { mode: "single" as const, steps: [{ id: "write", kind: "primary" as const }] },
      }),
      executeSafeWrite: async () => ({ ok: true as const, action: "clockify_metadata_only_safe_write" }),
      mutationWorkflow: undefined,
    };

    expect(mutationCatalogCoverage([...ACTION_CATALOG, synthetic]).uncovered)
      .toEqual(["clockify_metadata_only_safe_write"]);
  });
});
