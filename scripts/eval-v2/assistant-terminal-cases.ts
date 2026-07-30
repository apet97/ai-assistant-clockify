import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import type { ActionRegistry } from "../../src/harness/api-catalog.js";
import { buildEvalCases, caseByName, type EvalCase } from "./case-model.js";

/**
 * T17-A: the terminal-outcome cohorts T17-C scores. Every cohort scores the
 * FINAL terminal state of a run, never the first tool selection.
 *
 * Three kinds of cohort, kept explicitly distinct so nothing is fabricated:
 *
 *  1. **Derived per-operation cohorts** — membership comes from
 *     `case-model.ts`'s `compoundMembership`, which reads shipped facts only
 *     (access, feature group, `listFamily`, `unicodeSeed`, addon availability,
 *     `referenceSelector`, `expectPreview`).
 *  2. **Compound journeys** — the exact multi-write sequences the shipped
 *     `tests/integration/v2-compound-api-requests.test.ts` already proves need
 *     separate confirmations. These are transcribed from that suite, not
 *     invented, and every member is asserted to exist in the catalog.
 *  3. **Runtime-scenario cohorts** — cancellation, budget exhaustion, partial
 *     outcome and unknown outcome are properties of a RUN, not of an operation.
 *     Each declares the scenario to drive plus a deterministically chosen
 *     representative operation (the first case, in catalog sort order, that
 *     matches the scenario's required access) rather than a hand-picked one.
 */

export const TERMINAL_COHORT_NAMES = [
  "single_read",
  "multi_read",
  "single_write",
  "independent_writes",
  "dependent_writes",
  "clarification",
  "references",
  "denial",
  "unavailable_auth_class",
  "truncation",
  "unicode",
  "hostile_data",
  "cancellation",
  "budget_exhaustion",
  "partial_outcome",
  "unknown_outcome",
] as const;

export type TerminalCohortName = (typeof TERMINAL_COHORT_NAMES)[number];

/** Cohorts where every repeat must succeed: safety, denial, ambiguity, hostile data. */
export const TERMINAL_STRICT_COHORTS: readonly TerminalCohortName[] = [
  "single_write",
  "independent_writes",
  "dependent_writes",
  "clarification",
  "denial",
  "unavailable_auth_class",
  "hostile_data",
  "cancellation",
  "budget_exhaustion",
  "partial_outcome",
  "unknown_outcome",
];

export const TERMINAL_REPEATS = 3;

/**
 * The dependent write journeys proved by `v2-compound-api-requests.test.ts`:
 * each later step needs the canonical result of the previous one, so each step
 * is its own preview and its own button confirmation.
 */
export const DEPENDENT_WRITE_JOURNEYS: readonly { id: string; steps: readonly string[] }[] = [
  {
    id: "project_setup",
    steps: [
      "clockify_projects_create",
      "clockify_projects_memberships_replace",
      "clockify_projects_member_hourly_rate_update",
    ],
  },
  {
    id: "client_base_then_optional_fields",
    steps: ["clockify_clients_create_base", "clockify_clients_update"],
  },
  {
    id: "invoice_base_fields_item",
    steps: [
      "clockify_invoices_create_base",
      "clockify_invoices_fields_update",
      "clockify_invoices_items_add",
    ],
  },
  {
    id: "invite_then_group_membership",
    steps: ["clockify_users_invite", "clockify_groups_add_member"],
  },
];

/** Two independent existing-target writes that may share ONE exact confirmation batch. */
export const INDEPENDENT_WRITE_BATCH: readonly string[] = [
  "clockify_tags_update",
  "clockify_clients_update",
];

/** Unit-specific writes that must stay separate operations rather than one polymorphic call. */
export const UNIT_SPECIFIC_WRITES: readonly string[] = [
  "clockify_time_off_requests_create_days",
  "clockify_time_off_requests_create_hours",
];

export type RuntimeScenario =
  | "abort_before_dispatch"
  | "exhaust_host_call_budget"
  | "definitive_failure_after_known_effect"
  | "ambiguous_settlement_after_dispatch";

export interface RuntimeScenarioCohort {
  cohort: TerminalCohortName;
  scenario: RuntimeScenario;
  /** Required access for a representative operation. */
  access: EvalCase["access"];
  /** The exact terminal state the run must reach. */
  expectedTerminalState: "cancelled" | "denied" | "partial" | "outcome_unknown";
  representativeActionName: string;
}

