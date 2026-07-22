import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ActionDefinition } from "../../src/harness/action.js";
import { ACTION_CATALOG, actionFingerprint, catalogHash, getAction } from "../../src/harness/catalog.js";
import { summarizeArgs } from "../../src/harness/arg-summary.js";
import { writeAuthorityFor } from "../../src/harness/write-authority.js";

type AliasDefinition = {
  path: string;
  value: string | number | boolean | null;
  authoredPhrases: readonly string[];
};

interface JsonSchemaNode {
  type?: string | readonly string[];
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
}

const alias = (
  path: string,
  value: boolean,
  authoredPhrases: readonly string[],
): AliasDefinition => ({ path, value, authoredPhrases });

function canonicalAliases(aliases: readonly AliasDefinition[]): AliasDefinition[] {
  const scalarKey = (value: AliasDefinition["value"]) =>
    `${value === null ? "null" : typeof value}:${JSON.stringify(value)}`;
  return aliases
    .map((item) => ({ ...item, authoredPhrases: [...item.authoredPhrases].sort() }))
    .sort((left, right) =>
      left.path.localeCompare(right.path) ||
      scalarKey(left.value).localeCompare(scalarKey(right.value)) ||
      left.authoredPhrases.join("\0").localeCompare(right.authoredPhrases.join("\0")));
}

const BILLABLE = Object.freeze([
  alias("billable", false, ["non-billable", "nonbillable", "non billable", "not billable"]),
  alias("billable", true, ["billable"]),
]);
const ARCHIVED = Object.freeze([
  alias("archived", false, ["active", "restore", "unarchive", "unarchived"]),
  alias("archived", true, ["archive", "archived"]),
]);
const SEND_EMAIL = Object.freeze([
  alias("sendEmail", false, ["do not send email", "don't send email", "without email", "no email"]),
  alias("sendEmail", true, ["send email", "send an email"]),
]);

type ExpectedBooleanPath =
  | { aliases: readonly AliasDefinition[] }
  | { excluded: string };

