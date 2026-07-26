import { describe, expect, it } from "vitest";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import type { ActionRegistry } from "../../src/harness/api-catalog.js";
import type { ActionDefinition } from "../../src/harness/action.js";
import {
  buildEvalCases,
  evalOperationNames,
  type EvalCase,
} from "../../scripts/eval-v2/case-model.js";
import {
  buildDiscoveryEvalCases,
  DISCOVERY_THRESHOLDS,
} from "../../scripts/eval-v2/api-discovery-cases.js";
import {
  buildTerminalCohorts,
  TERMINAL_COHORT_NAMES,
  TERMINAL_STRICT_COHORTS,
} from "../../scripts/eval-v2/assistant-terminal-cases.js";
import {
  buildWriteSafetyEvalCases,
  WRITE_SAFETY_INVARIANTS,
} from "../../scripts/eval-v2/write-safety-cases.js";
import {
  buildEvalReport,
  buildMissingCredentialReport,
  isReleasableReport,
  MISSING_CREDENTIAL_STATUS,
  type EvalAttempt,
} from "../../scripts/eval-v2/report.js";

/**
 * T17-A: the accounting gate. Every expectation here computes BOTH sides from
 * `MODEL_API_ACTION_CATALOG` at runtime — no literal operation count appears
 * anywhere, so this file stays correct when the catalog changes and still fails
 * if a fixture goes missing, duplicates, goes stale, or is invented.
 */

const IDENTITY = {
  candidateSha: "a".repeat(40),
  catalogHash: MODEL_API_ACTION_CATALOG.hash(),
  registryId: "v2-api" as const,
  modelConfiguration: "fixture-model",
  cohortOrder: ["canonical"],
};

/** A registry restricted to the named actions, used to prove derivation follows its input. */
function registryWithout(excluded: ReadonlySet<string>): ActionRegistry {
  const actions = MODEL_API_ACTION_CATALOG.actions.filter((action) => !excluded.has(action.name));
  return {
    ...MODEL_API_ACTION_CATALOG,
    actions,
    get: (name: string): ActionDefinition | undefined => actions.find((action) => action.name === name),
  } as ActionRegistry;
}

function catalogOperationNames(): string[] {
  return MODEL_API_ACTION_CATALOG.actions
    .filter((action) => action.apiOperation)
    .map((action) => action.name)
    .sort();
}

