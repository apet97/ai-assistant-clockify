import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  INTENT_LITERAL_LIMITS,
  INVOICE_CREATE_MUTATION_STEP_MAX,
  INVOICE_ITEM_BATCH_MAX,
  MARK_INVOICED_ENTRY_BATCH_MAX,
  SETUP_PROJECT_MEMBER_BATCH_MAX,
} from "../../src/harness/safety-limits.js";
import type { ActionContext, ActionDefinition } from "../../src/harness/action.js";
import { executeAction } from "../../src/harness/actions.js";
import { ACTION_CATALOG, actionFingerprint } from "../../src/harness/catalog.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { errorReceipt, type ErrorReceipt } from "../../src/harness/receipts.js";
import { summarizeArgs } from "../../src/harness/arg-summary.js";
import { PRESENTATION_RULES_VERSION } from "../../src/harness/prepared-write-presentation.js";
import {
  optionalLiteralPathsFromJsonSchema,
  validateWriteAuthorityOperation,
  writeAuthorityActionNames,
} from "../../src/harness/write-authority.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";

interface WriteAuthorityMetadata {
  literalControlledPaths: readonly string[];
  numericLiteralPaths: readonly string[];
  semanticLiteralAliases: ReadonlyArray<{ path: string }>;
  authenticatedSelfLiteralPaths: readonly string[];
  serverDerivedIdPaths: readonly string[];
  permittedServerDefaultPaths: readonly string[];
  preservedStatePaths: readonly string[];
  cardinality: {
    mode: "single" | "fixed" | "argument";
    maxExecutions: number;
    maxArgumentItems?: number;
    argumentPath?: string;
  };
  mutationPlans: readonly unknown[];
  authoredIntent?: {
    commandPatterns: readonly string[];
    commandGerundPatterns: readonly string[];
    forbiddenPatterns: readonly string[];
    literalObligations: ReadonlyArray<{
      anyOfPaths: readonly string[];
      cuePatterns: readonly string[];
      sourceRolePatterns?: readonly string[];
    }>;
    safeOmissionPaths: readonly string[];
  };
}

function hasValidNumericLiteralTopology(authority: unknown): boolean {
  if (!authority || typeof authority !== "object") return false;
  const candidate = authority as Partial<WriteAuthorityMetadata>;
  if (!Array.isArray(candidate.literalControlledPaths) || !Array.isArray(candidate.numericLiteralPaths) ||
    !Object.isFrozen(candidate.numericLiteralPaths)) return false;
  const numericPaths = candidate.numericLiteralPaths as unknown[];
  return new Set(numericPaths).size === numericPaths.length && numericPaths.every((path) =>
    typeof path === "string" && path.length > 0 && !path.includes(".*") &&
    path.replace(/\[\d+\]/gu, "[]") === path && candidate.literalControlledPaths!.includes(path));
}

function externalWrites(): ActionDefinition[] {
  return ACTION_CATALOG.filter((action) =>
    action.name.startsWith("clockify_") && action.risks.some((risk) => risk !== "read"));
}

function modelVisibleWrites(): ActionDefinition[] {
  return ACTION_CATALOG.filter((action) => action.kind !== "read");
}