const EXPECTED_BOOLEAN_PATHS: Readonly<Record<string, ExpectedBooleanPath>> = Object.freeze({
  "clockify_start_timer\0billable": { aliases: BILLABLE },
  "clockify_log_work\0billable": { aliases: BILLABLE },
  "clockify_fix_entry\0billable": { aliases: BILLABLE },
  "clockify_entries_mark_invoiced\0invoiced": { aliases: [
    alias("invoiced", false, ["not invoiced", "uninvoiced", "unmark as invoiced"]),
    alias("invoiced", true, ["invoiced", "mark as invoiced"]),
  ] },
  "clockify_create_work_package\0startTimer": { aliases: [
    alias("startTimer", false, ["do not start timer", "do not start a timer"]),
    alias("startTimer", true, ["start timer", "start a timer"]),
  ] },
  "clockify_create_work_package\0startTimer.billable": { aliases: [
    alias("startTimer.billable", false, BILLABLE[0]!.authoredPhrases),
    alias("startTimer.billable", true, BILLABLE[1]!.authoredPhrases),
  ] },
  "clockify_projects_create\0billable": { aliases: BILLABLE },
  "clockify_projects_create\0isPublic": { aliases: [
    alias("isPublic", false, ["private", "not public", "non-public"]),
    alias("isPublic", true, ["public", "not private"]),
  ] },
  "clockify_projects_update\0archived": { aliases: ARCHIVED },
  "clockify_projects_update\0billable": { aliases: BILLABLE },
  "clockify_projects_update\0isPublic": { aliases: [
    alias("isPublic", false, ["private", "not public", "non-public"]),
    alias("isPublic", true, ["public", "not private"]),
  ] },
  "clockify_clients_update\0archived": { aliases: ARCHIVED },
  "clockify_tags_update\0archived": { aliases: ARCHIVED },
  "clockify_expenses_create\0billable": { aliases: BILLABLE },
  "clockify_expenses_update\0billable": { aliases: BILLABLE },
  "clockify_expenses_categories_update\0archived": { aliases: ARCHIVED },
  "clockify_custom_fields_create\0required": { aliases: [
    alias("required", false, ["optional", "not required"]),
    alias("required", true, ["required"]),
  ] },
  "clockify_custom_fields_update\0required": { aliases: [
    alias("required", false, ["optional", "not required"]),
    alias("required", true, ["required"]),
  ] },
  "clockify_custom_fields_set_value_project\0value": {
    excluded: "The custom-field value is deliberately unconstrained and may itself be a boolean; only exact true/false text may authorize it.",
  },
  "clockify_custom_fields_set_value_entry\0value": {
    excluded: "The custom-field value is deliberately unconstrained and may itself be a boolean; only exact true/false text may authorize it.",
  },
  "clockify_time_off_policies_create\0negativeBalance": { aliases: [
    alias("negativeBalance", false, ["do not allow negative balance", "no negative balance", "negative balance not allowed"]),
    alias("negativeBalance", true, ["allow negative balance", "negative balance allowed"]),
  ] },
  "clockify_time_off_policies_create\0requiresApproval": { aliases: [
    alias("requiresApproval", false, ["does not require approval", "no approval required", "without approval"]),
    alias("requiresApproval", true, ["requires approval", "require approval", "approval required"]),
  ] },
  "clockify_time_off_policies_update\0requiresApproval": { aliases: [
    alias("requiresApproval", false, ["does not require approval", "no approval required", "without approval"]),
    alias("requiresApproval", true, ["requires approval", "require approval", "approval required"]),
  ] },
  "clockify_time_off_policies_archive\0archived": { aliases: ARCHIVED },
  "clockify_time_off_requests_create\0halfDay": { aliases: [
    alias("halfDay", false, ["full day", "full-day"]),
    alias("halfDay", true, ["half day", "half-day"]),
  ] },
  "clockify_holidays_create\0occursAnnually": { aliases: [
    alias("occursAnnually", false, ["one-time", "one time", "does not repeat"]),
    alias("occursAnnually", true, ["annually", "annual", "yearly", "every year"]),
  ] },
  "clockify_holidays_update\0occursAnnually": { aliases: [
    alias("occursAnnually", false, ["one-time", "one time", "does not repeat"]),
    alias("occursAnnually", true, ["annually", "annual", "yearly", "every year"]),
  ] },
  "clockify_scheduling_publish\0notifyUsers": { aliases: [
    alias("notifyUsers", false, ["do not notify users", "don't notify users", "without notifications"]),
    alias("notifyUsers", true, ["notify users", "send notifications"]),
  ] },
  "clockify_users_invite\0sendEmail": { aliases: SEND_EMAIL },
  "clockify_onboard_user\0sendEmail": { aliases: SEND_EMAIL },
  "clockify_setup_project\0isPublic": { aliases: [
    alias("isPublic", false, ["private", "not public", "non-public"]),
    alias("isPublic", true, ["public", "not private"]),
  ] },
  "clockify_setup_project\0private": { aliases: [
    alias("private", false, ["public", "not private"]),
    alias("private", true, ["private", "not public", "non-public"]),
  ] },
});

function schemaNodesAtPath(
  node: JsonSchemaNode,
  segments: readonly string[],
  index = 0,
): JsonSchemaNode[] {
  const branches = node.anyOf ?? node.oneOf;
  if (branches) return branches.flatMap((branch) => schemaNodesAtPath(branch, segments, index));
  if (index === segments.length) return [node];
  const segment = segments[index]!;
  const isArrayItem = segment.endsWith("[]");
  const propertyName = isArrayItem ? segment.slice(0, -2) : segment;
  const child = node.properties?.[propertyName];
  if (!child) return [];
  if (!isArrayItem) return schemaNodesAtPath(child, segments, index + 1);
  const arrayBranches = child.anyOf ?? child.oneOf ?? [child];
  return arrayBranches.flatMap((branch) => branch.items
    ? schemaNodesAtPath(branch.items, segments, index + 1)
    : []);
}

