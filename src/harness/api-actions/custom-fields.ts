import { defineRiskyAction, type ActionDefinition } from "../action.js";
import { durableMutationContract } from "../durable-mutation-contract.js";
import {
  CUSTOM_FIELD_ALLOWED_VALUES_MAX,
  CUSTOM_FIELD_VALUE_ARRAY_MAX,
} from "../safety-limits.js";
import {
  boundedCustomFieldCreateSchema,
  boundedCustomFieldSetValueEntrySchema,
  boundedCustomFieldSetValueProjectSchema,
  boundedCustomFieldUpdateSchema,
  commitBoundedCustomFieldCreate,
  commitBoundedCustomFieldSetValueEntry,
  commitBoundedCustomFieldSetValueProject,
  commitBoundedCustomFieldUpdate,
  CUSTOM_FIELD_REQUIRED_LITERAL_ALIASES,
  previewBoundedCustomFieldCreate,
  previewBoundedCustomFieldSetValueEntry,
  previewBoundedCustomFieldSetValueProject,
  previewBoundedCustomFieldUpdate,
} from "../workflows/custom-field-action-shared.js";
import type {
  ApiAccess,
  ApiActionMetadataCarrier,
  ApiMethod,
  AvailabilityByAuthClass,
  MaterialFieldMetadata,
} from "../api-operation.js";

const CF = "custom_fields" as const;

const CUSTOM_FIELD_AVAILABILITY: AvailabilityByAuthClass = Object.freeze({
  addon: Object.freeze({ available: true }),
  api_key: Object.freeze({ available: true }),
});

const CUSTOM_FIELD_CREATE_AVAILABILITY: AvailabilityByAuthClass = Object.freeze({
  addon: Object.freeze({ available: false, reason: "unsupported_auth_class" }),
  api_key: Object.freeze({ available: true }),
});

function customFieldEndpointKey(access: ApiAccess, method: ApiMethod, path: string, sourceModule = "custom-fields.ts"): string {
  return [access, "api", method, path, sourceModule].join("\0");
}

function customFieldMaterialField(path: string, label: string, formatterId: string, requiredInPreview: boolean): MaterialFieldMetadata {
  return Object.freeze({ kind: "value", path, label, formatterId, formatterVersion: 1, requiredInPreview });
}

function customFieldApiMetadata(input: {
  actionName: string;
  operationId: string;
  method: ApiMethod;
  path: string;
  access: ApiAccess;
  primary: string;
  support: readonly string[];
  materialFields: readonly MaterialFieldMetadata[];
  availability?: AvailabilityByAuthClass;
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
    adapterEndpoints: Object.freeze({ primary: Object.freeze([input.primary]), support: Object.freeze([...input.support]) }),
    availabilityByAuthClass: input.availability ?? CUSTOM_FIELD_AVAILABILITY,
    boundedArgumentDictionaries: Object.freeze([]),
    materialFields: Object.freeze([...input.materialFields]),
    presentation: Object.freeze({ presenterId: input.actionName, version: 1 }),
  });
}

const customFieldEndpoint = Object.freeze({
  list: customFieldEndpointKey("read", "GET", "/workspaces/{workspaceId}/custom-fields"),
  create: customFieldEndpointKey("write", "POST", "/workspaces/{workspaceId}/custom-fields"),
  update: customFieldEndpointKey("write", "PUT", "/workspaces/{workspaceId}/custom-fields/{id}"),
  projectValue: customFieldEndpointKey("write", "PATCH", "/workspaces/{workspaceId}/projects/{projectId}/custom-fields/{fieldId}"),
  entryRead: customFieldEndpointKey("read", "GET", "/workspaces/{workspaceId}/time-entries/{id}", "custom-fields.ts"),
  entryUpdate: customFieldEndpointKey("write", "PUT", "/workspaces/{workspaceId}/time-entries/{id}", "custom-fields.ts"),
  projectGet: customFieldEndpointKey("read", "GET", "/workspaces/{workspaceId}/projects/{id}", "projects.ts"),
});

