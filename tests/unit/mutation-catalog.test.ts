import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACTION_CATALOG } from "../../src/harness/catalog.js";
import { mutationPlanContractError, type ActionDefinition } from "../../src/harness/action.js";
import { mutationCatalogCoverage } from "../../src/harness/mutation-compatibility.js";

describe("durable external-mutation catalog coverage", () => {
  it("requires every Clockify external write to satisfy the complete durable contract", () => {
    const coverage = mutationCatalogCoverage(ACTION_CATALOG);
    expect(coverage).toEqual({ uncovered: [], invalidContracts: [] });
  });

  it("contains no compatibility or target-verification exception bridge", () => {
    const source = readFileSync(
      new URL("../../src/harness/mutation-compatibility.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain("EXTERNAL_MUTATION_COMPATIBILITY_EXCEPTIONS");
    expect(source).not.toContain("DURABLE_TARGET_VERIFICATION_EXCEPTIONS");
    expect(source).not.toContain("PHASE_5_ACTIONS");
    expect(source).not.toContain("phase-5-domain-target-verification");
  });

  it("detects an external write without a journaled path", () => {
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

  it.each(["operationData", "mutationPlan", "targeting", "reconciliation"] as const)(
    "rejects a pretend durable write missing %s contract metadata",
    (missing) => {
      const complete = {
        operationData: { source: "confirmable_operation" as const, normalized: true as const, nonsecret: true as const },
        mutationPlan: { source: "preview" as const, exact: true as const },
        targeting: { mode: "create_no_target" as const },
        reconciliation: { strategies: ["create" as const], stepBound: true as const, requiresCompleteEvidence: true as const },
      };
      const synthetic = {
        ...ACTION_CATALOG[0],
        name: `clockify_missing_${missing}`,
        risks: ["safe_write" as const],
        mutationWorkflow: "durable" as const,
        mutationContract: Object.fromEntries(Object.entries(complete).filter(([key]) => key !== missing)),
      };
      const coverage = mutationCatalogCoverage([...ACTION_CATALOG, synthetic as unknown as ActionDefinition]);
      expect(coverage.invalidContracts).toEqual([`clockify_missing_${missing}:${missing}`]);
    },
  );

  it("rejects safe/confirmed metadata whose declared source contradicts the implementation", () => {
    const safe = {
      ...ACTION_CATALOG[0],
      name: "clockify_safe_source_lie",
      risks: ["safe_write" as const],
      mutationWorkflow: "durable" as const,
      prepareSafeWrite: async () => ({ operation: {}, mutationPlan: { mode: "single" as const, steps: [{ id: "x", kind: "primary" as const }] } }),
      executeSafeWrite: async () => ({ ok: true as const, action: "clockify_safe_source_lie" }),
      mutationContract: {
        operationData: { source: "confirmable_operation" as const, normalized: true as const, nonsecret: true as const },
        mutationPlan: { source: "preview" as const, exact: true as const },
        targeting: { mode: "create_no_target" as const },
        reconciliation: { strategies: ["create" as const], stepBound: true as const, requiresCompleteEvidence: true as const },
      },
    };
    expect(mutationCatalogCoverage([...ACTION_CATALOG, safe as unknown as ActionDefinition]).invalidContracts)
      .toEqual(["clockify_safe_source_lie:source"]);
  });

  it("does not let a formerly excepted invoice action hide missing metadata", () => {
    const action = ACTION_CATALOG.find((candidate) => candidate.name === "clockify_invoices_update")!;
    const broken = {
      ...action,
      mutationContract: {
        ...action.mutationContract!,
        operationData: undefined,
      },
    };
    const catalog = ACTION_CATALOG.map((candidate) => candidate.name === broken.name ? broken as unknown as ActionDefinition : candidate);
    expect(mutationCatalogCoverage(catalog).invalidContracts)
      .toEqual(["clockify_invoices_update:operationData"]);
  });

  it("rejects all deferred targeting and undeclared reconciliation strategies", () => {
    const base = ACTION_CATALOG.find((candidate) => candidate.name === "clockify_invoices_delete")!;
    const deferred = {
      ...base,
      name: "clockify_invoices_update",
      mutationContract: {
        ...base.mutationContract!,
        targeting: { mode: "deferred" as const, exception: "phase-5-domain-target-verification" as const },
      },
    };
    const catalog = ACTION_CATALOG.map((candidate) => candidate.name === deferred.name ? deferred : candidate);
    expect(mutationCatalogCoverage(catalog).invalidContracts)
      .toContain("clockify_invoices_update:targeting");

    const evil = {
      ...base,
      name: "clockify_invalid_strategy",
      mutationContract: {
        ...base.mutationContract!,
        reconciliation: { ...base.mutationContract!.reconciliation, strategies: ["invented"] },
      },
    };
    expect(mutationCatalogCoverage([...ACTION_CATALOG, evil as unknown as ActionDefinition]).invalidContracts)
      .toContain("clockify_invalid_strategy:reconciliation");
  });

  it("fails malformed, missing, or undeclared runtime plans before persistence", () => {
    const contract = ACTION_CATALOG.find((candidate) => candidate.name === "clockify_invoices_delete")!.mutationContract!;
    expect(mutationPlanContractError(undefined, { mode: "single", steps: [{ id: "x", kind: "primary", reconciliationStrategy: "delete" }] }))
      .toBe("missing_mutation_contract");
    expect(mutationPlanContractError(contract, { mode: "broken", steps: [{ id: "x", kind: "primary", reconciliationStrategy: "delete" }] } as never))
      .toBe("missing_mutation_plan");
    expect(mutationPlanContractError(contract, { mode: "single", steps: [{ id: "x", kind: "primary", targetFingerprint: 7, reconciliationStrategy: "delete" }] } as never))
      .toBe("invalid_mutation_plan_step");
    expect(mutationPlanContractError(contract, { mode: "single", steps: [{ id: "x", kind: "primary" }] }))
      .toBe("missing_reconciliation_strategy:x");
    expect(mutationPlanContractError(contract, { mode: "single", steps: [{ id: "x", kind: "primary", reconciliationStrategy: "update" }] }))
      .toBe("undeclared_reconciliation_strategy:x");
  });
});