describe("T17-A: v2 evaluation fixtures cover every model-API operation exactly once", () => {
  it("derives exactly one case per model-API operation, with no missing, extra, stale, or duplicate entry", () => {
    const cases = buildEvalCases();
    const caseNames = cases.map((entry) => entry.actionName).sort();
    const expected = catalogOperationNames();

    // Missing / extra / stale all collapse into this one set comparison against
    // the live catalog — never against a literal list or count.
    expect(caseNames).toEqual(expected);
    expect(new Set(caseNames).size).toBe(caseNames.length); // no duplicate fixture
    expect(caseNames).toEqual(evalOperationNames());
    expect(cases.length).toBe(MODEL_API_ACTION_CATALOG.actions.filter((a) => a.apiOperation).length);
  });

  it("splits the case set into reads and writes exactly as the catalog does", () => {
    const cases = buildEvalCases();
    const reads = cases.filter((entry) => entry.access === "read").map((entry) => entry.actionName).sort();
    const writes = cases.filter((entry) => entry.access === "write").map((entry) => entry.actionName).sort();
    const catalogReads = MODEL_API_ACTION_CATALOG.actions
      .filter((action) => action.apiOperation?.access === "read")
      .map((action) => action.name)
      .sort();
    const catalogWrites = MODEL_API_ACTION_CATALOG.actions
      .filter((action) => action.apiOperation?.access === "write")
      .map((action) => action.name)
      .sort();
    expect(reads).toEqual(catalogReads);
    expect(writes).toEqual(catalogWrites);
  });

  it("gives every case the complete required fixture shape", () => {
    for (const entry of buildEvalCases()) {
      expect(entry.apiOperationId.length, entry.actionName).toBeGreaterThan(0);
      expect(entry.canonicalRequest.length, entry.actionName).toBeGreaterThan(0);
      expect(entry.paraphraseRequest.length, entry.actionName).toBeGreaterThan(0);
      if (entry.typoRequest !== undefined) {
        expect(entry.typoRequest, entry.actionName).not.toBe(entry.canonicalRequest);
      }
      expect(entry.fakeSeed, entry.actionName).toBeTypeOf("object");
      expect(entry.expectedArguments, entry.actionName).toBeTypeOf("object");
      expect(Array.isArray(entry.compoundMembership), entry.actionName).toBe(true);
      expect(entry.compoundMembership.length, entry.actionName).toBeGreaterThan(0);
      // A write can never be scored as an executed mutation from a model turn.
      if (entry.access === "write") {
        expect(["pending_confirmation", "denied"], entry.actionName).toContain(entry.expectedTerminalState);
      } else {
        expect(entry.expectedTerminalState, entry.actionName).toBe("succeeded");
      }
      // T17-F populates live cases; nothing here may invent one.
      expect(entry.liveCase, entry.actionName).toBeUndefined();
    }
  });

  it("fails closed when an operation has no shipped fixture", () => {
    // A registry containing an action the parity fixtures never covered is the
    // exact "stale/missing fixture" condition. Synthesize it by renaming one.
    const real = MODEL_API_ACTION_CATALOG.actions.find((action) => action.apiOperation?.access === "read")!;
    const invented = { ...real, name: "clockify_invented_read" } as ActionDefinition;
    const actions = [...MODEL_API_ACTION_CATALOG.actions, invented];
    const registry = {
      ...MODEL_API_ACTION_CATALOG,
      actions,
      get: (name: string) => actions.find((action) => action.name === name),
    } as ActionRegistry;
    expect(() => buildEvalCases(registry)).toThrow(/missing_eval_fixture:clockify_invented_read/);
  });

  it("shrinks with its input: removing operations removes exactly their cases", () => {
    const dropped = new Set(
      MODEL_API_ACTION_CATALOG.actions
        .filter((action) => action.apiOperation)
        .slice(0, 3)
        .map((action) => action.name),
    );
    const full = buildEvalCases().map((entry) => entry.actionName).sort();
    const reduced = buildEvalCases(registryWithout(dropped)).map((entry) => entry.actionName).sort();
    expect(reduced).toEqual(full.filter((name) => !dropped.has(name)));
    expect(reduced.length).toBe(full.length - dropped.size);
  });
});

describe("T17-A: the discovery cohort covers every operation and never invites a destructive neighbour", () => {
  it("emits one discovery case per operation with its three phrasings", () => {
    const cases = buildDiscoveryEvalCases();
    expect(cases.map((entry) => entry.actionName).sort()).toEqual(catalogOperationNames());
    for (const entry of cases) {
      expect(entry.canonicalRequest.length, entry.actionName).toBeGreaterThan(0);
      expect(entry.paraphraseRequest.length, entry.actionName).toBeGreaterThan(0);
      // Nothing in the watch list may share the request's own feature group,
      // and the requested operation is never its own counter-example.
      expect(entry.unrelatedDestructiveOperations, entry.actionName).not.toContain(entry.actionName);
    }
  });

  it("watches only real DELETE operations from other feature groups", () => {
    const deletesByGroup = new Map<string, string>();
    for (const action of MODEL_API_ACTION_CATALOG.actions) {
      if (action.apiOperation?.access === "write" && action.apiOperation.method === "DELETE") {
        deletesByGroup.set(action.name, action.featureGroup);
      }
    }
    for (const entry of buildDiscoveryEvalCases()) {
      for (const name of entry.unrelatedDestructiveOperations) {
        expect(deletesByGroup.has(name), `${name} must be a catalog DELETE`).toBe(true);
        expect(deletesByGroup.get(name), name).not.toBe(entry.featureGroup);
      }
    }
  });

  it("pins the enforced discovery thresholds", () => {
    expect(DISCOVERY_THRESHOLDS.canonicalRequired).toBe(3);
    expect(DISCOVERY_THRESHOLDS.paraphraseRequired).toBe(2);
    expect(DISCOVERY_THRESHOLDS.typoRequired).toBe(2);
    expect(DISCOVERY_THRESHOLDS.unrelatedDestructiveAllowed).toBe(0);
    expect(DISCOVERY_THRESHOLDS.maxLoadedApiTools).toBe(12);
  });
});

