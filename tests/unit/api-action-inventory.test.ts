import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  adapterRequestShapeKey,
  extractAdapterEndpoints,
} from "../../scripts/lib/adapter-endpoints.js";
import type { ActionDefinition } from "../../src/harness/action.js";
import {
  ACTION_CATALOG,
  actionFingerprintForDefinition,
  getAction,
} from "../../src/harness/catalog.js";

type RegistryId = "v1-internal" | "v2-api" | "v2-local";

interface InventoryEntry {
  sourceSurface: RegistryId;
  definition: ActionDefinition;
}

interface RegistryModule {
  normalizeRegistryAction(definition: ActionDefinition, registryId: RegistryId): ActionDefinition;
  registryHashForActions(actions: readonly ActionDefinition[]): string;
  inventoryActionDefinitions(): readonly InventoryEntry[];
}

function isRegistryModule(value: unknown): value is RegistryModule {
  return typeof value === "object" && value !== null
    && "normalizeRegistryAction" in value && typeof value.normalizeRegistryAction === "function"
    && "registryHashForActions" in value && typeof value.registryHashForActions === "function"
    && "inventoryActionDefinitions" in value && typeof value.inventoryActionDefinitions === "function";
}

async function loadRegistryModule(): Promise<RegistryModule> {
  const sourceUrl = new URL("../../src/harness/action-registry.ts", import.meta.url);
  if (!existsSync(fileURLToPath(sourceUrl))) throw new Error("missing_action_registry_module");
  const loaded: unknown = await import(/* @vite-ignore */ sourceUrl.href);
  if (!isRegistryModule(loaded)) throw new Error("invalid_action_registry_module");
  return loaded;
}

interface AvailabilityDecision {
  available: boolean;
  reason?: "unsupported_auth_class" | "unavailable_endpoint" | "official_operation_id_missing";
}

interface TestApiMetadata {
  apiExposure?: "api" | "composite" | "generic" | "local";
  apiExposureReason?: string;
  apiOperation?: {
    operationId: string;
    host: "api" | "reports" | "audit";
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    access: "read" | "write";
    exposure: "api" | "composite" | "generic" | "local";
  };
  adapterEndpoints?: { primary: readonly string[]; support: readonly string[] };
  availabilityByAuthClass?: { addon: AvailabilityDecision; api_key: AvailabilityDecision };
  boundedArgumentDictionaries?: readonly {
    path: string;
    keyPattern: string;
    maxKeyUtf8Bytes: number;
    maxEntries: number;
    valueSchemaFingerprint: string;
  }[];
  materialFields?: readonly ({
    kind: "value";
    path: string;
    label: string;
    formatterId: string;
    formatterVersion: number;
    requiredInPreview: boolean;
  } | {
    kind: "array_item";
    containerPath: string;
    itemPath: string;
    labelTemplate: string;
    maxItems: number;
    formatterId: string;
    formatterVersion: number;
    requiredInPreview: boolean;
  } | {
    kind: "dictionary_entry";
    containerPath: string;
    valuePath: string;
    labelTemplate: string;
    maxEntries: number;
    formatterId: string;
    formatterVersion: number;
    requiredInPreview: boolean;
  })[];
  presentation?: { presenterId: string; version: number };
}

type TestApiOperation = NonNullable<TestApiMetadata["apiOperation"]>;

function fixtureAction(name: string): ActionDefinition {
  const definition = getAction(name);
  if (!definition) throw new Error(`missing fixture action: ${name}`);
  return definition;
}

const TAG_OPERATION = {
  operationId: "createTag",
  host: "api" as const,
  method: "POST" as const,
  path: "/workspaces/{workspaceId}/tags",
  access: "write" as const,
  exposure: "api" as const,
};

function endpointKey(
  operation: Pick<TestApiOperation, "access" | "host" | "method" | "path">,
  sourceModule = "tags.ts",
): string {
  return [operation.access, operation.host, operation.method, operation.path, sourceModule].join("\0");
}

const TAG_METADATA = {
  apiExposure: "api" as const,
  apiOperation: TAG_OPERATION,
  adapterEndpoints: { primary: [endpointKey(TAG_OPERATION)], support: [] },
  availabilityByAuthClass: {
    addon: { available: true },
    api_key: { available: true },
  },
  boundedArgumentDictionaries: [],
  materialFields: [{
    kind: "value" as const,
    path: "/body/name",
    label: "Name",
    formatterId: "text",
    formatterVersion: 1,
    requiredInPreview: true,
  }],
  presentation: { presenterId: "tag-write", version: 1 },
} satisfies TestApiMetadata;

type ExpectedAvailability = NonNullable<TestApiMetadata["availabilityByAuthClass"]>;
type ExpectedEndpoints = NonNullable<TestApiMetadata["adapterEndpoints"]>;
type ExpectedMaterialFields = NonNullable<TestApiMetadata["materialFields"]>;

type ExpectedActionAnnotation =
  | {
      name: string;
      exposure: "api";
      operation: TestApiOperation;
      endpoints: ExpectedEndpoints;
      availability: ExpectedAvailability;
      materialFields: ExpectedMaterialFields;
      presentation: NonNullable<TestApiMetadata["presentation"]>;
    }
  | {
      name: string;
      exposure: "composite" | "generic";
      reason: string;
      endpoints: ExpectedEndpoints;
      availability: ExpectedAvailability;
    };

