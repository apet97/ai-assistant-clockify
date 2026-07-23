import type {
  ApiAccess,
  ApiActionMetadataCarrier,
  ApiMethod,
  AvailabilityByAuthClass,
  MaterialFieldMetadata,
} from "../api-operation.js";
import { TIME_ENTRY_TAG_BATCH_MAX } from "../safety-limits.js";

export type EntryApiActionName =
  | "clockify_entries_list"
  | "clockify_entries_get"
  | "clockify_entries_create"
  | "clockify_entries_start"
  | "clockify_entries_update"
  | "clockify_entries_delete"
  | "clockify_entries_mark_invoiced";

export const TIME_ENTRY_AVAILABLE_TO_BOTH: AvailabilityByAuthClass = Object.freeze({
  addon: Object.freeze({ available: true }),
  api_key: Object.freeze({ available: true }),
});

const AVAILABLE_TO_BOTH_AUTH_CLASSES = TIME_ENTRY_AVAILABLE_TO_BOTH;

export function buildTimeEntryEndpointKey(
  access: ApiAccess,
  method: ApiMethod,
  path: string,
  sourceModule: string,
): string {
  return [access, "api", method, path, sourceModule].join("\0");
}

function endpointKey(
  access: ApiAccess,
  method: ApiMethod,
  path: string,
  sourceModule: string,
): string {
  return buildTimeEntryEndpointKey(access, method, path, sourceModule);
}

export function timeEntryValueField(
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

function valueField(
  path: string,
  label: string,
  formatterId: string,
  requiredInPreview: boolean,
): MaterialFieldMetadata {
  return timeEntryValueField(path, label, formatterId, requiredInPreview);
}

function tagArrayField(containerPath: string): MaterialFieldMetadata {
  return Object.freeze({
    kind: "array_item",
    containerPath,
    itemPath: "",
    labelTemplate: "Tag {index}",
    maxItems: TIME_ENTRY_TAG_BATCH_MAX,
    formatterId: "entity",
    formatterVersion: 1,
    requiredInPreview: false,
  });
}

export function buildTimeEntryApiMetadata(input: {
  actionName: string;
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
    availabilityByAuthClass: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    boundedArgumentDictionaries: Object.freeze([]),
    materialFields: Object.freeze([...input.materialFields]),
    presentation: Object.freeze({ presenterId: input.actionName, version: 1 }),
  });
}

export function buildTimeEntryInternalMetadata(input: {
  exposure: "composite" | "generic";
  reason: string;
  primary: readonly string[];
  support: readonly string[];
}): ApiActionMetadataCarrier {
  return Object.freeze({
    apiExposure: input.exposure,
    apiExposureReason: input.reason,
    adapterEndpoints: Object.freeze({
      primary: Object.freeze([...input.primary]),
      support: Object.freeze([...input.support]),
    }),
    availabilityByAuthClass: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    boundedArgumentDictionaries: Object.freeze([]),
  });
}

function apiMetadata(input: {
  actionName: EntryApiActionName;
  operationId: string;
  method: ApiMethod;
  path: string;
  access: ApiAccess;
  primary: string;
  support: readonly string[];
  materialFields: readonly MaterialFieldMetadata[];
}): ApiActionMetadataCarrier {
  return buildTimeEntryApiMetadata(input);
}

const endpoint = Object.freeze({
  timeEntries: Object.freeze({
    list: endpointKey("read", "GET", "/workspaces/{workspaceId}/user/{userId}/time-entries", "time-entries.ts"),
    get: endpointKey("read", "GET", "/workspaces/{workspaceId}/time-entries/{id}", "time-entries.ts"),
    create: endpointKey("write", "POST", "/workspaces/{workspaceId}/time-entries", "time-entries.ts"),
    stop: endpointKey("write", "PATCH", "/workspaces/{workspaceId}/user/{userId}/time-entries", "time-entries.ts"),
    update: endpointKey("write", "PUT", "/workspaces/{workspaceId}/time-entries/{id}", "time-entries.ts"),
    delete: endpointKey("write", "DELETE", "/workspaces/{workspaceId}/time-entries/{id}", "time-entries.ts"),
    invoiced: endpointKey("write", "PATCH", "/workspaces/{workspaceId}/time-entries/invoiced", "time-entries.ts"),
  }),
  projects: Object.freeze({
    list: endpointKey("read", "GET", "/workspaces/{workspaceId}/projects", "projects.ts"),
    get: endpointKey("read", "GET", "/workspaces/{workspaceId}/projects/{id}", "projects.ts"),
  }),
  tasks: Object.freeze({
    list: endpointKey("read", "GET", "/workspaces/{workspaceId}/projects/{projectId}/tasks", "tasks.ts"),
    get: endpointKey("read", "GET", "/workspaces/{workspaceId}/projects/{projectId}/tasks/{id}", "tasks.ts"),
  }),
  tags: Object.freeze({
    list: endpointKey("read", "GET", "/workspaces/{workspaceId}/tags", "tags.ts"),
  }),
  users: Object.freeze({
    list: endpointKey("read", "GET", "/workspaces/{workspaceId}/users", "users.ts"),
  }),
});

