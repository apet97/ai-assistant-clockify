import { z } from "zod";
import { clarifyResult, defineAction, defineReadAction, defineRiskyAction, type ActionContext, type ActionDefinition, type SemanticLiteralAlias, type TargetSnapshot } from "../action.js";
import { errorReceipt, listReceipt, successReceipt } from "../receipts.js";
import { describePatch, resolveEntityRef } from "./resolve.js";
import { durableMutationContract } from "../durable-mutation-contract.js";
import { commitSingleDurableRiskyStep, executeDurableRiskyStep } from "../durable-risky-write.js";
import { isJournalDegradedStep, withJournalDegradedWarning } from "../mutation-workflow.js";
import { captureTargetSnapshot } from "../target-snapshots.js";
import { dispatchWithReconciliation, reconcileCreate, reconcileDelete } from "./structure-durable.js";
import type { CustomFieldSummary, CreateCustomFieldInput, PreparedCustomFieldUpdateInput } from "../../clockify/ports/custom-fields.js";
import type {
  ApiAccess,
  ApiActionMetadataCarrier,
  ApiExposure,
  ApiMethod,
  AvailabilityByAuthClass,
  MaterialFieldMetadata,
} from "../api-operation.js";

/**
 * Typed custom-field workflows (goclmcp §2.8). Reads (list/get) execute
 * immediately; create/update/delete + set-value are risky and run preview→commit.
 * Risk classes: create/update/set-value = `high_risk_write`; delete adds
 * `destructive`. All gated by the `custom_fields` feature group — these are real
 * Clockify admin writes, so they use `high_risk_write` (which keeps BOTH the
 * confirmation and the policy gate), never `permission_change` (which would
 * bypass the gate). `fieldType` is case-sensitive on the wire.
 */

const CF = "custom_fields" as const;

type CustomFieldActionName =
  | "clockify_custom_fields_list"
  | "clockify_custom_fields_get"
  | "clockify_custom_fields_create"
  | "clockify_custom_fields_update"
  | "clockify_custom_fields_delete"
  | "clockify_custom_fields_set_value_project"
  | "clockify_custom_fields_set_value_entry";

const CUSTOM_FIELD_AVAILABILITY: AvailabilityByAuthClass = Object.freeze({
  addon: Object.freeze({ available: true }),
  api_key: Object.freeze({ available: true }),
});

const CUSTOM_FIELD_CREATE_AVAILABILITY: AvailabilityByAuthClass = Object.freeze({
  addon: Object.freeze({ available: false, reason: "unsupported_auth_class" }),
  api_key: Object.freeze({ available: true }),
});

function customFieldEndpointKey(
  access: ApiAccess,
  method: ApiMethod,
  path: string,
  sourceModule = "custom-fields.ts",
): string {
  return [access, "api", method, path, sourceModule].join("\0");
}

function customFieldMaterialField(
  path: string,
  label: string,
  formatterId: string,
  requiredInPreview: boolean,
): MaterialFieldMetadata {
  return Object.freeze({
    kind: "value",
    path,
    label,
    formatterId,
    formatterVersion: 1,
    requiredInPreview,
  });
}

function customFieldApiMetadata(input: {
  actionName: CustomFieldActionName;
  operationId: string;
  method: ApiMethod;
  path: string;
  access: ApiAccess;
  primary: string;
  support: readonly string[];
  materialFields: readonly MaterialFieldMetadata[];
}): ApiActionMetadataCarrier {
  return Object.freeze({
    apiExposure: "api",
    apiOperation: Object.freeze({
      operationId: input.operationId,
      host: "api",
      method: input.method,
      path: input.path,
      access: input.access,
      exposure: "api",
    }),
    adapterEndpoints: Object.freeze({
      primary: Object.freeze([input.primary]),
      support: Object.freeze([...input.support]),
    }),
    availabilityByAuthClass: CUSTOM_FIELD_AVAILABILITY,
    boundedArgumentDictionaries: Object.freeze([]),
    materialFields: Object.freeze([...input.materialFields]),
    presentation: Object.freeze({ presenterId: input.actionName, version: 1 }),
  });
}

