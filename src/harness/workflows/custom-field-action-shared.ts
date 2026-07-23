import { z } from "zod";
import type {
  ActionContext,
  CommitResult,
  ConfirmableOperation,
  RiskyClarifyResult,
  RiskyPreviewResult,
  SemanticLiteralAlias,
  TargetSnapshot,
} from "../action.js";
import { errorReceipt, successReceipt } from "../receipts.js";
import { commitSingleDurableRiskyStep, executeDurableRiskyStep } from "../durable-risky-write.js";
import { isJournalDegradedStep, withJournalDegradedWarning } from "../mutation-workflow.js";
import { captureTargetSnapshot } from "../target-snapshots.js";
import { describePatch } from "./resolve.js";
import { dispatchWithReconciliation, reconcileCreate } from "./structure-durable.js";
import type { CreateCustomFieldInput, CustomFieldSummary, PreparedCustomFieldUpdateInput } from "../../clockify/ports/custom-fields.js";
import { CUSTOM_FIELD_ALLOWED_VALUES_MAX, CUSTOM_FIELD_VALUE_ARRAY_MAX } from "../safety-limits.js";

export const CUSTOM_FIELD_REQUIRED_LITERAL_ALIASES = Object.freeze([
  { path: "required", value: false, authoredPhrases: Object.freeze(["optional", "not required"]) },
  { path: "required", value: true, authoredPhrases: Object.freeze(["required"]) },
] satisfies readonly SemanticLiteralAlias[]);

export const customFieldTypeSchema = z.enum([
  "TXT",
  "NUMBER",
  "DROPDOWN_SINGLE",
  "DROPDOWN_MULTIPLE",
  "CHECKBOX",
  "LINK",
]);

export const boundedCustomFieldValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string().min(1)).max(CUSTOM_FIELD_VALUE_ARRAY_MAX),
]);

export const boundedCustomFieldCreateSchema = z
  .object({
    name: z.string().min(1),
    fieldType: customFieldTypeSchema.optional(),
    allowedValues: z.array(z.string().min(1)).max(CUSTOM_FIELD_ALLOWED_VALUES_MAX).optional(),
    required: z.boolean().optional(),
    status: z.string().optional(),
  })
  .refine(
    (v) =>
      v.fieldType === undefined
      || !isDropdown(v.fieldType)
      || (Array.isArray(v.allowedValues) && v.allowedValues.length > 0),
    { message: "allowedValues is required for DROPDOWN_SINGLE / DROPDOWN_MULTIPLE." },
  );

export const boundedCustomFieldUpdateSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    fieldType: customFieldTypeSchema.optional(),
    allowedValues: z.array(z.string().min(1)).max(CUSTOM_FIELD_ALLOWED_VALUES_MAX).optional(),
    required: z.boolean().optional(),
    status: z.string().optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined
      || v.fieldType !== undefined
      || v.allowedValues !== undefined
      || v.required !== undefined
      || v.status !== undefined,
    { message: "Provide at least one field to change." },
  );

export const boundedCustomFieldSetValueProjectSchema = z.object({
  projectId: z.string().min(1),
  fieldId: z.string().min(1),
  value: boundedCustomFieldValueSchema,
});

export const boundedCustomFieldSetValueEntrySchema = z.object({
  entryId: z.string().min(1),
  fieldId: z.string().min(1),
  value: boundedCustomFieldValueSchema,
});

const isDropdown = (type: string): boolean => type === "DROPDOWN_SINGLE" || type === "DROPDOWN_MULTIPLE";

export function sameCustomField(
  row: CustomFieldSummary,
  expected: CreateCustomFieldInput | PreparedCustomFieldUpdateInput,
): boolean {
  if (row.name !== expected.name || row.type !== expected.type) return false;
  return (row.status ?? "VISIBLE") === (expected.status ?? "VISIBLE")
    && (row.required ?? false) === (expected.required ?? false)
    && JSON.stringify(row.allowedValues ?? []) === JSON.stringify(expected.allowedValues ?? []);
}

async function fetchCustomFieldSnapshot(ctx: ActionContext, id: string) {
  const field = await ctx.clockify.getCustomField(id);
  return field ? captureTargetSnapshot("target", { type: "custom_field", id: field.id, name: field.name }, field) : undefined;
}

export function fetchCustomFieldMutationSnapshot(ctx: ActionContext, snapshot: TargetSnapshot) {
  if (snapshot.ref.type === "custom_field") {
    return ctx.clockify.getCustomField(snapshot.ref.id).then((row) => row
      ? { ref: { type: "custom_field", id: row.id, name: row.name }, projection: row, truncated: false }
      : undefined);
  }
  if (snapshot.ref.type === "project") {
    return ctx.clockify.getProject(snapshot.ref.id).then((row) => row
      ? { ref: { type: "project", id: row.id, name: row.name }, projection: row, truncated: false }
      : undefined);
  }
  return ctx.clockify.getEntryCustomFieldMutationState(snapshot.ref.id).then((row) => row
    ? { ref: { type: "time_entry", id: snapshot.ref.id }, projection: row, truncated: false }
    : undefined);
}

export async function previewBoundedCustomFieldCreate(
  ctx: ActionContext,
  args: z.infer<typeof boundedCustomFieldCreateSchema>,
): Promise<RiskyPreviewResult | RiskyClarifyResult> {
  if (ctx.clockify.authClass === "addon") {
    return {
      clarify:
        "Clockify does not allow add-ons to create custom fields — no manifest scope can grant it, so I can't do this from inside the add-on. This is a Clockify platform restriction, not one of your assistant permissions. An admin can add the field under Clockify's workspace settings; I can read and set values on existing custom fields.",
    };
  }
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
}

