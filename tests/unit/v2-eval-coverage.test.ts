import { describe, expect, it } from "vitest";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import type { ActionRegistry } from "../../src/harness/api-catalog.js";
import type { ActionDefinition } from "../../src/harness/action.js";
import {
  buildEvalCases,
  caseByName,
  evalOperationNames,
  type EvalCase,
} from "../../scripts/eval-v2/case-model.js";
import { READ_PARITY_FIXTURES } from "../helpers/v2-read-parity-fixtures.js";
import { WRITE_PREVIEW_FIXTURES } from "../helpers/v2-write-preview-fixtures.js";
import {
  buildDiscoveryEvalCorpus,
  buildDiscoveryEvalCases,
  DISCOVERY_CORPUS_VERSION,
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
import {
  apiDiscoveryIdentity,
  runApiDiscoveryEvaluation,
} from "../../scripts/eval-api-discovery.js";

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

const M4_EXCLUDED_ADDON_OPERATIONS = [
  "clockify_custom_fields_create",
  "clockify_webhooks_create",
  "clockify_webhooks_delete",
  "clockify_webhooks_get",
  "clockify_webhooks_list",
  "clockify_webhooks_logs",
  "clockify_webhooks_update",
] as const;

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

function addonLoadableOperationNames(): string[] {
  return MODEL_API_ACTION_CATALOG.actions
    .filter((action) => action.apiOperation)
    .filter((action) => MODEL_API_ACTION_CATALOG.availability(action.name, "addon").available)
    .map((action) => action.name)
    .sort();
}

function excludedDiscoveryOperationNames(): string[] {
  const emitted = new Set(buildDiscoveryEvalCases().map((entry) => entry.actionName));
  return catalogOperationNames().filter((name) => !emitted.has(name));
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

  it("detects an ORPHAN fixture: a shipped fixture key with no catalog operation", () => {
    // The catalog-to-fixture direction alone cannot see a fixture left behind by a
    // renamed action (pre-T18 review). Check the reverse direction explicitly.
    const catalogNames = new Set(
      MODEL_API_ACTION_CATALOG.actions.filter((action) => action.apiOperation).map((action) => action.name),
    );
    const readOrphans = Object.keys(READ_PARITY_FIXTURES).filter((name) => !catalogNames.has(name));
    const writeOrphans = Object.keys(WRITE_PREVIEW_FIXTURES).filter((name) => !catalogNames.has(name));
    expect(readOrphans, "orphan read fixtures").toEqual([]);
    expect(writeOrphans, "orphan write fixtures").toEqual([]);
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

describe("T17-A/M4: the discovery cohort covers every addon-loadable operation and never invites a destructive neighbour", () => {
  it("emits one discovery case per addon-loadable operation with its three phrasings", () => {
    const cases = buildDiscoveryEvalCases();
    expect(cases.map((entry) => entry.actionName).sort()).toEqual(addonLoadableOperationNames());
    for (const entry of cases) {
      expect(entry.canonicalRequest.length, entry.actionName).toBeGreaterThan(0);
      expect(entry.paraphraseRequest.length, entry.actionName).toBeGreaterThan(0);
      // Nothing in the watch list may share the request's own feature group,
      // and the requested operation is never its own counter-example.
      expect(entry.unrelatedDestructiveOperations, entry.actionName).not.toContain(entry.actionName);
    }
  });

  it("drops the discovery corpus from 127 source operations to 120 addon-loadable cases", () => {
    expect(catalogOperationNames()).toHaveLength(127);
    expect(buildDiscoveryEvalCases()).toHaveLength(120);
  });

  it("records the exact seven operations excluded by the addon availability contract", () => {
    expect(excludedDiscoveryOperationNames()).toEqual(M4_EXCLUDED_ADDON_OPERATIONS);
  });

  it("emits no case that the real registry says the addon harness cannot load", () => {
    for (const entry of buildDiscoveryEvalCases()) {
      expect(
        MODEL_API_ACTION_CATALOG.availability(entry.actionName, "addon").available,
        entry.actionName,
      ).toBe(true);
    }
  });

  it("makes the auth-class filter and denominator change visible in report identity metadata", async () => {
    const credentialKeys = ["LLM_PROVIDER", "LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"] as const;
    const saved = new Map(credentialKeys.map((key) => [key, process.env[key]] as const));
    for (const key of credentialKeys) delete process.env[key];
    try {
      const report = await runApiDiscoveryEvaluation();

      expect(report.caseCount).toBe(120);
      expect(report.identity.caseSelection).toEqual({
        authClass: "addon",
        sourceOperationCount: 127,
        excludedOperationNames: M4_EXCLUDED_ADDON_OPERATIONS,
      });
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
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

interface PromptArgumentLeaf {
  path: string;
  value: string | number | boolean;
}

function promptArgumentLeaves(value: unknown, path = ""): PromptArgumentLeaf[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => promptArgumentLeaves(entry, `${path}[${index}]`));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) =>
      promptArgumentLeaves(entry, path.length > 0 ? `${path}.${key}` : key));
  }
  if (value === undefined || value === null) return [];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return [{ path, value }];
  }
  return [];
}

type ResolverSeedResource =
  | "clients"
  | "expenseCategories"
  | "groups"
  | "invoices"
  | "projects"
  | "tags"
  | "tasks"
  | "timeOffPolicies"
  | "users";

const RESOLVER_RESOURCE_BY_PATH: Readonly<Record<string, ResolverSeedResource>> = {
  assigneeIds: "users",
  categoryId: "expenseCategories",
  clientId: "clients",
  groupId: "groups",
  invoiceId: "invoices",
  policyId: "timeOffPolicies",
  projectId: "projects",
  taskId: "tasks",
  userId: "users",
  userIds: "users",
};

const RESOLVER_ID_RESOURCE_BY_ACTION_PREFIX: ReadonlyArray<readonly [string, ResolverSeedResource]> = [
  ["clockify_clients_", "clients"],
  ["clockify_expenses_categories_", "expenseCategories"],
  ["clockify_groups_", "groups"],
  ["clockify_invoices_", "invoices"],
  ["clockify_projects_", "projects"],
  ["clockify_tags_", "tags"],
  ["clockify_tasks_", "tasks"],
  ["clockify_time_off_policies_", "timeOffPolicies"],
];

function resolverResource(actionName: string, path: string): ResolverSeedResource | undefined {
  const normalized = path.replace(/\[\d+\]/gu, "");
  const leafPath = normalized.split(".").at(-1) ?? normalized;
  const pathResource = RESOLVER_RESOURCE_BY_PATH[leafPath];
  if (pathResource !== undefined) return pathResource;
  if (normalized !== "id") return undefined;
  return RESOLVER_ID_RESOURCE_BY_ACTION_PREFIX.find(([prefix]) => actionName.startsWith(prefix))?.[1];
}

function seededHumanAliases(entry: EvalCase, leaf: PromptArgumentLeaf): string[] {
  if (typeof leaf.value !== "string") return [];
  const resource = resolverResource(entry.actionName, leaf.path);
  if (resource === undefined || entry.fakeSeed === null || typeof entry.fakeSeed !== "object") return [];
  const rows = (entry.fakeSeed as Record<string, unknown>)[resource];
  if (!Array.isArray(rows)) return [];
  const row = rows.find((candidate) =>
    candidate !== null
    && typeof candidate === "object"
    && (candidate as Record<string, unknown>).id === leaf.value);
  if (row === null || typeof row !== "object") return [];
  const aliases = new Set<string>();
  const record = row as Record<string, unknown>;
  for (const key of ["name", "number", "email"] as const) {
    if (typeof record[key] === "string" && record[key].length > 0) aliases.add(record[key]);
  }
  return [...aliases];
}

function idArgumentLabel(actionName: string): string {
  if (actionName.startsWith("clockify_clients_")) return "client";
  if (actionName.startsWith("clockify_expenses_categories_")) return "expense category";
  if (actionName.startsWith("clockify_groups_")) return "group";
  if (actionName.startsWith("clockify_invoices_")) return "invoice";
  if (actionName.startsWith("clockify_projects_")) return "project";
  if (actionName.startsWith("clockify_tags_")) return "tag";
  if (actionName.startsWith("clockify_tasks_")) return "task";
  if (actionName.startsWith("clockify_time_off_policies_")) return "time-off policy";
  return "id";
}

function expectedPromptLabel(actionName: string, path: string): string {
  const normalized = path.replace(/\[\d+\]/gu, "");
  if (normalized === "id") return idArgumentLabel(actionName);
  if (normalized === "name" && /_(?:update|rename)$/u.test(actionName)) return "new name";
  const leaf = normalized.split(".").at(-1) ?? normalized;
  const labels: Record<string, string> = {
    assigneeIds: "assignee",
    categoryId: "expense category",
    clientId: "client",
    dateRangeEnd: "date range end",
    dateRangeStart: "date range start",
    durationHours: "duration hours",
    endDate: "end date",
    entryId: "time entry id",
    fieldId: "custom field id",
    groupId: "group",
    groups: "report grouping",
    hoursPerDay: "hours per day",
    invoiceId: "invoice",
    memberships: "member",
    paymentDate: "payment date",
    paymentId: "payment id",
    policyId: "time-off policy",
    projectId: "project",
    requestId: "request id",
    seriesUpdateOption: "series update option",
    startDate: "start date",
    taskId: "task",
    unitPrice: "unit price",
    userId: "user",
    userIds: "user",
  };
  return labels[leaf] ?? leaf.replace(/([a-z])([A-Z])/gu, "$1 $2").toLocaleLowerCase("en-US");
}

function exactPromptValues(entry: EvalCase, leaf: PromptArgumentLeaf): string[] {
  const raw = leaf.value;
  if (typeof raw !== "string") return [String(raw)];
  const aliases = seededHumanAliases(entry, leaf);
  if (aliases.length > 0) return aliases.map((alias) => `"${alias}"`);
  const values = new Set<string>();
  values.add(`"${raw}"`);
  if (/^PT\d+H$/u.test(raw)) values.add(`"${raw.slice(2, -1)} hours (${raw})"`);
  if (raw === "this_week" || raw === "last_week") {
    values.add(`"${raw.replace("_", " ")} (${raw})"`);
  }
  return [...values];
}

const PROMPT_ARGUMENT_MARKER = " Use these request values: ";

function promptArgumentSuffix(request: string): string {
  const marker = request.indexOf(PROMPT_ARGUMENT_MARKER);
  return marker === -1 ? "" : request.slice(marker);
}

function promptIntentPrefix(request: string): string {
  const marker = request.indexOf(PROMPT_ARGUMENT_MARKER);
  return marker === -1 ? request : request.slice(0, marker);
}

function invalidPromptArguments(entry: EvalCase, request: string): string[] {
  const leaves = promptArgumentLeaves(entry.expectedArguments);
  const marker = request.indexOf(PROMPT_ARGUMENT_MARKER);
  if (leaves.length === 0) {
    return marker === -1 ? [] : ["unexpected_argument_suffix"];
  }
  if (marker === -1 || marker !== request.lastIndexOf(PROMPT_ARGUMENT_MARKER)) {
    return leaves.map((leaf) => `${leaf.path}=${leaf.value}`);
  }
  const suffixBody = request.slice(marker + PROMPT_ARGUMENT_MARKER.length);
  if (!suffixBody.endsWith(".")) return leaves.map((leaf) => `${leaf.path}=${leaf.value}`);
  const clauses = suffixBody.slice(0, -1).split("; ");
  const invalid: string[] = [];
  for (const [index, leaf] of leaves.entries()) {
    const clause = clauses[index];
    const label = expectedPromptLabel(entry.actionName, leaf.path);
    const expectedPrefix = `${label} `;
    const value = clause?.startsWith(expectedPrefix) ? clause.slice(expectedPrefix.length) : undefined;
    if (value === undefined || !exactPromptValues(entry, leaf).includes(value)) {
      invalid.push(`${leaf.path}=${leaf.value}`);
    }
  }
  if (clauses.length !== leaves.length) invalid.push(`clause_count=${clauses.length}/${leaves.length}`);
  return invalid;
}

function isSingleCharacterInsertionOrDeletion(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) !== 1) return false;
  const [longer, shorter] = left.length > right.length ? [left, right] : [right, left];
  let mismatch = 0;
  while (mismatch < shorter.length && longer[mismatch] === shorter[mismatch]) mismatch += 1;
  return longer.slice(mismatch + 1) === shorter.slice(mismatch);
}

describe("M5: the discovery corpus carries user-authored arguments", () => {
  it("grounds every expected argument in every canonical, paraphrase, and typo request", () => {
    const casesByName = caseByName(buildEvalCases());
    const offenders: string[] = [];
    const discoveryCases = buildDiscoveryEvalCases();
    let checkedScalarArguments = 0;
    for (const discovery of discoveryCases) {
      const entry = casesByName.get(discovery.actionName);
      if (!entry) throw new Error(`missing_eval_case:${discovery.actionName}`);
      expect(discovery.paraphraseRequest, entry.actionName).not.toBe(discovery.canonicalRequest);
      expect(promptArgumentSuffix(discovery.paraphraseRequest), `${entry.actionName}:paraphrase suffix`)
        .toBe(promptArgumentSuffix(discovery.canonicalRequest));
      expect(promptArgumentSuffix(discovery.typoRequest ?? ""), `${entry.actionName}:typo suffix`)
        .toBe(promptArgumentSuffix(discovery.canonicalRequest));
      expect(
        discovery.typoRequest
          ? isSingleCharacterInsertionOrDeletion(
            promptIntentPrefix(discovery.canonicalRequest),
            promptIntentPrefix(discovery.typoRequest),
          )
          : false,
        `${entry.actionName} typo must change exactly one character without changing its arguments`,
      ).toBe(true);
      for (const [cohort, request] of [
        ["canonical", discovery.canonicalRequest],
        ["paraphrase", discovery.paraphraseRequest],
        ["typo", discovery.typoRequest],
      ] as const) {
        if (!request) {
          offenders.push(`${entry.actionName}:${cohort}:missing_request`);
          continue;
        }
        checkedScalarArguments += promptArgumentLeaves(entry.expectedArguments).length;
        const missing = invalidPromptArguments(entry, request);
        if (missing.length > 0) offenders.push(`${entry.actionName}:${cohort}:${missing.join(",")}`);
      }
    }

    expect(discoveryCases).toHaveLength(120);
    expect(checkedScalarArguments).toBe(570);
    expect(
      offenders,
      `${offenders.length} under-specified case/cohort phrasings; first offenders: ${offenders.slice(0, 8).join(" | ")}`,
    ).toEqual([]);
  });

  it("detects clause deletion, evidence corruption, and invalid resource aliases", () => {
    const cases = caseByName(buildEvalCases());
    const mutations = [
      {
        id: "entries_list_start_deleted",
        entry: cases.get("clockify_entries_list")!,
        originalRequest: cases.get("clockify_entries_list")!.canonicalRequest,
        request: cases.get("clockify_entries_list")!.canonicalRequest.replace('start "today"; ', ""),
        expectedMissing: "start=today",
      },
      {
        id: "expenses_create_category_deleted",
        entry: cases.get("clockify_expenses_create")!,
        originalRequest: cases.get("clockify_expenses_create")!.canonicalRequest,
        request: cases.get("clockify_expenses_create")!.canonicalRequest.replace('expense category "Travel"; ', ""),
        expectedMissing: "categoryId=ec1",
      },
      {
        id: "groups_update_source_deleted",
        entry: cases.get("clockify_groups_update")!,
        originalRequest: cases.get("clockify_groups_update")!.canonicalRequest,
        request: cases.get("clockify_groups_update")!.canonicalRequest.replace('group "Team"; ', ""),
        expectedMissing: "id=g1",
      },
      {
        id: "invoice_item_quantity_deleted",
        entry: cases.get("clockify_invoices_items_add")!,
        originalRequest: cases.get("clockify_invoices_items_add")!.canonicalRequest,
        request: cases.get("clockify_invoices_items_add")!.canonicalRequest.replace("quantity 1; ", ""),
        expectedMissing: "quantity=1",
      },
      {
        id: "scheduling_start_deleted",
        entry: cases.get("clockify_scheduling_assignments_create")!,
        originalRequest: cases.get("clockify_scheduling_assignments_create")!.canonicalRequest,
        request: cases.get("clockify_scheduling_assignments_create")!.canonicalRequest.replace(
          'start "2026-06-10"; ',
          "",
        ),
        expectedMissing: "start=2026-06-10",
      },
      {
        id: "typo_start_evidence_corrupted",
        entry: cases.get("clockify_entries_list")!,
        originalRequest: cases.get("clockify_entries_list")!.typoRequest!,
        request: cases.get("clockify_entries_list")!.typoRequest!.replace('start "today"', 'start "tday"'),
        expectedMissing: "start=today",
      },
      {
        id: "entries_get_description_alias",
        entry: cases.get("clockify_entries_get")!,
        originalRequest: cases.get("clockify_entries_get")!.canonicalRequest,
        request: cases.get("clockify_entries_get")!.canonicalRequest.replace('id "e1"', 'id "Focus"'),
        expectedMissing: "id=e1",
      },
      {
        id: "expenses_get_unscoped_alias",
        entry: cases.get("clockify_expenses_get")!,
        originalRequest: cases.get("clockify_expenses_get")!.canonicalRequest,
        request: cases.get("clockify_expenses_get")!.canonicalRequest.replace('id "exp1"', 'id "Travel"'),
        expectedMissing: "id=exp1",
      },
      {
        id: "custom_fields_delete_unscoped_alias",
        entry: cases.get("clockify_custom_fields_delete")!,
        originalRequest: cases.get("clockify_custom_fields_delete")!.canonicalRequest,
        request: cases.get("clockify_custom_fields_delete")!.canonicalRequest.replace(
          'id "cf1"',
          'id "Priority"',
        ),
        expectedMissing: "id=cf1",
      },
      {
        id: "holidays_delete_unscoped_alias",
        entry: cases.get("clockify_holidays_delete")!,
        originalRequest: cases.get("clockify_holidays_delete")!.canonicalRequest,
        request: cases.get("clockify_holidays_delete")!.canonicalRequest.replace('id "h1"', 'id "Team day"'),
        expectedMissing: "id=h1",
      },
      {
        id: "clients_get_raw_id",
        entry: cases.get("clockify_clients_get")!,
        originalRequest: cases.get("clockify_clients_get")!.canonicalRequest,
        request: cases.get("clockify_clients_get")!.canonicalRequest.replace('client "Acme"', 'client "c1"'),
        expectedMissing: "id=c1",
      },
    ];
    const undetected: string[] = [];
    for (const mutation of mutations) {
      expect(mutation.request, `${mutation.id} must mutate the request`).not.toBe(mutation.originalRequest);
      if (!invalidPromptArguments(mutation.entry, mutation.request).includes(mutation.expectedMissing)) {
        undetected.push(mutation.id);
      }
    }
    expect(undetected, `${undetected.length} clause mutations escaped the argument gate`).toEqual([]);
  });

  it("uses seeded names and preserves representative dates, renames, durations, and typo meaning", () => {
    const cases = caseByName(buildEvalCases());
    const clientsGet = cases.get("clockify_clients_get")!;
    const groupRename = cases.get("clockify_groups_update")!;
    const entryCreate = cases.get("clockify_entries_create")!;
    const estimate = cases.get("clockify_projects_estimate_update")!;
    const schedule = cases.get("clockify_scheduling_assignments_create")!;

    for (const request of [clientsGet.canonicalRequest, clientsGet.paraphraseRequest, clientsGet.typoRequest!]) {
      expect(request).toContain("Acme");
      expect(request).not.toContain("c1");
    }
    for (const request of [groupRename.canonicalRequest, groupRename.paraphraseRequest, groupRename.typoRequest!]) {
      expect(request).toContain("Team");
      expect(request).toContain("Team renamed");
      expect(request).not.toContain("g1");
    }
    for (const request of [entryCreate.canonicalRequest, entryCreate.paraphraseRequest, entryCreate.typoRequest!]) {
      expect(request).toContain("today");
      expect(request).toContain("1");
      expect(request).toContain("Work");
    }
    expect(estimate.canonicalRequest).toContain("Website");
    expect(estimate.canonicalRequest).toMatch(/PT2H|2 hours/u);
    expect(schedule.canonicalRequest).toContain("2026-06-10");
    expect(schedule.canonicalRequest).toContain("8");

    expect(entryCreate.typoRequest).not.toBe(entryCreate.canonicalRequest);
    for (const literal of ["today", "1", "Work"]) {
      expect(entryCreate.typoRequest).toContain(literal);
    }
  });

  it("pins the discovery corpus version in normal and missing-credential report identities", async () => {
    expect(DISCOVERY_CORPUS_VERSION).toBe("v2-discovery-argument-bearing-v1");
    expect(apiDiscoveryIdentity(
      { provider: "http", model: "fixture-model" },
      buildDiscoveryEvalCorpus().caseSelection,
    ).corpusVersion).toBe(DISCOVERY_CORPUS_VERSION);

    const credentialKeys = ["LLM_PROVIDER", "LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"] as const;
    const saved = new Map(credentialKeys.map((key) => [key, process.env[key]] as const));
    for (const key of credentialKeys) delete process.env[key];
    try {
      const report = await runApiDiscoveryEvaluation();
      expect((report.identity as unknown as Record<string, unknown>).corpusVersion)
        .toBe(DISCOVERY_CORPUS_VERSION);
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("keeps generic eval report identities compatible without a corpus version", () => {
    const report = buildEvalReport({
      kind: "generic_eval",
      identity: IDENTITY,
      caseIds: ["case"],
      attempts: [{ caseId: "case", cohort: "canonical", repeat: 0, passed: true }],
    });
    expect((report.identity as unknown as Record<string, unknown>).corpusVersion).toBeUndefined();
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

  it("rejects a SHORT attempt set: passing 5 of 127 cases is not releasable", () => {
    const all = buildEvalCases().map((entry) => entry.actionName);
    const short = buildEvalReport({
      kind: "k",
      identity: IDENTITY,
      caseIds: all,
      attempts: attemptsFor(all.slice(0, 5), true),
    });
    // Internally consistent (5/5) but it covered 5 of 127 cases.
    expect(short.status).toBe("passed");
    expect(short.numerator).toBe(short.denominator);
    expect(short.scoredCaseIds).toHaveLength(5);
    expect(isReleasableReport(short)).toBe(false);
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