function customFieldInternalMetadata(input: {
  exposure: Exclude<ApiExposure, "api" | "local">;
  reason: string;
  primary: readonly string[];
  support: readonly string[];
  availability: AvailabilityByAuthClass;
}): ApiActionMetadataCarrier {
  return Object.freeze({
    apiExposure: input.exposure,
    apiExposureReason: input.reason,
    adapterEndpoints: Object.freeze({
      primary: Object.freeze([...input.primary]),
      support: Object.freeze([...input.support]),
    }),
    availabilityByAuthClass: input.availability,
    boundedArgumentDictionaries: Object.freeze([]),
  });
}

const customFieldEndpoint = Object.freeze({
  list: customFieldEndpointKey("read", "GET", "/workspaces/{workspaceId}/custom-fields"),
  create: customFieldEndpointKey("write", "POST", "/workspaces/{workspaceId}/custom-fields"),
  update: customFieldEndpointKey("write", "PUT", "/workspaces/{workspaceId}/custom-fields/{id}"),
  delete: customFieldEndpointKey("write", "DELETE", "/workspaces/{workspaceId}/custom-fields/{id}"),
  projectValue: customFieldEndpointKey("write", "PATCH", "/workspaces/{workspaceId}/projects/{projectId}/custom-fields/{fieldId}"),
  entryRead: customFieldEndpointKey("read", "GET", "/workspaces/{workspaceId}/time-entries/{entryId}"),
  entryUpdate: customFieldEndpointKey("write", "PUT", "/workspaces/{workspaceId}/time-entries/{entryId}"),
  projectGet: customFieldEndpointKey("read", "GET", "/workspaces/{workspaceId}/projects/{id}", "projects.ts"),
});

const CUSTOM_FIELD_API_METADATA = Object.freeze({
  clockify_custom_fields_list: customFieldApiMetadata({
    actionName: "clockify_custom_fields_list",
    operationId: "ofWorkspace",
    method: "GET",
    path: "/workspaces/{workspaceId}/custom-fields",
    access: "read",
    primary: customFieldEndpoint.list,
    support: [],
    materialFields: [],
  }),
  clockify_custom_fields_get: customFieldInternalMetadata({
    exposure: "composite",
    reason: "Finds one custom field by scanning the workspace custom-field list because Clockify exposes no usable GET /custom-fields/{id}; it is not a fabricated get-one operation.",
    primary: [customFieldEndpoint.list],
    support: [],
    availability: CUSTOM_FIELD_AVAILABILITY,
  }),
  clockify_custom_fields_create: customFieldInternalMetadata({
    exposure: "generic",
    reason: "The allowedValues array is unbounded on the legacy path; use the bounded clockify_custom_fields_create API action instead.",
    primary: [customFieldEndpoint.create],
    support: [customFieldEndpoint.list],
    availability: CUSTOM_FIELD_CREATE_AVAILABILITY,
  }),
  clockify_custom_fields_update: customFieldInternalMetadata({
    exposure: "generic",
    reason: "The allowedValues array is unbounded on the legacy path; use the bounded clockify_custom_fields_update API action instead.",
    primary: [customFieldEndpoint.update],
    support: [customFieldEndpoint.list],
    availability: CUSTOM_FIELD_AVAILABILITY,
  }),
  clockify_custom_fields_delete: customFieldApiMetadata({
    actionName: "clockify_custom_fields_delete",
    operationId: "delete",
    method: "DELETE",
    path: "/workspaces/{workspaceId}/custom-fields/{id}",
    access: "write",
    primary: customFieldEndpoint.delete,
    support: [customFieldEndpoint.list],
    materialFields: [
      customFieldMaterialField("/id", "Custom field", "entity", true),
      customFieldMaterialField("/name", "Custom field name", "text", false),
    ],
  }),
  clockify_custom_fields_set_value_project: customFieldInternalMetadata({
    exposure: "generic",
    reason: "The custom-field value accepts an unbounded string array on the legacy path; use the bounded clockify_custom_fields_set_value_project API action instead.",
    primary: [customFieldEndpoint.projectValue],
    support: [customFieldEndpoint.projectGet, customFieldEndpoint.list],
    availability: CUSTOM_FIELD_AVAILABILITY,
  }),
  clockify_custom_fields_set_value_entry: customFieldInternalMetadata({
    exposure: "generic",
    reason: "The custom-field value accepts an unbounded string array on the legacy path; use the bounded clockify_custom_fields_set_value_entry API action instead.",
    primary: [customFieldEndpoint.entryUpdate],
    support: [customFieldEndpoint.entryRead, customFieldEndpoint.list],
    availability: CUSTOM_FIELD_AVAILABILITY,
  }),
} satisfies Readonly<Record<CustomFieldActionName, ApiActionMetadataCarrier>>);