describe("Phase 6 write authority enforcement", () => {
  it("advertises only host-budget-safe batch maxima at the exact boundary", () => {
    const action = (name: string) => ACTION_CATALOG.find((candidate) => candidate.name === name)!;
    const strings = (count: number, prefix: string) => Array.from({ length: count }, (_, index) => `${prefix}-${index}`);
    const items = (count: number) => Array.from({ length: count }, (_, index) => ({ itemType: `type-${index}` }));
    const rates = (count: number) => Array.from({ length: count }, (_, index) => ({
      member: `member-${index}`, amount: 10, kind: "hourly" as const,
    }));

    expect(action("clockify_groups_add_user").schema.safeParse({ groupName: "Ops", members: strings(14, "user") }).success).toBe(true);
    expect(action("clockify_groups_add_user").schema.safeParse({ groupName: "Ops", members: strings(15, "user") }).success).toBe(false);
    expect(action("clockify_onboard_user").schema.safeParse({ email: "a@example.com", groups: strings(13, "group") }).success).toBe(true);
    expect(action("clockify_onboard_user").schema.safeParse({ email: "a@example.com", groups: strings(14, "group") }).success).toBe(false);
    expect(action("clockify_invoices_create").schema.safeParse({ clientName: "Acme", items: items(INVOICE_ITEM_BATCH_MAX) }).success).toBe(true);
    expect(action("clockify_invoices_create").schema.safeParse({ clientName: "Acme", items: items(INVOICE_ITEM_BATCH_MAX + 1) }).success).toBe(false);
    expect(action("clockify_setup_project").schema.safeParse({ name: "Apollo", memberRates: rates(4) }).success).toBe(true);
    expect(action("clockify_setup_project").schema.safeParse({ name: "Apollo", memberRates: rates(5) }).success).toBe(false);
    expect(action("clockify_setup_project").schema.safeParse({ name: "Apollo", members: strings(SETUP_PROJECT_MEMBER_BATCH_MAX, "member") }).success).toBe(true);
    expect(action("clockify_setup_project").schema.safeParse({ name: "Apollo", members: strings(SETUP_PROJECT_MEMBER_BATCH_MAX + 1, "member") }).success).toBe(false);
    expect(action("clockify_groups_add_user").schema.safeParse({ groupId: "g1", members: strings(13, "member"), userId: "u14" }).success).toBe(true);
    expect(action("clockify_groups_add_user").schema.safeParse({ groupId: "g1", members: strings(14, "member"), userId: "u15" }).success).toBe(false);
    expect(action("clockify_setup_project").schema.safeParse({
      name: "Apollo", clientName: "Acme", members: ["extra"], memberRates: rates(4),
    }).success).toBe(true);
    expect(action("clockify_setup_project").schema.safeParse({
      name: "Apollo", clientName: "Acme", members: ["extra", "excess"], memberRates: rates(4),
    }).success).toBe(false);
  });

  it("requires explicit literal, derived-id, default, and cardinality metadata on every external write", () => {
    const invalid = externalWrites().flatMap((action) => {
      const authority = (action as ActionDefinition & { writeAuthority?: WriteAuthorityMetadata }).writeAuthority;
      if (!authority || !Array.isArray(authority.literalControlledPaths) ||
        !hasValidNumericLiteralTopology(authority) ||
        authority.literalConstraintLimits !== INTENT_LITERAL_LIMITS ||
        !Array.isArray(authority.authenticatedSelfLiteralPaths) ||
        !Array.isArray(authority.serverDerivedIdPaths) || !Array.isArray(authority.permittedServerDefaultPaths) ||
        !Array.isArray(authority.preservedStatePaths) ||
        !authority.cardinality || !["single", "fixed", "argument"].includes(authority.cardinality.mode) ||
        !Number.isInteger(authority.cardinality.maxExecutions) || authority.cardinality.maxExecutions < 1 ||
        !Array.isArray(authority.mutationPlans) || authority.mutationPlans.length === 0) {
        return [action.name];
      }
      return [];
    });

    expect(invalid).toEqual([]);
  });

  it("requires valid numeric literal topology on every model-visible write authority", () => {
    expect(modelVisibleWrites().filter((action) =>
      !hasValidNumericLiteralTopology(action.writeAuthority)).map((action) => action.name)).toEqual([]);
  });

  it("rejects missing, mutable, open, duplicate, concrete-index, and unknown numeric authority paths", () => {
    const authority = ACTION_CATALOG.find((action) =>
      action.name === "clockify_invoices_create")!.writeAuthority!;
    const validPath = "items[].amount";
    expect(hasValidNumericLiteralTopology(authority)).toBe(true);
    for (const numericLiteralPaths of [
      undefined,
      "items[].amount",
      [validPath],
      Object.freeze([validPath, validPath]),
      Object.freeze(["groups.*"]),
      Object.freeze(["items[0].amount"]),
      Object.freeze(["items[].invented"]),
    ]) {
      expect(hasValidNumericLiteralTopology({
        ...authority,
        numericLiteralPaths,
      }), JSON.stringify(numericLiteralPaths)).toBe(false);
    }
    expect(hasValidNumericLiteralTopology({
      ...authority,
      numericLiteralPaths: Object.freeze([validPath]),
    })).toBe(true);
  });

  it("has one reviewed semantics entry for every model-visible write and no extras", () => {
    expect([...writeAuthorityActionNames()].sort()).toEqual(modelVisibleWrites().map((action) => action.name).sort());
  });

  it("catalog-fingerprints authored command and literal authority for exactly all 14 safe writes", () => {
    const expected = [
      "clockify_entries_create",
      "clockify_entries_start",
      "clockify_start_timer",
      "clockify_stop_timer",
      "clockify_log_work",
      "clockify_create_work_package",
      "clockify_projects_create",
      "clockify_projects_from_template",
      "clockify_tasks_create",
      "clockify_clients_create",
      "clockify_clients_create_base",
      "clockify_invoices_create_base",
      "clockify_tags_create",
      "clockify_holidays_create",
      "clockify_scheduling_assignments_create",
    ].sort();
    const safeWrites = ACTION_CATALOG.filter((action) => action.kind === "safe_write");
    expect(safeWrites.map((action) => action.name).sort()).toEqual(expected);

    const withAuthoredIntent = ACTION_CATALOG.filter((action) =>
      (action.writeAuthority as WriteAuthorityMetadata | undefined)?.authoredIntent !== undefined);
    expect(withAuthoredIntent.map((action) => action.name).sort()).toEqual(expected);
    for (const action of safeWrites) {
      const authority = action.writeAuthority as WriteAuthorityMetadata;
      const authored = authority.authoredIntent!;
      expect(authored.commandPatterns.length).toBeGreaterThan(0);
      expect(authored.commandPatterns.every((pattern) => typeof pattern === "string" && pattern.length > 0)).toBe(true);
      expect(authored.literalObligations.flatMap((obligation) => obligation.anyOfPaths)
        .every((path) => authority.literalControlledPaths.includes(path))).toBe(true);
      expect(authored.literalObligations.every((obligation) =>
        obligation.anyOfPaths.length > 0 && obligation.cuePatterns.length > 0)).toBe(true);

      const optional = new Set([
        ...optionalLiteralPathsFromJsonSchema(zodToJsonSchema(action.schema, {
          $refStrategy: "none",
          target: "jsonSchema7",
        })),
        ...(action.argumentAliases ?? []),
      ]);
      const decisions = new Map<string, number>();
      const decide = (path: string) => decisions.set(path, (decisions.get(path) ?? 0) + 1);
      for (const obligation of authored.literalObligations) {
        for (const path of obligation.anyOfPaths) if (optional.has(path)) decide(path);
      }
      for (const path of new Set(authority.semanticLiteralAliases.map((alias) => alias.path))) {
        if (optional.has(path)) decide(path);
      }
      for (const path of authored.safeOmissionPaths) decide(path);
      expect([...optional].filter((path) => decisions.get(path) !== 1)).toEqual([]);
    }
  });

  it("treats branch-specific required leaves as optional across a union", () => {
    expect(optionalLiteralPathsFromJsonSchema({
      oneOf: [
        {
          type: "object",
          properties: { left: { type: "string" }, shared: { type: "string" } },
          required: ["left", "shared"],
        },
        {
          type: "object",
          properties: { right: { type: "string" }, shared: { type: "string" } },
          required: ["right", "shared"],
        },
      ],
    })).toEqual(["left", "right"]);
  });

  it("matches exact ordered mutation plans, including delete compensation", () => {
    const deleteEntity = ACTION_CATALOG.find((action) => action.name === "clockify_delete_entity")!;
    const operation = { id: "p1", entityType: "project" };
    const valid = {
      mode: "curated" as const,
      maxHostCalls: 60,
      steps: [
        { id: "archive-project", kind: "primary" as const },
        { id: "delete-project", kind: "primary" as const },
        { id: "restore-project", kind: "compensation" as const },
      ],
    };
    expect(validateWriteAuthorityOperation(deleteEntity, operation, valid)).toBeUndefined();
    expect(validateWriteAuthorityOperation(deleteEntity, operation, {
      ...valid,
      steps: [valid.steps[1]!, valid.steps[0]!, valid.steps[2]!],
    })).toBe("undeclared_mutation_plan");
    expect(validateWriteAuthorityOperation(deleteEntity, operation, {
      ...valid,
      steps: [...valid.steps, { id: "delete-project", kind: "primary" as const }],
    })).toBe("mutation_cardinality_exceeded");
  });

  it("accepts reviewed repeated plan families and rejects excess dispatch", () => {
    const invoice = ACTION_CATALOG.find((action) => action.name === "clockify_invoices_create")!;
    const steps = [
      { id: "create-invoice", kind: "primary" as const },
      { id: "enrich-invoice", kind: "primary" as const },
      ...Array.from({ length: INVOICE_ITEM_BATCH_MAX }, (_, index) => ({ id: `add-invoice-item-${index}`, kind: "primary" as const })),
    ];
    expect(validateWriteAuthorityOperation(invoice, { items: Array(INVOICE_ITEM_BATCH_MAX).fill({}) }, {
      mode: "curated", maxHostCalls: 60, steps,
    })).toBeUndefined();
    expect(validateWriteAuthorityOperation(invoice, { items: Array(INVOICE_ITEM_BATCH_MAX + 1).fill({}) }, {
      mode: "curated", maxHostCalls: 60,
      steps: [...steps, { id: `add-invoice-item-${INVOICE_ITEM_BATCH_MAX}`, kind: "primary" }],
    })).toBe("mutation_cardinality_exceeded");
    expect(validateWriteAuthorityOperation(invoice, { items: [{}, {}] }, {
      mode: "curated",
      maxHostCalls: 60,
      steps: [
        { id: "create-invoice", kind: "primary" },
        { id: "add-invoice-item-0", kind: "primary" },
        { id: "add-invoice-item-2", kind: "primary" },
      ],
    })).toBe("undeclared_mutation_plan");
    expect(validateWriteAuthorityOperation(invoice, { items: [{}] }, {
      mode: "curated",
      maxHostCalls: 60,
      steps: [
        { id: "create-invoice", kind: "primary" },
        { id: "add-invoice-item-0", kind: "primary" },
        { id: "enrich-invoice", kind: "primary" },
      ],
    })).toBe("undeclared_mutation_plan");
  });

  it("rejects undeclared normalized derived ids and permits declared ids/defaults", () => {
    const project = ACTION_CATALOG.find((action) => action.name === "clockify_projects_create")!;
    expect(validateWriteAuthorityOperation(project, {
      body: { name: "Apollo", clientId: "client-1", rateUnit: "HOUR" },
    }, { mode: "single", maxHostCalls: 60, steps: [{ id: "create-project", kind: "primary" }] })).toBeUndefined();
    expect(validateWriteAuthorityOperation(project, {
      body: { name: "Apollo", inventedTargetId: "client-2" },
    }, { mode: "single", maxHostCalls: 60, steps: [{ id: "create-project", kind: "primary" }] })).toBe(
      "undeclared_server_derived_path:operation.body.inventedTargetId",
    );
  });

  it("binds write-authority metadata into every external action fingerprint", () => {
    const action = externalWrites()[0]! as ActionDefinition & { writeAuthority?: WriteAuthorityMetadata };
    expect(action.writeAuthority).toBeDefined();
    const expected = createHash("sha256").update(JSON.stringify({
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
      apiExposure: action.apiExposure ?? null,
      apiExposureReason: action.apiExposureReason ?? null,
      apiOperation: action.apiOperation ?? null,
      adapterEndpoints: action.adapterEndpoints ?? null,
      availabilityByAuthClass: action.availabilityByAuthClass ?? null,
      boundedArgumentDictionaries: action.boundedArgumentDictionaries ?? [],
      materialFields: action.materialFields ?? [],
      normalizedOperationMaterialContract:
        action.normalizedOperationMaterialContract ?? [],
      presentation: action.presentation ?? null,
      presentationRulesVersion: PRESENTATION_RULES_VERSION,
      referenceSelector: action.referenceSelector ?? null,
    })).digest("hex");
    expect(actionFingerprint(action.name)).toBe(expected);
  });

  it("uses action semantics instead of the first array-shaped argument for cardinality", () => {
    const authorityFor = (name: string) => {
      const action = ACTION_CATALOG.find((candidate) => candidate.name === name);
      expect(action?.writeAuthority).toBeDefined();
      return action!.writeAuthority!;
    };

    // These arrays are values inside one host mutation. Their raw item ceiling
    // is distinct from the one exact external plan step.
    expect(authorityFor("clockify_start_timer").cardinality).toEqual({ mode: "single", maxExecutions: 1 });
    expect(authorityFor("clockify_entries_mark_invoiced").cardinality).toEqual({
      mode: "argument",
      maxExecutions: 1,
      maxArgumentItems: MARK_INVOICED_ENTRY_BATCH_MAX,
      argumentPath: "ids[]",
    });
    // Curated actions declare their real host-step ceiling explicitly.
    expect(authorityFor("clockify_clients_create").cardinality).toEqual({ mode: "fixed", maxExecutions: 2 });
    expect(authorityFor("clockify_create_work_package").cardinality).toEqual({ mode: "fixed", maxExecutions: 5 });
    expect(authorityFor("clockify_invoices_create").cardinality).toEqual({
      mode: "argument",
      maxExecutions: INVOICE_CREATE_MUTATION_STEP_MAX,
      maxArgumentItems: INVOICE_ITEM_BATCH_MAX,
      argumentPath: "items[]",
    });
  });

  it("separates raw literals from operation-derived ids and explicit server defaults", () => {
    const invoice = ACTION_CATALOG.find((action) => action.name === "clockify_invoices_create")!.writeAuthority!;
    expect(invoice.literalControlledPaths).toContain("clientId");
    expect(invoice.serverDerivedIdPaths).toContain("operation.clientId");
    expect(invoice.permittedServerDefaultPaths).toEqual(expect.arrayContaining([
      "operation.number",
      "operation.issuedDate",
      "operation.dueDate",
      "operation.currency",
      "operation.items[].description",
      "operation.items[].quantity",
    ]));
    expect(invoice.literalControlledPaths.filter((path) =>
      invoice.serverDerivedIdPaths.includes(path) || invoice.permittedServerDefaultPaths.includes(path))).toEqual([]);

    const projectUpdate = ACTION_CATALOG.find((action) => action.name === "clockify_projects_update")!.writeAuthority!;
    expect(projectUpdate.serverDerivedIdPaths).toEqual(expect.arrayContaining([
      "operation.projectId",
      "operation.clientId",
    ]));
    expect(projectUpdate.preservedStatePaths).toEqual(expect.arrayContaining([
      "operation.body.*",
      "operation.patch.*",
      "operation.updateBody.*",
      "operation.archiveBody.*",
      "operation.restoreBody.*",
      "operation.doneBody.*",
      "operation.originalBody.*",
      "operation.prepared.body.*",
      "operation.prepared.source.*",
    ]));
    expect(projectUpdate.cardinality).toEqual({ mode: "single", maxExecutions: 1 });
    expect(validateWriteAuthorityOperation(
      ACTION_CATALOG.find((action) => action.name === "clockify_projects_update")!,
      {
        id: "project-1",
        patch: { isPublic: false },
        body: { name: "Apollo", isPublic: false },
        invented: { currency: "USD" },
      },
      { mode: "single", maxHostCalls: 60, steps: [{ id: "update-project", kind: "primary" }] },
    )).toBe("undeclared_server_default_path:operation.invented.currency");
  });

  it("pins the reviewed nested id/default paths used by prepared replacement workflows", () => {
    const authorityFor = (name: string) => ACTION_CATALOG.find((action) => action.name === name)!.writeAuthority!;
    const under = (paths: readonly string[], prefix: string) => paths.filter((path) => path.startsWith(prefix));

    const fixEntry = authorityFor("clockify_fix_entry");
    expect(under(fixEntry.serverDerivedIdPaths, "operation.body.")).toEqual([
      "operation.body.projectId", "operation.body.tagIds[]", "operation.body.taskId",
    ]);
    expect(under(fixEntry.permittedServerDefaultPaths, "operation.body.")).toEqual(["operation.body.start"]);

    const entryField = authorityFor("clockify_custom_fields_set_value_entry");
    expect(under(entryField.serverDerivedIdPaths, "operation.prepared.")).toEqual([
      "operation.prepared.body.customFieldValues[].customFieldId",
      "operation.prepared.body.projectId",
      "operation.prepared.body.tagIds[]",
      "operation.prepared.body.taskId",
      "operation.prepared.source.customFieldValues[].customFieldId",
      "operation.prepared.source.projectId",
      "operation.prepared.source.tagIds[]",
      "operation.prepared.source.taskId",
    ]);
    expect(under(entryField.permittedServerDefaultPaths, "operation.prepared.")).toEqual([
      "operation.prepared.body.start",
      "operation.prepared.source.start",
    ]);
    expect(entryField.preservedStatePaths).toEqual(expect.arrayContaining([
      "operation.prepared.body.description",
      "operation.prepared.source.description",
      "operation.prepared.body.*",
      "operation.prepared.source.*",
    ]));
    expect(validateWriteAuthorityOperation(
      ACTION_CATALOG.find((action) => action.name === "clockify_custom_fields_set_value_entry")!,
      { invented: { description: "not-authoritative" } },
      { mode: "single", maxHostCalls: 60, steps: [{ id: "set-entry-custom-field", kind: "primary" }] },
    )).toBe("undeclared_server_default_path:operation.invented.description");

    expect(under(authorityFor("clockify_time_off_policies_create").serverDerivedIdPaths, "operation.input.")).toEqual([
      "operation.input.userGroupIds[]", "operation.input.userId", "operation.input.userIds[]",
    ]);
    expect(under(authorityFor("clockify_time_off_policies_update").serverDerivedIdPaths, "operation.updateBody.")).toEqual([
      "operation.updateBody.body.userGroupIds[]",
      "operation.updateBody.body.userIds[]",
      "operation.updateBody.source.userGroupIds[]",
      "operation.updateBody.source.userIds[]",
      "operation.updateBody.userGroupIds[]",
      "operation.updateBody.userIds[]",
    ]);
    expect(under(authorityFor("clockify_time_off_balance_update").serverDerivedIdPaths, "operation.expectedBalances")).toEqual([
      "operation.expectedBalances[].userId",
    ]);
    expect(under(authorityFor("clockify_invoices_import_time").serverDerivedIdPaths, "operation.range.")).toEqual([
      "operation.range.projectIds[]",
    ]);
  });

  it("checks the raw model arguments before preprocessing or server-side resolution", async () => {
    const fake = createFakeWorkspace();
    const rawArgs = { projectName: "Apollo", startTimer: true };
    const observed: unknown[] = [];
    const denied = errorReceipt({
      action: "clockify_create_work_package",
      code: "intent_capability_denied",
      message: "The model arguments exceed the admin-authored intent.",
    });
    const context = {
      workspaceId: "ws",
      adminUserId: "admin",
      policy: defaultAdminPolicy(),
      clockify: fake.client,
      authorizeWriteArguments(input: { actionName: string; rawArgs: unknown }): ErrorReceipt | undefined {
        observed.push(input);
        return denied;
      },
    } as ActionContext & {
      authorizeWriteArguments(input: { actionName: string; rawArgs: unknown }): ErrorReceipt | undefined;
    };

    const result = await executeAction({
      actionName: "clockify_create_work_package",
      args: rawArgs,
      context,
    });

    expect(observed).toEqual([expect.objectContaining({
      actionName: "clockify_create_work_package",
      rawArgs,
    })]);
    expect(result).toEqual({ kind: "receipt", receipt: denied });
    expect(fake.counts.createProjectAtomic ?? 0).toBe(0);
    expect(fake.counts.startTimeEntryAtomic ?? 0).toBe(0);
  });

  it("checks local permission-write raw arguments before preprocessing", async () => {
    const fake = createFakeWorkspace();
    const rawArgs = { group: "reports", level: "read" };
    const observed: unknown[] = [];
    const denied = errorReceipt({
      action: "assistant_update_permissions",
      code: "intent_capability_denied",
      message: "The model arguments exceed the admin-authored intent.",
    });
    const context = {
      workspaceId: "ws",
      adminUserId: "admin",
      policy: defaultAdminPolicy(),
      clockify: fake.client,
      authorizeWriteArguments(input: { actionName: string; rawArgs: unknown }): ErrorReceipt | undefined {
        observed.push(input);
        return denied;
      },
    } as ActionContext;

    const result = await executeAction({
      actionName: "assistant_update_permissions",
      args: rawArgs,
      context,
    });

    expect(observed).toEqual([expect.objectContaining({
      actionName: "assistant_update_permissions",
      rawArgs,
      authority: expect.objectContaining({ literalControlledPaths: expect.arrayContaining(["groups.*"]) }),
    })]);
    expect(result).toEqual({ kind: "receipt", receipt: denied });
  });

});