function acceptsBoolean(node: JsonSchemaNode): boolean {
  const branches = node.anyOf ?? node.oneOf;
  if (branches) return branches.some(acceptsBoolean);
  const types = typeof node.type === "string" ? [node.type] : node.type ?? [];
  return types.includes("boolean");
}

function projectCreateWithAliases(semanticLiteralAliases: readonly AliasDefinition[]): ActionDefinition {
  const action = getAction("clockify_projects_create");
  if (!action) throw new Error("missing_project_create_action");
  return { ...action, semanticLiteralAliases } as ActionDefinition;
}

function fingerprintContract(action: ActionDefinition) {
  const hasApiMetadata = action.apiExposure !== undefined
    || action.apiExposureReason !== undefined
    || action.apiOperation !== undefined
    || action.adapterEndpoints !== undefined
    || action.availabilityByAuthClass !== undefined
    || action.boundedArgumentDictionaries !== undefined
    || action.materialFields !== undefined
    || action.presentation !== undefined;
  return {
    name: action.name,
    args: summarizeArgs(action.schema),
    featureGroup: action.featureGroup,
    risks: action.risks,
    argumentAliases: action.argumentAliases ?? [],
    argumentOpenPaths: action.argumentOpenPaths ?? [],
    semanticLiteralAliases: action.semanticLiteralAliases ?? [],
    mutationWorkflow: action.mutationWorkflow,
    mutationContract: action.mutationContract,
    writeAuthority: action.writeAuthority,
    preparedSafeWrite: !!action.prepareSafeWrite && !!action.executeSafeWrite,
    ...(hasApiMetadata
      ? {
          apiExposure: action.apiExposure ?? null,
          apiExposureReason: action.apiExposureReason ?? null,
          apiOperation: action.apiOperation ?? null,
          adapterEndpoints: action.adapterEndpoints ?? null,
          availabilityByAuthClass: action.availabilityByAuthClass ?? null,
          boundedArgumentDictionaries: action.boundedArgumentDictionaries ?? [],
          materialFields: action.materialFields ?? [],
          presentation: action.presentation ?? null,
        }
      : {}),
  };
}