const REQUIRED_LITERAL_ALIASES = Object.freeze([
  { path: "required", value: false, authoredPhrases: Object.freeze(["optional", "not required"]) },
  { path: "required", value: true, authoredPhrases: Object.freeze(["required"]) },
] satisfies readonly SemanticLiteralAlias[]);
const createContract = durableMutationContract({ source: "confirmed", targeting: { mode: "create_no_target" }, strategies: ["create"] });
const targetContract = (relations: ["target" | "parent", ...Array<"target" | "parent">], strategy: "update" | "delete") =>
  durableMutationContract({ source: "confirmed", targeting: { mode: "snapshots", relations }, strategies: [strategy] });

async function fetchCustomFieldSnapshot(ctx: ActionContext, id: string) {
  const field = await ctx.clockify.getCustomField(id);
  return field ? captureTargetSnapshot("target", { type: "custom_field", id: field.id, name: field.name }, field) : undefined;
}

function fetchSnapshot(ctx: ActionContext, snapshot: TargetSnapshot) {
  if (snapshot.ref.type === "custom_field") {
    return ctx.clockify.getCustomField(snapshot.ref.id).then((row) => row ? { ref: { type: "custom_field", id: row.id, name: row.name }, projection: row, truncated: false } : undefined);
  }
  if (snapshot.ref.type === "project") {
    return ctx.clockify.getProject(snapshot.ref.id).then((row) => row ? { ref: { type: "project", id: row.id, name: row.name }, projection: row, truncated: false } : undefined);
  }
  return ctx.clockify.getEntryCustomFieldMutationState(snapshot.ref.id).then((row) => row ? { ref: { type: "time_entry", id: snapshot.ref.id }, projection: row, truncated: false } : undefined);
}

const fieldTypeSchema = z.enum([
  "TXT",
  "NUMBER",
  "DROPDOWN_SINGLE",
  "DROPDOWN_MULTIPLE",
  "CHECKBOX",
  "LINK",
]);

/** A custom-field value the model may set (text/number/checkbox/link/dropdown). */
const valueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);

const isDropdown = (t: string): boolean => t === "DROPDOWN_SINGLE" || t === "DROPDOWN_MULTIPLE";

function sameField(row: CustomFieldSummary, expected: CreateCustomFieldInput | PreparedCustomFieldUpdateInput): boolean {
  if (row.name !== expected.name || row.type !== expected.type) return false;
  return (row.status ?? "VISIBLE") === (expected.status ?? "VISIBLE") &&
    (row.required ?? false) === (expected.required ?? false) &&
    JSON.stringify(row.allowedValues ?? []) === JSON.stringify(expected.allowedValues ?? []);
}

const listCustomFields = defineReadAction({
  name: "clockify_custom_fields_list",
  ...CUSTOM_FIELD_API_METADATA.clockify_custom_fields_list,
  description: "List the workspace custom fields.",
  group: CF,
  schema: z.object({}),
  async handler(ctx) {
    const { rows, truncated } = await ctx.clockify.listCustomFields();
    return listReceipt({
      action: "clockify_custom_fields_list",
      entity: "custom_field",
      ids: { workspaceId: ctx.workspaceId },
      rows,
      truncated,
    });
  },
});

const getCustomField = defineAction({
  name: "clockify_custom_fields_get",
  ...CUSTOM_FIELD_API_METADATA.clockify_custom_fields_get,
  description: "Fetch a single custom field by id, or by its exact `name` (resolved server-side).",
  featureGroup: CF,
  risks: ["read"],
  schema: z
    .object({ id: z.string().min(1).optional(), name: z.string().min(1).optional() })
    .refine((v) => v.id !== undefined || v.name !== undefined, {
      message: "Provide the custom field id or its exact name.",
    }),
  async handler(ctx, args) {
    const resolved = await resolveEntityRef(args, {
      noun: "custom field",
      verb: "fetch",
      list: () => ctx.clockify.listCustomFields(),
    });
    if (!resolved.ok) {
      return clarifyResult(resolved.clarify);
    }
    const entity = await ctx.clockify.getCustomField(resolved.id);
    return {
      kind: "receipt",
      receipt: successReceipt({
        action: "clockify_custom_fields_get",
        entity: "custom_field",
        ids: { workspaceId: ctx.workspaceId },
        data: { entity },
      }),
    };
  },
});

