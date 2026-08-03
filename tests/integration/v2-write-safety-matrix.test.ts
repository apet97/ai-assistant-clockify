import { beforeAll, describe, expect, it } from "vitest";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import {
  buildWriteSafetyEvalCases,
  writeSafetyExpectedChecks,
  WRITE_SAFETY_INVARIANTS,
} from "../../scripts/eval-v2/write-safety-cases.js";
import {
  attemptsFromObservations,
  authorityEvidenceFromReport,
  blockedWriteSafetyReport,
  buildWriteSafetyReport,
  type WriteSafetyObservation,
} from "../../scripts/eval-write-safety.js";
import { candidateSha } from "../../scripts/eval-v2/runner-harness.js";
import {
  V2_AUTHORITY_NOT_EVALUATED_SENTINEL,
} from "../../scripts/evidence/v2-authority-evidence.js";
import { isReleasableReport } from "../../scripts/eval-v2/report.js";
import { catalogWritesForDomain, WRITE_PARITY_DOMAIN_GROUPS } from "../helpers/v2-write-parity.js";
import { observeWriteSafetyMatrix } from "../helpers/v2-write-safety-observer.js";

/**
 * T17-D: the write-safety ACCOUNTING gate.
 *
 * The per-write safety proofs are the shipped suites (the seven
 * `v2-write-parity-*` domain matrices plus `v2-preview-first-matrix`,
 * `v2-confirmation-authority`, `v2-typed-consent`, `v2-prompt-injection-write`,
 * `v2-confirmation-batch` and `mutation-workflow`). The OBSERVATIONS feeding the
 * artifact come from `observeWriteSafetyMatrix()`, which re-executes those same
 * real preparation/confirmation flows (real services, real SQLite store, fake
 * host) per write and DERIVES each invariant verdict from measured behaviour —
 * nothing here is asserted `satisfied` by fiat. This file proves:
 *
 *  1. the derived matrix covers EVERY atomic model write with EVERY invariant;
 *  2. only the real observed matrix — complete and violation-free — becomes the
 *     T13 `V2AuthorityEvidence` artifact; one unsatisfied invariant on any
 *     write makes it incomplete, naming that write;
 *  3. a partial, violating, sentinel, zero-case, wrong-SHA or wrong-catalog-hash
 *     report can never become the artifact;
 *  4. the seven domain matrices between them account for all 84 writes, so no
 *     write can be safety-covered by nothing.
 */

function catalogWriteNames(): string[] {
  return MODEL_API_ACTION_CATALOG.actions
    .filter((action) => action.apiOperation?.access === "write")
    .map((action) => action.name)
    .sort();
}

/**
 * Deliberately MIXED arithmetic fixture: roughly half satisfied, half not. It
 * exists ONLY to prove the report's counting arithmetic — it can never produce
 * a passing report or a complete artifact, so no fabricated all-true input can
 * masquerade as evidence again.
 */
function mixedArithmeticObservations(): WriteSafetyObservation[] {
  return buildWriteSafetyEvalCases().flatMap((entry, caseIndex) =>
    WRITE_SAFETY_INVARIANTS.map((invariant, invariantIndex): WriteSafetyObservation => {
      const satisfied = (caseIndex + invariantIndex) % 2 === 0;
      return {
        actionName: entry.actionName,
        invariant,
        satisfied,
        ...(satisfied ? {} : { violationCode: "mixed_fixture_violation" }),
      };
    }),
  );
}

// The real observations are produced ONCE for the whole file: ~84 writes, each
// re-driven through prepare/confirm flows against its own real SQLite store.
let realObservations: WriteSafetyObservation[] = [];

beforeAll(async () => {
  realObservations = await observeWriteSafetyMatrix();
}, 300_000);

