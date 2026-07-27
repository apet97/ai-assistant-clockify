import { describe, expect, it } from "vitest";
import type { WriteAuthorityMetadata } from "../../src/harness/action.js";
import {
  buildAllowIntentCapabilityV1,
  buildDenyAllWritesIntentCapabilityV1,
  type IntentLiteralValue,
  type Utf8SourceSpan,
} from "../../src/harness/intent-capability.js";
import { authorizeIntentWriteArguments } from "../../src/harness/intent-authority.js";
import { ACTION_CATALOG } from "../../src/harness/catalog.js";
import { INTENT_LITERAL_LIMITS } from "../../src/harness/safety-limits.js";

const authority: WriteAuthorityMetadata = {
  literalConstraintLimits: INTENT_LITERAL_LIMITS,
  literalControlledPaths: ["name", "amount", "members[]"],
  numericLiteralPaths: ["amount"],
  semanticLiteralAliases: [],
  authenticatedSelfLiteralPaths: [],
  serverDerivedIdPaths: ["clientId"],
  permittedServerDefaultPaths: ["currencyId"],
  preservedStatePaths: [],
  cardinality: { mode: "argument", maxExecutions: 3, argumentPath: "members[]" },
  mutationPlans: [{
    mode: "batch",
    minSteps: 1,
    maxSteps: 3,
    steps: [{ id: "write-*", kind: "primary", min: 1, max: 3 }],
  }],
};

function spanFor(source: string, text: string): Utf8SourceSpan {
  const start = source.indexOf(text);
  if (start < 0) throw new Error("missing_test_span");
  return {
    startByte: Buffer.byteLength(source.slice(0, start), "utf8"),
    endByte: Buffer.byteLength(source.slice(0, start + text.length), "utf8"),
    text,
  };
}

function allow(input: {
  source?: string;
  constraints?: Array<{ path: string; value: IntentLiteralValue; text: string }>;
  maxExecutions?: number;
}) {
  const source = input.source ?? "Create Acme for Ana and Bob at 125.5";
  const constraints = input.constraints ?? [{ path: "name", value: "Acme", text: "Acme" }];
  const spans = constraints.map((constraint) => spanFor(source, constraint.text));
  return buildAllowIntentCapabilityV1({
    authoredSource: source,
    catalogHash: "catalog-current",
    writeActions: [{
      actionName: "clockify_clients_create",
      sourceSpans: spans,
      literalConstraints: constraints.map((constraint, index) => ({
        path: constraint.path,
        value: constraint.value,
        sourceSpan: spans[index]!,
      })),
      maxExecutions: input.maxExecutions,
    }],
  });
}

function authorize(capability: ReturnType<typeof allow>, rawArgs: unknown) {
  return authorizeIntentWriteArguments({
    capability,
    actionName: "clockify_clients_create",
    rawArgs,
    authority,
    catalogHash: "catalog-current",
  });
}