const createCustomField = defineRiskyAction({
  name: "clockify_custom_fields_create",
  ...CUSTOM_FIELD_API_METADATA.clockify_custom_fields_create,
  description:
    "Create a custom field (TXT/NUMBER/DROPDOWN_SINGLE/DROPDOWN_MULTIPLE/CHECKBOX/LINK). NOTE: Clockify blocks custom-field CREATION for add-ons (no scope grants it) — inside the embedded add-on this returns an honest restriction notice; an admin can add the field in Clockify's workspace settings. Elevated write — previews and requires confirmation. Dropdowns require allowedValues.",
  group: CF,
  risks: ["high_risk_write"],
  mutationWorkflow: "durable",
  mutationContract: createContract,
  semanticLiteralAliases: REQUIRED_LITERAL_ALIASES,
  // `fieldType` is OPTIONAL in the schema so an add-on session refuses up front
  // (the platform restriction below) without first being forced to ask the user
  // which type — the dev/api_key path still clarifies for the type after that.
  schema: z
    .object({
      name: z.string().min(1),
      fieldType: fieldTypeSchema.optional(),
      allowedValues: z.array(z.string().min(1)).optional(),
      required: z.boolean().optional(),
      status: z.string().optional(),
    })
    .refine(
      (v) =>
        v.fieldType === undefined ||
        !isDropdown(v.fieldType) ||
        (Array.isArray(v.allowedValues) && v.allowedValues.length > 0),
      { message: "allowedValues is required for DROPDOWN_SINGLE / DROPDOWN_MULTIPLE." },
    ),
  async preview(ctx, args) {
    // Clockify refuses custom-field CREATION for add-on tokens — no manifest
    // scope can grant it (probed live 2026-06-10). Surface that at PREVIEW time
    // so the admin is never told to confirm a doomed create (live item 180).
    // This is the FIRST check (before any use of fieldType) so an add-on session
    // refuses immediately instead of asking which type for a doomed create.
    if (ctx.clockify.authClass === "addon") {
      return {
        clarify:
          "Clockify does not allow add-ons to create custom fields — no manifest scope can grant it, so I can't do this from inside the add-on. This is a Clockify platform restriction, not one of your assistant permissions. An admin can add the field under Clockify's workspace settings; I can read and set values on existing custom fields.",
      };
    }
    // Dev/api_key path: the type is required to create the field, so clarify for
    // it rather than guessing (preserves the dev UX the add-on restriction skips).
    if (args.fieldType === undefined) {
      return {
        clarify:
          "Which type of custom field should I create — TXT, NUMBER, DROPDOWN_SINGLE, DROPDOWN_MULTIPLE, CHECKBOX, or LINK? (Dropdowns also need a list of allowed values.)",
      };
    }
    const input = {
      name: args.name,
      type: args.fieldType,
      ...(args.allowedValues !== undefined ? { allowedValues: args.allowedValues } : {}),
      ...(args.required !== undefined ? { required: args.required } : {}),
      ...(args.status !== undefined ? { status: args.status } : {}),
    };
    const baseline = await ctx.clockify.listCustomFields();
    if (baseline.truncated) return { clarify: "Clockify returned an incomplete custom-field baseline. Retry after it can be read completely." };
    return {
      actionLabel: "Create custom field",
      targets: [],
      expectedChanges: [`Create ${args.fieldType} custom field "${args.name}"`],
      reversibility: "You can update or delete the custom field afterward.",
      warnings: ["This adds a custom field to the workspace."],
      payload: { input },
      mutationPlan: { mode: "single", steps: [{ id: "create-custom-field", kind: "primary", reconciliationStrategy: "create" }] },
    };
  },
  async commit(ctx, payload, operation) {
    const { input } = payload as { input: CreateCustomFieldInput };
    let baselineIds: string[];
    try {
      const baseline = await ctx.clockify.listCustomFields();
      if (baseline.truncated) {
        return errorReceipt({
          action: operation.actionName,
          code: "create_baseline_unavailable",
          message: "Clockify returned an incomplete custom-field list immediately before dispatch. No field was created.",
          recovery: { hint: "Refresh and preview the field again when the complete list is available.", retryable: true },
        });
      }
      baselineIds = baseline.rows.map((row) => row.id);
    } catch {
      return errorReceipt({
        action: operation.actionName,
        code: "create_baseline_unavailable",
        message: "The custom-field list could not be read immediately before dispatch. No field was created.",
        recovery: { hint: "Refresh and preview the field again after Clockify reads recover.", retryable: true },
      });
    }
    const step = await executeDurableRiskyStep({
      ctx, operation, planStepId: "create-custom-field", index: 0, name: "Create custom field",
      preparedDetail: { preDispatch: { strategy: "custom_field_create_baseline", ids: baselineIds, truncated: false } },
      dispatch: async () => {
        const result = await dispatchWithReconciliation({
          dispatch: () => ctx.clockify.createCustomFieldAtomic(input),
          reconcile: () => reconcileCreate({ beforeIds: baselineIds, list: () => ctx.clockify.listCustomFields(), matches: (row) => sameField(row, input) }),
        });
        const field = result.value;
        return { externalId: field.id, effect: { created: { type: "custom_field", id: field.id, name: field.name } }, detail: { reconciled: result.reconciled } };
      },
    });
    if (step.status === "succeeded") {
      const receipt = successReceipt({
        action: "clockify_custom_fields_create", entity: "custom_field", ids: { workspaceId: ctx.workspaceId },
        changed: { created: [{ type: "custom_field", id: step.externalId ?? "unknown", name: input.name }] },
      });
      return isJournalDegradedStep(step) ? withJournalDegradedWarning(receipt) : receipt;
    }
    return errorReceipt({
      action: operation.actionName,
      code: step.status === "outcome_unknown" ? "commit_outcome_unknown" : "write_failed",
      message: step.status === "outcome_unknown"
        ? "Clockify did not provide a definitive response, so the custom field may or may not have been created."
        : "Clockify definitively rejected custom-field creation.",
      recovery: step.status === "outcome_unknown"
        ? { hint: "Verify the exact custom field in Clockify before deciding whether to try again.", retryable: false }
        : { hint: "Correct the custom-field details and preview again.", retryable: true },
    });
  },
});

