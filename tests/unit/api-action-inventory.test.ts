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
      primaryMutationCount?: number;
      compensationCount?: number;
    }
  | {
      name: string;
      exposure: "composite" | "generic";
      reason: string;
      endpoints: ExpectedEndpoints;
      availability: ExpectedAvailability;
      primaryMutationCount?: number;
      compensationCount?: number;
    }
  | {
      name: string;
      exposure: "local";
      reason: string;
      endpoints: undefined;
      availability: ExpectedAvailability;
      primaryMutationCount?: number;
      compensationCount?: number;
    };

const AVAILABLE_TO_BOTH_AUTH_CLASSES = {
  addon: { available: true },
  api_key: { available: true },
} satisfies ExpectedAvailability;

const API_KEY_ONLY = {
  addon: { available: false, reason: "unsupported_auth_class" },
  api_key: { available: true },
} satisfies ExpectedAvailability;

const OFFICIAL_OPERATION_ID_MISSING = {
  addon: { available: false, reason: "official_operation_id_missing" },
  api_key: { available: false, reason: "official_operation_id_missing" },
} satisfies ExpectedAvailability;

function adapterEndpointKey(
  access: TestApiOperation["access"],
  host: TestApiOperation["host"],
  method: TestApiOperation["method"],
  path: string,
  sourceModule: string,
): string {
  return [access, host, method, path, sourceModule].join("\0");
}