describe("T17-A: terminal cohorts are complete and every member is a real catalog operation", () => {
  it("declares all sixteen cohorts, each with at least one scored member", () => {
    const cohorts = buildTerminalCohorts();
    expect(cohorts.map((entry) => entry.cohort)).toEqual([...TERMINAL_COHORT_NAMES]);
    const known = new Set(catalogOperationNames());
    for (const cohort of cohorts) {
      expect(cohort.actionNames.length, cohort.cohort).toBeGreaterThan(0);
      for (const name of cohort.actionNames) {
        expect(known.has(name), `${cohort.cohort} member ${name}`).toBe(true);
      }
    }
  });

  it("marks every safety, denial, ambiguity, and hostile-data cohort strict", () => {
    for (const cohort of buildTerminalCohorts()) {
      expect(cohort.strict, cohort.cohort).toBe(TERMINAL_STRICT_COHORTS.includes(cohort.cohort));
    }
  });

  it("carries the real dependent journeys as ordered multi-step sequences of writes", () => {
    const dependent = buildTerminalCohorts().find((entry) => entry.cohort === "dependent_writes")!;
    expect(dependent.journeys?.length).toBeGreaterThan(0);
    const writes = new Set(
      MODEL_API_ACTION_CATALOG.actions
        .filter((action) => action.apiOperation?.access === "write")
        .map((action) => action.name),
    );
    for (const journey of dependent.journeys ?? []) {
      expect(journey.steps.length, journey.id).toBeGreaterThan(1);
      for (const step of journey.steps) expect(writes.has(step), `${journey.id}:${step}`).toBe(true);
    }
  });

  it("rejects a journey step that is not a catalog operation", () => {
    const dropped = new Set(["clockify_projects_create"]);
    expect(() => buildTerminalCohorts(registryWithout(dropped)))
      .toThrow(/unknown_journey_step:project_setup:clockify_projects_create/);
  });

  it("gives each runtime-scenario cohort an exact scenario and terminal state", () => {
    const runtime = buildTerminalCohorts().filter((entry) => entry.runtime);
    expect(runtime.map((entry) => entry.cohort).sort()).toEqual([
      "budget_exhaustion",
      "cancellation",
      "partial_outcome",
      "unknown_outcome",
    ]);
    const known = new Set(catalogOperationNames());
    for (const cohort of runtime) {
      expect(known.has(cohort.runtime!.representativeActionName), cohort.cohort).toBe(true);
      expect(cohort.runtime!.scenario.length, cohort.cohort).toBeGreaterThan(0);
    }
  });
});

describe("T17-A: write-safety cases cover every atomic model write", () => {
  it("emits one case per catalog write, each carrying the full invariant list", () => {
    const cases = buildWriteSafetyEvalCases();
    const catalogWrites = MODEL_API_ACTION_CATALOG.actions
      .filter((action) => action.apiOperation?.access === "write")
      .map((action) => action.name)
      .sort();
    expect(cases.map((entry) => entry.actionName).sort()).toEqual(catalogWrites);
    for (const entry of cases) {
      expect(entry.invariants).toEqual(WRITE_SAFETY_INVARIANTS);
      expect(entry.primaryMutation.method, entry.actionName).not.toBe("GET");
      expect(entry.primaryMutation.path.length, entry.actionName).toBeGreaterThan(0);
    }
  });
});