const updateCustomField = defineRiskyAction({
  name: "clockify_custom_fields_update",
  ...CUSTOM_FIELD_API_METADATA.clockify_custom_fields_update,
  description:
    "Update a custom field (name/type/allowedValues/required/status). Elevated write — previews and requires confirmation.",
  group: CF,
  risks: ["high_risk_write"],
  mutationWorkflow: "durable",
  mutationContract: targetContract(["target"], "update"),
  semanticLiteralAliases: REQUIRED_LITERAL_ALIASES,
  schema: z
    .object({
      id: z.string().min(1),
      name: z.string().optional(),
      fieldType: fieldTypeSchema.optional(),
      allowedValues: z.array(z.string().min(1)).optional(),
      required: z.boolean().optional(),
      status: z.string().optional(),
    })
    .refine(
      (v) =>
        v.name !== undefined ||
        v.fieldType !== undefined ||
        v.allowedValues !== undefined ||
        v.required !== undefined ||
        v.status !== undefined,
      { message: "Provide at least one field to change." },
    ),
  async preview(ctx, args) {
    const target = await fetchCustomFieldSnapshot(ctx, args.id);
    if (!target) return { clarify: `Custom field ${args.id} could not be verified.` };
    const patch = {
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.fieldType !== undefined ? { type: args.fieldType } : {}),
      ...(args.allowedValues !== undefined ? { allowedValues: args.allowedValues } : {}),
      ...(args.required !== undefined ? { required: args.required } : {}),
      ...(args.status !== undefined ? { status: args.status } : {}),
    };
    let updateBody: Awaited<ReturnType<typeof ctx.clockify.prepareCustomFieldUpdate>>;
    try { updateBody = await ctx.clockify.prepareCustomFieldUpdate(args.id, patch); }
    catch { return { clarify: "The current custom field could not be prepared safely. Refresh it and preview again." }; }
    return {
      actionLabel: "Update custom field",
      targets: [{ type: "custom_field", id: args.id, ...(args.name !== undefined ? { name: args.name } : {}) }],
      expectedChanges: describePatch(patch),
      reversibility: "You can update the custom field again to revert most fields.",
      warnings: ["This changes a workspace custom field."],
      payload: { id: args.id, patch, updateBody },
      targetSnapshots: [target],
      mutationPlan: { mode: "single", steps: [{ id: "update-custom-field", kind: "primary", targetFingerprint: target.fingerprint, reconciliationStrategy: "update" }] },
    };
  },
  async commit(ctx, payload, operation) {
    const { id, updateBody } = payload as {
      id: string;
      updateBody: Awaited<ReturnType<typeof ctx.clockify.prepareCustomFieldUpdate>>;
    };
    return commitSingleDurableRiskyStep({
      ctx, operation, planStepId: "update-custom-field", name: "Update custom field",
      verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (snapshot) => fetchSnapshot(ctx, snapshot) },
      dispatch: async () => {
        const result = await dispatchWithReconciliation({
          dispatch: () => ctx.clockify.updateCustomFieldAtomic(id, updateBody),
          reconcile: async () => { const row = await ctx.clockify.getCustomField(id); return row && sameField(row, updateBody) ? row : undefined; },
        });
        const updated = result.value;
        return { externalId: updated.id, effect: { updated: { type: "custom_field", id: updated.id, name: updated.name } }, detail: { reconciled: result.reconciled } };
      },
      success: (step) => successReceipt({ action: "clockify_custom_fields_update", entity: "custom_field", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "custom_field", id: step.externalId ?? id, name: updateBody.name }] } }),
    });
  },
});