export async function commitBoundedCustomFieldCreate(
  ctx: ActionContext,
  payload: Record<string, unknown>,
  operation: ConfirmableOperation,
  actionName: string,
): Promise<CommitResult> {
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
        reconcile: () => reconcileCreate({ beforeIds: baselineIds, list: () => ctx.clockify.listCustomFields(), matches: (row) => sameCustomField(row, input) }),
      });
      const field = result.value;
      return { externalId: field.id, effect: { created: { type: "custom_field", id: field.id, name: field.name } }, detail: { reconciled: result.reconciled } };
    },
  });
  if (step.status === "succeeded") {
    const receipt = successReceipt({
      action: actionName,
      entity: "custom_field",
      ids: { workspaceId: ctx.workspaceId },
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
}

export async function previewBoundedCustomFieldUpdate(
  ctx: ActionContext,
  args: z.infer<typeof boundedCustomFieldUpdateSchema>,
): Promise<RiskyPreviewResult | RiskyClarifyResult> {
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
  try {
    updateBody = await ctx.clockify.prepareCustomFieldUpdate(args.id, patch);
  } catch {
    return { clarify: "The current custom field could not be prepared safely. Refresh it and preview again." };
  }
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
}

export async function commitBoundedCustomFieldUpdate(
  ctx: ActionContext,
  payload: Record<string, unknown>,
  operation: ConfirmableOperation,
  actionName: string,
): Promise<CommitResult> {
  const { id, updateBody } = payload as {
    id: string;
    updateBody: Awaited<ReturnType<typeof ctx.clockify.prepareCustomFieldUpdate>>;
  };
  return commitSingleDurableRiskyStep({
    ctx, operation, planStepId: "update-custom-field", name: "Update custom field",
    verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (snapshot) => fetchCustomFieldMutationSnapshot(ctx, snapshot) },
    dispatch: async () => {
      const result = await dispatchWithReconciliation({
        dispatch: () => ctx.clockify.updateCustomFieldAtomic(id, updateBody),
        reconcile: async () => { const row = await ctx.clockify.getCustomField(id); return row && sameCustomField(row, updateBody) ? row : undefined; },
      });
      const updated = result.value;
      return { externalId: updated.id, effect: { updated: { type: "custom_field", id: updated.id, name: updated.name } }, detail: { reconciled: result.reconciled } };
    },
    success: (step) => successReceipt({
      action: actionName,
      entity: "custom_field",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "custom_field", id: step.externalId ?? id, name: updateBody.name }] },
    }),
  });
}

export async function previewBoundedCustomFieldSetValueProject(
  ctx: ActionContext,
  args: z.infer<typeof boundedCustomFieldSetValueProjectSchema>,
): Promise<RiskyPreviewResult | RiskyClarifyResult> {
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
}

export async function commitBoundedCustomFieldSetValueProject(
  ctx: ActionContext,
  payload: Record<string, unknown>,
  operation: ConfirmableOperation,
  actionName: string,
): Promise<CommitResult> {
  const { projectId, fieldId, value } = payload as { projectId: string; fieldId: string; value: unknown };
  return commitSingleDurableRiskyStep({
    ctx, operation, planStepId: "set-project-custom-field", name: "Set project custom field",
    verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (snapshot) => fetchCustomFieldMutationSnapshot(ctx, snapshot) },
    dispatch: async () => {
      await ctx.clockify.setProjectCustomFieldValueAtomic(projectId, fieldId, value);
      return { effect: { updated: { type: "project", id: projectId } } };
    },
    success: () => successReceipt({
      action: actionName,
      entity: "project",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "project", id: projectId }] },
    }),
  });
}

export async function previewBoundedCustomFieldSetValueEntry(
  ctx: ActionContext,
  args: z.infer<typeof boundedCustomFieldSetValueEntrySchema>,
): Promise<RiskyPreviewResult | RiskyClarifyResult> {
  let prepared: Awaited<ReturnType<typeof ctx.clockify.prepareEntryCustomFieldValue>>;
  try {
    prepared = await ctx.clockify.prepareEntryCustomFieldValue(args.entryId, args.fieldId, args.value);
  } catch {
    return { clarify: "The current time entry could not be prepared safely. Refresh it and preview again." };
  }
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
}

export async function commitBoundedCustomFieldSetValueEntry(
  ctx: ActionContext,
  payload: Record<string, unknown>,
  operation: ConfirmableOperation,
  actionName: string,
): Promise<CommitResult> {
  const { entryId, fieldId, prepared } = payload as {
    entryId: string;
    fieldId: string;
    prepared: Awaited<ReturnType<typeof ctx.clockify.prepareEntryCustomFieldValue>>;
  };
  return commitSingleDurableRiskyStep({
    ctx, operation, planStepId: "set-entry-custom-field", name: "Set entry custom field",
    verification: { snapshots: operation.targetSnapshots ?? [], fetchSnapshot: (snapshot) => fetchCustomFieldMutationSnapshot(ctx, snapshot) },
    dispatch: async () => {
      await ctx.clockify.setEntryCustomFieldValueAtomic(entryId, prepared);
      return { effect: { updated: { type: "time_entry", id: entryId, fieldId } } };
    },
    success: () => successReceipt({
      action: actionName,
      entity: "time_entry",
      ids: { workspaceId: ctx.workspaceId },
      changed: { updated: [{ type: "time_entry", id: entryId }] },
    }),
  });
}