describe("raw intent authority matcher", () => {
  it("allows only exact declared raw literals", () => {
    expect(authorize(allow({}), { name: "Acme" })).toBeUndefined();
    expect(authorize(allow({}), { name: "Other" })).toMatchObject({
      ok: false,
      code: "intent_capability_argument_mismatch",
    });
  });

  it("matches before numeric coercion and denies unconstrained extra literals", () => {
    const capability = allow({
      constraints: [
        { path: "name", value: "Acme", text: "Acme" },
        { path: "amount", value: 125.5, text: "125.5" },
      ],
    });

    expect(authorize(capability, { name: "Acme", amount: 125.5 })).toBeUndefined();
    expect(authorize(capability, { name: "Acme", amount: "125.5" })).toMatchObject({
      code: "intent_capability_argument_mismatch",
    });
    expect(authorize(allow({}), { name: "Acme", amount: 125.5 })).toMatchObject({
      code: "intent_capability_argument_undeclared",
    });
  });

  it("accepts an exact structured literal under a reviewed open-record path", () => {
    const source = 'Set project estimate to {"estimate":100,"active":true}';
    const text = '{"estimate":100,"active":true}';
    const capability = allow({
      source,
      constraints: [{
        path: "fields",
        value: { estimate: 100, active: true },
        text,
      }],
    });
    const openRecordAuthority: WriteAuthorityMetadata = {
      ...authority,
      literalControlledPaths: ["fields.*"],
      cardinality: { mode: "single", maxExecutions: 1 },
    };
    const check = (rawArgs: unknown) => authorizeIntentWriteArguments({
      capability,
      actionName: "clockify_clients_create",
      rawArgs,
      authority: openRecordAuthority,
      catalogHash: "catalog-current",
    });

    expect(check({ fields: { estimate: 100, active: true } })).toBeUndefined();
    expect(check({ fields: { estimate: 101, active: true } })).toMatchObject({
      code: "intent_capability_argument_mismatch",
    });
  });

  it("accepts an exact structured array at an advertised open-array path", () => {
    const source = 'Set memberships to [{"userId":"u1","membershipStatus":"ACTIVE"}]';
    const text = '[{"userId":"u1","membershipStatus":"ACTIVE"}]';
    const capability = allow({
      source,
      constraints: [{
        path: "memberships[]",
        value: [{ userId: "u1", membershipStatus: "ACTIVE" }],
        text,
      }],
    });
    const openArrayAuthority: WriteAuthorityMetadata = {
      ...authority,
      literalControlledPaths: ["memberships[]", "memberships[].*"],
      cardinality: { mode: "argument", maxExecutions: 14, argumentPath: "memberships[]" },
    };
    const check = (rawArgs: unknown) => authorizeIntentWriteArguments({
      capability,
      actionName: "clockify_clients_create",
      rawArgs,
      authority: openArrayAuthority,
      catalogHash: "catalog-current",
    });

    expect(check({ memberships: [{ userId: "u1", membershipStatus: "ACTIVE" }] })).toBeUndefined();
    expect(check({ memberships: [{ userId: "u2", membershipStatus: "ACTIVE" }] })).toMatchObject({
      code: "intent_capability_argument_mismatch",
    });
  });

  it("lets host-derived/default values narrow later but never accepts them from raw model args", () => {
    const capability = allow({});
    expect(authorize(capability, { name: "Acme" })).toBeUndefined();
    expect(authorize(capability, { name: "Acme", clientId: "invented" })).toMatchObject({
      code: "intent_capability_argument_undeclared",
    });
    expect(authorize(capability, { name: "Acme", currencyId: "invented" })).toMatchObject({
      code: "intent_capability_argument_undeclared",
    });
  });

  it("binds authored me only to the exact authenticated admin on reviewed project-member paths", () => {
    const capabilityFor = (
      actionName: "clockify_projects_memberships_update" | "clockify_projects_rate_update",
      path: "addUserIds[]" | "userId",
      value: IntentLiteralValue = "me",
    ) => {
      const source = "add me";
      const sourceSpan = spanFor(source, "me");
      return buildAllowIntentCapabilityV1({
        authoredSource: source,
        catalogHash: "catalog-current",
        writeActions: [{
          actionName,
          sourceSpans: [sourceSpan],
          literalConstraints: [{ path, value, sourceSpan }],
        }],
      });
    };
    const check = (
      actionName: "clockify_projects_memberships_update" | "clockify_projects_rate_update",
      capability: ReturnType<typeof capabilityFor>,
      rawArgs: unknown,
    ) => authorizeIntentWriteArguments({
      capability,
      actionName,
      rawArgs,
      authority: ACTION_CATALOG.find((action) => action.name === actionName)!.writeAuthority!,
      catalogHash: "catalog-current",
      authenticatedAdminUserId: "admin-1",
    });

    const membership = capabilityFor("clockify_projects_memberships_update", "addUserIds[]", ["me"]);
    expect(check("clockify_projects_memberships_update", membership, { addUserIds: ["me"] }))
      .toBeUndefined();
    expect(check("clockify_projects_memberships_update", membership, { addUserIds: ["admin-1"] }))
      .toBeUndefined();
    expect(check("clockify_projects_memberships_update", membership, { addUserIds: ["my"] }))
      .toMatchObject({ code: "intent_capability_argument_mismatch" });
    for (const addUserIds of [
      ["other-1"],
      ["admin-2"],
      ["admin-1", "other-1"],
      ["admin-1", "admin-1"],
      [" admin-1"],
      ["ADMIN-1"],
      ["admin-1-extra"],
    ]) {
      expect(check("clockify_projects_memberships_update", membership, { addUserIds }))
        .toMatchObject({ code: "intent_capability_argument_mismatch" });
    }
    for (const declaration of [["Ada"], ["me", "me"], [" me"], ["ME"], ["myself"]]) {
      const nonMe = capabilityFor("clockify_projects_memberships_update", "addUserIds[]", declaration);
      expect(check("clockify_projects_memberships_update", nonMe, { addUserIds: ["admin-1"] }))
        .toMatchObject({ code: "intent_capability_argument_mismatch" });
    }
    const authoredId = capabilityFor("clockify_projects_memberships_update", "addUserIds[]", ["admin-1"]);
    expect(check("clockify_projects_memberships_update", authoredId, { addUserIds: ["me"] }))
      .toMatchObject({ code: "intent_capability_argument_mismatch" });

    const rate = capabilityFor("clockify_projects_rate_update", "userId");
    expect(check("clockify_projects_rate_update", rate, { userId: "me" })).toBeUndefined();
    expect(check("clockify_projects_rate_update", rate, { userId: "my" })).toBeUndefined();
    expect(check("clockify_projects_rate_update", rate, { userId: "myself" })).toBeUndefined();
    expect(check("clockify_projects_rate_update", rate, { userId: "admin-1" })).toBeUndefined();
    for (const userName of ["me", "my", "myself"]) {
      expect(check("clockify_projects_rate_update", rate, { userName })).toBeUndefined();
    }
    for (const userName of ["other-1", "ME", " me", "self"]) {
      expect(check("clockify_projects_rate_update", rate, { userName }))
        .toMatchObject({ code: "intent_capability_argument_mismatch" });
    }
    expect(check("clockify_projects_rate_update", rate, { userId: "other-1", userName: "me" }))
      .toMatchObject({ code: "intent_capability_argument_mismatch" });
    for (const userId of ["other-1", "admin-2", " admin-1", "ADMIN-1", "admin-1-extra", "MY", " my"]) {
      expect(check("clockify_projects_rate_update", rate, { userId }))
        .toMatchObject({ code: "intent_capability_argument_mismatch" });
    }
    const reverseRate = capabilityFor("clockify_projects_rate_update", "userId", "admin-1");
    expect(check("clockify_projects_rate_update", reverseRate, { userId: "me" }))
      .toMatchObject({ code: "intent_capability_argument_mismatch" });
    expect(authorizeIntentWriteArguments({
      capability: rate,
      actionName: "clockify_projects_rate_update",
      rawArgs: { userId: "admin-1" },
      authority: ACTION_CATALOG.find((action) => action.name === "clockify_projects_rate_update")!.writeAuthority!,
      catalogHash: "catalog-current",
    })).toMatchObject({ code: "intent_capability_argument_mismatch" });

    const unreviewedPath = capabilityFor("clockify_projects_rate_update", "addUserIds[]");
    expect(check("clockify_projects_rate_update", unreviewedPath, { addUserIds: ["admin-1"] }))
      .toMatchObject({ code: "intent_capability_argument_mismatch" });
    const source = "Create me";
    const sourceSpan = spanFor(source, "me");
    const unreviewedAction = buildAllowIntentCapabilityV1({
      authoredSource: source,
      catalogHash: "catalog-current",
      writeActions: [{
        actionName: "clockify_clients_create",
        sourceSpans: [sourceSpan],
        literalConstraints: [{ path: "name", value: "me", sourceSpan }],
      }],
    });
    expect(authorizeIntentWriteArguments({
      capability: unreviewedAction,
      actionName: "clockify_clients_create",
      rawArgs: { name: "admin-1" },
      authority: ACTION_CATALOG.find((action) => action.name === "clockify_clients_create")!.writeAuthority!,
      catalogHash: "catalog-current",
      authenticatedAdminUserId: "admin-1",
    })).toMatchObject({ code: "intent_capability_argument_mismatch" });

    expect(ACTION_CATALOG.flatMap((action) =>
      action.writeAuthority?.authenticatedSelfLiteralPaths.map((path) => `${action.name}:${path}`) ?? [])).toEqual([
      "clockify_projects_rate_update:userId",
      "clockify_projects_memberships_update:addUserIds[]",
      "clockify_projects_member_hourly_rate_update:userId",
      "clockify_projects_member_cost_rate_update:userId",
      "clockify_users_hourly_rate_update:userId",
      "clockify_users_cost_rate_update:userId",
    ]);
  });

  it("enforces array literals and the action cardinality ceiling", () => {
    const capability = allow({
      constraints: [
        { path: "name", value: "Acme", text: "Acme" },
        { path: "members[]", value: ["Ana", "Bob"], text: "Ana and Bob" },
      ],
    });
    expect(authorize(capability, { name: "Acme", members: ["Ana", "Bob"] })).toBeUndefined();
    expect(authorize(capability, { name: "Acme", members: ["Ana", "Bob", "Eve", "Zoe"] })).toMatchObject({
      code: "intent_capability_cardinality_exceeded",
    });
    // Capability usage count is consumed by the store per bound operation; it
    // is deliberately independent from this action's one-operation host plan.
    expect(authorizeIntentWriteArguments({
      capability: allow({ maxExecutions: 4 }),
      actionName: "clockify_clients_create",
      rawArgs: { name: "Acme" },
      authority,
      catalogHash: "catalog-current",
    })).toBeUndefined();
  });

  it("authorizes an exact empty tag list for the real clockify_fix_entry action only at the empty boundary", () => {
    const source = "Update entry entry-1 tags to []";
    const idSpan = spanFor(source, "entry-1");
    const tagsSpan = spanFor(source, "[]");
    const capability = buildAllowIntentCapabilityV1({
      authoredSource: source,
      catalogHash: "catalog-current",
      writeActions: [{
        actionName: "clockify_fix_entry",
        sourceSpans: [idSpan, tagsSpan],
        literalConstraints: [
          { path: "id", value: "entry-1", sourceSpan: idSpan },
          { path: "tagIds[]", value: [], sourceSpan: tagsSpan },
        ],
      }],
    });
    const fixEntryAuthority = ACTION_CATALOG.find(
      (action) => action.name === "clockify_fix_entry",
    )?.writeAuthority;
    expect(fixEntryAuthority).toBeDefined();
    const check = (tagIds: string[]) => authorizeIntentWriteArguments({
      capability,
      actionName: "clockify_fix_entry",
      rawArgs: { id: "entry-1", tagIds },
      authority: fixEntryAuthority!,
      catalogHash: "catalog-current",
    });

    expect(check([])).toBeUndefined();
    expect(authorizeIntentWriteArguments({
      capability,
      actionName: "clockify_fix_entry",
      rawArgs: { id: "entry-1" },
      authority: fixEntryAuthority!,
      catalogHash: "catalog-current",
    })).toMatchObject({
      code: "intent_capability_argument_mismatch",
    });
    expect(check(["invented-tag-id"])).toMatchObject({
      code: "intent_capability_argument_mismatch",
    });
  });

  it.each([
    ["top-level present empty", "members[]", { members: [] }, true],
    ["top-level missing", "members[]", {}, false],
    ["nested absent ancestor", "filter.tags[]", {}, false],
    ["nested present ancestor without child", "filter.tags[]", { filter: {} }, false],
    ["nested explicit empty", "filter.tags[]", { filter: { tags: [] } }, true],
    ["array-object absent ancestor", "groups[].memberIds[]", {}, false],
    ["array-object outer empty", "groups[].memberIds[]", { groups: [] }, false],
    ["array-object child missing", "groups[].memberIds[]", { groups: [{}] }, false],
    [
      "array-object mixed explicit and missing siblings",
      "groups[].memberIds[]",
      { groups: [{ memberIds: [] }, {}] },
      false,
    ],
    [
      "mixed membership siblings cannot mask an omitted nested tag list",
      "memberships[].tags[]",
      { memberships: [{ id: "m1", tags: [] }, { id: "m2" }] },
      false,
    ],
    ["array-object explicit nested empty", "groups[].memberIds[]", { groups: [{ memberIds: [] }] }, true],
  ] as const)("keeps empty-array presence exact across topology: %s", (_label, path, rawArgs, allowed) => {
    const source = "Set the exact list to []";
    const sourceSpan = spanFor(source, "[]");
    const capability = buildAllowIntentCapabilityV1({
      authoredSource: source,
      catalogHash: "catalog-current",
      writeActions: [{
        actionName: "clockify_clients_create",
        sourceSpans: [sourceSpan],
        literalConstraints: [{ path, value: [], sourceSpan }],
      }],
    });
    const topologyAuthority: WriteAuthorityMetadata = {
      ...authority,
      literalControlledPaths: [path],
      cardinality: { mode: "single", maxExecutions: 1 },
    };

    const result = authorizeIntentWriteArguments({
      capability,
      actionName: "clockify_clients_create",
      rawArgs,
      authority: topologyAuthority,
      catalogHash: "catalog-current",
    });
    if (allowed) expect(result).toBeUndefined();
    else expect(result).toMatchObject({ code: "intent_capability_argument_mismatch" });
  });

  it("fails closed for deny-all, catalog drift, and undeclared actions", () => {
    const source = "Create Acme";
    const denied = buildDenyAllWritesIntentCapabilityV1({
      authoredSource: source,
      catalogHash: "catalog-current",
      reason: "provider_unavailable",
    });
    expect(authorizeIntentWriteArguments({
      capability: denied,
      actionName: "clockify_clients_create",
      rawArgs: { name: "Acme" },
      authority,
      catalogHash: "catalog-current",
    })).toMatchObject({ code: "intent_capability_denied" });
    expect(authorizeIntentWriteArguments({
      capability: allow({}),
      actionName: "clockify_clients_create",
      rawArgs: { name: "Acme" },
      authority,
      catalogHash: "catalog-changed",
    })).toMatchObject({ code: "intent_capability_catalog_drift" });
    expect(authorizeIntentWriteArguments({
      capability: allow({}),
      actionName: "clockify_projects_create",
      rawArgs: { name: "Acme" },
      authority,
      catalogHash: "catalog-current",
    })).toMatchObject({ code: "intent_capability_action_denied" });
  });

  it("denies invented targets, amounts, dates, and accepts only the exact authored alias", () => {
    const source = "Create for Acme in Apollo for 125.5 due 2026-08-01";
    const constraints = [
      { path: "clientName", value: "Acme" as const, text: "Acme" },
      { path: "projectName", value: "Apollo" as const, text: "Apollo" },
      { path: "amount", value: 125.5 as const, text: "125.5" },
      { path: "dueDate", value: "2026-08-01" as const, text: "2026-08-01" },
    ];
    const spans = constraints.map((constraint) => spanFor(source, constraint.text));
    const capability = buildAllowIntentCapabilityV1({
      authoredSource: source,
      catalogHash: "catalog-current",
      writeActions: [{
        actionName: "clockify_invoices_create",
        sourceSpans: spans,
        literalConstraints: constraints.map((constraint, index) => ({
          path: constraint.path,
          value: constraint.value,
          sourceSpan: spans[index]!,
        })),
      }],
    });
    const aliasAuthority: WriteAuthorityMetadata = {
      literalConstraintLimits: INTENT_LITERAL_LIMITS,
      literalControlledPaths: ["clientName", "projectName", "amount", "dueDate"],
      numericLiteralPaths: ["amount"],
      semanticLiteralAliases: [],
      authenticatedSelfLiteralPaths: [],
      serverDerivedIdPaths: ["operation.clientId", "operation.projectId"],
      permittedServerDefaultPaths: ["operation.currency"],
      preservedStatePaths: [],
      cardinality: { mode: "single", maxExecutions: 1 },
      mutationPlans: [{
        mode: "single",
        minSteps: 1,
        maxSteps: 1,
        steps: [{ id: "write", kind: "primary", min: 1, max: 1 }],
      }],
    };
    const exact = {
      clientName: "Acme",
      projectName: "Apollo",
      amount: 125.5,
      dueDate: "2026-08-01",
    };
    const check = (rawArgs: unknown) => authorizeIntentWriteArguments({
      capability,
      actionName: "clockify_invoices_create",
      rawArgs,
      authority: aliasAuthority,
      catalogHash: "catalog-current",
    });

    expect(check(exact)).toBeUndefined();
    for (const invented of [
      { ...exact, clientName: "Other" },
      { ...exact, amount: 999 },
      { ...exact, dueDate: "2026-09-01" },
      { ...exact, projectName: "Zeus" },
    ]) {
      expect(check(invented)).toMatchObject({ code: "intent_capability_argument_mismatch" });
    }
  });
});