const AVAILABLE_TO_BOTH_AUTH_CLASSES = {
  addon: { available: true },
  api_key: { available: true },
} satisfies ExpectedAvailability;

const API_KEY_ONLY = {
  addon: { available: false, reason: "unsupported_auth_class" },
  api_key: { available: true },
} satisfies ExpectedAvailability;

function structureEndpointKey(
  access: TestApiOperation["access"],
  method: TestApiOperation["method"],
  path: string,
  sourceModule: string,
): string {
  return [access, "api", method, path, sourceModule].join("\0");
}

const STRUCTURE_ENDPOINT = {
  projects: {
    list: structureEndpointKey("read", "GET", "/workspaces/{workspaceId}/projects", "projects.ts"),
    get: structureEndpointKey("read", "GET", "/workspaces/{workspaceId}/projects/{id}", "projects.ts"),
    create: structureEndpointKey("write", "POST", "/workspaces/{workspaceId}/projects", "projects.ts"),
    fromTemplate: structureEndpointKey("write", "POST", "/workspaces/{workspaceId}/projects/from-template", "projects.ts"),
    update: structureEndpointKey("write", "PUT", "/workspaces/{workspaceId}/projects/{id}", "projects.ts"),
    delete: structureEndpointKey("write", "DELETE", "/workspaces/{workspaceId}/projects/{id}", "projects.ts"),
    rate: structureEndpointKey("write", "PUT", "/workspaces/{workspaceId}/projects/{projectId}/users/{userId}/{kind}", "projects.ts"),
    estimate: structureEndpointKey("write", "PATCH", "/workspaces/{workspaceId}/projects/{id}/estimate", "projects.ts"),
    memberships: structureEndpointKey("write", "PATCH", "/workspaces/{workspaceId}/projects/{id}/memberships", "projects.ts"),
  },
  tasks: {
    list: structureEndpointKey("read", "GET", "/workspaces/{workspaceId}/projects/{projectId}/tasks", "tasks.ts"),
    get: structureEndpointKey("read", "GET", "/workspaces/{workspaceId}/projects/{projectId}/tasks/{id}", "tasks.ts"),
    create: structureEndpointKey("write", "POST", "/workspaces/{workspaceId}/projects/{projectId}/tasks", "tasks.ts"),
    update: structureEndpointKey("write", "PUT", "/workspaces/{workspaceId}/projects/{projectId}/tasks/{id}", "tasks.ts"),
    delete: structureEndpointKey("write", "DELETE", "/workspaces/{workspaceId}/projects/{projectId}/tasks/{id}", "tasks.ts"),
    rate: structureEndpointKey("write", "PUT", "/workspaces/{workspaceId}/projects/{projectId}/tasks/{taskId}/{kind}", "tasks.ts"),
  },
  clients: {
    list: structureEndpointKey("read", "GET", "/workspaces/{workspaceId}/clients", "clients.ts"),
    get: structureEndpointKey("read", "GET", "/workspaces/{workspaceId}/clients/{id}", "clients.ts"),
    currencies: structureEndpointKey("read", "GET", "/workspaces/{workspaceId}", "clients.ts"),
    create: structureEndpointKey("write", "POST", "/workspaces/{workspaceId}/clients", "clients.ts"),
    update: structureEndpointKey("write", "PUT", "/workspaces/{workspaceId}/clients/{id}", "clients.ts"),
    delete: structureEndpointKey("write", "DELETE", "/workspaces/{workspaceId}/clients/{id}", "clients.ts"),
  },
  tags: {
    list: structureEndpointKey("read", "GET", "/workspaces/{workspaceId}/tags", "tags.ts"),
    get: structureEndpointKey("read", "GET", "/workspaces/{workspaceId}/tags/{id}", "tags.ts"),
    create: structureEndpointKey("write", "POST", "/workspaces/{workspaceId}/tags", "tags.ts"),
    update: structureEndpointKey("write", "PUT", "/workspaces/{workspaceId}/tags/{id}", "tags.ts"),
    delete: structureEndpointKey("write", "DELETE", "/workspaces/{workspaceId}/tags/{id}", "tags.ts"),
  },
  templates: {
    list: structureEndpointKey("read", "GET", "/workspaces/{workspaceId}/projects", "workspace.ts"),
  },
  users: {
    list: structureEndpointKey("read", "GET", "/workspaces/{workspaceId}/users", "users.ts"),
  },
  expenses: {
    list: structureEndpointKey("read", "GET", "/workspaces/{workspaceId}/expenses", "expenses.ts"),
    get: structureEndpointKey("read", "GET", "/workspaces/{workspaceId}/expenses/{id}", "expenses.ts"),
  },
  webhooks: {
    list: structureEndpointKey("read", "GET", "/workspaces/{workspaceId}/webhooks", "webhooks.ts"),
    get: structureEndpointKey("read", "GET", "/workspaces/{workspaceId}/webhooks/{id}", "webhooks.ts"),
  },
  timeEntries: {
    running: structureEndpointKey("read", "GET", "/workspaces/{workspaceId}/user/{userId}/time-entries", "time-entries.ts"),
    create: structureEndpointKey("write", "POST", "/workspaces/{workspaceId}/time-entries", "time-entries.ts"),
    get: structureEndpointKey("read", "GET", "/workspaces/{workspaceId}/time-entries/{id}", "time-entries.ts"),
    stop: structureEndpointKey("write", "PATCH", "/workspaces/{workspaceId}/user/{userId}/time-entries", "time-entries.ts"),
    update: structureEndpointKey("write", "PUT", "/workspaces/{workspaceId}/time-entries/{id}", "time-entries.ts"),
    delete: structureEndpointKey("write", "DELETE", "/workspaces/{workspaceId}/time-entries/{id}", "time-entries.ts"),
    invoiced: structureEndpointKey("write", "PATCH", "/workspaces/{workspaceId}/time-entries/invoiced", "time-entries.ts"),
  },
} as const;