function structureEndpointKey(
  access: TestApiOperation["access"],
  method: TestApiOperation["method"],
  path: string,
  sourceModule: string,
): string {
  return adapterEndpointKey(access, "api", method, path, sourceModule);
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

const ADMINISTRATION_ENDPOINT = {
  audit: {
    search: adapterEndpointKey("read", "audit", "POST", "/workspaces/{workspaceId}/audit-log", "audit.ts"),
    entityChanges: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/entities/{changeType}", "audit.ts"),
  },
  workspace: {
    templatesList: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/projects", "workspace.ts"),
  },
  holidays: {
    list: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/holidays", "holidays.ts"),
    create: adapterEndpointKey("write", "api", "POST", "/workspaces/{workspaceId}/holidays", "holidays.ts"),
    update: adapterEndpointKey("write", "api", "PUT", "/workspaces/{workspaceId}/holidays/{id}", "holidays.ts"),
  },
  users: {
    list: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/users", "users.ts"),
    groups: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/user-groups", "users.ts"),
  },
  webhooks: {
    list: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/webhooks", "webhooks.ts"),
    get: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/webhooks/{id}", "webhooks.ts"),
    create: adapterEndpointKey("write", "api", "POST", "/workspaces/{workspaceId}/webhooks", "webhooks.ts"),
    update: adapterEndpointKey("write", "api", "PUT", "/workspaces/{workspaceId}/webhooks/{id}", "webhooks.ts"),
  },
} as const;

const INVOICE_ENDPOINT = {
  list: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/invoices", "invoices.ts"),
  get: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/invoices/{id}", "invoices.ts"),
  export: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/invoices/{id}/export", "invoices.ts"),
  paymentsList: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/invoices/{id}/payments", "invoices.ts"),
  create: adapterEndpointKey("write", "api", "POST", "/workspaces/{workspaceId}/invoices", "invoices.ts"),
  update: adapterEndpointKey("write", "api", "PUT", "/workspaces/{workspaceId}/invoices/{id}", "invoices.ts"),
  status: adapterEndpointKey("write", "api", "PATCH", "/workspaces/{workspaceId}/invoices/{id}/status", "invoices.ts"),
  delete: adapterEndpointKey("write", "api", "DELETE", "/workspaces/{workspaceId}/invoices/{id}", "invoices.ts"),
  itemsAdd: adapterEndpointKey("write", "api", "POST", "/workspaces/{workspaceId}/invoices/{id}/items", "invoices.ts"),
  itemsDelete: adapterEndpointKey("write", "api", "DELETE", "/workspaces/{workspaceId}/invoices/{id}/items/{index}", "invoices.ts"),
  paymentsCreate: adapterEndpointKey("write", "api", "POST", "/workspaces/{workspaceId}/invoices/{id}/payments", "invoices.ts"),
  paymentsDelete: adapterEndpointKey("write", "api", "DELETE", "/workspaces/{workspaceId}/invoices/{id}/payments/{paymentId}", "invoices.ts"),
  importTime: adapterEndpointKey("write", "api", "POST", "/workspaces/{workspaceId}/invoices/{id}/items/import", "invoices.ts"),
} as const;

const EXPENSE_CUSTOM_FIELD_ENDPOINT = {
  expenses: {
    list: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/expenses", "expenses.ts"),
    get: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/expenses/{id}", "expenses.ts"),
    create: adapterEndpointKey("write", "api", "POST", "/workspaces/{workspaceId}/expenses", "expenses.ts"),
    update: adapterEndpointKey("write", "api", "PUT", "/workspaces/{workspaceId}/expenses/{id}", "expenses.ts"),
    delete: adapterEndpointKey("write", "api", "DELETE", "/workspaces/{workspaceId}/expenses/{id}", "expenses.ts"),
    categoriesList: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/expenses/categories", "expenses.ts"),
    categoriesCreate: adapterEndpointKey("write", "api", "POST", "/workspaces/{workspaceId}/expenses/categories", "expenses.ts"),
    categoriesUpdate: adapterEndpointKey("write", "api", "PUT", "/workspaces/{workspaceId}/expenses/categories/{id}", "expenses.ts"),
    categoriesStatus: adapterEndpointKey("write", "api", "PATCH", "/workspaces/{workspaceId}/expenses/categories/{id}/status", "expenses.ts"),
    categoriesDelete: adapterEndpointKey("write", "api", "DELETE", "/workspaces/{workspaceId}/expenses/categories/{id}", "expenses.ts"),
  },
  customFields: {
    list: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/custom-fields", "custom-fields.ts"),
    create: adapterEndpointKey("write", "api", "POST", "/workspaces/{workspaceId}/custom-fields", "custom-fields.ts"),
    update: adapterEndpointKey("write", "api", "PUT", "/workspaces/{workspaceId}/custom-fields/{id}", "custom-fields.ts"),
    delete: adapterEndpointKey("write", "api", "DELETE", "/workspaces/{workspaceId}/custom-fields/{id}", "custom-fields.ts"),
    projectValue: adapterEndpointKey("write", "api", "PATCH", "/workspaces/{workspaceId}/projects/{projectId}/custom-fields/{fieldId}", "custom-fields.ts"),
    entryRead: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/time-entries/{entryId}", "custom-fields.ts"),
    entryUpdate: adapterEndpointKey("write", "api", "PUT", "/workspaces/{workspaceId}/time-entries/{entryId}", "custom-fields.ts"),
  },
  projects: {
    list: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/projects", "projects.ts"),
    get: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/projects/{id}", "projects.ts"),
  },
  tasks: {
    list: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/projects/{projectId}/tasks", "tasks.ts"),
    get: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/projects/{projectId}/tasks/{id}", "tasks.ts"),
  },
  users: {
    list: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/users", "users.ts"),
  },
} as const;

const USER_GROUP_ENDPOINT = {
  users: {
    list: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/users", "users.ts"),
    invite: adapterEndpointKey("write", "api", "POST", "/workspaces/{workspaceId}/users", "users.ts"),
    role: adapterEndpointKey("write", "api", "POST", "/workspaces/{workspaceId}/users/{userId}/roles", "users.ts"),
    rate: adapterEndpointKey("write", "api", "PUT", "/workspaces/{workspaceId}/users/{userId}/{kind}", "users.ts"),
    status: adapterEndpointKey("write", "api", "PUT", "/workspaces/{workspaceId}/users/{userId}", "users.ts"),
  },
  groups: {
    list: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/user-groups", "users.ts"),
    create: adapterEndpointKey("write", "api", "POST", "/workspaces/{workspaceId}/user-groups", "users.ts"),
    update: adapterEndpointKey("write", "api", "PUT", "/workspaces/{workspaceId}/user-groups/{id}", "users.ts"),
    delete: adapterEndpointKey("write", "api", "DELETE", "/workspaces/{workspaceId}/user-groups/{id}", "users.ts"),
    addUser: adapterEndpointKey("write", "api", "POST", "/workspaces/{workspaceId}/user-groups/{groupId}/users", "users.ts"),
    removeUser: adapterEndpointKey("write", "api", "DELETE", "/workspaces/{workspaceId}/user-groups/{groupId}/users/{userId}", "users.ts"),
  },
  projects: {
    list: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/projects", "projects.ts"),
    get: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/projects/{id}", "projects.ts"),
  },
  workspace: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}", "workspace.ts"),
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
  host?: TestApiOperation["host"];
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
    host: input.host ?? "api",
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

const ADMINISTRATION_ANNOTATIONS: readonly ExpectedActionAnnotation[] = [
  apiAnnotation({
    name: "clockify_reports_summary",
    operationId: "generateSummaryReport",
    host: "reports",
    method: "POST",
    path: "/workspaces/{workspaceId}/reports/summary",
    access: "read",
    sourceModule: "reports.ts",
    support: [],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [],
  }),
  apiAnnotation({
    name: "clockify_reports_detailed",
    operationId: "generateDetailedReport",
    host: "reports",
    method: "POST",
    path: "/workspaces/{workspaceId}/reports/detailed",
    access: "read",
    sourceModule: "reports.ts",
    support: [],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [],
  }),
  apiAnnotation({
    name: "clockify_reports_weekly",
    operationId: "generateWeeklyReport",
    host: "reports",
    method: "POST",
    path: "/workspaces/{workspaceId}/reports/weekly",
    access: "read",
    sourceModule: "reports.ts",
    support: [],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [],
  }),
  internalAnnotation({
    name: "clockify_audit_logs_search",
    exposure: "generic",
    reason: "The official Clockify OpenAPI description contains audit-log schemas but no path or operation ID, so this adapter workflow stays internal until official operation identity exists.",
    primary: [ADMINISTRATION_ENDPOINT.audit.search],
    support: [],
    availability: OFFICIAL_OPERATION_ID_MISSING,
  }),
  internalAnnotation({
    name: "clockify_entity_changes_list",
    exposure: "generic",
    reason: "Selects the created, updated, or deleted entity-change endpoint from changeType, so one action cannot bind one official operation ID; Task 6 must split the three reads.",
    primary: [ADMINISTRATION_ENDPOINT.audit.entityChanges],
    support: [],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
  apiAnnotation({
    name: "clockify_workspace_get",
    operationId: "getWorkspaceOfUser",
    method: "GET",
    path: "/workspaces/{workspaceId}",
    access: "read",
    sourceModule: "workspace.ts",
    support: [],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [],
  }),
  apiAnnotation({
    name: "clockify_templates_list",
    operationId: "getProjects",
    method: "GET",
    path: "/workspaces/{workspaceId}/projects",
    access: "read",
    sourceModule: "workspace.ts",
    support: [],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [],
  }),
  apiAnnotation({
    name: "clockify_templates_get",
    operationId: "getProject",
    method: "GET",
    path: "/workspaces/{workspaceId}/projects/{id}",
    access: "read",
    sourceModule: "workspace.ts",
    support: [ADMINISTRATION_ENDPOINT.workspace.templatesList],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [],
  }),
  apiAnnotation({
    name: "clockify_holidays_list",
    operationId: "getHolidays",
    method: "GET",
    path: "/workspaces/{workspaceId}/holidays",
    access: "read",
    sourceModule: "holidays.ts",
    support: [],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [],
  }),
  internalAnnotation({
    name: "clockify_holidays_get",
    exposure: "composite",
    reason: "Finds one holiday by scanning the holidays list because Clockify exposes no GET /holidays/{id}; it is not a fabricated get-one operation.",
    primary: [ADMINISTRATION_ENDPOINT.holidays.list],
    support: [],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
  apiAnnotation({
    name: "clockify_holidays_in_period",
    operationId: "getHolidaysInPeriod",
    method: "GET",
    path: "/workspaces/{workspaceId}/holidays/in-period",
    access: "read",
    sourceModule: "holidays.ts",
    support: [ADMINISTRATION_ENDPOINT.users.list],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [],
  }),
  internalAnnotation({
    name: "clockify_holidays_create",
    exposure: "generic",
    reason: "The userIds and userGroupIds arrays are unbounded, so material expansion cannot be statically capped at 22 facts; Task 6 must expose a narrowed create operation.",
    primary: [ADMINISTRATION_ENDPOINT.holidays.create],
    support: [
      ADMINISTRATION_ENDPOINT.holidays.list,
      ADMINISTRATION_ENDPOINT.users.list,
      ADMINISTRATION_ENDPOINT.users.groups,
    ],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
  internalAnnotation({
    name: "clockify_holidays_update",
    exposure: "generic",
    reason: "The userIds and userGroupIds arrays are unbounded, so material expansion cannot be statically capped at 22 facts; Task 6 must expose a narrowed update operation.",
    primary: [ADMINISTRATION_ENDPOINT.holidays.update],
    support: [
      ADMINISTRATION_ENDPOINT.holidays.list,
      ADMINISTRATION_ENDPOINT.users.list,
      ADMINISTRATION_ENDPOINT.users.groups,
    ],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
  apiAnnotation({
    name: "clockify_holidays_delete",
    operationId: "deleteHoliday",
    method: "DELETE",
    path: "/workspaces/{workspaceId}/holidays/{id}",
    access: "write",
    sourceModule: "holidays.ts",
    support: [ADMINISTRATION_ENDPOINT.holidays.list],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [
      materialField("/id", "Holiday", "entity", true),
      materialField("/name", "Holiday name", "text", false),
    ],
  }),
  apiAnnotation({
    name: "clockify_webhooks_list",
    operationId: "getWebhooks",
    method: "GET",
    path: "/workspaces/{workspaceId}/webhooks",
    access: "read",
    sourceModule: "webhooks.ts",
    support: [],
    availability: API_KEY_ONLY,
    materialFields: [],
  }),
  apiAnnotation({
    name: "clockify_webhooks_get",
    operationId: "getWebhook",
    method: "GET",
    path: "/workspaces/{workspaceId}/webhooks/{id}",
    access: "read",
    sourceModule: "webhooks.ts",
    support: [],
    availability: API_KEY_ONLY,
    materialFields: [],
  }),
  {
    name: "clockify_webhooks_events",
    exposure: "local",
    reason: "Returns a static reviewed event list because the attempted events routes fail; it performs no Clockify request.",
    endpoints: undefined,
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  },
  apiAnnotation({
    name: "clockify_webhooks_logs",
    operationId: "getLogsForWebhook",
    method: "POST",
    path: "/workspaces/{workspaceId}/webhooks/{id}/logs",
    access: "read",
    sourceModule: "webhooks.ts",
    support: [],
    availability: API_KEY_ONLY,
    materialFields: [],
  }),
  internalAnnotation({
    name: "clockify_webhooks_create",
    exposure: "generic",
    reason: "The triggerSource array is unbounded, so material expansion cannot be statically capped at 22 facts; Task 6 must expose a narrowed create operation.",
    primary: [ADMINISTRATION_ENDPOINT.webhooks.create],
    support: [ADMINISTRATION_ENDPOINT.webhooks.list],
    availability: API_KEY_ONLY,
  }),
  internalAnnotation({
    name: "clockify_webhooks_update",
    exposure: "generic",
    reason: "The triggerSource array is unbounded, so material expansion cannot be statically capped at 22 facts; Task 6 must expose a narrowed update operation.",
    primary: [ADMINISTRATION_ENDPOINT.webhooks.update],
    support: [ADMINISTRATION_ENDPOINT.webhooks.get],
    availability: API_KEY_ONLY,
  }),
  apiAnnotation({
    name: "clockify_webhooks_delete",
    operationId: "deleteWebhook",
    method: "DELETE",
    path: "/workspaces/{workspaceId}/webhooks/{id}",
    access: "write",
    sourceModule: "webhooks.ts",
    support: [ADMINISTRATION_ENDPOINT.webhooks.get, ADMINISTRATION_ENDPOINT.webhooks.list],
    availability: API_KEY_ONLY,
    materialFields: [
      materialField("/id", "Webhook", "entity", true),
      materialField("/name", "Webhook name", "text", false),
    ],
  }),
];

const INVOICE_ANNOTATIONS: readonly ExpectedActionAnnotation[] = [
  apiAnnotation({
    name: "clockify_invoices_list",
    operationId: "getInvoices",
    method: "GET",
    path: "/workspaces/{workspaceId}/invoices",
    access: "read",
    sourceModule: "invoices.ts",
    support: [],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [],
  }),
  apiAnnotation({
    name: "clockify_invoices_get",
    operationId: "getInvoice",
    method: "GET",
    path: "/workspaces/{workspaceId}/invoices/{id}",
    access: "read",
    sourceModule: "invoices.ts",
    support: [INVOICE_ENDPOINT.list],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [],
  }),
  apiAnnotation({
    name: "clockify_invoices_items_list",
    operationId: "getInvoice",
    method: "GET",
    path: "/workspaces/{workspaceId}/invoices/{id}",
    access: "read",
    sourceModule: "invoices.ts",
    support: [INVOICE_ENDPOINT.list],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [],
  }),
  apiAnnotation({
    name: "clockify_invoices_payments_list",
    operationId: "getPaymentsForInvoice",
    method: "GET",
    path: "/workspaces/{workspaceId}/invoices/{id}/payments",
    access: "read",
    sourceModule: "invoices.ts",
    support: [INVOICE_ENDPOINT.list],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [],
  }),
  apiAnnotation({
    name: "clockify_invoices_export",
    operationId: "exportInvoice",
    method: "GET",
    path: "/workspaces/{workspaceId}/invoices/{id}/export",
    access: "read",
    sourceModule: "invoices.ts",
    support: [INVOICE_ENDPOINT.list],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [],
  }),
  {
    ...internalAnnotation({
      name: "clockify_invoices_create",
      exposure: "composite",
      reason: "Creates the base invoice, then may update enrichment fields and add up to 25 items for a maximum of 27 primary mutations; Task 6 must expose the atomic operations separately.",
      primary: [INVOICE_ENDPOINT.create, INVOICE_ENDPOINT.update, INVOICE_ENDPOINT.itemsAdd],
      support: [STRUCTURE_ENDPOINT.clients.list, INVOICE_ENDPOINT.list, INVOICE_ENDPOINT.get],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    }),
    primaryMutationCount: 27,
    compensationCount: 0,
  },
  {
    ...internalAnnotation({
      name: "clockify_invoices_update",
      exposure: "composite",
      reason: "May dispatch both the invoice fields PUT and the status PATCH for a maximum of two primary mutations; Task 6 must expose those operations separately.",
      primary: [INVOICE_ENDPOINT.update, INVOICE_ENDPOINT.status],
      support: [INVOICE_ENDPOINT.list, INVOICE_ENDPOINT.get, STRUCTURE_ENDPOINT.clients.list, STRUCTURE_ENDPOINT.clients.get],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    }),
    primaryMutationCount: 2,
    compensationCount: 0,
  },
  {
    ...apiAnnotation({
      name: "clockify_invoices_delete",
      operationId: "deleteInvoice",
      method: "DELETE",
      path: "/workspaces/{workspaceId}/invoices/{id}",
      access: "write",
      sourceModule: "invoices.ts",
      support: [INVOICE_ENDPOINT.list, INVOICE_ENDPOINT.get],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
      materialFields: [
        materialField("/id", "Invoice", "entity", true),
        materialField("/number", "Invoice number", "text", false),
      ],
    }),
    primaryMutationCount: 1,
    compensationCount: 0,
  },
  {
    ...apiAnnotation({
      name: "clockify_invoices_items_add",
      operationId: "addInvoiceItem",
      method: "POST",
      path: "/workspaces/{workspaceId}/invoices/{id}/items",
      access: "write",
      sourceModule: "invoices.ts",
      support: [INVOICE_ENDPOINT.list, INVOICE_ENDPOINT.get],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
      materialFields: [
        materialField("/invoiceId", "Invoice", "entity", true),
        materialField("/item/itemType", "Item type", "text", true),
        materialField("/item/description", "Description", "text", true),
        materialField("/item/quantity", "Quantity", "number", true),
        materialField("/item/unitPriceMinor", "Unit price", "money-minor", false),
        materialField("/item/applyTaxes", "Taxes", "text", true),
      ],
    }),
    primaryMutationCount: 1,
    compensationCount: 0,
  },
  {
    ...apiAnnotation({
      name: "clockify_invoices_items_delete",
      operationId: "removeInvoiceItem",
      method: "DELETE",
      path: "/workspaces/{workspaceId}/invoices/{id}/items/{index}",
      access: "write",
      sourceModule: "invoices.ts",
      support: [INVOICE_ENDPOINT.list, INVOICE_ENDPOINT.get],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
      materialFields: [
        materialField("/invoiceId", "Invoice", "entity", true),
        materialField("/index", "Item index", "number", true),
        materialField("/itemSnapshot/description", "Description", "text", false),
      ],
    }),
    primaryMutationCount: 1,
    compensationCount: 0,
  },
  {
    ...apiAnnotation({
      name: "clockify_invoices_payments_create",
      operationId: "createInvoicePayment",
      method: "POST",
      path: "/workspaces/{workspaceId}/invoices/{id}/payments",
      access: "write",
      sourceModule: "invoices.ts",
      support: [INVOICE_ENDPOINT.list, INVOICE_ENDPOINT.get, INVOICE_ENDPOINT.paymentsList],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
      materialFields: [
        materialField("/invoiceId", "Invoice", "entity", true),
        materialField("/payment/amountMinor", "Payment amount", "money-minor", true),
        materialField("/payment/paymentDate", "Payment date", "text", true),
        materialField("/payment/note", "Payment note", "text", false),
      ],
    }),
    primaryMutationCount: 1,
    compensationCount: 0,
  },
  {
    ...apiAnnotation({
      name: "clockify_invoices_payments_delete",
      operationId: "deletePaymentById",
      method: "DELETE",
      path: "/workspaces/{workspaceId}/invoices/{id}/payments/{paymentId}",
      access: "write",
      sourceModule: "invoices.ts",
      support: [INVOICE_ENDPOINT.list, INVOICE_ENDPOINT.get, INVOICE_ENDPOINT.paymentsList],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
      materialFields: [
        materialField("/invoiceId", "Invoice", "entity", true),
        materialField("/paymentId", "Payment", "entity", true),
        materialField("/paymentSnapshot/amount", "Payment amount", "money-minor", false),
        materialField("/paymentSnapshot/paymentDate", "Payment date", "text", false),
        materialField("/paymentSnapshot/note", "Payment note", "text", false),
      ],
    }),
    primaryMutationCount: 1,
    compensationCount: 0,
  },
  {
    ...internalAnnotation({
      name: "clockify_invoices_import_time",
      exposure: "generic",
      reason: "The one-request import accepts up to 54 project ids, exceeding the 22-fact material presentation limit; Task 6 must expose a narrower import operation.",
      primary: [INVOICE_ENDPOINT.importTime],
      support: [INVOICE_ENDPOINT.list, INVOICE_ENDPOINT.get, STRUCTURE_ENDPOINT.projects.get],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    }),
    primaryMutationCount: 1,
    compensationCount: 0,
  },
];

const EXPENSE_CUSTOM_FIELD_ANNOTATIONS: readonly ExpectedActionAnnotation[] = [
  apiAnnotation({
    name: "clockify_expenses_list",
    operationId: "getExpenses",
    method: "GET",
    path: "/workspaces/{workspaceId}/expenses",
    access: "read",
    sourceModule: "expenses.ts",
    support: [],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [],
  }),
  apiAnnotation({
    name: "clockify_expenses_get",
    operationId: "getExpense",
    method: "GET",
    path: "/workspaces/{workspaceId}/expenses/{id}",
    access: "read",
    sourceModule: "expenses.ts",
    support: [],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [],
  }),
  apiAnnotation({
    name: "clockify_expenses_categories_list",
    operationId: "getCategories",
    method: "GET",
    path: "/workspaces/{workspaceId}/expenses/categories",
    access: "read",
    sourceModule: "expenses.ts",
    support: [],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [],
  }),
  {
    ...apiAnnotation({
      name: "clockify_expenses_create",
      operationId: "createExpense",
      method: "POST",
      path: "/workspaces/{workspaceId}/expenses",
      access: "write",
      sourceModule: "expenses.ts",
      support: [
        EXPENSE_CUSTOM_FIELD_ENDPOINT.expenses.categoriesList,
        EXPENSE_CUSTOM_FIELD_ENDPOINT.users.list,
        EXPENSE_CUSTOM_FIELD_ENDPOINT.projects.list,
        EXPENSE_CUSTOM_FIELD_ENDPOINT.projects.get,
        EXPENSE_CUSTOM_FIELD_ENDPOINT.tasks.list,
        EXPENSE_CUSTOM_FIELD_ENDPOINT.tasks.get,
        EXPENSE_CUSTOM_FIELD_ENDPOINT.expenses.list,
      ],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
      materialFields: [
        materialField("/input/amountMinor", "Amount", "money-minor", true),
        materialField("/input/date", "Date", "text", true),
        materialField("/input/categoryId", "Category", "entity", true),
        materialField("/input/userId", "User", "entity", true),
        materialField("/input/notes", "Notes", "text", false),
        materialField("/input/billable", "Billable", "boolean", false),
        materialField("/input/projectId", "Project", "entity", false),
        materialField("/input/taskId", "Task", "entity", false),
      ],
    }),
    primaryMutationCount: 1,
    compensationCount: 0,
  },
  {
    ...apiAnnotation({
      name: "clockify_expenses_update",
      operationId: "updateExpense",
      method: "PUT",
      path: "/workspaces/{workspaceId}/expenses/{id}",
      access: "write",
      sourceModule: "expenses.ts",
      support: [
        EXPENSE_CUSTOM_FIELD_ENDPOINT.expenses.get,
        EXPENSE_CUSTOM_FIELD_ENDPOINT.expenses.categoriesList,
        EXPENSE_CUSTOM_FIELD_ENDPOINT.users.list,
        EXPENSE_CUSTOM_FIELD_ENDPOINT.projects.list,
        EXPENSE_CUSTOM_FIELD_ENDPOINT.projects.get,
        EXPENSE_CUSTOM_FIELD_ENDPOINT.tasks.list,
        EXPENSE_CUSTOM_FIELD_ENDPOINT.tasks.get,
      ],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
      materialFields: [
        materialField("/id", "Expense", "entity", true),
        materialField("/values/amountMinor", "Amount", "money-minor", false),
        materialField("/values/date", "Date", "text", false),
        materialField("/values/categoryId", "Category", "entity", false),
        materialField("/values/notes", "Notes", "text", false),
        materialField("/values/billable", "Billable", "boolean", false),
        materialField("/values/projectId", "Project", "entity", false),
        materialField("/values/taskId", "Task", "entity", false),
      ],
    }),
    primaryMutationCount: 1,
    compensationCount: 0,
  },
  {
    ...apiAnnotation({
      name: "clockify_expenses_delete",
      operationId: "deleteExpense",
      method: "DELETE",
      path: "/workspaces/{workspaceId}/expenses/{id}",
      access: "write",
      sourceModule: "expenses.ts",
      support: [EXPENSE_CUSTOM_FIELD_ENDPOINT.expenses.get],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
      materialFields: [
        materialField("/id", "Expense", "entity", true),
        materialField("/notes", "Notes", "text", false),
      ],
    }),
    primaryMutationCount: 1,
    compensationCount: 0,
  },
  {
    ...apiAnnotation({
      name: "clockify_expenses_categories_create",
      operationId: "createExpenseCategory",
      method: "POST",
      path: "/workspaces/{workspaceId}/expenses/categories",
      access: "write",
      sourceModule: "expenses.ts",
      support: [EXPENSE_CUSTOM_FIELD_ENDPOINT.expenses.categoriesList],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
      materialFields: [materialField("/name", "Category name", "text", true)],
    }),
    primaryMutationCount: 1,
    compensationCount: 0,
  },
  {
    ...internalAnnotation({
      name: "clockify_expenses_categories_update",
      exposure: "composite",
      reason: "May dispatch the category-name PUT, the archive-status PATCH, or both primary mutations; Task 6 must expose the atomic operations separately.",
      primary: [
        EXPENSE_CUSTOM_FIELD_ENDPOINT.expenses.categoriesUpdate,
        EXPENSE_CUSTOM_FIELD_ENDPOINT.expenses.categoriesStatus,
      ],
      support: [EXPENSE_CUSTOM_FIELD_ENDPOINT.expenses.categoriesList],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    }),
    primaryMutationCount: 2,
    compensationCount: 0,
  },
  {
    ...internalAnnotation({
      name: "clockify_expenses_categories_delete",
      exposure: "composite",
      reason: "Archives an active category before deletion, so one invocation can contain two primary mutations; Task 6 must expose delete of an already archived category separately.",
      primary: [
        EXPENSE_CUSTOM_FIELD_ENDPOINT.expenses.categoriesStatus,
        EXPENSE_CUSTOM_FIELD_ENDPOINT.expenses.categoriesDelete,
      ],
      support: [EXPENSE_CUSTOM_FIELD_ENDPOINT.expenses.categoriesList],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    }),
    primaryMutationCount: 2,
    compensationCount: 0,
  },
  apiAnnotation({
    name: "clockify_custom_fields_list",
    operationId: "ofWorkspace",
    method: "GET",
    path: "/workspaces/{workspaceId}/custom-fields",
    access: "read",
    sourceModule: "custom-fields.ts",
    support: [],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [],
  }),
  internalAnnotation({
    name: "clockify_custom_fields_get",
    exposure: "composite",
    reason: "Finds one custom field by scanning the workspace custom-field list because Clockify exposes no usable GET /custom-fields/{id}; it is not a fabricated get-one operation.",
    primary: [EXPENSE_CUSTOM_FIELD_ENDPOINT.customFields.list],
    support: [],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
  {
    ...internalAnnotation({
      name: "clockify_custom_fields_create",
      exposure: "generic",
      reason: "The allowedValues array is unbounded, so material expansion cannot be statically capped at 22 facts; Task 6 must expose a narrowed create operation.",
      primary: [EXPENSE_CUSTOM_FIELD_ENDPOINT.customFields.create],
      support: [EXPENSE_CUSTOM_FIELD_ENDPOINT.customFields.list],
      availability: API_KEY_ONLY,
    }),
    primaryMutationCount: 1,
    compensationCount: 0,
  },
  {
    ...internalAnnotation({
      name: "clockify_custom_fields_update",
      exposure: "generic",
      reason: "The allowedValues array is unbounded, so material expansion cannot be statically capped at 22 facts; Task 6 must expose a narrowed update operation.",
      primary: [EXPENSE_CUSTOM_FIELD_ENDPOINT.customFields.update],
      support: [EXPENSE_CUSTOM_FIELD_ENDPOINT.customFields.list],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    }),
    primaryMutationCount: 1,
    compensationCount: 0,
  },
  {
    ...apiAnnotation({
      name: "clockify_custom_fields_delete",
      operationId: "delete",
      method: "DELETE",
      path: "/workspaces/{workspaceId}/custom-fields/{id}",
      access: "write",
      sourceModule: "custom-fields.ts",
      support: [EXPENSE_CUSTOM_FIELD_ENDPOINT.customFields.list],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
      materialFields: [
        materialField("/id", "Custom field", "entity", true),
        materialField("/name", "Custom field name", "text", false),
      ],
    }),
    primaryMutationCount: 1,
    compensationCount: 0,
  },
  {
    ...internalAnnotation({
      name: "clockify_custom_fields_set_value_project",
      exposure: "generic",
      reason: "The custom-field value accepts an unbounded string array, so material expansion cannot be statically capped at 22 facts; Task 6 must expose a bounded project-value operation.",
      primary: [EXPENSE_CUSTOM_FIELD_ENDPOINT.customFields.projectValue],
      support: [
        EXPENSE_CUSTOM_FIELD_ENDPOINT.projects.get,
        EXPENSE_CUSTOM_FIELD_ENDPOINT.customFields.list,
      ],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    }),
    primaryMutationCount: 1,
    compensationCount: 0,
  },
  {
    ...internalAnnotation({
      name: "clockify_custom_fields_set_value_entry",
      exposure: "generic",
      reason: "The custom-field value accepts an unbounded string array, so material expansion cannot be statically capped at 22 facts; Task 6 must expose a bounded entry-value operation.",
      primary: [EXPENSE_CUSTOM_FIELD_ENDPOINT.customFields.entryUpdate],
      support: [
        EXPENSE_CUSTOM_FIELD_ENDPOINT.customFields.entryRead,
        EXPENSE_CUSTOM_FIELD_ENDPOINT.customFields.list,
      ],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    }),
    primaryMutationCount: 1,
    compensationCount: 0,
  },
];

const USER_GROUP_ANNOTATIONS: readonly ExpectedActionAnnotation[] = [
  apiAnnotation({
    name: "clockify_users_list",
    operationId: "getUsersOfWorkspace",
    method: "GET",
    path: "/workspaces/{workspaceId}/users",
    access: "read",
    sourceModule: "users.ts",
    support: [],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [],
  }),
  {
    ...apiAnnotation({
      name: "clockify_users_invite",
      operationId: "addUsers",
      method: "POST",
      path: "/workspaces/{workspaceId}/users",
      access: "write",
      sourceModule: "users.ts",
      support: [USER_GROUP_ENDPOINT.users.list],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
      materialFields: [
        materialField("/email", "Email", "text", true),
        materialField("/sendEmail", "Send email", "boolean", true),
      ],
    }),
    primaryMutationCount: 1,
    compensationCount: 0,
  },
  {
    ...apiAnnotation({
      name: "clockify_users_role_update",
      operationId: "createUserRole",
      method: "POST",
      path: "/workspaces/{workspaceId}/users/{userId}/roles",
      access: "write",
      sourceModule: "users.ts",
      support: [
        USER_GROUP_ENDPOINT.users.list,
        USER_GROUP_ENDPOINT.groups.list,
        USER_GROUP_ENDPOINT.projects.list,
        USER_GROUP_ENDPOINT.projects.get,
        USER_GROUP_ENDPOINT.workspace,
      ],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
      materialFields: [
        materialField("/granteeId", "User", "entity", true),
        materialField("/role", "Role", "text", true),
        materialField("/entityId", "Role scope", "entity", true),
        materialField("/sourceType", "Scope type", "text", false),
      ],
    }),
    primaryMutationCount: 1,
    compensationCount: 0,
  },
  {
    ...internalAnnotation({
      name: "clockify_users_rate_update",
      exposure: "generic",
      reason: "Selects the hourly-rate or cost-rate endpoint from rateKind; Task 6 must split the dynamic mutation path.",
      primary: [USER_GROUP_ENDPOINT.users.rate],
      support: [USER_GROUP_ENDPOINT.users.list],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    }),
    primaryMutationCount: 1,
    compensationCount: 0,
  },
  {
    ...apiAnnotation({
      name: "clockify_users_deactivate",
      operationId: "updateUserStatus",
      method: "PUT",
      path: "/workspaces/{workspaceId}/users/{userId}",
      access: "write",
      sourceModule: "users.ts",
      support: [USER_GROUP_ENDPOINT.users.list],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
      materialFields: [materialField("/userId", "User", "entity", true)],
    }),
    primaryMutationCount: 1,
    compensationCount: 0,
  },
  apiAnnotation({
    name: "clockify_groups_list",
    operationId: "getUserGroups",
    method: "GET",
    path: "/workspaces/{workspaceId}/user-groups",
    access: "read",
    sourceModule: "users.ts",
    support: [],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [],
  }),
  internalAnnotation({
    name: "clockify_groups_get",
    exposure: "composite",
    reason: "Finds one user group by scanning the workspace group list because Clockify exposes no GET /user-groups/{id}; it is not a fabricated get-one operation.",
    primary: [USER_GROUP_ENDPOINT.groups.list],
    support: [],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
  {
    ...apiAnnotation({
      name: "clockify_groups_create",
      operationId: "createUserGroup",
      method: "POST",
      path: "/workspaces/{workspaceId}/user-groups",
      access: "write",
      sourceModule: "users.ts",
      support: [USER_GROUP_ENDPOINT.groups.list],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
      materialFields: [materialField("/name", "Group name", "text", true)],
    }),
    primaryMutationCount: 1,
    compensationCount: 0,
  },
  {
    ...apiAnnotation({
      name: "clockify_groups_update",
      operationId: "updateUserGroup",
      method: "PUT",
      path: "/workspaces/{workspaceId}/user-groups/{id}",
      access: "write",
      sourceModule: "users.ts",
      support: [USER_GROUP_ENDPOINT.groups.list],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
      materialFields: [
        materialField("/id", "Group", "entity", true),
        materialField("/name", "Group name", "text", true),
      ],
    }),
    primaryMutationCount: 1,
    compensationCount: 0,
  },
  {
    ...apiAnnotation({
      name: "clockify_groups_delete",
      operationId: "deleteUserGroup",
      method: "DELETE",
      path: "/workspaces/{workspaceId}/user-groups/{id}",
      access: "write",
      sourceModule: "users.ts",
      support: [USER_GROUP_ENDPOINT.groups.list],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
      materialFields: [
        materialField("/id", "Group", "entity", true),
        materialField("/name", "Group name", "text", false),
      ],
    }),
    primaryMutationCount: 1,
    compensationCount: 0,
  },
  {
    ...internalAnnotation({
      name: "clockify_groups_add_user",
      exposure: "composite",
      reason: "May add up to 14 users through independent membership POSTs, so the current bounded loop is not one atomic API operation; Task 6 must expose a single-user add.",
      primary: [USER_GROUP_ENDPOINT.groups.addUser],
      support: [USER_GROUP_ENDPOINT.groups.list, USER_GROUP_ENDPOINT.users.list],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    }),
    primaryMutationCount: 14,
    compensationCount: 0,
  },
  {
    ...apiAnnotation({
      name: "clockify_groups_remove_user",
      operationId: "deleteUser",
      method: "DELETE",
      path: "/workspaces/{workspaceId}/user-groups/{groupId}/users/{userId}",
      access: "write",
      sourceModule: "users.ts",
      support: [USER_GROUP_ENDPOINT.groups.list, USER_GROUP_ENDPOINT.users.list],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
      materialFields: [
        materialField("/groupId", "Group", "entity", true),
        materialField("/userId", "User", "entity", true),
      ],
    }),
    primaryMutationCount: 1,
    compensationCount: 0,
  },
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

  it.each([
    ...STRUCTURE_ANNOTATIONS,
    ...TIME_ENTRY_ANNOTATIONS,
    ...ADMINISTRATION_ANNOTATIONS,
    ...INVOICE_ANNOTATIONS,
    ...EXPENSE_CUSTOM_FIELD_ANNOTATIONS,
    ...USER_GROUP_ANNOTATIONS,
  ])(
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
        expected.exposure === "api"
          ? "v2-api"
          : expected.exposure === "local"
            ? "v2-local"
            : "v1-internal",
      )).not.toThrow();
      expect(actionFingerprintForDefinition(definition)).not.toBe(
        actionFingerprintForDefinition(withoutApiMetadata(definition)),
      );

      if (expected.primaryMutationCount !== undefined) {
        const plans = definition.writeAuthority?.mutationPlans ?? [];
        const count = (kind: "primary" | "compensation"): number => Math.max(
          0,
          ...plans.map((plan) => plan.steps
            .filter((step) => step.kind === kind)
            .reduce((sum, step) => sum + step.max, 0)),
        );
        expect(count("primary")).toBe(expected.primaryMutationCount);
        expect(count("compensation")).toBe(expected.compensationCount);
      }
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