const deleteCustomField = defineRiskyAction({
  name: "clockify_custom_fields_delete",
  ...CUSTOM_FIELD_API_METADATA.clockify_custom_fields_delete,
  description: "Delete a custom field. Destructive — previews and requires confirmation.",
  group: CF,
  risks: ["destructive"],
  mutationWorkflow: "durable",
  mutationContract: targetContract(["target"], "delete"),
  schema: z.object({ id: z.string().min(1), name: z.string().optional() }),
  async preview(ctx, args) {
    const target = await fetchCustomFieldSnapshot(ctx, args.id);
    if (!target) return { clarify: `Custom field ${args.id} could not be verified.` };
    return {
      actionLabel: "Delete custom field",
      targets: [{ type: "custom_field", id: args.id, ...(args.name !== undefined ? { name: args.name } : {}) }],
      expectedChanges: [`Delete custom field ${args.name ?? args.id}`],
      reversibility: "This cannot be undone.",
      warnings: ["Deleting a custom field removes its values from all entities."],
      payload: { id: args.id, ...(args.name !== undefined ? { name: args.name } : {}) },
      targetSnapshots: [target],
      mutationPlan: { mode: "single", steps: [{ id: "delete-custom-field", kind: "primary", targetFingerprint: target.fingerprint, reconciliationStrategy: "delete" }] },
    };
  },
  async commit(ctx, payload, operation) {
    const { id, name } = payload as { id: string; name?: string };
    return commitSingleDurableRiskyStep({
      ctx, operation, planStepId: "delete-custom-field", name: "Delete custom field",
      verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (snapshot) => fetchSnapshot(ctx, snapshot) },
      dispatch: async () => {
        const result = await dispatchWithReconciliation({ dispatch: async () => { await ctx.clockify.deleteCustomFieldAtomic(id); return true as const; }, reconcile: () => reconcileDelete(() => ctx.clockify.getCustomField(id)) });
        return { effect: { deleted: { type: "custom_field", id, name } }, detail: { reconciled: result.reconciled } };
      },
      success: () => successReceipt({ action: "clockify_custom_fields_delete", entity: "custom_field", ids: { workspaceId: ctx.workspaceId }, changed: { deleted: [{ type: "custom_field", id, name }] } }),
    });
  },
});

