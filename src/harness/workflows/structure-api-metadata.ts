import type {
  ApiAccess,
  ApiActionMetadataCarrier,
  ApiMethod,
  AvailabilityByAuthClass,
  MaterialFieldMetadata,
} from "../api-operation.js";
import { GROUP_MEMBER_BATCH_MAX } from "../safety-limits.js";

type StructureActionName =
  | "clockify_projects_list"
  | "clockify_projects_get"
  | "clockify_projects_create"
  | "clockify_projects_from_template"
  | "clockify_projects_update"
  | "clockify_projects_archive"
  | "clockify_projects_delete"
  | "clockify_projects_delete_archived"
  | "clockify_projects_rate_update"
  | "clockify_projects_member_hourly_rate_update"
  | "clockify_projects_member_cost_rate_update"
  | "clockify_projects_estimate_update"
  | "clockify_projects_memberships_update"
  | "clockify_projects_memberships_replace"
  | "clockify_tasks_list"
  | "clockify_tasks_get"
  | "clockify_tasks_create"
  | "clockify_tasks_update"
  | "clockify_tasks_delete"
  | "clockify_tasks_rate_update"
  | "clockify_tasks_delete_completed"
  | "clockify_tasks_status_update"
  | "clockify_tasks_assignees_replace"
  | "clockify_tasks_hourly_rate_update"
  | "clockify_tasks_cost_rate_update"
  | "clockify_clients_list"
  | "clockify_clients_get"
  | "clockify_clients_create"
  | "clockify_clients_create_base"
  | "clockify_clients_update"
  | "clockify_clients_archive"
  | "clockify_clients_delete"
  | "clockify_clients_delete_archived"
  | "clockify_tags_list"
  | "clockify_tags_get"
  | "clockify_tags_create"
  | "clockify_tags_update"
  | "clockify_tags_delete"
  | "clockify_create_work_package"
  | "clockify_list_entities"
  | "clockify_get_entity"
  | "clockify_setup_project"
  | "clockify_setup_task";

const AVAILABLE_TO_BOTH_AUTH_CLASSES: AvailabilityByAuthClass = Object.freeze({
  addon: Object.freeze({ available: true }),
  api_key: Object.freeze({ available: true }),
});

const API_KEY_ONLY: AvailabilityByAuthClass = Object.freeze({
  addon: Object.freeze({ available: false, reason: "unsupported_auth_class" }),
  api_key: Object.freeze({ available: true }),
});

function endpointKey(
  access: ApiAccess,
  method: ApiMethod,
  path: string,
  sourceModule: string,
): string {
  return [access, "api", method, path, sourceModule].join("\0");
}

