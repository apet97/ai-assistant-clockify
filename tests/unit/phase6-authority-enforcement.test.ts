import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ActionContext, ActionDefinition } from "../../src/harness/action.js";
import { executeAction } from "../../src/harness/actions.js";
import { ACTION_CATALOG, actionFingerprint } from "../../src/harness/catalog.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { errorReceipt, type ErrorReceipt } from "../../src/harness/receipts.js";
import { summarizeArgs } from "../../src/harness/arg-summary.js";
import {
  validateWriteAuthorityOperation,
  writeAuthorityActionNames,
} from "../../src/harness/write-authority.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";

interface WriteAuthorityMetadata {
  literalControlledPaths: readonly string[];
  serverDerivedIdPaths: readonly string[];
  permittedServerDefaultPaths: readonly string[];
  preservedStatePaths: readonly string[];
  cardinality: {
    mode: "single" | "fixed" | "argument";
    maxExecutions: number;
    argumentPath?: string;
  };
  mutationPlans: readonly unknown[];
}

function externalWrites(): ActionDefinition[] {
  return ACTION_CATALOG.filter((action) =>
    action.name.startsWith("clockify_") && action.risks.some((risk) => risk !== "read"));
}

describe("Phase 6 write authority enforcement", () => {
  it("requires explicit literal, derived-id, default, and cardinality metadata on every external write", () => {
    const invalid = externalWrites().flatMap((action) => {
      const authority = (action as ActionDefinition & { writeAuthority?: WriteAuthorityMetadata }).writeAuthority;
      if (!authority || !Array.isArray(authority.literalControlledPaths) ||
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

  it("has one reviewed semantics entry for every external write and no extras", () => {
    expect([...writeAuthorityActionNames()].sort()).toEqual(externalWrites().map((action) => action.name).sort());
  });

  it("matches exact ordered mutation plans, including delete compensation", () => {
    const deleteEntity = ACTION_CATALOG.find((action) => action.name === "clockify_delete_entity")!;
    const operation = { id: "p1", entityType: "project" };
    const valid = {
      mode: "curated" as const,
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
      ...Array.from({ length: 100 }, (_, index) => ({ id: `add-invoice-item-${index}`, kind: "primary" as const })),
    ];
    expect(validateWriteAuthorityOperation(invoice, { items: Array(100).fill({}) }, {
      mode: "curated", steps,
    })).toBeUndefined();
    expect(validateWriteAuthorityOperation(invoice, { items: Array(101).fill({}) }, {
      mode: "curated", steps: [...steps, { id: "add-invoice-item-100", kind: "primary" }],
    })).toBe("mutation_cardinality_exceeded");
    expect(validateWriteAuthorityOperation(invoice, { items: [{}, {}] }, {
      mode: "curated",
      steps: [
        { id: "create-invoice", kind: "primary" },
        { id: "add-invoice-item-0", kind: "primary" },
        { id: "add-invoice-item-2", kind: "primary" },
      ],
    })).toBe("undeclared_mutation_plan");
    expect(validateWriteAuthorityOperation(invoice, { items: [{}] }, {
      mode: "curated",
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
    }, { mode: "single", steps: [{ id: "create-project", kind: "primary" }] })).toBeUndefined();
    expect(validateWriteAuthorityOperation(project, {
      body: { name: "Apollo", inventedTargetId: "client-2" },
    }, { mode: "single", steps: [{ id: "create-project", kind: "primary" }] })).toBe(
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
      mutationWorkflow: action.mutationWorkflow,
      mutationContract: action.mutationContract,
      writeAuthority: action.writeAuthority,
      preparedSafeWrite: !!action.prepareSafeWrite && !!action.executeSafeWrite,
    })).digest("hex");
    expect(actionFingerprint(action.name)).toBe(expected);
  });

  it("uses action semantics instead of the first array-shaped argument for cardinality", () => {
    const authorityFor = (name: string) => {
      const action = ACTION_CATALOG.find((candidate) => candidate.name === name);
      expect(action?.writeAuthority).toBeDefined();
      return action!.writeAuthority!;
    };

    // These arrays are values inside one host mutation, not repeated dispatches.
    expect(authorityFor("clockify_start_timer").cardinality).toEqual({ mode: "single", maxExecutions: 1 });
    expect(authorityFor("clockify_entries_mark_invoiced").cardinality).toEqual({ mode: "single", maxExecutions: 1 });
    // Curated actions declare their real host-step ceiling explicitly.
    expect(authorityFor("clockify_clients_create").cardinality).toEqual({ mode: "fixed", maxExecutions: 2 });
    expect(authorityFor("clockify_create_work_package").cardinality).toEqual({ mode: "fixed", maxExecutions: 5 });
    expect(authorityFor("clockify_invoices_create").cardinality).toEqual({
      mode: "argument",
      maxExecutions: 102,
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
    expect(projectUpdate.cardinality).toEqual({ mode: "single", maxExecutions: 1 });
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
    expect(entryField.preservedStatePaths).toEqual([
      "operation.prepared.body.description", "operation.prepared.source.description",
    ]);
    expect(validateWriteAuthorityOperation(
      ACTION_CATALOG.find((action) => action.name === "clockify_custom_fields_set_value_entry")!,
      { invented: { description: "not-authoritative" } },
      { mode: "single", steps: [{ id: "set-entry-custom-field", kind: "primary" }] },
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

});