describe("T17-D: the write-safety matrix covers every atomic model write", () => {
  it("emits one case per catalog write with all nine invariants", () => {
    const cases = buildWriteSafetyEvalCases();
    expect(cases.map((entry) => entry.actionName).sort()).toEqual(catalogWriteNames());
    for (const entry of cases) expect(entry.invariants).toEqual(WRITE_SAFETY_INVARIANTS);
    expect(writeSafetyExpectedChecks()).toBe(cases.length * WRITE_SAFETY_INVARIANTS.length);
  });

  it("binds every case to exactly one primary mutation that is not a GET", () => {
    for (const entry of buildWriteSafetyEvalCases()) {
      expect(["POST", "PUT", "PATCH", "DELETE"], entry.actionName).toContain(entry.primaryMutation.method);
      expect(entry.primaryMutation.path.startsWith("/"), entry.actionName).toBe(true);
      expect(["api", "reports", "audit"], entry.actionName).toContain(entry.primaryMutation.host);
    }
  });

  it("never expects an executed mutation as a write's terminal state", () => {
    for (const entry of buildWriteSafetyEvalCases()) {
      expect(["pending_confirmation", "denied"], entry.actionName).toContain(entry.expectedTerminalState);
    }
  });

  it("accounts for every write across the seven shipped domain matrices", () => {
    const covered = new Set<string>();
    for (const domain of Object.keys(WRITE_PARITY_DOMAIN_GROUPS) as Array<keyof typeof WRITE_PARITY_DOMAIN_GROUPS>) {
      for (const action of catalogWritesForDomain(domain)) covered.add(action.name);
    }
    // A write in no domain matrix would be safety-covered by nothing.
    expect([...covered].sort()).toEqual(catalogWriteNames());
  });

  it("uses no composite or generic tool: every case is an api-exposed atomic action", () => {
    const byName = new Map(MODEL_API_ACTION_CATALOG.actions.map((action) => [action.name, action]));
    for (const entry of buildWriteSafetyEvalCases()) {
      const action = byName.get(entry.actionName)!;
      expect(action.apiExposure, entry.actionName).toBe("api");
      expect(action.apiOperation?.access, entry.actionName).toBe("write");
    }
  });
});