function materialField(
  path: string,
  label: string,
  formatterId: string,
  requiredInPreview: boolean,
): ExpectedMaterialFields[number] {
  return {
    kind: "value",
    path,
    label,
    formatterId,
    formatterVersion: 1,
    requiredInPreview,
  };
}

function apiAnnotation(input: {
  name: string;
  operationId: string;
  method: TestApiOperation["method"];
  path: string;
  access: TestApiOperation["access"];
  sourceModule: string;
  support: readonly string[];
  availability: ExpectedAvailability;
  materialFields: ExpectedMaterialFields;
}): ExpectedActionAnnotation {
  const operation: TestApiOperation = {
    operationId: input.operationId,
    host: "api",
    method: input.method,
    path: input.path,
    access: input.access,
    exposure: "api",
  };
  return {
    name: input.name,
    exposure: "api",
    operation,
    endpoints: {
      primary: [endpointKey(operation, input.sourceModule)],
      support: input.support,
    },
    availability: input.availability,
    materialFields: input.materialFields,
    presentation: { presenterId: input.name, version: 1 },
  };
}

function internalAnnotation(input: {
  name: string;
  exposure: "composite" | "generic";
  reason: string;
  primary: readonly string[];
  support: readonly string[];
  availability: ExpectedAvailability;
}): ExpectedActionAnnotation {
  return {
    name: input.name,
    exposure: input.exposure,
    reason: input.reason,
    endpoints: { primary: input.primary, support: input.support },
    availability: input.availability,
  };
}

