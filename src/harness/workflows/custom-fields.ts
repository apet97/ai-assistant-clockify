import { z } from "zod";
import { clarifyResult, defineAction, defineReadAction, defineRiskyAction, type ActionContext, type ActionDefinition, type TargetSnapshot } from "../action.js";
import { listReceipt, successReceipt } from "../receipts.js";
import { resolveEntityRef } from "./resolve.js";
import { durableMutationContract } from "../durable-mutation-contract.js";
import { commitSingleDurableRiskyStep } from "../durable-risky-write.js";
import { captureTargetSnapshot } from "../target-snapshots.js";
import { dispatchWithReconciliation, reconcileDelete } from "./structure-durable.js";
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
  return Promise.resolve(undefined);
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
      return clarifyResult(resolved.clarify, "id");
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

export const CUSTOM_FIELD_ACTIONS: ActionDefinition[] = [
  listCustomFields,
  getCustomField,
  deleteCustomField,
];