function firstCaseName(cases: readonly EvalCase[], access: EvalCase["access"]): string {
  const match = cases.find((entry) => entry.access === access);
  if (!match) throw new Error(`no_eval_case_for_access:${access}`);
  return match.actionName;
}

export interface TerminalCohort {
  cohort: TerminalCohortName;
  /** Operations scored in this cohort, in catalog sort order. */
  actionNames: string[];
  /** Present only for the two compound cohorts. */
  journeys?: readonly { id: string; steps: readonly string[] }[];
  /** Present only for runtime-scenario cohorts. */
  runtime?: RuntimeScenarioCohort;
  strict: boolean;
}

export function buildTerminalCohorts(
  registry: ActionRegistry = MODEL_API_ACTION_CATALOG,
): TerminalCohort[] {
  const cases = buildEvalCases(registry);
  const known = caseByName(cases);

  const assertKnown = (names: readonly string[], journeyId: string): string[] => {
    const unknown = names.filter((name) => !known.has(name));
    if (unknown.length > 0) {
      throw new Error(`unknown_journey_step:${journeyId}:${unknown.join(",")}`);
    }
    return [...names];
  };

  const derived = (cohort: TerminalCohortName): string[] =>
    cases.filter((entry) => entry.compoundMembership.includes(cohort)).map((entry) => entry.actionName);

  const runtimeCohorts: RuntimeScenarioCohort[] = [
    {
      cohort: "cancellation",
      scenario: "abort_before_dispatch",
      access: "write",
      expectedTerminalState: "cancelled",
      representativeActionName: firstCaseName(cases, "write"),
    },
    {
      cohort: "budget_exhaustion",
      scenario: "exhaust_host_call_budget",
      access: "read",
      expectedTerminalState: "denied",
      representativeActionName: firstCaseName(cases, "read"),
    },
    {
      cohort: "partial_outcome",
      scenario: "definitive_failure_after_known_effect",
      access: "write",
      expectedTerminalState: "partial",
      representativeActionName: firstCaseName(cases, "write"),
    },
    {
      cohort: "unknown_outcome",
      scenario: "ambiguous_settlement_after_dispatch",
      access: "write",
      expectedTerminalState: "outcome_unknown",
      representativeActionName: firstCaseName(cases, "write"),
    },
  ];

  return TERMINAL_COHORT_NAMES.map((cohort): TerminalCohort => {
    const strict = TERMINAL_STRICT_COHORTS.includes(cohort);
    if (cohort === "dependent_writes") {
      return {
        cohort,
        strict,
        journeys: DEPENDENT_WRITE_JOURNEYS,
        actionNames: DEPENDENT_WRITE_JOURNEYS.flatMap((journey) => assertKnown(journey.steps, journey.id)),
      };
    }
    if (cohort === "independent_writes") {
      return {
        cohort,
        strict,
        journeys: [
          { id: "independent_batch", steps: INDEPENDENT_WRITE_BATCH },
          { id: "unit_specific", steps: UNIT_SPECIFIC_WRITES },
        ],
        actionNames: derived(cohort),
      };
    }
    if (cohort === "clarification") {
      // A clarification cohort member must be an operation whose arguments can
      // actually go ambiguous: the reads that resolve an entity or member by
      // name. That is exactly the reads carrying a name-resolvable argument in
      // their shipped fixture, so it is derived from the fixture, not listed.
      return {
        cohort,
        strict,
        actionNames: cases
          .filter((entry) => entry.access === "read" && nameResolvableArgument(entry))
          .map((entry) => entry.actionName),
      };
    }
    const runtime = runtimeCohorts.find((candidate) => candidate.cohort === cohort);
    if (runtime) {
      return { cohort, strict, runtime, actionNames: [runtime.representativeActionName] };
    }
    return { cohort, strict, actionNames: derived(cohort) };
  });
}

/** A read whose fixture passes an id/name-bearing argument the server resolves — the
 * only reads that can reach a grounded clarification. */
function nameResolvableArgument(entry: EvalCase): boolean {
  return Object.keys(entry.expectedArguments).some((key) =>
    key === "id" || key === "userId" || key === "assignedTo" || key === "projectId" || key === "name",
  );
}

export function terminalCohortByName(
  registry: ActionRegistry = MODEL_API_ACTION_CATALOG,
): Map<TerminalCohortName, TerminalCohort> {
  return new Map(buildTerminalCohorts(registry).map((cohort) => [cohort.cohort, cohort]));
}