const STRUCTURE_ANNOTATIONS: readonly ExpectedActionAnnotation[] = [
  apiAnnotation({
    name: "clockify_projects_list",
    operationId: "getProjects",
    method: "GET",
    path: "/workspaces/{workspaceId}/projects",
    access: "read",
    sourceModule: "projects.ts",
    support: [],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [],
  }),
  apiAnnotation({
    name: "clockify_projects_get",
    operationId: "getProject",
    method: "GET",
    path: "/workspaces/{workspaceId}/projects/{id}",
    access: "read",
    sourceModule: "projects.ts",
    support: [STRUCTURE_ENDPOINT.projects.list],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [],
  }),
  apiAnnotation({
    name: "clockify_projects_create",
    operationId: "createNewProject",
    method: "POST",
    path: "/workspaces/{workspaceId}/projects",
    access: "write",
    sourceModule: "projects.ts",
    support: [STRUCTURE_ENDPOINT.clients.list, STRUCTURE_ENDPOINT.clients.get, STRUCTURE_ENDPOINT.projects.list],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [
      materialField("/body/name", "Project name", "text", true),
      materialField("/body/clientId", "Client", "entity", false),
      materialField("/body/billable", "Billable", "boolean", false),
      materialField("/body/color", "Color", "text", false),
      materialField("/body/isPublic", "Public", "boolean", false),
      materialField("/body/hourlyRate/amount", "Default hourly rate", "money-minor", false),
      materialField("/body/costRate/amount", "Default cost rate", "money-minor", false),
    ],
  }),
  apiAnnotation({
    name: "clockify_projects_from_template",
    operationId: "createProjectFromTemplate",
    method: "POST",
    path: "/workspaces/{workspaceId}/projects/from-template",
    access: "write",
    sourceModule: "projects.ts",
    support: [STRUCTURE_ENDPOINT.templates.list, STRUCTURE_ENDPOINT.projects.get, STRUCTURE_ENDPOINT.projects.list],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [
      materialField("/body/templateProjectId", "Project template", "entity", true),
      materialField("/body/name", "Project name", "text", true),
    ],
  }),
  apiAnnotation({
    name: "clockify_projects_update",
    operationId: "updateProject",
    method: "PUT",
    path: "/workspaces/{workspaceId}/projects/{id}",
    access: "write",
    sourceModule: "projects.ts",
    support: [STRUCTURE_ENDPOINT.projects.list, STRUCTURE_ENDPOINT.projects.get, STRUCTURE_ENDPOINT.clients.list, STRUCTURE_ENDPOINT.clients.get],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [
      materialField("/id", "Project", "entity", true),
      materialField("/patch/name", "Project name", "text", false),
      materialField("/patch/clientId", "Client", "entity", false),
      materialField("/patch/billable", "Billable", "boolean", false),
      materialField("/patch/color", "Color", "text", false),
      materialField("/patch/isPublic", "Public", "boolean", false),
      materialField("/patch/archived", "Archived", "boolean", false),
      materialField("/patch/hourlyRate/amount", "Default hourly rate", "money-minor", false),
      materialField("/patch/costRate/amount", "Default cost rate", "money-minor", false),
    ],
  }),
  apiAnnotation({
    name: "clockify_projects_archive",
    operationId: "updateProject",
    method: "PUT",
    path: "/workspaces/{workspaceId}/projects/{id}",
    access: "write",
    sourceModule: "projects.ts",
    support: [STRUCTURE_ENDPOINT.projects.list, STRUCTURE_ENDPOINT.projects.get],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [
      materialField("/id", "Project", "entity", true),
      materialField("/name", "Project name", "text", false),
      materialField("/body/archived", "Archived", "boolean", true),
    ],
  }),
  internalAnnotation({
    name: "clockify_projects_delete",
    exposure: "composite",
    reason: "Archives an active project before deletion and may compensate with a restore PUT, so one invocation can contain two primary mutations.",
    primary: [STRUCTURE_ENDPOINT.projects.update, STRUCTURE_ENDPOINT.projects.delete],
    support: [STRUCTURE_ENDPOINT.projects.list, STRUCTURE_ENDPOINT.projects.get],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
  internalAnnotation({
    name: "clockify_projects_rate_update",
    exposure: "generic",
    reason: "Selects the hourly-rate or cost-rate endpoint from rateKind; Task 6 must split the dynamic mutation path.",
    primary: [STRUCTURE_ENDPOINT.projects.rate],
    support: [STRUCTURE_ENDPOINT.projects.list, STRUCTURE_ENDPOINT.projects.get, STRUCTURE_ENDPOINT.users.list],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
  internalAnnotation({
    name: "clockify_projects_estimate_update",
    exposure: "generic",
    reason: "Accepts an open fields dictionary; Task 6 must replace it with a closed operation schema.",
    primary: [STRUCTURE_ENDPOINT.projects.estimate],
    support: [STRUCTURE_ENDPOINT.projects.get],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
  internalAnnotation({
    name: "clockify_projects_memberships_update",
    exposure: "generic",
    reason: "Accepts open membership rows and unbounded add/replace arrays; Task 6 must split and bound the membership operations.",
    primary: [STRUCTURE_ENDPOINT.projects.memberships],
    support: [STRUCTURE_ENDPOINT.projects.list, STRUCTURE_ENDPOINT.projects.get],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
  apiAnnotation({
    name: "clockify_tasks_list",
    operationId: "getTasks",
    method: "GET",
    path: "/workspaces/{workspaceId}/projects/{projectId}/tasks",
    access: "read",
    sourceModule: "tasks.ts",
    support: [],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [],
  }),
  apiAnnotation({
    name: "clockify_tasks_get",
    operationId: "getTask",
    method: "GET",
    path: "/workspaces/{workspaceId}/projects/{projectId}/tasks/{id}",
    access: "read",
    sourceModule: "tasks.ts",
    support: [STRUCTURE_ENDPOINT.projects.list, STRUCTURE_ENDPOINT.tasks.list],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [],
  }),
  internalAnnotation({
    name: "clockify_tasks_create",
    exposure: "generic",
    reason: "The assigneeIds array is unbounded, so leaf-level material expansion cannot be statically bounded; Task 6 must narrow the schema.",
    primary: [STRUCTURE_ENDPOINT.tasks.create],
    support: [STRUCTURE_ENDPOINT.projects.get, STRUCTURE_ENDPOINT.users.list, STRUCTURE_ENDPOINT.tasks.list],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
  internalAnnotation({
    name: "clockify_tasks_update",
    exposure: "generic",
    reason: "Accepts an open fields dictionary and an unbounded assigneeIds array; Task 6 must split and narrow the update schema.",
    primary: [STRUCTURE_ENDPOINT.tasks.update],
    support: [STRUCTURE_ENDPOINT.projects.list, STRUCTURE_ENDPOINT.projects.get, STRUCTURE_ENDPOINT.tasks.list, STRUCTURE_ENDPOINT.tasks.get, STRUCTURE_ENDPOINT.users.list],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
  internalAnnotation({
    name: "clockify_tasks_delete",
    exposure: "composite",
    reason: "Marks a non-DONE task DONE before deletion and may compensate by restoring status, so one invocation can contain two primary mutations.",
    primary: [STRUCTURE_ENDPOINT.tasks.update, STRUCTURE_ENDPOINT.tasks.delete],
    support: [STRUCTURE_ENDPOINT.projects.list, STRUCTURE_ENDPOINT.projects.get, STRUCTURE_ENDPOINT.tasks.list, STRUCTURE_ENDPOINT.tasks.get],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
  internalAnnotation({
    name: "clockify_tasks_rate_update",
    exposure: "generic",
    reason: "Selects the hourly-rate or cost-rate endpoint from rateKind; Task 6 must split the dynamic mutation path.",
    primary: [STRUCTURE_ENDPOINT.tasks.rate],
    support: [STRUCTURE_ENDPOINT.projects.list, STRUCTURE_ENDPOINT.projects.get, STRUCTURE_ENDPOINT.tasks.list, STRUCTURE_ENDPOINT.tasks.get],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
  apiAnnotation({
    name: "clockify_clients_list",
    operationId: "getClients",
    method: "GET",
    path: "/workspaces/{workspaceId}/clients",
    access: "read",
    sourceModule: "clients.ts",
    support: [],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [],
  }),
  apiAnnotation({
    name: "clockify_clients_get",
    operationId: "getClient",
    method: "GET",
    path: "/workspaces/{workspaceId}/clients/{id}",
    access: "read",
    sourceModule: "clients.ts",
    support: [STRUCTURE_ENDPOINT.clients.list],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [],
  }),
  internalAnnotation({
    name: "clockify_clients_create",
    exposure: "composite",
    reason: "May dispatch a create POST followed by an enrichment PUT, so the current action can contain two primary mutations; Task 6 must split them.",
    primary: [STRUCTURE_ENDPOINT.clients.create, STRUCTURE_ENDPOINT.clients.update],
    support: [STRUCTURE_ENDPOINT.clients.currencies, STRUCTURE_ENDPOINT.clients.list, STRUCTURE_ENDPOINT.clients.get],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
  internalAnnotation({
    name: "clockify_clients_update",
    exposure: "generic",
    reason: "Accepts an open fields dictionary; Task 6 must replace it with a closed operation schema.",
    primary: [STRUCTURE_ENDPOINT.clients.update],
    support: [STRUCTURE_ENDPOINT.clients.list, STRUCTURE_ENDPOINT.clients.get, STRUCTURE_ENDPOINT.clients.currencies],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
  internalAnnotation({
    name: "clockify_clients_delete",
    exposure: "composite",
    reason: "Archives an active client before deletion and may compensate with a restore PUT, so one invocation can contain two primary mutations.",
    primary: [STRUCTURE_ENDPOINT.clients.update, STRUCTURE_ENDPOINT.clients.delete],
    support: [STRUCTURE_ENDPOINT.clients.list, STRUCTURE_ENDPOINT.clients.get],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
  apiAnnotation({
    name: "clockify_tags_list",
    operationId: "getTags",
    method: "GET",
    path: "/workspaces/{workspaceId}/tags",
    access: "read",
    sourceModule: "tags.ts",
    support: [],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [],
  }),
  apiAnnotation({
    name: "clockify_tags_get",
    operationId: "getTag",
    method: "GET",
    path: "/workspaces/{workspaceId}/tags/{id}",
    access: "read",
    sourceModule: "tags.ts",
    support: [STRUCTURE_ENDPOINT.tags.list],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [],
  }),
  apiAnnotation({
    name: "clockify_tags_create",
    operationId: "createNewTag",
    method: "POST",
    path: "/workspaces/{workspaceId}/tags",
    access: "write",
    sourceModule: "tags.ts",
    support: [STRUCTURE_ENDPOINT.tags.list],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [materialField("/body/name", "Tag name", "text", true)],
  }),
  apiAnnotation({
    name: "clockify_tags_update",
    operationId: "updateTag",
    method: "PUT",
    path: "/workspaces/{workspaceId}/tags/{id}",
    access: "write",
    sourceModule: "tags.ts",
    support: [STRUCTURE_ENDPOINT.tags.list, STRUCTURE_ENDPOINT.tags.get],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [
      materialField("/id", "Tag", "entity", true),
      materialField("/patch/name", "Tag name", "text", false),
      materialField("/patch/archived", "Archived", "boolean", false),
    ],
  }),
  apiAnnotation({
    name: "clockify_tags_delete",
    operationId: "deleteTag",
    method: "DELETE",
    path: "/workspaces/{workspaceId}/tags/{id}",
    access: "write",
    sourceModule: "tags.ts",
    support: [STRUCTURE_ENDPOINT.tags.list, STRUCTURE_ENDPOINT.tags.get],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [
      materialField("/id", "Tag", "entity", true),
      materialField("/name", "Tag name", "text", false),
    ],
  }),
  internalAnnotation({
    name: "clockify_create_work_package",
    exposure: "composite",
    reason: "Conditionally creates up to four structure entities and starts a timer in one workflow, so it is not one atomic API operation.",
    primary: [
      STRUCTURE_ENDPOINT.tags.create,
      STRUCTURE_ENDPOINT.clients.create,
      STRUCTURE_ENDPOINT.projects.create,
      STRUCTURE_ENDPOINT.tasks.create,
      STRUCTURE_ENDPOINT.timeEntries.create,
    ],
    support: [
      STRUCTURE_ENDPOINT.tags.list,
      STRUCTURE_ENDPOINT.tags.get,
      STRUCTURE_ENDPOINT.clients.list,
      STRUCTURE_ENDPOINT.clients.get,
      STRUCTURE_ENDPOINT.projects.list,
      STRUCTURE_ENDPOINT.projects.get,
      STRUCTURE_ENDPOINT.tasks.list,
      STRUCTURE_ENDPOINT.tasks.get,
      STRUCTURE_ENDPOINT.timeEntries.running,
    ],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
  internalAnnotation({
    name: "clockify_list_entities",
    exposure: "generic",
    reason: "Selects unrelated list endpoints from entityType, including webhooks unavailable to add-on auth; Task 6 must split typed reads.",
    primary: [
      STRUCTURE_ENDPOINT.tags.list,
      STRUCTURE_ENDPOINT.projects.list,
      STRUCTURE_ENDPOINT.clients.list,
      STRUCTURE_ENDPOINT.tasks.list,
      STRUCTURE_ENDPOINT.users.list,
      STRUCTURE_ENDPOINT.expenses.list,
      STRUCTURE_ENDPOINT.webhooks.list,
    ],
    support: [],
    availability: API_KEY_ONLY,
  }),
  internalAnnotation({
    name: "clockify_get_entity",
    exposure: "generic",
    reason: "Selects unrelated get endpoints from entityType, including webhooks unavailable to add-on auth; Task 6 must split typed reads.",
    primary: [
      STRUCTURE_ENDPOINT.tags.get,
      STRUCTURE_ENDPOINT.projects.get,
      STRUCTURE_ENDPOINT.clients.get,
      STRUCTURE_ENDPOINT.tasks.get,
      STRUCTURE_ENDPOINT.users.list,
      STRUCTURE_ENDPOINT.expenses.get,
      STRUCTURE_ENDPOINT.webhooks.get,
    ],
    support: [],
    availability: API_KEY_ONLY,
  }),
  internalAnnotation({
    name: "clockify_setup_project",
    exposure: "composite",
    reason: "Creates a project, then may replace memberships and set multiple member rates; it is an intentionally multi-primary setup workflow.",
    primary: [STRUCTURE_ENDPOINT.projects.create, STRUCTURE_ENDPOINT.projects.memberships, STRUCTURE_ENDPOINT.projects.rate],
    support: [
      STRUCTURE_ENDPOINT.clients.list,
      STRUCTURE_ENDPOINT.clients.get,
      STRUCTURE_ENDPOINT.users.list,
      STRUCTURE_ENDPOINT.projects.list,
      STRUCTURE_ENDPOINT.projects.get,
    ],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
  internalAnnotation({
    name: "clockify_setup_task",
    exposure: "composite",
    reason: "Creates a task and may set its rate in a second primary mutation; it is an intentionally multi-primary setup workflow.",
    primary: [STRUCTURE_ENDPOINT.tasks.create, STRUCTURE_ENDPOINT.tasks.rate],
    support: [
      STRUCTURE_ENDPOINT.projects.list,
      STRUCTURE_ENDPOINT.projects.get,
      STRUCTURE_ENDPOINT.users.list,
      STRUCTURE_ENDPOINT.tasks.list,
      STRUCTURE_ENDPOINT.tasks.get,
    ],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
];

const TIME_ENTRY_ANNOTATIONS: readonly ExpectedActionAnnotation[] = [
  apiAnnotation({
    name: "clockify_status",
    operationId: "getTimeEntries",
    method: "GET",
    path: "/workspaces/{workspaceId}/user/{userId}/time-entries",
    access: "read",
    sourceModule: "time-entries.ts",
    support: [STRUCTURE_ENDPOINT.projects.get],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [],
  }),
  internalAnnotation({
    name: "clockify_start_timer",
    exposure: "generic",
    reason: "The tagIds and tagNames inputs are unbounded, so leaf-level material expansion cannot be statically bounded; Task 6 must expose a narrowed start operation.",
    primary: [STRUCTURE_ENDPOINT.timeEntries.create],
    support: [
      STRUCTURE_ENDPOINT.projects.list,
      STRUCTURE_ENDPOINT.projects.get,
      STRUCTURE_ENDPOINT.tasks.list,
      STRUCTURE_ENDPOINT.tasks.get,
      STRUCTURE_ENDPOINT.tags.list,
      STRUCTURE_ENDPOINT.timeEntries.running,
    ],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
  apiAnnotation({
    name: "clockify_stop_timer",
    operationId: "stopRunningTimeEntry",
    method: "PATCH",
    path: "/workspaces/{workspaceId}/user/{userId}/time-entries",
    access: "write",
    sourceModule: "time-entries.ts",
    support: [STRUCTURE_ENDPOINT.timeEntries.running, STRUCTURE_ENDPOINT.timeEntries.get],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [
      materialField("/userId", "User", "entity", true),
      materialField("/end", "Stop time", "text", true),
    ],
  }),
  internalAnnotation({
    name: "clockify_log_work",
    exposure: "generic",
    reason: "The tagIds and tagNames inputs are unbounded, so leaf-level material expansion cannot be statically bounded; Task 6 must expose a narrowed create operation.",
    primary: [STRUCTURE_ENDPOINT.timeEntries.create],
    support: [
      STRUCTURE_ENDPOINT.projects.list,
      STRUCTURE_ENDPOINT.projects.get,
      STRUCTURE_ENDPOINT.tasks.list,
      STRUCTURE_ENDPOINT.tasks.get,
      STRUCTURE_ENDPOINT.tags.list,
      STRUCTURE_ENDPOINT.timeEntries.running,
    ],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
  internalAnnotation({
    name: "clockify_review_day",
    exposure: "composite",
    reason: "Resolves a user and day window, then computes an aggregate total over the list response, so it remains an internal review workflow.",
    primary: [STRUCTURE_ENDPOINT.timeEntries.running],
    support: [STRUCTURE_ENDPOINT.users.list],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
  internalAnnotation({
    name: "clockify_review_week",
    exposure: "composite",
    reason: "Resolves a user and seven-day window, then computes an aggregate total over the list response, so it remains an internal review workflow.",
    primary: [STRUCTURE_ENDPOINT.timeEntries.running],
    support: [STRUCTURE_ENDPOINT.users.list],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
  internalAnnotation({
    name: "clockify_fix_entry",
    exposure: "generic",
    reason: "The tagIds and tagNames inputs are unbounded, so leaf-level material expansion cannot be statically bounded; Task 6 must expose a narrowed update operation.",
    primary: [STRUCTURE_ENDPOINT.timeEntries.update],
    support: [
      STRUCTURE_ENDPOINT.timeEntries.get,
      STRUCTURE_ENDPOINT.projects.list,
      STRUCTURE_ENDPOINT.projects.get,
      STRUCTURE_ENDPOINT.tasks.list,
      STRUCTURE_ENDPOINT.tasks.get,
      STRUCTURE_ENDPOINT.tags.list,
    ],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
  apiAnnotation({
    name: "clockify_entries_list",
    operationId: "getTimeEntries",
    method: "GET",
    path: "/workspaces/{workspaceId}/user/{userId}/time-entries",
    access: "read",
    sourceModule: "time-entries.ts",
    support: [
      STRUCTURE_ENDPOINT.users.list,
      STRUCTURE_ENDPOINT.projects.list,
      STRUCTURE_ENDPOINT.tasks.list,
    ],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [],
  }),
  apiAnnotation({
    name: "clockify_entries_get",
    operationId: "getTimeEntry",
    method: "GET",
    path: "/workspaces/{workspaceId}/time-entries/{id}",
    access: "read",
    sourceModule: "time-entries.ts",
    support: [],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [],
  }),
  apiAnnotation({
    name: "clockify_entries_delete",
    operationId: "deleteTimeEntry",
    method: "DELETE",
    path: "/workspaces/{workspaceId}/time-entries/{id}",
    access: "write",
    sourceModule: "time-entries.ts",
    support: [STRUCTURE_ENDPOINT.timeEntries.get],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [
      materialField("/id", "Time entry", "entity", true),
      materialField("/description", "Description", "text", false),
    ],
  }),
  internalAnnotation({
    name: "clockify_entries_mark_invoiced",
    exposure: "generic",
    reason: "The current batch maximum exceeds the 22-fact material presentation limit; Task 6 must narrow the invoiced-state operation.",
    primary: [STRUCTURE_ENDPOINT.timeEntries.invoiced],
    support: [STRUCTURE_ENDPOINT.timeEntries.get],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
];

const ADAPTER_ENDPOINT_KEYS = new Set(
  extractAdapterEndpoints(fileURLToPath(new URL("../..", import.meta.url)))
    .map(adapterRequestShapeKey),
);

function withoutApiMetadata(definition: ActionDefinition): ActionDefinition {
  const {
    apiExposure: _apiExposure,
    apiExposureReason: _apiExposureReason,
    apiOperation: _apiOperation,
    adapterEndpoints: _adapterEndpoints,
    availabilityByAuthClass: _availabilityByAuthClass,
    boundedArgumentDictionaries: _boundedArgumentDictionaries,
    materialFields: _materialFields,
    presentation: _presentation,
    ...legacyDefinition
  } = definition;
  return legacyDefinition;
}

describe("API action inventory normalization", () => {
  it("keeps the current catalog in a duplicate-safe raw inventory without normalizing it", async () => {
    const registry = await loadRegistryModule();
    const inventory = registry.inventoryActionDefinitions();
    expect(inventory).toHaveLength(ACTION_CATALOG.length);
    expect(new Set(inventory.map(({ sourceSurface, definition }) =>
      `${sourceSurface}\0${definition.name}`).values()).size).toBe(inventory.length);
    expect(inventory.every(({ sourceSurface }) => sourceSurface === "v1-internal")).toBe(true);
  });

  it("rejects an incomplete raw definition before it can enter a model registry", async () => {
    const registry = await loadRegistryModule();
    expect(() => registry.normalizeRegistryAction(
      withoutApiMetadata(fixtureAction("clockify_tags_create")),
      "v2-api",
    ))
      .toThrowError("missing_api_exposure:clockify_tags_create");
  });

  it.each([...STRUCTURE_ANNOTATIONS, ...TIME_ENTRY_ANNOTATIONS])(
    "classifies $name and binds its endpoint evidence into the fingerprint",
    async (expected) => {
      const registry = await loadRegistryModule();
      const definition = fixtureAction(expected.name);

      expect(definition.apiExposure).toBe(expected.exposure);
      expect(definition.adapterEndpoints).toEqual(expected.endpoints);
      expect([
        ...(definition.adapterEndpoints?.primary ?? []),
        ...(definition.adapterEndpoints?.support ?? []),
      ].filter((key) => !ADAPTER_ENDPOINT_KEYS.has(key))).toEqual([]);
      expect(definition.availabilityByAuthClass).toEqual(expected.availability);
      expect(definition.boundedArgumentDictionaries).toEqual([]);

      if (expected.exposure === "api") {
        expect(definition.apiOperation).toEqual(expected.operation);
        expect(definition.apiExposureReason).toBeUndefined();
        expect(definition.materialFields).toEqual(expected.materialFields);
        expect(definition.presentation).toEqual(expected.presentation);
      } else {
        expect(definition.apiOperation).toBeUndefined();
        expect(definition.apiExposureReason).toBe(expected.reason);
        expect(definition.materialFields).toBeUndefined();
        expect(definition.presentation).toBeUndefined();
      }

      expect(() => registry.normalizeRegistryAction(
        definition,
        expected.exposure === "api" ? "v2-api" : "v1-internal",
      )).not.toThrow();
      expect(actionFingerprintForDefinition(definition)).not.toBe(
        actionFingerprintForDefinition(withoutApiMetadata(definition)),
      );
    },
  );

  it("attaches reviewed write authority to a complete atomic API definition", async () => {
    const registry = await loadRegistryModule();
    const normalized = registry.normalizeRegistryAction({
      ...fixtureAction("clockify_tags_create"),
      ...TAG_METADATA,
    }, "v2-api");

    expect(normalized.writeAuthority).toMatchObject({
      cardinality: { mode: "single", maxExecutions: 1 },
      mutationPlans: [{ mode: "single", minSteps: 1, maxSteps: 1 }],
    });
  });

  it.each([
    ["unknown endpoint key", {
      ...TAG_METADATA,
      adapterEndpoints: {
        primary: [endpointKey({ ...TAG_OPERATION, path: "/workspaces/{workspaceId}/labels" })],
        support: [],
      },
    }, "unknown_adapter_endpoint:clockify_tags_create"],
    ["write endpoint presented as support", {
      ...TAG_METADATA,
      adapterEndpoints: {
        primary: [endpointKey(TAG_OPERATION)],
        support: [endpointKey({
          ...TAG_OPERATION,
          method: "PUT",
          path: "/workspaces/{workspaceId}/tags/{tagId}",
        })],
      },
    }, "write_support_endpoint:clockify_tags_create"],
    ["unmatched dictionary material", {
      ...TAG_METADATA,
      materialFields: [{
        kind: "dictionary_entry" as const,
        containerPath: "/attributes",
        valuePath: "",
        labelTemplate: "Attribute {key}",
        maxEntries: 2,
        formatterId: "text",
        formatterVersion: 1,
        requiredInPreview: true,
      }],
    }, "unmatched_material_dictionary:clockify_tags_create:/attributes"],
    ["more than 22 material facts", {
      ...TAG_METADATA,
      materialFields: Array.from({ length: 23 }, (_, index) => ({
        kind: "value" as const,
        path: `/material/${index}`,
        label: `Material ${index}`,
        formatterId: "text",
        formatterVersion: 1,
        requiredInPreview: true,
      })),
    }, "material_fact_limit_exceeded:clockify_tags_create:23"],
  ] satisfies readonly (readonly [string, TestApiMetadata, string])[])(
    "rejects %s",
    async (_label, metadata, error) => {
      const registry = await loadRegistryModule();
      expect(() => registry.normalizeRegistryAction({
        ...fixtureAction("clockify_tags_create"),
        ...metadata,
      }, "v2-api")).toThrowError(error);
    },
  );

  it("rejects an open model-write schema", async () => {
    const registry = await loadRegistryModule();
    const openDefinition = {
      ...fixtureAction("clockify_tags_create"),
      ...TAG_METADATA,
      schema: z.object({ fields: z.record(z.unknown()) }),
    };
    expect(() => registry.normalizeRegistryAction(openDefinition, "v2-api"))
      .toThrowError("unreviewed_open_schema:clockify_tags_create:/fields");
  });

  it("rejects a reviewed write plan with more than one primary mutation", async () => {
    const registry = await loadRegistryModule();
    const projectDelete = fixtureAction("clockify_projects_delete");
    const operation = {
      operationId: "deleteProject",
      host: "api" as const,
      method: "DELETE" as const,
      path: "/workspaces/{workspaceId}/projects/{projectId}",
      access: "write" as const,
      exposure: "api" as const,
    };
    expect(() => registry.normalizeRegistryAction({
      ...projectDelete,
      apiExposure: "api",
      apiExposureReason: undefined,
      apiOperation: operation,
      adapterEndpoints: { primary: [endpointKey(operation, "projects.ts")], support: [] },
      availabilityByAuthClass: {
        addon: { available: true },
        api_key: { available: true },
      },
      boundedArgumentDictionaries: [],
      materialFields: [{
        kind: "value",
        path: "/projectId",
        label: "Project",
        formatterId: "entity",
        formatterVersion: 1,
        requiredInPreview: true,
      }],
      presentation: { presenterId: "project-delete", version: 1 },
    }, "v2-api")).toThrowError("multiple_primary_mutations:clockify_projects_delete");
  });

  it("binds availability decisions into the ordered registry hash", async () => {
    const registry = await loadRegistryModule();
    const definition = fixtureAction("clockify_tags_create");
    const available = registry.normalizeRegistryAction({ ...definition, ...TAG_METADATA }, "v2-api");
    const addonUnavailable = registry.normalizeRegistryAction({
      ...definition,
      ...TAG_METADATA,
      availabilityByAuthClass: {
        addon: { available: false, reason: "unsupported_auth_class" },
        api_key: { available: true },
      },
    }, "v2-api");

    expect(registry.registryHashForActions([available])).not.toBe(
      registry.registryHashForActions([addonUnavailable]),
    );
    expect(registry.registryHashForActions([available])).toMatch(/^[a-f0-9]{64}$/u);
  });
});