describe("action-scoped semantic literal alias metadata", () => {
  it("advertises the reviewed project-member identity and rate aliases from the catalog contract", () => {
    const action = getAction("clockify_projects_rate_update");
    expect(action?.writeAuthority?.semanticLiteralAliases).toEqual(canonicalAliases([
      { path: "userId", value: "me", authoredPhrases: ["my", "myself"] },
      {
        path: "rateKind",
        value: "HOURLY",
        authoredPhrases: ["project member", "project member rate", "member rate", "hourly rate"],
      },
      {
        path: "rateKind",
        value: "COST",
        authoredPhrases: ["project member cost rate", "member cost rate", "cost rate"],
      },
    ]));
  });

  it("advertises only reviewed public/private aliases on the exact project visibility path", () => {
    for (const actionName of [
      "clockify_projects_create",
      "clockify_projects_update",
      "clockify_setup_project",
    ]) {
      const action = getAction(actionName);
      const visibilityAliases = action?.semanticLiteralAliases?.filter((item) => item.path === "isPublic");
      expect(visibilityAliases).toEqual([
        { path: "isPublic", value: false, authoredPhrases: ["private", "not public", "non-public"] },
        { path: "isPublic", value: true, authoredPhrases: ["public", "not private"] },
      ]);
      expect(action?.writeAuthority?.semanticLiteralAliases.filter((item) => item.path === "isPublic")).toEqual(
        canonicalAliases(visibilityAliases ?? []),
      );
    }
  });

  it("advertises reviewed member-rate aliases for the combined project setup action", () => {
    const action = getAction("clockify_setup_project");
    expect(action?.writeAuthority?.semanticLiteralAliases).toEqual(expect.arrayContaining(canonicalAliases([
      {
        path: "memberRates[].member",
        value: "me",
        authoredPhrases: ["my", "myself", "men"],
      },
      {
        path: "memberRates[].kind",
        value: "hourly",
        authoredPhrases: ["project member", "project member rate", "member rate", "hourly rate"],
      },
      {
        path: "memberRates[].kind",
        value: "cost",
        authoredPhrases: ["project member cost rate", "member cost rate", "cost rate"],
      },
    ])));
  });

  it("catalogues every model-controlled boolean write path or documents its exact-literal exclusion", async () => {
    const { zodToJsonSchema } = await import("zod-to-json-schema");
    const discovered: string[] = [];

    for (const action of ACTION_CATALOG) {
      if (action.kind === "read") continue;
      const schema = zodToJsonSchema(action.schema, {
        target: "jsonSchema7",
        $refStrategy: "none",
      }) as JsonSchemaNode;
      for (const path of action.writeAuthority?.literalControlledPaths ?? []) {
        if (!schemaNodesAtPath(schema, path.split(".")).some(acceptsBoolean)) continue;
        const key = `${action.name}\0${path}`;
        discovered.push(key);
        const expected = EXPECTED_BOOLEAN_PATHS[key];
        expect(expected, `missing reviewed boolean-path decision for ${action.name}.${path}`).toBeDefined();
        const actual = action.writeAuthority?.semanticLiteralAliases.filter((item) => item.path === path) ?? [];
        if (expected && "excluded" in expected) {
          expect(expected.excluded.length).toBeGreaterThan(40);
          expect(actual, expected.excluded).toEqual([]);
        } else if (expected) {
          expect(actual, `${action.name}.${path}`).toEqual(canonicalAliases(expected.aliases));
          expect(new Set(actual.map((item) => item.value))).toEqual(new Set([false, true]));
        }
      }
    }

    expect(discovered.sort()).toEqual(Object.keys(EXPECTED_BOOLEAN_PATHS).sort());
  });

  it("rejects aliases for paths or canonical values not accepted by the action schema", () => {
    expect(() => writeAuthorityFor(projectCreateWithAliases([
      { path: "billable.invented", value: true, authoredPhrases: ["billable"] },
    ]))).toThrow("invalid_semantic_literal_alias_path:clockify_projects_create:billable.invented");

    expect(() => writeAuthorityFor(projectCreateWithAliases([
      { path: "isPublic", value: "yes", authoredPhrases: ["public"] },
    ]))).toThrow("invalid_semantic_literal_alias_value:clockify_projects_create:isPublic");
  });

  it("rejects non-normalized, duplicate, and path-local ambiguous phrases", () => {
    expect(() => writeAuthorityFor(projectCreateWithAliases([
      { path: "isPublic", value: true, authoredPhrases: [" public "] },
    ]))).toThrow("invalid_semantic_literal_alias_phrase:clockify_projects_create:isPublic");

    expect(() => writeAuthorityFor(projectCreateWithAliases([
      { path: "isPublic", value: true, authoredPhrases: ["public", "public"] },
    ]))).toThrow("duplicate_semantic_literal_alias:clockify_projects_create:isPublic:public");

    expect(() => writeAuthorityFor(projectCreateWithAliases([
      { path: "isPublic", value: true, authoredPhrases: ["visible"] },
      { path: "isPublic", value: false, authoredPhrases: ["visible"] },
    ]))).toThrow("ambiguous_semantic_literal_alias:clockify_projects_create:isPublic:visible");
  });

  it("binds alias metadata into action and ordered-catalog compatibility hashes", () => {
    const action = getAction("clockify_projects_create");
    if (!action) throw new Error("missing_project_create_action");
    const contract = fingerprintContract(action);
    expect(actionFingerprint(action.name)).toBe(
      createHash("sha256").update(JSON.stringify(contract)).digest("hex"),
    );

    const contracts = ACTION_CATALOG.map(fingerprintContract);
    const expectedCatalogHash = createHash("sha256")
      .update(JSON.stringify(contracts))
      .digest("hex");

    expect(catalogHash()).toBe(expectedCatalogHash);
  });
});