const setValueProject = defineRiskyAction({
  name: "clockify_custom_fields_set_value_project",
  ...CUSTOM_FIELD_API_METADATA.clockify_custom_fields_set_value_project,
  description:
    "Set a custom field value on a project. Elevated write — previews and requires confirmation.",
  group: CF,
  risks: ["high_risk_write"],
  mutationWorkflow: "durable",
  mutationContract: targetContract(["target", "parent"], "update"),
  schema: z.object({ projectId: z.string().min(1), fieldId: z.string().min(1), value: valueSchema }),
  async preview(ctx, args) {
    const project = await ctx.clockify.getProject(args.projectId);
    const field = await ctx.clockify.getCustomField(args.fieldId);
    if (!project || !field) return { clarify: "The project or custom field could not be verified." };
    const target = captureTargetSnapshot("target", { type: "project", id: project.id, name: project.name }, project);
    const parent = captureTargetSnapshot("parent", { type: "custom_field", id: field.id, name: field.name }, field);
    return {
      actionLabel: "Set project custom field value",
      targets: [{ type: "project", id: args.projectId }],
      expectedChanges: [`Set custom field ${args.fieldId} on project ${args.projectId}`],
      reversibility: "You can set a new value at any time.",
      warnings: ["This changes a project's custom field value."],
      payload: { projectId: args.projectId, fieldId: args.fieldId, value: args.value },
      targetSnapshots: [target, parent],
      mutationPlan: { mode: "single", steps: [{ id: "set-project-custom-field", kind: "primary", targetFingerprint: target.fingerprint, reconciliationStrategy: "update" }] },
    };
  },
  async commit(ctx, payload, operation) {
    const { projectId, fieldId, value } = payload as { projectId: string; fieldId: string; value: unknown };
    return commitSingleDurableRiskyStep({
      ctx, operation, planStepId: "set-project-custom-field", name: "Set project custom field",
      verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (snapshot) => fetchSnapshot(ctx, snapshot) },
      dispatch: async () => { await ctx.clockify.setProjectCustomFieldValueAtomic(projectId, fieldId, value); return { effect: { updated: { type: "project", id: projectId } } }; },
      success: () => successReceipt({ action: "clockify_custom_fields_set_value_project", entity: "project", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "project", id: projectId }] } }),
    });
  },
});

const setValueEntry = defineRiskyAction({
  name: "clockify_custom_fields_set_value_entry",
  ...CUSTOM_FIELD_API_METADATA.clockify_custom_fields_set_value_entry,
  description:
    "Set a custom field value on a time entry. Elevated write — previews and requires confirmation.",
  group: CF,
  risks: ["high_risk_write"],
  mutationWorkflow: "durable",
  mutationContract: targetContract(["target", "parent"], "update"),
  schema: z.object({ entryId: z.string().min(1), fieldId: z.string().min(1), value: valueSchema }),
  async preview(ctx, args) {
    let prepared: Awaited<ReturnType<typeof ctx.clockify.prepareEntryCustomFieldValue>>;
    try { prepared = await ctx.clockify.prepareEntryCustomFieldValue(args.entryId, args.fieldId, args.value); }
    catch { return { clarify: "The current time entry could not be prepared safely. Refresh it and preview again." }; }
    const field = await ctx.clockify.getCustomField(args.fieldId);
    if (!field) return { clarify: "The custom field could not be verified." };
    const target = captureTargetSnapshot("target", { type: "time_entry", id: args.entryId }, prepared.source);
    const parent = captureTargetSnapshot("parent", { type: "custom_field", id: field.id, name: field.name }, field);
    return {
      actionLabel: "Set time-entry custom field value",
      targets: [{ type: "time_entry", id: args.entryId }],
      expectedChanges: [`Set custom field ${args.fieldId} on time entry ${args.entryId}`],
      reversibility: "You can set a new value at any time.",
      warnings: ["This changes a time entry's custom field value."],
      payload: { entryId: args.entryId, fieldId: args.fieldId, value: args.value, prepared },
      targetSnapshots: [target, parent],
      mutationPlan: { mode: "single", steps: [{ id: "set-entry-custom-field", kind: "primary", targetFingerprint: target.fingerprint, reconciliationStrategy: "update" }] },
    };
  },
  async commit(ctx, payload, operation) {
    const { entryId, fieldId, prepared } = payload as { entryId: string; fieldId: string; prepared: Awaited<ReturnType<typeof ctx.clockify.prepareEntryCustomFieldValue>> };
    return commitSingleDurableRiskyStep({
      ctx, operation, planStepId: "set-entry-custom-field", name: "Set entry custom field",
      verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (snapshot) => fetchSnapshot(ctx, snapshot) },
      dispatch: async () => { await ctx.clockify.setEntryCustomFieldValueAtomic(entryId, prepared); return { effect: { updated: { type: "time_entry", id: entryId, fieldId } } }; },
      success: () => successReceipt({ action: "clockify_custom_fields_set_value_entry", entity: "time_entry", ids: { workspaceId: ctx.workspaceId }, changed: { updated: [{ type: "time_entry", id: entryId }] } }),
    });
  },
});

export const CUSTOM_FIELD_ACTIONS: ActionDefinition[] = [
  listCustomFields,
  getCustomField,
  deleteCustomField,
];