export const CUSTOM_FIELD_WRITE_API_METADATA = Object.freeze({
  clockify_custom_fields_create: customFieldApiMetadata({
    actionName: "clockify_custom_fields_create",
    operationId: "create",
    method: "POST",
    path: "/workspaces/{workspaceId}/custom-fields",
    access: "write",
    primary: customFieldEndpoint.create,
    support: [customFieldEndpoint.list],
    availability: CUSTOM_FIELD_CREATE_AVAILABILITY,
    materialFields: [
      customFieldMaterialField("/name", "Field name", "text", true),
      customFieldMaterialField("/fieldType", "Field type", "text", true),
      {
        kind: "array_item",
        containerPath: "/allowedValues",
        itemPath: "/value",
        labelTemplate: "Allowed value {index}",
        maxItems: CUSTOM_FIELD_ALLOWED_VALUES_MAX,
        formatterId: "text",
        formatterVersion: 1,
        requiredInPreview: false,
      },
      customFieldMaterialField("/required", "Required", "boolean", false),
      customFieldMaterialField("/status", "Status", "text", false),
    ],
  }),
  clockify_custom_fields_update: customFieldApiMetadata({
    actionName: "clockify_custom_fields_update",
    operationId: "editCustomField",
    method: "PUT",
    path: "/workspaces/{workspaceId}/custom-fields/{id}",
    access: "write",
    primary: customFieldEndpoint.update,
    support: [customFieldEndpoint.list],
    materialFields: [
      customFieldMaterialField("/id", "Custom field", "entity", true),
      customFieldMaterialField("/name", "Field name", "text", false),
      customFieldMaterialField("/fieldType", "Field type", "text", false),
      {
        kind: "array_item",
        containerPath: "/allowedValues",
        itemPath: "/value",
        labelTemplate: "Allowed value {index}",
        maxItems: CUSTOM_FIELD_ALLOWED_VALUES_MAX,
        formatterId: "text",
        formatterVersion: 1,
        requiredInPreview: false,
      },
      customFieldMaterialField("/required", "Required", "boolean", false),
      customFieldMaterialField("/status", "Status", "text", false),
    ],
  }),
  clockify_custom_fields_set_value_project: customFieldApiMetadata({
    actionName: "clockify_custom_fields_set_value_project",
    operationId: "editProjectCustomFieldDefaultValue",
    method: "PATCH",
    path: "/workspaces/{workspaceId}/projects/{projectId}/custom-fields/{fieldId}",
    access: "write",
    primary: customFieldEndpoint.projectValue,
    support: [customFieldEndpoint.projectGet, customFieldEndpoint.list],
    materialFields: [
      customFieldMaterialField("/projectId", "Project", "entity", true),
      customFieldMaterialField("/fieldId", "Custom field", "entity", true),
      {
        kind: "array_item",
        containerPath: "/value",
        itemPath: "/item",
        labelTemplate: "Value {index}",
        maxItems: CUSTOM_FIELD_VALUE_ARRAY_MAX,
        formatterId: "text",
        formatterVersion: 1,
        requiredInPreview: false,
      },
    ],
  }),
  clockify_custom_fields_set_value_entry: customFieldApiMetadata({
    actionName: "clockify_custom_fields_set_value_entry",
    operationId: "updateTimeEntry",
    method: "PUT",
    path: "/workspaces/{workspaceId}/time-entries/{id}",
    access: "write",
    primary: customFieldEndpoint.entryUpdate,
    support: [customFieldEndpoint.entryRead, customFieldEndpoint.list],
    materialFields: [
      customFieldMaterialField("/entryId", "Time entry", "entity", true),
      customFieldMaterialField("/fieldId", "Custom field", "entity", true),
      {
        kind: "array_item",
        containerPath: "/value",
        itemPath: "/item",
        labelTemplate: "Value {index}",
        maxItems: CUSTOM_FIELD_VALUE_ARRAY_MAX,
        formatterId: "text",
        formatterVersion: 1,
        requiredInPreview: false,
      },
    ],
  }),
});