function valueField(
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

function apiMetadata(input: {
  actionName: StructureActionName;
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

function internalMetadata(input: {
  exposure: "composite" | "generic";
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

const endpoint = Object.freeze({
  projects: Object.freeze({
    list: endpointKey("read", "GET", "/workspaces/{workspaceId}/projects", "projects.ts"),
    get: endpointKey("read", "GET", "/workspaces/{workspaceId}/projects/{id}", "projects.ts"),
    membershipState: endpointKey("read", "GET", "/workspaces/{workspaceId}/projects/{projectId}", "projects.ts"),
    create: endpointKey("write", "POST", "/workspaces/{workspaceId}/projects", "projects.ts"),
    fromTemplate: endpointKey("write", "POST", "/workspaces/{workspaceId}/projects/from-template", "projects.ts"),
    update: endpointKey("write", "PUT", "/workspaces/{workspaceId}/projects/{id}", "projects.ts"),
    delete: endpointKey("write", "DELETE", "/workspaces/{workspaceId}/projects/{projectId}", "projects.ts"),
    rate: endpointKey("write", "PUT", "/workspaces/{workspaceId}/projects/{projectId}/users/{userId}/{kind}", "projects.ts"),
    hourlyRate: endpointKey("write", "PUT", "/workspaces/{workspaceId}/projects/{projectId}/users/{userId}/hourly-rate", "projects.ts"),
    costRate: endpointKey("write", "PUT", "/workspaces/{workspaceId}/projects/{projectId}/users/{userId}/cost-rate", "projects.ts"),
    estimate: endpointKey("write", "PATCH", "/workspaces/{workspaceId}/projects/{id}/estimate", "projects.ts"),
    memberships: endpointKey("write", "PATCH", "/workspaces/{workspaceId}/projects/{id}/memberships", "projects.ts"),
  }),
  tasks: Object.freeze({
    list: endpointKey("read", "GET", "/workspaces/{workspaceId}/projects/{projectId}/tasks", "tasks.ts"),
    get: endpointKey("read", "GET", "/workspaces/{workspaceId}/projects/{projectId}/tasks/{id}", "tasks.ts"),
    create: endpointKey("write", "POST", "/workspaces/{workspaceId}/projects/{projectId}/tasks", "tasks.ts"),
    update: endpointKey("write", "PUT", "/workspaces/{workspaceId}/projects/{projectId}/tasks/{id}", "tasks.ts"),
    delete: endpointKey("write", "DELETE", "/workspaces/{workspaceId}/projects/{projectId}/tasks/{id}", "tasks.ts"),
    hourlyRate: endpointKey("write", "PUT", "/workspaces/{workspaceId}/projects/{projectId}/tasks/{taskId}/hourly-rate", "tasks.ts"),
    costRate: endpointKey("write", "PUT", "/workspaces/{workspaceId}/projects/{projectId}/tasks/{taskId}/cost-rate", "tasks.ts"),
    rate: endpointKey("write", "PUT", "/workspaces/{workspaceId}/projects/{projectId}/tasks/{taskId}/{kind}", "tasks.ts"),
  }),
  clients: Object.freeze({
    list: endpointKey("read", "GET", "/workspaces/{workspaceId}/clients", "clients.ts"),
    get: endpointKey("read", "GET", "/workspaces/{workspaceId}/clients/{id}", "clients.ts"),
    currencies: endpointKey("read", "GET", "/workspaces/{workspaceId}", "clients.ts"),
    create: endpointKey("write", "POST", "/workspaces/{workspaceId}/clients", "clients.ts"),
    update: endpointKey("write", "PUT", "/workspaces/{workspaceId}/clients/{id}", "clients.ts"),
    delete: endpointKey("write", "DELETE", "/workspaces/{workspaceId}/clients/{id}", "clients.ts"),
  }),
  tags: Object.freeze({
    list: endpointKey("read", "GET", "/workspaces/{workspaceId}/tags", "tags.ts"),
    get: endpointKey("read", "GET", "/workspaces/{workspaceId}/tags/{id}", "tags.ts"),
    create: endpointKey("write", "POST", "/workspaces/{workspaceId}/tags", "tags.ts"),
    update: endpointKey("write", "PUT", "/workspaces/{workspaceId}/tags/{id}", "tags.ts"),
    delete: endpointKey("write", "DELETE", "/workspaces/{workspaceId}/tags/{id}", "tags.ts"),
  }),
  templates: Object.freeze({
    list: endpointKey("read", "GET", "/workspaces/{workspaceId}/projects", "workspace.ts"),
  }),
  users: Object.freeze({
    list: endpointKey("read", "GET", "/workspaces/{workspaceId}/users", "users.ts"),
  }),
  expenses: Object.freeze({
    list: endpointKey("read", "GET", "/workspaces/{workspaceId}/expenses", "expenses.ts"),
    get: endpointKey("read", "GET", "/workspaces/{workspaceId}/expenses/{id}", "expenses.ts"),
  }),
  webhooks: Object.freeze({
    list: endpointKey("read", "GET", "/workspaces/{workspaceId}/webhooks", "webhooks.ts"),
    get: endpointKey("read", "GET", "/workspaces/{workspaceId}/webhooks/{id}", "webhooks.ts"),
  }),
  timeEntries: Object.freeze({
    running: endpointKey("read", "GET", "/workspaces/{workspaceId}/user/{userId}/time-entries", "time-entries.ts"),
    create: endpointKey("write", "POST", "/workspaces/{workspaceId}/time-entries", "time-entries.ts"),
  }),
});

export const STRUCTURE_API_METADATA = Object.freeze({
  clockify_projects_list: apiMetadata({
    actionName: "clockify_projects_list",
    operationId: "getProjects",
    method: "GET",
    path: "/workspaces/{workspaceId}/projects",
    access: "read",
    primary: endpoint.projects.list,
    support: [],
    materialFields: [],
  }),
  clockify_projects_get: apiMetadata({
    actionName: "clockify_projects_get",
    operationId: "getProject",
    method: "GET",
    path: "/workspaces/{workspaceId}/projects/{id}",
    access: "read",
    primary: endpoint.projects.get,
    support: [endpoint.projects.list],
    materialFields: [],
  }),
  clockify_projects_create: apiMetadata({
    actionName: "clockify_projects_create",
    operationId: "createNewProject",
    method: "POST",
    path: "/workspaces/{workspaceId}/projects",
    access: "write",
    primary: endpoint.projects.create,
    support: [endpoint.clients.list, endpoint.clients.get, endpoint.projects.list],
    materialFields: [
      valueField("/body/name", "Project name", "text", true),
      valueField("/body/clientId", "Client", "entity", false),
      valueField("/body/billable", "Billable", "boolean", false),
      valueField("/body/color", "Color", "text", false),
      valueField("/body/isPublic", "Public", "boolean", false),
      valueField("/body/hourlyRate/amount", "Default hourly rate", "money-minor", false),
      valueField("/body/costRate/amount", "Default cost rate", "money-minor", false),
    ],
  }),
  clockify_projects_from_template: apiMetadata({
    actionName: "clockify_projects_from_template",
    operationId: "createProjectFromTemplate",
    method: "POST",
    path: "/workspaces/{workspaceId}/projects/from-template",
    access: "write",
    primary: endpoint.projects.fromTemplate,
    support: [endpoint.templates.list, endpoint.projects.get, endpoint.projects.list],
    materialFields: [
      valueField("/body/templateProjectId", "Project template", "entity", true),
      valueField("/body/name", "Project name", "text", true),
    ],
  }),
  clockify_projects_update: apiMetadata({
    actionName: "clockify_projects_update",
    operationId: "updateProject",
    method: "PUT",
    path: "/workspaces/{workspaceId}/projects/{id}",
    access: "write",
    primary: endpoint.projects.update,
    support: [endpoint.projects.list, endpoint.projects.get, endpoint.clients.list, endpoint.clients.get],
    materialFields: [
      valueField("/id", "Project", "entity", true),
      valueField("/patch/name", "Project name", "text", false),
      valueField("/patch/clientId", "Client", "entity", false),
      valueField("/patch/billable", "Billable", "boolean", false),
      valueField("/patch/color", "Color", "text", false),
      valueField("/patch/isPublic", "Public", "boolean", false),
      valueField("/patch/archived", "Archived", "boolean", false),
      valueField("/patch/hourlyRate/amount", "Default hourly rate", "money-minor", false),
      valueField("/patch/costRate/amount", "Default cost rate", "money-minor", false),
    ],
  }),
  clockify_projects_archive: apiMetadata({
    actionName: "clockify_projects_archive",
    operationId: "updateProject",
    method: "PUT",
    path: "/workspaces/{workspaceId}/projects/{id}",
    access: "write",
    primary: endpoint.projects.update,
    support: [endpoint.projects.list, endpoint.projects.get],
    materialFields: [
      valueField("/id", "Project", "entity", true),
      valueField("/name", "Project name", "text", false),
      valueField("/body/archived", "Archived", "boolean", true),
    ],
  }),
  clockify_projects_delete: internalMetadata({
    exposure: "composite",
    reason: "Archives an active project before deletion and may compensate with a restore PUT, so one invocation can contain two primary mutations.",
    primary: [endpoint.projects.update, endpoint.projects.delete],
    support: [endpoint.projects.list, endpoint.projects.get],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
  clockify_projects_delete_archived: apiMetadata({
    actionName: "clockify_projects_delete_archived",
    operationId: "deleteProject",
    method: "DELETE",
    path: "/workspaces/{workspaceId}/projects/{projectId}",
    access: "write",
    primary: endpoint.projects.delete,
    support: [endpoint.projects.list, endpoint.projects.get],
    materialFields: [
      valueField("/id", "Project", "entity", true),
      valueField("/name", "Project name", "text", false),
    ],
  }),
  clockify_projects_rate_update: internalMetadata({
    exposure: "generic",
    reason: "Selects the hourly-rate or cost-rate endpoint from rateKind; Task 6 must split the dynamic mutation path.",
    primary: [endpoint.projects.rate],
    support: [endpoint.projects.list, endpoint.projects.get, endpoint.projects.membershipState, endpoint.users.list],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
  clockify_projects_member_hourly_rate_update: apiMetadata({
    actionName: "clockify_projects_member_hourly_rate_update",
    operationId: "addUsersHourlyRate",
    method: "PUT",
    path: "/workspaces/{workspaceId}/projects/{projectId}/users/{userId}/hourly-rate",
    access: "write",
    primary: endpoint.projects.hourlyRate,
    support: [endpoint.projects.list, endpoint.projects.get, endpoint.projects.membershipState, endpoint.users.list],
    materialFields: [
      valueField("/projectId", "Project", "entity", true),
      valueField("/userId", "Member", "entity", true),
      valueField("/amountMinor", "Hourly rate", "money-minor", true),
    ],
  }),
  clockify_projects_member_cost_rate_update: apiMetadata({
    actionName: "clockify_projects_member_cost_rate_update",
    operationId: "addUsersCostRate",
    method: "PUT",
    path: "/workspaces/{workspaceId}/projects/{projectId}/users/{userId}/cost-rate",
    access: "write",
    primary: endpoint.projects.costRate,
    support: [endpoint.projects.list, endpoint.projects.get, endpoint.projects.membershipState, endpoint.users.list],
    materialFields: [
      valueField("/projectId", "Project", "entity", true),
      valueField("/userId", "Member", "entity", true),
      valueField("/amountMinor", "Cost rate", "money-minor", true),
    ],
  }),
  clockify_projects_estimate_update: apiMetadata({
    actionName: "clockify_projects_estimate_update",
    operationId: "updateEstimate",
    method: "PATCH",
    path: "/workspaces/{workspaceId}/projects/{id}/estimate",
    access: "write",
    primary: endpoint.projects.estimate,
    support: [endpoint.projects.get],
    materialFields: [
      valueField("/id", "Project", "entity", true),
      valueField("/fields/timeEstimate/estimate", "Time estimate", "text", false),
      valueField("/fields/budgetEstimate/estimate", "Budget estimate", "number", false),
      valueField("/fields/estimateReset/active", "Estimate reset active", "boolean", false),
    ],
  }),
  clockify_projects_memberships_update: internalMetadata({
    exposure: "generic",
    reason: "Accepts open membership rows and unbounded add/replace arrays; Task 6 must split and bound the membership operations.",
    primary: [endpoint.projects.memberships],
    support: [endpoint.projects.list, endpoint.projects.get, endpoint.projects.membershipState],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
  clockify_projects_memberships_replace: apiMetadata({
    actionName: "clockify_projects_memberships_replace",
    operationId: "updateMemberships",
    method: "PATCH",
    path: "/workspaces/{workspaceId}/projects/{id}/memberships",
    access: "write",
    primary: endpoint.projects.memberships,
    support: [endpoint.projects.list, endpoint.projects.get, endpoint.projects.membershipState],
    materialFields: [
      valueField("/id", "Project", "entity", true),
      {
        kind: "array_item",
        containerPath: "/memberships",
        itemPath: "/userId",
        labelTemplate: "Member {index}",
        maxItems: GROUP_MEMBER_BATCH_MAX,
        formatterId: "entity",
        formatterVersion: 1,
        requiredInPreview: true,
      },
    ],
  }),
  clockify_tasks_list: apiMetadata({
    actionName: "clockify_tasks_list",
    operationId: "getTasks",
    method: "GET",
    path: "/workspaces/{workspaceId}/projects/{projectId}/tasks",
    access: "read",
    primary: endpoint.tasks.list,
    support: [],
    materialFields: [],
  }),
  clockify_tasks_get: apiMetadata({
    actionName: "clockify_tasks_get",
    operationId: "getTask",
    method: "GET",
    path: "/workspaces/{workspaceId}/projects/{projectId}/tasks/{id}",
    access: "read",
    primary: endpoint.tasks.get,
    support: [endpoint.projects.list, endpoint.tasks.list],
    materialFields: [],
  }),
  clockify_tasks_create: apiMetadata({
    actionName: "clockify_tasks_create",
    operationId: "createTask",
    method: "POST",
    path: "/workspaces/{workspaceId}/projects/{projectId}/tasks",
    access: "write",
    primary: endpoint.tasks.create,
    support: [endpoint.projects.get, endpoint.users.list, endpoint.tasks.list],
    materialFields: [
      valueField("/projectId", "Project", "entity", true),
      valueField("/name", "Task name", "text", true),
      {
        kind: "array_item",
        containerPath: "/assigneeIds",
        itemPath: "/userId",
        labelTemplate: "Assignee {index}",
        maxItems: GROUP_MEMBER_BATCH_MAX,
        formatterId: "entity",
        formatterVersion: 1,
        requiredInPreview: false,
      },
    ],
  }),
  clockify_tasks_update: apiMetadata({
    actionName: "clockify_tasks_update",
    operationId: "updateTask",
    method: "PUT",
    path: "/workspaces/{workspaceId}/projects/{projectId}/tasks/{id}",
    access: "write",
    primary: endpoint.tasks.update,
    support: [endpoint.projects.list, endpoint.projects.get, endpoint.tasks.list, endpoint.tasks.get],
    materialFields: [
      valueField("/projectId", "Project", "entity", true),
      valueField("/id", "Task", "entity", true),
      valueField("/patch/name", "Task name", "text", false),
      valueField("/patch/estimate", "Time estimate", "text", false),
      valueField("/patch/budgetEstimate", "Budget estimate", "number", false),
      valueField("/patch/billable", "Billable", "boolean", false),
    ],
  }),
  clockify_tasks_delete: internalMetadata({
    exposure: "composite",
    reason: "Marks a non-DONE task DONE before deletion and may compensate by restoring status, so one invocation can contain two primary mutations.",
    primary: [endpoint.tasks.update, endpoint.tasks.delete],
    support: [endpoint.projects.list, endpoint.projects.get, endpoint.tasks.list, endpoint.tasks.get],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
  clockify_tasks_rate_update: internalMetadata({
    exposure: "generic",
    reason: "Selects the hourly-rate or cost-rate endpoint from rateKind; Task 6 must split the dynamic mutation path.",
    primary: [endpoint.tasks.rate],
    support: [endpoint.projects.list, endpoint.projects.get, endpoint.tasks.list, endpoint.tasks.get],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
  clockify_tasks_delete_completed: apiMetadata({
    actionName: "clockify_tasks_delete_completed",
    operationId: "deleteTask",
    method: "DELETE",
    path: "/workspaces/{workspaceId}/projects/{projectId}/tasks/{id}",
    access: "write",
    primary: endpoint.tasks.delete,
    support: [endpoint.projects.list, endpoint.projects.get, endpoint.tasks.list, endpoint.tasks.get],
    materialFields: [
      valueField("/projectId", "Project", "entity", true),
      valueField("/id", "Task", "entity", true),
      valueField("/name", "Task name", "text", false),
    ],
  }),
  clockify_tasks_status_update: apiMetadata({
    actionName: "clockify_tasks_status_update",
    operationId: "updateTask",
    method: "PUT",
    path: "/workspaces/{workspaceId}/projects/{projectId}/tasks/{id}",
    access: "write",
    primary: endpoint.tasks.update,
    support: [endpoint.projects.list, endpoint.projects.get, endpoint.tasks.list, endpoint.tasks.get],
    materialFields: [
      valueField("/projectId", "Project", "entity", true),
      valueField("/id", "Task", "entity", true),
      valueField("/status", "Status", "text", true),
    ],
  }),
  clockify_tasks_assignees_replace: apiMetadata({
    actionName: "clockify_tasks_assignees_replace",
    operationId: "updateTask",
    method: "PUT",
    path: "/workspaces/{workspaceId}/projects/{projectId}/tasks/{id}",
    access: "write",
    primary: endpoint.tasks.update,
    support: [endpoint.projects.list, endpoint.projects.get, endpoint.tasks.list, endpoint.tasks.get, endpoint.users.list],
    materialFields: [
      valueField("/projectId", "Project", "entity", true),
      valueField("/id", "Task", "entity", true),
      {
        kind: "array_item",
        containerPath: "/assigneeIds",
        itemPath: "/userId",
        labelTemplate: "Assignee {index}",
        maxItems: GROUP_MEMBER_BATCH_MAX,
        formatterId: "entity",
        formatterVersion: 1,
        requiredInPreview: true,
      },
    ],
  }),
  clockify_tasks_hourly_rate_update: apiMetadata({
    actionName: "clockify_tasks_hourly_rate_update",
    operationId: "setTaskHourlyRate",
    method: "PUT",
    path: "/workspaces/{workspaceId}/projects/{projectId}/tasks/{taskId}/hourly-rate",
    access: "write",
    primary: endpoint.tasks.hourlyRate,
    support: [endpoint.projects.list, endpoint.projects.get, endpoint.tasks.list, endpoint.tasks.get],
    materialFields: [
      valueField("/projectId", "Project", "entity", true),
      valueField("/taskId", "Task", "entity", true),
      valueField("/amountMinor", "Hourly rate", "money-minor", true),
    ],
  }),
  clockify_tasks_cost_rate_update: apiMetadata({
    actionName: "clockify_tasks_cost_rate_update",
    operationId: "setTaskCostRate",
    method: "PUT",
    path: "/workspaces/{workspaceId}/projects/{projectId}/tasks/{taskId}/cost-rate",
    access: "write",
    primary: endpoint.tasks.costRate,
    support: [endpoint.projects.list, endpoint.projects.get, endpoint.tasks.list, endpoint.tasks.get],
    materialFields: [
      valueField("/projectId", "Project", "entity", true),
      valueField("/taskId", "Task", "entity", true),
      valueField("/amountMinor", "Cost rate", "money-minor", true),
    ],
  }),
  clockify_clients_list: apiMetadata({
    actionName: "clockify_clients_list",
    operationId: "getClients",
    method: "GET",
    path: "/workspaces/{workspaceId}/clients",
    access: "read",
    primary: endpoint.clients.list,
    support: [],
    materialFields: [],
  }),
  clockify_clients_get: apiMetadata({
    actionName: "clockify_clients_get",
    operationId: "getClient",
    method: "GET",
    path: "/workspaces/{workspaceId}/clients/{id}",
    access: "read",
    primary: endpoint.clients.get,
    support: [endpoint.clients.list],
    materialFields: [],
  }),
  clockify_clients_create: internalMetadata({
    exposure: "composite",
    reason: "May dispatch a create POST followed by an enrichment PUT, so the current action can contain two primary mutations; Task 6 must split them.",
    primary: [endpoint.clients.create, endpoint.clients.update],
    support: [endpoint.clients.currencies, endpoint.clients.list, endpoint.clients.get],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
  clockify_clients_create_base: apiMetadata({
    actionName: "clockify_clients_create_base",
    operationId: "createClient",
    method: "POST",
    path: "/workspaces/{workspaceId}/clients",
    access: "write",
    primary: endpoint.clients.create,
    support: [endpoint.clients.list],
    materialFields: [
      valueField("/body/name", "Client name", "text", true),
    ],
  }),
  clockify_clients_update: apiMetadata({
    actionName: "clockify_clients_update",
    operationId: "updateClient",
    method: "PUT",
    path: "/workspaces/{workspaceId}/clients/{id}",
    access: "write",
    primary: endpoint.clients.update,
    support: [endpoint.clients.list, endpoint.clients.get, endpoint.clients.currencies],
    materialFields: [
      valueField("/id", "Client", "entity", true),
      valueField("/patch/name", "Client name", "text", false),
      valueField("/patch/archived", "Archived", "boolean", false),
      valueField("/patch/ccEmails", "Billing CC emails", "text", false),
      valueField("/patch/currencyId", "Currency", "entity", false),
    ],
  }),
  clockify_clients_archive: apiMetadata({
    actionName: "clockify_clients_archive",
    operationId: "updateClient",
    method: "PUT",
    path: "/workspaces/{workspaceId}/clients/{id}",
    access: "write",
    primary: endpoint.clients.update,
    support: [endpoint.clients.list, endpoint.clients.get],
    materialFields: [
      valueField("/id", "Client", "entity", true),
      valueField("/name", "Client name", "text", false),
      valueField("/body/archived", "Archived", "boolean", true),
    ],
  }),
  clockify_clients_delete: internalMetadata({
    exposure: "composite",
    reason: "Archives an active client before deletion and may compensate with a restore PUT, so one invocation can contain two primary mutations.",
    primary: [endpoint.clients.update, endpoint.clients.delete],
    support: [endpoint.clients.list, endpoint.clients.get],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
  clockify_clients_delete_archived: apiMetadata({
    actionName: "clockify_clients_delete_archived",
    operationId: "deleteClient",
    method: "DELETE",
    path: "/workspaces/{workspaceId}/clients/{id}",
    access: "write",
    primary: endpoint.clients.delete,
    support: [endpoint.clients.list, endpoint.clients.get],
    materialFields: [
      valueField("/id", "Client", "entity", true),
      valueField("/name", "Client name", "text", false),
    ],
  }),
  clockify_tags_list: apiMetadata({
    actionName: "clockify_tags_list",
    operationId: "getTags",
    method: "GET",
    path: "/workspaces/{workspaceId}/tags",
    access: "read",
    primary: endpoint.tags.list,
    support: [],
    materialFields: [],
  }),
  clockify_tags_get: apiMetadata({
    actionName: "clockify_tags_get",
    operationId: "getTag",
    method: "GET",
    path: "/workspaces/{workspaceId}/tags/{id}",
    access: "read",
    primary: endpoint.tags.get,
    support: [endpoint.tags.list],
    materialFields: [],
  }),
  clockify_tags_create: apiMetadata({
    actionName: "clockify_tags_create",
    operationId: "createNewTag",
    method: "POST",
    path: "/workspaces/{workspaceId}/tags",
    access: "write",
    primary: endpoint.tags.create,
    support: [endpoint.tags.list],
    materialFields: [valueField("/body/name", "Tag name", "text", true)],
  }),
  clockify_tags_update: apiMetadata({
    actionName: "clockify_tags_update",
    operationId: "updateTag",
    method: "PUT",
    path: "/workspaces/{workspaceId}/tags/{id}",
    access: "write",
    primary: endpoint.tags.update,
    support: [endpoint.tags.list, endpoint.tags.get],
    materialFields: [
      valueField("/id", "Tag", "entity", true),
      valueField("/patch/name", "Tag name", "text", false),
      valueField("/patch/archived", "Archived", "boolean", false),
    ],
  }),
  clockify_tags_delete: apiMetadata({
    actionName: "clockify_tags_delete",
    operationId: "deleteTag",
    method: "DELETE",
    path: "/workspaces/{workspaceId}/tags/{id}",
    access: "write",
    primary: endpoint.tags.delete,
    support: [endpoint.tags.list, endpoint.tags.get],
    materialFields: [
      valueField("/id", "Tag", "entity", true),
      valueField("/name", "Tag name", "text", false),
    ],
  }),
  clockify_create_work_package: internalMetadata({
    exposure: "composite",
    reason: "Conditionally creates up to four structure entities and starts a timer in one workflow, so it is not one atomic API operation.",
    primary: [
      endpoint.tags.create,
      endpoint.clients.create,
      endpoint.projects.create,
      endpoint.tasks.create,
      endpoint.timeEntries.create,
    ],
    support: [
      endpoint.tags.list,
      endpoint.tags.get,
      endpoint.clients.list,
      endpoint.clients.get,
      endpoint.projects.list,
      endpoint.projects.get,
      endpoint.tasks.list,
      endpoint.tasks.get,
      endpoint.timeEntries.running,
    ],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
  clockify_list_entities: internalMetadata({
    exposure: "generic",
    reason: "Selects unrelated list endpoints from entityType, including webhooks unavailable to add-on auth; Task 6 must split typed reads.",
    primary: [
      endpoint.tags.list,
      endpoint.projects.list,
      endpoint.clients.list,
      endpoint.tasks.list,
      endpoint.users.list,
      endpoint.expenses.list,
      endpoint.webhooks.list,
    ],
    support: [],
    availability: API_KEY_ONLY,
  }),
  clockify_get_entity: internalMetadata({
    exposure: "generic",
    reason: "Selects unrelated get endpoints from entityType, including webhooks unavailable to add-on auth; Task 6 must split typed reads.",
    primary: [
      endpoint.tags.get,
      endpoint.projects.get,
      endpoint.clients.get,
      endpoint.tasks.get,
      endpoint.users.list,
      endpoint.expenses.get,
      endpoint.webhooks.get,
    ],
    support: [],
    availability: API_KEY_ONLY,
  }),
  clockify_setup_project: internalMetadata({
    exposure: "composite",
    reason: "Creates a project, then may replace memberships and set multiple member rates; it is an intentionally multi-primary setup workflow.",
    primary: [endpoint.projects.create, endpoint.projects.memberships, endpoint.projects.rate],
    support: [
      endpoint.clients.list,
      endpoint.clients.get,
      endpoint.users.list,
      endpoint.projects.list,
      endpoint.projects.get,
      endpoint.projects.membershipState,
    ],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
  clockify_setup_task: internalMetadata({
    exposure: "composite",
    reason: "Creates a task and may set its rate in a second primary mutation; it is an intentionally multi-primary setup workflow.",
    primary: [endpoint.tasks.create, endpoint.tasks.rate],
    support: [
      endpoint.projects.list,
      endpoint.projects.get,
      endpoint.users.list,
      endpoint.tasks.list,
      endpoint.tasks.get,
    ],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
} satisfies Readonly<Record<StructureActionName, ApiActionMetadataCarrier>>);