describe("T17-A: the report builder never hard-codes a numerator or denominator", () => {
  function attemptsFor(caseIds: readonly string[], passed: boolean): EvalAttempt[] {
    return caseIds.map((caseId, index) => ({
      caseId,
      cohort: "canonical",
      repeat: index,
      passed,
      ...(passed ? {} : { failureCode: "wrong_operation" }),
    }));
  }

  it("tracks the denominator of whatever case set it is handed", () => {
    const all = buildEvalCases().map((entry) => entry.actionName);
    const full = buildEvalReport({ kind: "k", identity: IDENTITY, caseIds: all, attempts: attemptsFor(all, true) });
    expect(full.denominator).toBe(all.length);
    expect(full.numerator).toBe(all.length);
    expect(full.caseCount).toBe(all.length);

    const five = all.slice(0, 5);
    const partial = buildEvalReport({ kind: "k", identity: IDENTITY, caseIds: five, attempts: attemptsFor(five, true) });
    // A hard-coded operation count on either side would fail here.
    expect(partial.denominator).toBe(5);
    expect(partial.caseCount).toBe(5);
    expect(partial.denominator).not.toBe(full.denominator);
  });

  it("treats an empty attempt set as a failure, never a vacuous pass", () => {
    const all = buildEvalCases().map((entry) => entry.actionName);
    const empty = buildEvalReport({ kind: "k", identity: IDENTITY, caseIds: all, attempts: [] });
    expect(empty.denominator).toBe(0);
    expect(empty.numerator).toBe(0);
    expect(empty.status).toBe("failed");
    expect(isReleasableReport(empty)).toBe(false);
  });

  it("records every failure with its exact code and marks the report failed", () => {
    const three = buildEvalCases().slice(0, 3).map((entry) => entry.actionName);
    const report = buildEvalReport({
      kind: "k",
      identity: IDENTITY,
      caseIds: three,
      attempts: [...attemptsFor(three.slice(0, 2), true), ...attemptsFor(three.slice(2), false)],
    });
    expect(report.status).toBe("failed");
    expect(report.numerator).toBe(2);
    expect(report.denominator).toBe(3);
    expect(report.failures).toEqual([
      { caseId: three[2], cohort: "canonical", repeat: 0, failureCode: "wrong_operation" },
    ]);
    expect(isReleasableReport(report)).toBe(false);
  });

  it("rejects an attempt that scores a case outside the derived set", () => {
    const two = buildEvalCases().slice(0, 2).map((entry) => entry.actionName);
    expect(() => buildEvalReport({
      kind: "k",
      identity: IDENTITY,
      caseIds: two,
      attempts: [{ caseId: "clockify_not_in_set", cohort: "canonical", repeat: 0, passed: true }],
    })).toThrow(/unknown_eval_case:clockify_not_in_set/);
  });

  it("emits an explicit non-passing sentinel when credentials are absent", () => {
    const all = buildEvalCases().map((entry) => entry.actionName);
    const report = buildMissingCredentialReport({
      kind: "k",
      identity: { candidateSha: IDENTITY.candidateSha, catalogHash: IDENTITY.catalogHash, registryId: "v2-api", cohortOrder: [] },
      caseIds: all,
      blockedReason: "no model credentials configured",
    });
    expect(report.status).toBe(MISSING_CREDENTIAL_STATUS);
    expect(report.identity.modelConfiguration).toBe(MISSING_CREDENTIAL_STATUS);
    // It still reports the real case count, so it can never look like a pass.
    expect(report.caseCount).toBe(all.length);
    expect(report.numerator).toBe(0);
    expect(report.denominator).toBe(0);
    expect(isReleasableReport(report)).toBe(false);
  });

  it("only calls a complete, fully passing report releasable", () => {
    const all = buildEvalCases().map((entry) => entry.actionName);
    const passing = buildEvalReport({ kind: "k", identity: IDENTITY, caseIds: all, attempts: attemptsFor(all, true) });
    expect(isReleasableReport(passing)).toBe(true);
  });
});

/** Guards the shape assumption every cohort projection makes. */
function assertCaseShape(entry: EvalCase): void {
  expect(entry.actionName.startsWith("clockify_")).toBe(true);
}

describe("T17-A: every derived case names a real model-facing tool", () => {
  it("uses only clockify_* tool names", () => {
    for (const entry of buildEvalCases()) assertCaseShape(entry);
  });
});
