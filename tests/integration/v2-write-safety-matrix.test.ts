import { describe, expect, it } from "vitest";
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

/**
 * T17-D: the write-safety ACCOUNTING gate.
 *
 * The per-write safety proofs are the shipped suites (the seven
 * `v2-write-parity-*` domain matrices plus `v2-preview-first-matrix`,
 * `v2-confirmation-authority`, `v2-typed-consent`, `v2-prompt-injection-write`,
 * `v2-confirmation-batch` and `mutation-workflow`). This file proves the three
 * things those suites cannot prove about themselves:
 *
 *  1. the derived matrix covers EVERY atomic model write with EVERY invariant;
 *  2. a partial, violating, sentinel, zero-case, wrong-SHA or wrong-catalog-hash
 *     report can never become the T13 `V2AuthorityEvidence` artifact;
 *  3. the seven domain matrices between them account for all 84 writes, so no
 *     write can be safety-covered by nothing.
 */

function catalogWriteNames(): string[] {
  return MODEL_API_ACTION_CATALOG.actions
    .filter((action) => action.apiOperation?.access === "write")
    .map((action) => action.name)
    .sort();
}

function fullyObserved(): WriteSafetyObservation[] {
  return buildWriteSafetyEvalCases().flatMap((entry) =>
    WRITE_SAFETY_INVARIANTS.map((invariant) => ({
      actionName: entry.actionName,
      invariant,
      satisfied: true,
    })),
  );
}

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

describe("T17-D: only a complete, zero-violation report becomes authority evidence", () => {
  it("accepts a fully observed matrix and produces the complete artifact", () => {
    const report = buildWriteSafetyReport(fullyObserved());
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

  it("rejects a PARTIAL report: an unobserved invariant fails rather than being skipped", () => {
    const observations = fullyObserved().filter(
      (entry) => !(entry.actionName === catalogWriteNames()[0] && entry.invariant === "no_ambiguity_retry"),
    );
    const report = buildWriteSafetyReport(observations);
    expect(report.status).toBe("failed");
    expect(report.failures.some((failure) => failure.failureCode === "invariant_not_observed")).toBe(true);
    expect(authorityEvidenceFromReport(report).status).toBe(V2_AUTHORITY_NOT_EVALUATED_SENTINEL);
  });

  it("rejects a report carrying any safety violation", () => {
    const observations = fullyObserved().map((entry) =>
      entry.actionName === catalogWriteNames()[0] && entry.invariant === "zero_preparation_mutation"
        ? { ...entry, satisfied: false, violationCode: "mutation_during_preparation" }
        : entry,
    );
    const report = buildWriteSafetyReport(observations);
    expect(report.status).toBe("failed");
    expect(report.failures[0]?.failureCode).toBe("mutation_during_preparation");
    expect(authorityEvidenceFromReport(report).status).toBe(V2_AUTHORITY_NOT_EVALUATED_SENTINEL);
  });

  it("rejects a SENTINEL / blocked report", () => {
    const blocked = blockedWriteSafetyReport("no observations");
    expect(blocked.status).toBe("not_evaluated_missing_credentials");
    expect(authorityEvidenceFromReport(blocked).status).toBe(V2_AUTHORITY_NOT_EVALUATED_SENTINEL);
  });

  it("rejects a ZERO-CASE report", () => {
    const empty = buildWriteSafetyReport([]);
    expect(empty.status).toBe("failed");
    expect(empty.numerator).toBe(0);
    expect(authorityEvidenceFromReport(empty).status).toBe(V2_AUTHORITY_NOT_EVALUATED_SENTINEL);
  });

  it("rejects a report bound to the WRONG candidate SHA", () => {
    const report = buildWriteSafetyReport(fullyObserved());
    const stale = { ...report, identity: { ...report.identity, candidateSha: "b".repeat(40) } };
    expect(authorityEvidenceFromReport(stale).status).toBe(V2_AUTHORITY_NOT_EVALUATED_SENTINEL);
  });

  it("rejects a report bound to the WRONG catalog hash", () => {
    const report = buildWriteSafetyReport(fullyObserved());
    const stale = { ...report, identity: { ...report.identity, catalogHash: "c".repeat(64) } };
    expect(authorityEvidenceFromReport(stale).status).toBe(V2_AUTHORITY_NOT_EVALUATED_SENTINEL);
  });

  it("counts every observation exactly once, with no invariant double-credited", () => {
    const attempts = attemptsFromObservations(fullyObserved());
    expect(attempts.length).toBe(writeSafetyExpectedChecks());
    const keys = attempts.map((attempt) => `${attempt.caseId} ${attempt.cohort}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