export const TIME_ENTRY_ADAPTER_ENDPOINTS = endpoint;

export const ENTRY_API_METADATA = Object.freeze({
  clockify_entries_list: apiMetadata({
    actionName: "clockify_entries_list",
    operationId: "getTimeEntries",
    method: "GET",
    path: "/workspaces/{workspaceId}/user/{userId}/time-entries",
    access: "read",
    primary: endpoint.timeEntries.list,
    support: [endpoint.users.list, endpoint.projects.list, endpoint.tasks.list],
    materialFields: [],
  }),
  clockify_entries_get: apiMetadata({
    actionName: "clockify_entries_get",
    operationId: "getTimeEntry",
    method: "GET",
    path: "/workspaces/{workspaceId}/time-entries/{id}",
    access: "read",
    primary: endpoint.timeEntries.get,
    support: [],
    materialFields: [],
  }),
  clockify_entries_create: apiMetadata({
    actionName: "clockify_entries_create",
    operationId: "createTimeEntry",
    method: "POST",
    path: "/workspaces/{workspaceId}/time-entries",
    access: "write",
    primary: endpoint.timeEntries.create,
    support: [
      endpoint.projects.list,
      endpoint.projects.get,
      endpoint.tasks.list,
      endpoint.tasks.get,
      endpoint.tags.list,
      endpoint.timeEntries.list,
    ],
    materialFields: [
      valueField("/start", "Start time", "text", true),
      valueField("/end", "End time", "text", false),
      valueField("/description", "Description", "text", false),
      valueField("/projectId", "Project", "entity", false),
      valueField("/taskId", "Task", "entity", false),
      valueField("/billable", "Billable", "boolean", false),
      tagArrayField("/tagIds"),
    ],
  }),
  clockify_entries_start: apiMetadata({
    actionName: "clockify_entries_start",
    operationId: "createTimeEntry",
    method: "POST",
    path: "/workspaces/{workspaceId}/time-entries",
    access: "write",
    primary: endpoint.timeEntries.create,
    support: [
      endpoint.projects.list,
      endpoint.projects.get,
      endpoint.tasks.list,
      endpoint.tasks.get,
      endpoint.tags.list,
      endpoint.timeEntries.list,
    ],
    materialFields: [
      valueField("/description", "Description", "text", false),
      valueField("/projectId", "Project", "entity", false),
      valueField("/taskId", "Task", "entity", false),
      valueField("/billable", "Billable", "boolean", false),
      tagArrayField("/tagIds"),
    ],
  }),
  clockify_entries_update: apiMetadata({
    actionName: "clockify_entries_update",
    operationId: "updateTimeEntry",
    method: "PUT",
    path: "/workspaces/{workspaceId}/time-entries/{id}",
    access: "write",
    primary: endpoint.timeEntries.update,
    support: [
      endpoint.timeEntries.get,
      endpoint.projects.list,
      endpoint.projects.get,
      endpoint.tasks.list,
      endpoint.tasks.get,
      endpoint.tags.list,
    ],
    materialFields: [
      valueField("/id", "Time entry", "entity", true),
      valueField("/description", "Description", "text", false),
      valueField("/projectId", "Project", "entity", false),
      valueField("/taskId", "Task", "entity", false),
      valueField("/billable", "Billable", "boolean", false),
      tagArrayField("/tagIds"),
    ],
  }),
  clockify_entries_delete: apiMetadata({
    actionName: "clockify_entries_delete",
    operationId: "deleteTimeEntry",
    method: "DELETE",
    path: "/workspaces/{workspaceId}/time-entries/{id}",
    access: "write",
    primary: endpoint.timeEntries.delete,
    support: [endpoint.timeEntries.get],
    materialFields: [
      valueField("/id", "Time entry", "entity", true),
      valueField("/description", "Description", "text", false),
    ],
  }),
  clockify_entries_mark_invoiced: buildTimeEntryInternalMetadata({
    exposure: "generic",
    reason: "The current batch maximum exceeds the 22-fact material presentation limit; Task 6 must narrow the invoiced-state operation.",
    primary: [endpoint.timeEntries.invoiced],
    support: [endpoint.timeEntries.get],
  }),
} satisfies Readonly<Record<EntryApiActionName, ApiActionMetadataCarrier>>);