const createContract = durableMutationContract({ source: "confirmed", targeting: { mode: "create_no_target" }, strategies: ["create"] });
const targetContract = (relations: ["target" | "parent", ...Array<"target" | "parent">], strategy: "update") =>
  durableMutationContract({ source: "confirmed", targeting: { mode: "snapshots", relations }, strategies: [strategy] });

const create = defineRiskyAction({
  name: "clockify_custom_fields_create",
  ...CUSTOM_FIELD_WRITE_API_METADATA.clockify_custom_fields_create,
  description:
    "Create a custom field (TXT/NUMBER/DROPDOWN_SINGLE/DROPDOWN_MULTIPLE/CHECKBOX/LINK). NOTE: Clockify blocks custom-field CREATION for add-ons — inside the embedded add-on this returns an honest restriction notice. Dropdown allowedValues are capped. Elevated write — previews and requires confirmation.",
  group: CF,
  risks: ["high_risk_write"],
  mutationWorkflow: "durable",
  mutationContract: createContract,
  semanticLiteralAliases: CUSTOM_FIELD_REQUIRED_LITERAL_ALIASES,
  schema: boundedCustomFieldCreateSchema,
  preview: (ctx, args) => previewBoundedCustomFieldCreate(ctx, args),
  commit: (ctx, payload, operation) => commitBoundedCustomFieldCreate(ctx, payload, operation, "clockify_custom_fields_create"),
});

const update = defineRiskyAction({
  name: "clockify_custom_fields_update",
  ...CUSTOM_FIELD_WRITE_API_METADATA.clockify_custom_fields_update,
  description:
    "Update a custom field (name/type/allowedValues/required/status). allowedValues are capped. Elevated write — previews and requires confirmation.",
  group: CF,
  risks: ["high_risk_write"],
  mutationWorkflow: "durable",
  mutationContract: targetContract(["target"], "update"),
  semanticLiteralAliases: CUSTOM_FIELD_REQUIRED_LITERAL_ALIASES,
  schema: boundedCustomFieldUpdateSchema,
  preview: (ctx, args) => previewBoundedCustomFieldUpdate(ctx, args),
  commit: (ctx, payload, operation) => commitBoundedCustomFieldUpdate(ctx, payload, operation, "clockify_custom_fields_update"),
});

const setValueProject = defineRiskyAction({
  name: "clockify_custom_fields_set_value_project",
  ...CUSTOM_FIELD_WRITE_API_METADATA.clockify_custom_fields_set_value_project,
  description:
    "Set a custom field value on a project. Multi-select values are capped. Elevated write — previews and requires confirmation.",
  group: CF,
  risks: ["high_risk_write"],
  mutationWorkflow: "durable",
  mutationContract: targetContract(["target", "parent"], "update"),
  schema: boundedCustomFieldSetValueProjectSchema,
  preview: (ctx, args) => previewBoundedCustomFieldSetValueProject(ctx, args),
  commit: (ctx, payload, operation) => commitBoundedCustomFieldSetValueProject(ctx, payload, operation, "clockify_custom_fields_set_value_project"),
});

const setValueEntry = defineRiskyAction({
  name: "clockify_custom_fields_set_value_entry",
  ...CUSTOM_FIELD_WRITE_API_METADATA.clockify_custom_fields_set_value_entry,
  description:
    "Set a custom field value on a time entry. Multi-select values are capped. Elevated write — previews and requires confirmation.",
  group: CF,
  risks: ["high_risk_write"],
  mutationWorkflow: "durable",
  mutationContract: targetContract(["target", "parent"], "update"),
  schema: boundedCustomFieldSetValueEntrySchema,
  preview: (ctx, args) => previewBoundedCustomFieldSetValueEntry(ctx, args),
  commit: (ctx, payload, operation) => commitBoundedCustomFieldSetValueEntry(ctx, payload, operation, "clockify_custom_fields_set_value_entry"),
});

export const CUSTOM_FIELD_API_ACTIONS: ActionDefinition[] = [
  create,
  update,
  setValueProject,
  setValueEntry,
];