describe("T17-D: the real observed matrix is the only input to authority evidence", () => {
  it("observes every write × invariant exactly once, from real flows", () => {
    expect(realObservations.length).toBe(writeSafetyExpectedChecks());
    const keys = realObservations.map((entry) => `${entry.actionName} ${entry.invariant}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...new Set(realObservations.map((entry) => entry.actionName))].sort())
      .toEqual(catalogWriteNames());
  });

  it("derives a complete artifact from the real observed write behaviour", () => {
    const report = buildWriteSafetyReport(realObservations);
    // Name every violating write before the aggregate assertion, so a single
    // regressed invariant fails THIS test with the write's name in the diff.
    expect(report.failures).toEqual([]);
    expect(report.status).toBe("passed");
    expect(report.numerator).toBe(report.denominator);
    expect(report.denominator).toBe(writeSafetyExpectedChecks());
    expect(isReleasableReport(report)).toBe(true);

    const authority = authorityEvidenceFromReport(report);
    expect(authority.status).toBe("complete");
    if (authority.status !== "complete") throw new Error("expected complete authority evidence");
    expect(authority.evidence.engine).toBe("v2");
    expect(authority.evidence.registryId).toBe("v2-api");
    expect(authority.evidence.candidateSha).toBe(candidateSha());
    expect(authority.evidence.catalogHash).toBe(MODEL_API_ACTION_CATALOG.hash());
    expect(authority.evidence.assistantWriteCases).toBe(catalogWriteNames().length);
    expect(authority.evidence.preparationMutationCount).toBe(0);
    expect(authority.evidence.typedConsentDispatchCount).toBe(0);
    expect(authority.evidence.promptInjectionDispatchCount).toBe(0);
    expect(authority.evidence.duplicateConfirmationDispatchViolations).toBe(0);
    expect(Object.values(authority.conclusions)).toEqual(["passed", "passed", "passed", "passed"]);
  });

  it("goes incomplete and NAMES the write when one real observation is unsatisfied", () => {
    const target = catalogWriteNames()[0]!;
    const mutated = realObservations.map((entry) =>
      entry.actionName === target && entry.invariant === "zero_preparation_mutation"
        ? { ...entry, satisfied: false, violationCode: "mutation_during_preparation" }
        : entry,
    );
    const report = buildWriteSafetyReport(mutated);
    expect(report.status).toBe("failed");
    expect(report.failures).toEqual([{
      caseId: target,
      cohort: "zero_preparation_mutation",
      repeat: 0,
      failureCode: "mutation_during_preparation",
    }]);
    expect(authorityEvidenceFromReport(report).status).toBe(V2_AUTHORITY_NOT_EVALUATED_SENTINEL);
  });

  it("rejects a PARTIAL report: an unobserved invariant fails rather than being skipped", () => {
    const observations = realObservations.filter(
      (entry) => !(entry.actionName === catalogWriteNames()[0] && entry.invariant === "no_ambiguity_retry"),
    );
    expect(() => buildWriteSafetyReport(observations)).toThrow(/missing_write_safety_observation/);
  });

  it("rejects a SENTINEL / blocked report", () => {
    const blocked = blockedWriteSafetyReport("no observations");
    expect(blocked.status).toBe("not_evaluated_missing_credentials");
    expect(authorityEvidenceFromReport(blocked).status).toBe(V2_AUTHORITY_NOT_EVALUATED_SENTINEL);
  });

  it("rejects a ZERO-CASE report", () => {
    expect(() => buildWriteSafetyReport([])).toThrow(/missing_write_safety_observation/);
  });

  it("rejects a report bound to the WRONG candidate SHA", () => {
    const report = buildWriteSafetyReport(realObservations);
    const stale = { ...report, identity: { ...report.identity, candidateSha: "b".repeat(40) } };
    expect(authorityEvidenceFromReport(stale).status).toBe(V2_AUTHORITY_NOT_EVALUATED_SENTINEL);
  });

  it("rejects a report bound to the WRONG catalog hash", () => {
    const report = buildWriteSafetyReport(realObservations);
    const stale = { ...report, identity: { ...report.identity, catalogHash: "c".repeat(64) } };
    expect(authorityEvidenceFromReport(stale).status).toBe(V2_AUTHORITY_NOT_EVALUATED_SENTINEL);
  });
});

describe("T17-D: the mixed fixture proves only counting arithmetic", () => {
  it("is genuinely mixed — some satisfied, some not, never all-true", () => {
    const mixed = mixedArithmeticObservations();
    const satisfied = mixed.filter((entry) => entry.satisfied).length;
    expect(satisfied).toBeGreaterThan(0);
    expect(mixed.length - satisfied).toBeGreaterThan(0);
  });

  it("counts every observation exactly once, with no invariant double-credited", () => {
    const mixed = mixedArithmeticObservations();
    const attempts = attemptsFromObservations(mixed);
    expect(attempts.length).toBe(writeSafetyExpectedChecks());
    const keys = attempts.map((attempt) => `${attempt.caseId} ${attempt.cohort}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(attempts.filter((attempt) => attempt.passed).length)
      .toBe(mixed.filter((entry) => entry.satisfied).length);
  });

  it("can never become a passing report or a complete artifact", () => {
    const report = buildWriteSafetyReport(mixedArithmeticObservations());
    expect(report.status).toBe("failed");
    expect(report.numerator).toBeGreaterThan(0);
    expect(report.failures.length).toBeGreaterThan(0);
    expect(report.numerator + report.failures.length).toBe(report.denominator);
    expect(isReleasableReport(report)).toBe(false);
    expect(authorityEvidenceFromReport(report).status).toBe(V2_AUTHORITY_NOT_EVALUATED_SENTINEL);
  });
});
