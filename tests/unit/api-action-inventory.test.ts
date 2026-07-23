import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  catalogHash,
  getAction,
} from "../../src/harness/catalog.js";
import { GROUP_MEMBER_BATCH_MAX } from "../../src/harness/safety-limits.js";

interface InventoryActionRow {
  name: string;
  kind: "read" | "safe_write" | "risky_write";
  featureGroup: string;
  workflowModule: string;
  exposure: "api" | "composite" | "generic" | "local";
  decisionReason: string;
  primaryMutationCount: number;
  compensationCount: number;
  boundedArgumentDictionaries: readonly { path: string }[];
  openSchemaVerdict: "closed" | "open" | "not_applicable";
  materialFields: readonly { kind: "value" | "array_item" | "dictionary_entry" }[];
  normalizedOperationMaterialContract: readonly TestMaterialContractEntry[];
  presentation: { presenterId: string; version: number } | null;
  operation: {
    host: "api" | "reports" | "audit";
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
  } | null;
  adapterShapes: readonly {
    role: "primary" | "support";
    host: "api" | "reports" | "audit";
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
  }[];
}

interface InventoryAdapterRow {
  key: string;
  host: "api" | "reports" | "audit";
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  decision: "model_api" | "internal_support" | "unavailable";
  mappedModelActionNames: readonly string[];
  internalSupportConsumers: readonly string[];
  sourceCallSites: readonly {
    sourceModule: string;
    sourceLine: number;
    sourceColumn: number;
  }[];
}

interface InventoryCorrelationRow {
  adapterKey: string;
  operations: readonly { operationId: string; method: string; path: string }[];
  unavailableReason?: "official_operation_id_missing";
}

interface ApiActionInventoryEvidence {
  schemaVersion: number;
  generatorVersion: number;
  catalogHash: string;
  officialOpenApi: {
    version: string;
    sha256: string;
    corroborationPath: string;
  };
  counts: {
    actions: number;
    rawAdapterCallSites: number;
    rawAdapterShapes: number;
    unclassifiedActions: number;
    unclassifiedAdapterShapes: number;
    exposures: { api: number; composite: number; generic: number; local: number };
  };
  actions: readonly InventoryActionRow[];
  adapterRequestShapes: readonly InventoryAdapterRow[];
  openApiCorrelations: readonly InventoryCorrelationRow[];
}

interface InventoryArtifacts {
  apiCatalogSource: string;
  evidenceJson: string;
  inventoryMarkdown: string;
}

interface InventoryGeneratorModule {
  buildApiActionInventoryEvidence(repositoryRoot: string): ApiActionInventoryEvidence;
  renderApiActionInventoryArtifacts(evidence: ApiActionInventoryEvidence): InventoryArtifacts;
  verifyOfficialOpenApiSnapshot?(
    repositoryRoot: string,
    operations: readonly never[],
  ): void;
}

function isInventoryGeneratorModule(value: unknown): value is InventoryGeneratorModule {
  return typeof value === "object" && value !== null
    && "buildApiActionInventoryEvidence" in value
    && typeof value.buildApiActionInventoryEvidence === "function"
    && "renderApiActionInventoryArtifacts" in value
    && typeof value.renderApiActionInventoryArtifacts === "function";
}

async function loadInventoryGeneratorModule(): Promise<InventoryGeneratorModule> {
  const sourceUrl = new URL("../../scripts/generate-api-action-inventory.ts", import.meta.url);
  if (!existsSync(fileURLToPath(sourceUrl))) {
    throw new Error("missing_api_action_inventory_generator");
  }
  const loaded: unknown = await import(/* @vite-ignore */ sourceUrl.href);
  if (!isInventoryGeneratorModule(loaded)) {
    throw new Error("invalid_api_action_inventory_generator");
  }
  return loaded;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

type RegistryId = "v1-internal" | "v2-api" | "v2-local";

interface InventoryEntry {
  sourceSurface: RegistryId;
  definition: ActionDefinition;
}

interface RegistryModule {
  normalizeRegistryAction(definition: unknown, registryId: RegistryId): ActionDefinition;
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

type TestMaterialContractEntry =
  | {
      kind: "value";
      path: string;
      scalarType: "string" | "number" | "boolean" | "null";
    }
  | {
      kind: "array_item";
      containerPath: string;
      itemPath: string;
      maxItems: number;
      scalarType: "string" | "number" | "boolean" | "null";
    }
  | {
      kind: "dictionary_entry";
      containerPath: string;
      valuePath: string;
      maxEntries: number;
      scalarType: "string" | "number" | "boolean" | "null";
    };

interface TestApiMetadata {
  apiExposure: "api" | "composite" | "generic" | "local";
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
  availabilityByAuthClass: { addon: AvailabilityDecision; api_key: AvailabilityDecision };
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
  normalizedOperationMaterialContract?: readonly TestMaterialContractEntry[];
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
    membershipState: structureEndpointKey("read", "GET", "/workspaces/{workspaceId}/projects/{projectId}", "projects.ts"),
    create: structureEndpointKey("write", "POST", "/workspaces/{workspaceId}/projects", "projects.ts"),
    fromTemplate: structureEndpointKey("write", "POST", "/workspaces/{workspaceId}/projects/from-template", "projects.ts"),
    update: structureEndpointKey("write", "PUT", "/workspaces/{workspaceId}/projects/{id}", "projects.ts"),
    delete: structureEndpointKey("write", "DELETE", "/workspaces/{workspaceId}/projects/{projectId}", "projects.ts"),
    rate: structureEndpointKey("write", "PUT", "/workspaces/{workspaceId}/projects/{projectId}/users/{userId}/{kind}", "projects.ts"),
    hourlyRate: structureEndpointKey("write", "PUT", "/workspaces/{workspaceId}/projects/{projectId}/users/{userId}/hourly-rate", "projects.ts"),
    costRate: structureEndpointKey("write", "PUT", "/workspaces/{workspaceId}/projects/{projectId}/users/{userId}/cost-rate", "projects.ts"),
    estimate: structureEndpointKey("write", "PATCH", "/workspaces/{workspaceId}/projects/{id}/estimate", "projects.ts"),
    memberships: structureEndpointKey("write", "PATCH", "/workspaces/{workspaceId}/projects/{id}/memberships", "projects.ts"),
  },
  tasks: {
    list: structureEndpointKey("read", "GET", "/workspaces/{workspaceId}/projects/{projectId}/tasks", "tasks.ts"),
    get: structureEndpointKey("read", "GET", "/workspaces/{workspaceId}/projects/{projectId}/tasks/{id}", "tasks.ts"),
    create: structureEndpointKey("write", "POST", "/workspaces/{workspaceId}/projects/{projectId}/tasks", "tasks.ts"),
    update: structureEndpointKey("write", "PUT", "/workspaces/{workspaceId}/projects/{projectId}/tasks/{id}", "tasks.ts"),
    delete: structureEndpointKey("write", "DELETE", "/workspaces/{workspaceId}/projects/{projectId}/tasks/{id}", "tasks.ts"),
    hourlyRate: structureEndpointKey("write", "PUT", "/workspaces/{workspaceId}/projects/{projectId}/tasks/{taskId}/hourly-rate", "tasks.ts"),
    costRate: structureEndpointKey("write", "PUT", "/workspaces/{workspaceId}/projects/{projectId}/tasks/{taskId}/cost-rate", "tasks.ts"),
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
    entityChanges: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/entities/created", "audit.ts"),
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
    hourlyRate: adapterEndpointKey("write", "api", "PUT", "/workspaces/{workspaceId}/users/{userId}/hourly-rate", "users.ts"),
    costRate: adapterEndpointKey("write", "api", "PUT", "/workspaces/{workspaceId}/users/{userId}/cost-rate", "users.ts"),
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

const TIME_OFF_APPROVAL_ENDPOINT = {
  policies: {
    list: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/time-off/policies", "time-off.ts"),
    get: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/time-off/policies/{id}", "time-off.ts"),
    create: adapterEndpointKey("write", "api", "POST", "/workspaces/{workspaceId}/time-off/policies", "time-off.ts"),
    update: adapterEndpointKey("write", "api", "PUT", "/workspaces/{workspaceId}/time-off/policies/{id}", "time-off.ts"),
    status: adapterEndpointKey("write", "api", "PATCH", "/workspaces/{workspaceId}/time-off/policies/{id}", "time-off.ts"),
  },
  requests: {
    list: adapterEndpointKey("read", "api", "POST", "/workspaces/{workspaceId}/time-off/requests", "time-off.ts"),
    create: adapterEndpointKey("write", "api", "POST", "/workspaces/{workspaceId}/time-off/policies/{policyId}/requests", "time-off.ts"),
    delete: adapterEndpointKey("write", "api", "DELETE", "/workspaces/{workspaceId}/time-off/policies/{policyId}/requests/{requestId}", "time-off.ts"),
    status: adapterEndpointKey("write", "api", "PATCH", "/workspaces/{workspaceId}/time-off/policies/{policyId}/requests/{requestId}", "time-off.ts"),
  },
  balance: {
    get: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/time-off/balance/user/{userId}", "time-off.ts"),
    update: adapterEndpointKey("write", "api", "PATCH", "/workspaces/{workspaceId}/time-off/balance/policy/{policyId}", "time-off.ts"),
  },
  approvals: {
    list: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/approval-requests", "approvals.ts"),
    submit: adapterEndpointKey("write", "api", "POST", "/workspaces/{workspaceId}/approval-requests", "approvals.ts"),
    status: adapterEndpointKey("write", "api", "PATCH", "/workspaces/{workspaceId}/approval-requests/{id}", "approvals.ts"),
    resubmit: adapterEndpointKey("write", "api", "POST", "/workspaces/{workspaceId}/approval-requests/resubmit-entries-for-approval", "approvals.ts"),
  },
  users: {
    list: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/users", "users.ts"),
  },
} as const;

const SCHEDULING_ENDPOINT = {
  assignments: {
    list: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/scheduling/assignments/all", "scheduling.ts"),
    create: adapterEndpointKey("write", "api", "POST", "/workspaces/{workspaceId}/scheduling/assignments/recurring", "scheduling.ts"),
    update: adapterEndpointKey("write", "api", "PATCH", "/workspaces/{workspaceId}/scheduling/assignments/recurring/{id}", "scheduling.ts"),
    delete: adapterEndpointKey("write", "api", "DELETE", "/workspaces/{workspaceId}/scheduling/assignments/recurring/{id}", "scheduling.ts"),
    publish: adapterEndpointKey("write", "api", "PUT", "/workspaces/{workspaceId}/scheduling/assignments/publish", "scheduling.ts"),
    projectTotalsAll: adapterEndpointKey("read", "api", "POST", "/workspaces/{workspaceId}/scheduling/assignments/projects/totals", "scheduling.ts"),
    projectTotalsOne: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/scheduling/assignments/projects/totals/{projectId}", "scheduling.ts"),
    userTotals: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/scheduling/assignments/users/{userId}/totals", "scheduling.ts"),
  },
  users: {
    list: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/users", "users.ts"),
  },
  projects: {
    list: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/projects", "projects.ts"),
    get: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/projects/{id}", "projects.ts"),
  },
} as const;

const NON_API_ENDPOINT = {
  projects: {
    list: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/projects", "projects.ts"),
    get: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/projects/{id}", "projects.ts"),
    update: adapterEndpointKey("write", "api", "PUT", "/workspaces/{workspaceId}/projects/{id}", "projects.ts"),
    delete: adapterEndpointKey("write", "api", "DELETE", "/workspaces/{workspaceId}/projects/{projectId}", "projects.ts"),
  },
  clients: {
    list: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/clients", "clients.ts"),
    get: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/clients/{id}", "clients.ts"),
    update: adapterEndpointKey("write", "api", "PUT", "/workspaces/{workspaceId}/clients/{id}", "clients.ts"),
    delete: adapterEndpointKey("write", "api", "DELETE", "/workspaces/{workspaceId}/clients/{id}", "clients.ts"),
  },
  tags: {
    list: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/tags", "tags.ts"),
    get: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/tags/{id}", "tags.ts"),
    update: adapterEndpointKey("write", "api", "PUT", "/workspaces/{workspaceId}/tags/{id}", "tags.ts"),
    delete: adapterEndpointKey("write", "api", "DELETE", "/workspaces/{workspaceId}/tags/{id}", "tags.ts"),
  },
  timeEntries: {
    get: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/time-entries/{id}", "time-entries.ts"),
    delete: adapterEndpointKey("write", "api", "DELETE", "/workspaces/{workspaceId}/time-entries/{id}", "time-entries.ts"),
  },
  invoices: {
    list: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/invoices", "invoices.ts"),
    get: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/invoices/{id}", "invoices.ts"),
    delete: adapterEndpointKey("write", "api", "DELETE", "/workspaces/{workspaceId}/invoices/{id}", "invoices.ts"),
  },
  expenses: {
    get: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/expenses/{id}", "expenses.ts"),
    delete: adapterEndpointKey("write", "api", "DELETE", "/workspaces/{workspaceId}/expenses/{id}", "expenses.ts"),
  },
  webhooks: {
    get: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/webhooks/{id}", "webhooks.ts"),
    delete: adapterEndpointKey("write", "api", "DELETE", "/workspaces/{workspaceId}/webhooks/{id}", "webhooks.ts"),
  },
  users: {
    list: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/users", "users.ts"),
    invite: adapterEndpointKey("write", "api", "POST", "/workspaces/{workspaceId}/users", "users.ts"),
  },
  groups: {
    list: adapterEndpointKey("read", "api", "GET", "/workspaces/{workspaceId}/user-groups", "users.ts"),
    addUser: adapterEndpointKey("write", "api", "POST", "/workspaces/{workspaceId}/user-groups/{groupId}/users", "users.ts"),
    delete: adapterEndpointKey("write", "api", "DELETE", "/workspaces/{workspaceId}/user-groups/{id}", "users.ts"),
  },
  reports: {
    summary: adapterEndpointKey("read", "reports", "POST", "/workspaces/{workspaceId}/reports/summary", "reports.ts"),
    detailed: adapterEndpointKey("read", "reports", "POST", "/workspaces/{workspaceId}/reports/detailed", "reports.ts"),
    weekly: adapterEndpointKey("read", "reports", "POST", "/workspaces/{workspaceId}/reports/weekly", "reports.ts"),
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
  apiAnnotation({
    name: "clockify_projects_delete_archived",
    operationId: "deleteProject",
    method: "DELETE",
    path: "/workspaces/{workspaceId}/projects/{projectId}",
    access: "write",
    sourceModule: "projects.ts",
    support: [STRUCTURE_ENDPOINT.projects.list, STRUCTURE_ENDPOINT.projects.get],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [
      materialField("/id", "Project", "entity", true),
      materialField("/name", "Project name", "text", false),
    ],
  }),
  internalAnnotation({
    name: "clockify_projects_rate_update",
    exposure: "generic",
    reason: "Selects the hourly-rate or cost-rate endpoint from rateKind; Task 6 must split the dynamic mutation path.",
    primary: [STRUCTURE_ENDPOINT.projects.rate],
    support: [STRUCTURE_ENDPOINT.projects.list, STRUCTURE_ENDPOINT.projects.get, STRUCTURE_ENDPOINT.projects.membershipState, STRUCTURE_ENDPOINT.users.list],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
  apiAnnotation({
    name: "clockify_projects_member_hourly_rate_update",
    operationId: "addUsersHourlyRate",
    method: "PUT",
    path: "/workspaces/{workspaceId}/projects/{projectId}/users/{userId}/hourly-rate",
    access: "write",
    sourceModule: "projects.ts",
    support: [STRUCTURE_ENDPOINT.projects.list, STRUCTURE_ENDPOINT.projects.get, STRUCTURE_ENDPOINT.projects.membershipState, STRUCTURE_ENDPOINT.users.list],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [
      materialField("/projectId", "Project", "entity", true),
      materialField("/userId", "Member", "entity", true),
      materialField("/amountMinor", "Hourly rate", "money-minor", true),
    ],
  }),
  apiAnnotation({
    name: "clockify_projects_member_cost_rate_update",
    operationId: "addUsersCostRate",
    method: "PUT",
    path: "/workspaces/{workspaceId}/projects/{projectId}/users/{userId}/cost-rate",
    access: "write",
    sourceModule: "projects.ts",
    support: [STRUCTURE_ENDPOINT.projects.list, STRUCTURE_ENDPOINT.projects.get, STRUCTURE_ENDPOINT.projects.membershipState, STRUCTURE_ENDPOINT.users.list],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [
      materialField("/projectId", "Project", "entity", true),
      materialField("/userId", "Member", "entity", true),
      materialField("/amountMinor", "Cost rate", "money-minor", true),
    ],
  }),
  apiAnnotation({
    name: "clockify_projects_estimate_update",
    operationId: "updateEstimate",
    method: "PATCH",
    path: "/workspaces/{workspaceId}/projects/{id}/estimate",
    access: "write",
    sourceModule: "projects.ts",
    support: [STRUCTURE_ENDPOINT.projects.get],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [
      materialField("/id", "Project", "entity", true),
      materialField("/fields/timeEstimate/estimate", "Time estimate", "text", false),
      materialField("/fields/budgetEstimate/estimate", "Budget estimate", "number", false),
      materialField("/fields/estimateReset/active", "Estimate reset active", "boolean", false),
    ],
  }),
  internalAnnotation({
    name: "clockify_projects_memberships_update",
    exposure: "generic",
    reason: "Accepts open membership rows and unbounded add/replace arrays; Task 6 must split and bound the membership operations.",
    primary: [STRUCTURE_ENDPOINT.projects.memberships],
    support: [STRUCTURE_ENDPOINT.projects.list, STRUCTURE_ENDPOINT.projects.get, STRUCTURE_ENDPOINT.projects.membershipState],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
  apiAnnotation({
    name: "clockify_projects_memberships_replace",
    operationId: "updateMemberships",
    method: "PATCH",
    path: "/workspaces/{workspaceId}/projects/{id}/memberships",
    access: "write",
    sourceModule: "projects.ts",
    support: [STRUCTURE_ENDPOINT.projects.list, STRUCTURE_ENDPOINT.projects.get, STRUCTURE_ENDPOINT.projects.membershipState],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [
      materialField("/id", "Project", "entity", true),
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
  apiAnnotation({
    name: "clockify_tasks_create",
    operationId: "createTask",
    method: "POST",
    path: "/workspaces/{workspaceId}/projects/{projectId}/tasks",
    access: "write",
    sourceModule: "tasks.ts",
    support: [STRUCTURE_ENDPOINT.projects.get, STRUCTURE_ENDPOINT.users.list, STRUCTURE_ENDPOINT.tasks.list],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [
      materialField("/projectId", "Project", "entity", true),
      materialField("/name", "Task name", "text", true),
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
  apiAnnotation({
    name: "clockify_tasks_update",
    operationId: "updateTask",
    method: "PUT",
    path: "/workspaces/{workspaceId}/projects/{projectId}/tasks/{id}",
    access: "write",
    sourceModule: "tasks.ts",
    support: [STRUCTURE_ENDPOINT.projects.list, STRUCTURE_ENDPOINT.projects.get, STRUCTURE_ENDPOINT.tasks.list, STRUCTURE_ENDPOINT.tasks.get],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [
      materialField("/projectId", "Project", "entity", true),
      materialField("/id", "Task", "entity", true),
      materialField("/patch/name", "Task name", "text", false),
      materialField("/patch/estimate", "Time estimate", "text", false),
      materialField("/patch/budgetEstimate", "Budget estimate", "number", false),
      materialField("/patch/billable", "Billable", "boolean", false),
    ],
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
    name: "clockify_tasks_delete_completed",
    operationId: "deleteTask",
    method: "DELETE",
    path: "/workspaces/{workspaceId}/projects/{projectId}/tasks/{id}",
    access: "write",
    sourceModule: "tasks.ts",
    support: [STRUCTURE_ENDPOINT.projects.list, STRUCTURE_ENDPOINT.projects.get, STRUCTURE_ENDPOINT.tasks.list, STRUCTURE_ENDPOINT.tasks.get],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [
      materialField("/projectId", "Project", "entity", true),
      materialField("/id", "Task", "entity", true),
      materialField("/name", "Task name", "text", false),
    ],
  }),
  apiAnnotation({
    name: "clockify_tasks_status_update",
    operationId: "updateTask",
    method: "PUT",
    path: "/workspaces/{workspaceId}/projects/{projectId}/tasks/{id}",
    access: "write",
    sourceModule: "tasks.ts",
    support: [STRUCTURE_ENDPOINT.projects.list, STRUCTURE_ENDPOINT.projects.get, STRUCTURE_ENDPOINT.tasks.list, STRUCTURE_ENDPOINT.tasks.get],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [
      materialField("/projectId", "Project", "entity", true),
      materialField("/id", "Task", "entity", true),
      materialField("/status", "Status", "text", true),
    ],
  }),
  apiAnnotation({
    name: "clockify_tasks_assignees_replace",
    operationId: "updateTask",
    method: "PUT",
    path: "/workspaces/{workspaceId}/projects/{projectId}/tasks/{id}",
    access: "write",
    sourceModule: "tasks.ts",
    support: [STRUCTURE_ENDPOINT.projects.list, STRUCTURE_ENDPOINT.projects.get, STRUCTURE_ENDPOINT.tasks.list, STRUCTURE_ENDPOINT.tasks.get, STRUCTURE_ENDPOINT.users.list],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [
      materialField("/projectId", "Project", "entity", true),
      materialField("/id", "Task", "entity", true),
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
  apiAnnotation({
    name: "clockify_tasks_hourly_rate_update",
    operationId: "setTaskHourlyRate",
    method: "PUT",
    path: "/workspaces/{workspaceId}/projects/{projectId}/tasks/{taskId}/hourly-rate",
    access: "write",
    sourceModule: "tasks.ts",
    support: [STRUCTURE_ENDPOINT.projects.list, STRUCTURE_ENDPOINT.projects.get, STRUCTURE_ENDPOINT.tasks.list, STRUCTURE_ENDPOINT.tasks.get],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [
      materialField("/projectId", "Project", "entity", true),
      materialField("/taskId", "Task", "entity", true),
      materialField("/amountMinor", "Hourly rate", "money-minor", true),
    ],
  }),
  apiAnnotation({
    name: "clockify_tasks_cost_rate_update",
    operationId: "setTaskCostRate",
    method: "PUT",
    path: "/workspaces/{workspaceId}/projects/{projectId}/tasks/{taskId}/cost-rate",
    access: "write",
    sourceModule: "tasks.ts",
    support: [STRUCTURE_ENDPOINT.projects.list, STRUCTURE_ENDPOINT.projects.get, STRUCTURE_ENDPOINT.tasks.list, STRUCTURE_ENDPOINT.tasks.get],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [
      materialField("/projectId", "Project", "entity", true),
      materialField("/taskId", "Task", "entity", true),
      materialField("/amountMinor", "Cost rate", "money-minor", true),
    ],
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
  apiAnnotation({
    name: "clockify_clients_create_base",
    operationId: "createClient",
    method: "POST",
    path: "/workspaces/{workspaceId}/clients",
    access: "write",
    sourceModule: "clients.ts",
    support: [STRUCTURE_ENDPOINT.clients.list],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [materialField("/body/name", "Client name", "text", true)],
  }),
  apiAnnotation({
    name: "clockify_clients_update",
    operationId: "updateClient",
    method: "PUT",
    path: "/workspaces/{workspaceId}/clients/{id}",
    access: "write",
    sourceModule: "clients.ts",
    support: [STRUCTURE_ENDPOINT.clients.list, STRUCTURE_ENDPOINT.clients.get, STRUCTURE_ENDPOINT.clients.currencies],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [
      materialField("/id", "Client", "entity", true),
      materialField("/patch/name", "Client name", "text", false),
      materialField("/patch/archived", "Archived", "boolean", false),
      materialField("/patch/ccEmails", "Billing CC emails", "text", false),
      materialField("/patch/currencyId", "Currency", "entity", false),
    ],
  }),
  apiAnnotation({
    name: "clockify_clients_archive",
    operationId: "updateClient",
    method: "PUT",
    path: "/workspaces/{workspaceId}/clients/{id}",
    access: "write",
    sourceModule: "clients.ts",
    support: [STRUCTURE_ENDPOINT.clients.list, STRUCTURE_ENDPOINT.clients.get],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [
      materialField("/id", "Client", "entity", true),
      materialField("/name", "Client name", "text", false),
      materialField("/body/archived", "Archived", "boolean", true),
    ],
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
    name: "clockify_clients_delete_archived",
    operationId: "deleteClient",
    method: "DELETE",
    path: "/workspaces/{workspaceId}/clients/{id}",
    access: "write",
    sourceModule: "clients.ts",
    support: [STRUCTURE_ENDPOINT.clients.list, STRUCTURE_ENDPOINT.clients.get],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [
      materialField("/id", "Client", "entity", true),
      materialField("/name", "Client name", "text", false),
    ],
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
      STRUCTURE_ENDPOINT.projects.membershipState,
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
  internalAnnotation({
    name: "clockify_status",
    exposure: "composite",
    reason: "Filters the running-timer list response and enriches it with a project name lookup, so it is not one exact Clockify read operation.",
    primary: [STRUCTURE_ENDPOINT.timeEntries.running],
    support: [STRUCTURE_ENDPOINT.projects.get],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
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
  apiAnnotation({
    name: "clockify_entries_create",
    operationId: "createTimeEntry",
    method: "POST",
    path: "/workspaces/{workspaceId}/time-entries",
    access: "write",
    sourceModule: "time-entries.ts",
    support: [
      STRUCTURE_ENDPOINT.projects.list,
      STRUCTURE_ENDPOINT.projects.get,
      STRUCTURE_ENDPOINT.tasks.list,
      STRUCTURE_ENDPOINT.tasks.get,
      STRUCTURE_ENDPOINT.tags.list,
      STRUCTURE_ENDPOINT.timeEntries.running,
    ],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [
      materialField("/start", "Start time", "text", true),
      materialField("/end", "End time", "text", false),
      materialField("/description", "Description", "text", false),
      materialField("/projectId", "Project", "entity", false),
      materialField("/taskId", "Task", "entity", false),
      materialField("/billable", "Billable", "boolean", false),
      {
        kind: "array_item",
        containerPath: "/tagIds",
        itemPath: "",
        labelTemplate: "Tag {index}",
        maxItems: 14,
        formatterId: "entity",
        formatterVersion: 1,
        requiredInPreview: false,
      },
    ],
  }),
  apiAnnotation({
    name: "clockify_entries_start",
    operationId: "createTimeEntry",
    method: "POST",
    path: "/workspaces/{workspaceId}/time-entries",
    access: "write",
    sourceModule: "time-entries.ts",
    support: [
      STRUCTURE_ENDPOINT.projects.list,
      STRUCTURE_ENDPOINT.projects.get,
      STRUCTURE_ENDPOINT.tasks.list,
      STRUCTURE_ENDPOINT.tasks.get,
      STRUCTURE_ENDPOINT.tags.list,
      STRUCTURE_ENDPOINT.timeEntries.running,
    ],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [
      materialField("/description", "Description", "text", false),
      materialField("/projectId", "Project", "entity", false),
      materialField("/taskId", "Task", "entity", false),
      materialField("/billable", "Billable", "boolean", false),
      {
        kind: "array_item",
        containerPath: "/tagIds",
        itemPath: "",
        labelTemplate: "Tag {index}",
        maxItems: 14,
        formatterId: "entity",
        formatterVersion: 1,
        requiredInPreview: false,
      },
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
    reason: "Superseded on MODEL_API by clockify_entries_update, which bounds tagIds for material expansion; retained for legacy planner paths.",
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
    name: "clockify_entries_update",
    operationId: "updateTimeEntry",
    method: "PUT",
    path: "/workspaces/{workspaceId}/time-entries/{id}",
    access: "write",
    sourceModule: "time-entries.ts",
    support: [
      STRUCTURE_ENDPOINT.timeEntries.get,
      STRUCTURE_ENDPOINT.projects.list,
      STRUCTURE_ENDPOINT.projects.get,
      STRUCTURE_ENDPOINT.tasks.list,
      STRUCTURE_ENDPOINT.tasks.get,
      STRUCTURE_ENDPOINT.tags.list,
    ],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [
      materialField("/id", "Time entry", "entity", true),
      materialField("/description", "Description", "text", false),
      materialField("/projectId", "Project", "entity", false),
      materialField("/taskId", "Task", "entity", false),
      materialField("/billable", "Billable", "boolean", false),
      {
        kind: "array_item",
        containerPath: "/tagIds",
        itemPath: "",
        labelTemplate: "Tag {index}",
        maxItems: 14,
        formatterId: "entity",
        formatterVersion: 1,
        requiredInPreview: false,
      },
    ],
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
  apiAnnotation({
    name: "clockify_entries_mark_invoiced",
    operationId: "updateInvoicedStatus",
    method: "PATCH",
    path: "/workspaces/{workspaceId}/time-entries/invoiced",
    access: "write",
    sourceModule: "time-entries.ts",
    support: [STRUCTURE_ENDPOINT.timeEntries.get],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [
      materialField("/invoiced", "Invoiced", "boolean", true),
      {
        kind: "array_item",
        containerPath: "/ids",
        itemPath: "",
        labelTemplate: "Entry {index}",
        maxItems: 21,
        formatterId: "entity",
        formatterVersion: 1,
        requiredInPreview: true,
      },
    ],
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
  apiAnnotation({
    name: "clockify_entity_changes_created",
    operationId: "getCreatedEntityInfo",
    method: "GET",
    path: "/workspaces/{workspaceId}/entities/created",
    access: "read",
    sourceModule: "audit.ts",
    support: [],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [],
  }),
  apiAnnotation({
    name: "clockify_entity_changes_updated",
    operationId: "getUpdatedEntityInfo",
    method: "GET",
    path: "/workspaces/{workspaceId}/entities/updated",
    access: "read",
    sourceModule: "audit.ts",
    support: [],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [],
  }),
  apiAnnotation({
    name: "clockify_entity_changes_deleted",
    operationId: "getDeletedEntityInfo",
    method: "GET",
    path: "/workspaces/{workspaceId}/entities/deleted",
    access: "read",
    sourceModule: "audit.ts",
    support: [],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [],
  }),
  internalAnnotation({
    name: "clockify_entity_changes_list",
    exposure: "generic",
    reason: "Selects the created, updated, or deleted entity-change endpoint from changeType; superseded on MODEL_API by the three literal entity-change reads.",
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
  apiAnnotation({
    name: "clockify_holidays_create",
    operationId: "createHoliday",
    method: "POST",
    path: "/workspaces/{workspaceId}/holidays",
    access: "write",
    sourceModule: "holidays.ts",
    support: [
      ADMINISTRATION_ENDPOINT.holidays.list,
      ADMINISTRATION_ENDPOINT.users.list,
      ADMINISTRATION_ENDPOINT.users.groups,
    ],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [
      materialField("/name", "Holiday name", "text", true),
      materialField("/startDate", "Start date", "text", true),
      materialField("/endDate", "End date", "text", false),
      materialField("/occursAnnually", "Recurs annually", "boolean", false),
      {
        kind: "array_item",
        containerPath: "/userIds",
        itemPath: "/userId",
        labelTemplate: "User {index}",
        maxItems: 8,
        formatterId: "entity",
        formatterVersion: 1,
        requiredInPreview: false,
      },
      {
        kind: "array_item",
        containerPath: "/userGroupIds",
        itemPath: "/groupId",
        labelTemplate: "Group {index}",
        maxItems: 8,
        formatterId: "entity",
        formatterVersion: 1,
        requiredInPreview: false,
      },
    ],
  }),
  apiAnnotation({
    name: "clockify_holidays_update",
    operationId: "updateHoliday",
    method: "PUT",
    path: "/workspaces/{workspaceId}/holidays/{id}",
    access: "write",
    sourceModule: "holidays.ts",
    support: [
      ADMINISTRATION_ENDPOINT.holidays.list,
      ADMINISTRATION_ENDPOINT.users.list,
      ADMINISTRATION_ENDPOINT.users.groups,
    ],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [
      materialField("/id", "Holiday", "entity", true),
      materialField("/name", "Holiday name", "text", false),
      materialField("/startDate", "Start date", "text", false),
      materialField("/endDate", "End date", "text", false),
      materialField("/occursAnnually", "Recurs annually", "boolean", false),
      {
        kind: "array_item",
        containerPath: "/userIds",
        itemPath: "/userId",
        labelTemplate: "User {index}",
        maxItems: 8,
        formatterId: "entity",
        formatterVersion: 1,
        requiredInPreview: false,
      },
      {
        kind: "array_item",
        containerPath: "/userGroupIds",
        itemPath: "/groupId",
        labelTemplate: "Group {index}",
        maxItems: 8,
        formatterId: "entity",
        formatterVersion: 1,
        requiredInPreview: false,
      },
    ],
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
  ...([
    ["clockify_users_hourly_rate_update", "setHourlyRateForUser", "/workspaces/{workspaceId}/users/{userId}/hourly-rate", USER_GROUP_ENDPOINT.users.hourlyRate, "Hourly rate"] as const,
    ["clockify_users_cost_rate_update", "setCostRateForUser", "/workspaces/{workspaceId}/users/{userId}/cost-rate", USER_GROUP_ENDPOINT.users.costRate, "Cost rate"] as const,
  ].map(([name, operationId, path, primary, rateLabel]) => ({
    ...apiAnnotation({
      name,
      operationId,
      method: "PUT",
      path,
      access: "write",
      sourceModule: "users.ts",
      support: [USER_GROUP_ENDPOINT.users.list],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
      materialFields: [
        materialField("/userId", "Member", "entity", true),
        materialField("/amountMinor", rateLabel, "money-minor", true),
      ],
    }),
    primaryMutationCount: 1,
    compensationCount: 0,
  }))),
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

const TIME_OFF_APPROVAL_ANNOTATIONS: readonly ExpectedActionAnnotation[] = [
  apiAnnotation({
    name: "clockify_time_off_policies_list",
    operationId: "findPoliciesForWorkspace",
    method: "GET",
    path: "/workspaces/{workspaceId}/time-off/policies",
    access: "read",
    sourceModule: "time-off.ts",
    support: [],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [],
  }),
  apiAnnotation({
    name: "clockify_time_off_policies_get",
    operationId: "getPolicy",
    method: "GET",
    path: "/workspaces/{workspaceId}/time-off/policies/{id}",
    access: "read",
    sourceModule: "time-off.ts",
    support: [TIME_OFF_APPROVAL_ENDPOINT.policies.list],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [],
  }),
  {
    ...internalAnnotation({
      name: "clockify_time_off_policies_create",
      exposure: "generic",
      reason: "The userIds and userGroupIds arrays are unbounded, so material expansion cannot be statically capped at 22 facts; Task 6 must expose a narrowed policy create operation.",
      primary: [TIME_OFF_APPROVAL_ENDPOINT.policies.create],
      support: [TIME_OFF_APPROVAL_ENDPOINT.policies.list, TIME_OFF_APPROVAL_ENDPOINT.users.list],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    }),
    primaryMutationCount: 1,
    compensationCount: 0,
  },
  {
    ...internalAnnotation({
      name: "clockify_time_off_policies_update",
      exposure: "generic",
      reason: "The userIds and userGroupIds arrays are unbounded, so material expansion cannot be statically capped at 22 facts; Task 6 must expose a narrowed policy update operation.",
      primary: [TIME_OFF_APPROVAL_ENDPOINT.policies.update],
      support: [TIME_OFF_APPROVAL_ENDPOINT.policies.get, TIME_OFF_APPROVAL_ENDPOINT.users.list],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    }),
    primaryMutationCount: 1,
    compensationCount: 0,
  },
  {
    ...apiAnnotation({
      name: "clockify_time_off_policies_archive",
      operationId: "updatePolicyStatus",
      method: "PATCH",
      path: "/workspaces/{workspaceId}/time-off/policies/{id}",
      access: "write",
      sourceModule: "time-off.ts",
      support: [TIME_OFF_APPROVAL_ENDPOINT.policies.get],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
      materialFields: [
        materialField("/id", "Policy", "entity", true),
        materialField("/name", "Policy name", "text", false),
        materialField("/archived", "Archived", "boolean", true),
      ],
    }),
    primaryMutationCount: 1,
    compensationCount: 0,
  },
  apiAnnotation({
    name: "clockify_time_off_requests_list",
    operationId: "getTimeOffRequest",
    method: "POST",
    path: "/workspaces/{workspaceId}/time-off/requests",
    access: "read",
    sourceModule: "time-off.ts",
    support: [TIME_OFF_APPROVAL_ENDPOINT.users.list],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [],
  }),
  internalAnnotation({
    name: "clockify_time_off_requests_get",
    exposure: "composite",
    reason: "Finds one request by scanning the POST request-search result because Clockify exposes no GET request-by-id operation; it is not a fabricated get-one operation.",
    primary: [TIME_OFF_APPROVAL_ENDPOINT.requests.list],
    support: [],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
  {
    ...apiAnnotation({
      name: "clockify_time_off_requests_create",
      operationId: "createTimeOffRequest",
      method: "POST",
      path: "/workspaces/{workspaceId}/time-off/policies/{policyId}/requests",
      access: "write",
      sourceModule: "time-off.ts",
      support: [
        TIME_OFF_APPROVAL_ENDPOINT.policies.list,
        TIME_OFF_APPROVAL_ENDPOINT.policies.get,
        TIME_OFF_APPROVAL_ENDPOINT.requests.list,
        TIME_OFF_APPROVAL_ENDPOINT.balance.get,
      ],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
      materialFields: [
        materialField("/policyId", "Policy", "entity", true),
        materialField("/input/start", "Start", "text", true),
        materialField("/input/end", "End", "text", true),
        materialField("/input/timeUnit", "Time unit", "text", false),
        materialField("/input/days", "Days", "number", false),
        materialField("/input/halfDay", "Half day", "boolean", false),
        materialField("/input/note", "Note", "text", false),
      ],
    }),
    primaryMutationCount: 1,
    compensationCount: 0,
  },
  {
    ...apiAnnotation({
      name: "clockify_time_off_requests_delete",
      operationId: "deleteTimeOffRequest",
      method: "DELETE",
      path: "/workspaces/{workspaceId}/time-off/policies/{policyId}/requests/{requestId}",
      access: "write",
      sourceModule: "time-off.ts",
      support: [TIME_OFF_APPROVAL_ENDPOINT.requests.list, TIME_OFF_APPROVAL_ENDPOINT.policies.get],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
      materialFields: [
        materialField("/policyId", "Policy", "entity", true),
        materialField("/requestId", "Request", "entity", true),
      ],
    }),
    primaryMutationCount: 1,
    compensationCount: 0,
  },
  ...(["approve", "deny"] as const).map((decision): ExpectedActionAnnotation => ({
    ...apiAnnotation({
      name: `clockify_time_off_${decision}`,
      operationId: "changeTimeOffRequestStatus",
      method: "PATCH",
      path: "/workspaces/{workspaceId}/time-off/policies/{policyId}/requests/{requestId}",
      access: "write",
      sourceModule: "time-off.ts",
      support: [TIME_OFF_APPROVAL_ENDPOINT.requests.list, TIME_OFF_APPROVAL_ENDPOINT.policies.get],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
      materialFields: [
        materialField("/policyId", "Policy", "entity", true),
        materialField("/requestId", "Request", "entity", true),
        materialField("/note", "Note", "text", false),
      ],
    }),
    primaryMutationCount: 1,
    compensationCount: 0,
  })),
  apiAnnotation({
    name: "clockify_time_off_balance_get",
    operationId: "getBalancesForUser",
    method: "GET",
    path: "/workspaces/{workspaceId}/time-off/balance/user/{userId}",
    access: "read",
    sourceModule: "time-off.ts",
    support: [TIME_OFF_APPROVAL_ENDPOINT.users.list],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [],
  }),
  {
    ...internalAnnotation({
      name: "clockify_time_off_balance_update",
      exposure: "generic",
      reason: "The current 27-user batch maximum exceeds the 22-fact material presentation limit; Task 6 must expose a narrower balance update operation.",
      primary: [TIME_OFF_APPROVAL_ENDPOINT.balance.update],
      support: [
        TIME_OFF_APPROVAL_ENDPOINT.policies.list,
        TIME_OFF_APPROVAL_ENDPOINT.policies.get,
        TIME_OFF_APPROVAL_ENDPOINT.users.list,
        TIME_OFF_APPROVAL_ENDPOINT.balance.get,
      ],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    }),
    primaryMutationCount: 1,
    compensationCount: 0,
  },
  apiAnnotation({
    name: "clockify_approvals_list",
    operationId: "getApprovalRequests",
    method: "GET",
    path: "/workspaces/{workspaceId}/approval-requests",
    access: "read",
    sourceModule: "approvals.ts",
    support: [],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [],
  }),
  internalAnnotation({
    name: "clockify_approvals_get",
    exposure: "composite",
    reason: "Finds one approval request by scanning the approval-request list because Clockify exposes no GET approval-by-id operation; it is not a fabricated get-one operation.",
    primary: [TIME_OFF_APPROVAL_ENDPOINT.approvals.list],
    support: [],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
  {
    ...apiAnnotation({
      name: "clockify_approvals_submit",
      operationId: "createApprrovalRequest",
      method: "POST",
      path: "/workspaces/{workspaceId}/approval-requests",
      access: "write",
      sourceModule: "approvals.ts",
      support: [TIME_OFF_APPROVAL_ENDPOINT.approvals.list],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
      materialFields: [
        materialField("/period", "Period", "text", true),
        materialField("/periodStart", "Period start", "text", true),
      ],
    }),
    primaryMutationCount: 1,
    compensationCount: 0,
  },
  ...(["approve", "reject"] as const).map((decision): ExpectedActionAnnotation => ({
    ...apiAnnotation({
      name: `clockify_approvals_${decision}`,
      operationId: "updateApprovalStatus",
      method: "PATCH",
      path: "/workspaces/{workspaceId}/approval-requests/{id}",
      access: "write",
      sourceModule: "approvals.ts",
      support: [TIME_OFF_APPROVAL_ENDPOINT.approvals.list],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
      materialFields: [
        materialField("/id", "Approval", "entity", true),
        materialField("/state", "State", "text", true),
        materialField("/note", "Note", "text", false),
      ],
    }),
    primaryMutationCount: 1,
    compensationCount: 0,
  })),
  {
    ...internalAnnotation({
      name: "clockify_approvals_approve_pending",
      exposure: "composite",
      reason: "May approve up to 18 requests through independent status PATCHes, so the current approve-all loop is not one atomic API operation; use the single-request approval operation.",
      primary: [TIME_OFF_APPROVAL_ENDPOINT.approvals.status],
      support: [TIME_OFF_APPROVAL_ENDPOINT.approvals.list],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    }),
    primaryMutationCount: 18,
    compensationCount: 0,
  },
  {
    ...apiAnnotation({
      name: "clockify_approvals_withdraw",
      operationId: "updateApprovalStatus",
      method: "PATCH",
      path: "/workspaces/{workspaceId}/approval-requests/{id}",
      access: "write",
      sourceModule: "approvals.ts",
      support: [TIME_OFF_APPROVAL_ENDPOINT.approvals.list],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
      materialFields: [
        materialField("/id", "Approval", "entity", true),
        materialField("/state", "State", "text", true),
        materialField("/note", "Note", "text", false),
      ],
    }),
    primaryMutationCount: 1,
    compensationCount: 0,
  },
  {
    ...apiAnnotation({
      name: "clockify_approvals_resubmit",
      operationId: "resubmitApprovalRequest",
      method: "POST",
      path: "/workspaces/{workspaceId}/approval-requests/resubmit-entries-for-approval",
      access: "write",
      sourceModule: "approvals.ts",
      support: [TIME_OFF_APPROVAL_ENDPOINT.approvals.list],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
      materialFields: [
        materialField("/approvalId", "Approval", "entity", true),
        materialField("/period", "Period", "text", true),
        materialField("/periodStart", "Period start", "text", true),
      ],
    }),
    primaryMutationCount: 1,
    compensationCount: 0,
  },
];

const SCHEDULING_ANNOTATIONS: readonly ExpectedActionAnnotation[] = [
  apiAnnotation({
    name: "clockify_scheduling_assignments_list",
    operationId: "getAllAssignments",
    method: "GET",
    path: "/workspaces/{workspaceId}/scheduling/assignments/all",
    access: "read",
    sourceModule: "scheduling.ts",
    support: [SCHEDULING_ENDPOINT.users.list],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [],
  }),
  internalAnnotation({
    name: "clockify_scheduling_assignments_get",
    exposure: "composite",
    reason: "Finds one assignment by scanning the assignment list because Clockify exposes no usable GET assignment-by-id operation; it is not a fabricated get-one operation.",
    primary: [SCHEDULING_ENDPOINT.assignments.list],
    support: [],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
  {
    ...apiAnnotation({
      name: "clockify_scheduling_assignments_create",
      operationId: "createRecurring",
      method: "POST",
      path: "/workspaces/{workspaceId}/scheduling/assignments/recurring",
      access: "write",
      sourceModule: "scheduling.ts",
      support: [
        SCHEDULING_ENDPOINT.users.list,
        SCHEDULING_ENDPOINT.projects.list,
        SCHEDULING_ENDPOINT.projects.get,
        SCHEDULING_ENDPOINT.assignments.list,
      ],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
      materialFields: [
        materialField("/input/userId", "User", "entity", true),
        materialField("/input/projectId", "Project", "entity", true),
        materialField("/input/start", "Start", "text", true),
        materialField("/input/end", "End", "text", true),
        materialField("/input/hoursPerDay", "Hours per day", "number", true),
        materialField("/input/note", "Note", "text", false),
      ],
    }),
    primaryMutationCount: 1,
    compensationCount: 0,
  },
  {
    ...apiAnnotation({
      name: "clockify_scheduling_assignments_update",
      operationId: "editRecurring",
      method: "PATCH",
      path: "/workspaces/{workspaceId}/scheduling/assignments/recurring/{id}",
      access: "write",
      sourceModule: "scheduling.ts",
      support: [SCHEDULING_ENDPOINT.assignments.list],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
      materialFields: [
        materialField("/id", "Assignment", "entity", true),
        materialField("/patch/hoursPerDay", "Hours per day", "number", false),
        materialField("/patch/note", "Note", "text", false),
        materialField("/patch/seriesUpdateOption", "Series update", "text", false),
      ],
    }),
    primaryMutationCount: 1,
    compensationCount: 0,
  },
  {
    ...apiAnnotation({
      name: "clockify_scheduling_assignments_delete",
      operationId: "deleteRRecurringAssignment",
      method: "DELETE",
      path: "/workspaces/{workspaceId}/scheduling/assignments/recurring/{id}",
      access: "write",
      sourceModule: "scheduling.ts",
      support: [SCHEDULING_ENDPOINT.assignments.list],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
      materialFields: [
        materialField("/id", "Assignment", "entity", true),
        materialField("/seriesUpdateOption", "Series update", "text", false),
      ],
    }),
    primaryMutationCount: 1,
    compensationCount: 0,
  },
  {
    ...apiAnnotation({
      name: "clockify_scheduling_publish",
      operationId: "publishAssignments",
      method: "PUT",
      path: "/workspaces/{workspaceId}/scheduling/assignments/publish",
      access: "write",
      sourceModule: "scheduling.ts",
      support: [SCHEDULING_ENDPOINT.assignments.list, SCHEDULING_ENDPOINT.users.list],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
      materialFields: [
        materialField("/start", "Start", "text", true),
        materialField("/end", "End", "text", true),
        materialField("/notifyUsers", "Notify users", "boolean", false),
        materialField("/userId", "User", "entity", false),
      ],
    }),
    primaryMutationCount: 1,
    compensationCount: 0,
  },
  internalAnnotation({
    name: "clockify_scheduling_project_totals",
    exposure: "generic",
    reason: "Selects POST all-project totals or GET one-project totals from the optional project filter; Task 6 must split the two official operations.",
    primary: [
      SCHEDULING_ENDPOINT.assignments.projectTotalsAll,
      SCHEDULING_ENDPOINT.assignments.projectTotalsOne,
    ],
    support: [SCHEDULING_ENDPOINT.projects.list],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
  apiAnnotation({
    name: "clockify_scheduling_user_totals",
    operationId: "getUserTotalsForSingleUser",
    method: "GET",
    path: "/workspaces/{workspaceId}/scheduling/assignments/users/{userId}/totals",
    access: "read",
    sourceModule: "scheduling.ts",
    support: [SCHEDULING_ENDPOINT.users.list],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    materialFields: [],
  }),
];

const NON_API_ANNOTATIONS: readonly ExpectedActionAnnotation[] = [
  {
    ...internalAnnotation({
      name: "clockify_delete_entity",
      exposure: "generic",
      reason: "Selects unrelated entity delete endpoints and may archive a project or client before deletion with compensation; Task 6 must use the typed atomic operations.",
      primary: [
        NON_API_ENDPOINT.projects.update,
        NON_API_ENDPOINT.projects.delete,
        NON_API_ENDPOINT.clients.update,
        NON_API_ENDPOINT.clients.delete,
        NON_API_ENDPOINT.tags.delete,
        NON_API_ENDPOINT.timeEntries.delete,
        NON_API_ENDPOINT.invoices.delete,
        NON_API_ENDPOINT.expenses.delete,
        NON_API_ENDPOINT.webhooks.delete,
        NON_API_ENDPOINT.groups.delete,
      ],
      support: [
        NON_API_ENDPOINT.projects.list,
        NON_API_ENDPOINT.projects.get,
        NON_API_ENDPOINT.clients.list,
        NON_API_ENDPOINT.clients.get,
        NON_API_ENDPOINT.tags.list,
        NON_API_ENDPOINT.tags.get,
        NON_API_ENDPOINT.timeEntries.get,
        NON_API_ENDPOINT.invoices.list,
        NON_API_ENDPOINT.invoices.get,
        NON_API_ENDPOINT.expenses.get,
        NON_API_ENDPOINT.webhooks.get,
        NON_API_ENDPOINT.groups.list,
      ],
      availability: API_KEY_ONLY,
    }),
    primaryMutationCount: 2,
    compensationCount: 1,
  },
  {
    name: "assistant_update_permissions",
    exposure: "local",
    reason: "Updates only the caller's persisted assistant policy and performs no Clockify request.",
    endpoints: undefined,
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  },
  {
    ...internalAnnotation({
      name: "clockify_update_entity",
      exposure: "generic",
      reason: "Selects the project, client, or tag update endpoint from entityType and accepts an open fields record; Task 6 must use operation-specific closed updates.",
      primary: [
        NON_API_ENDPOINT.projects.update,
        NON_API_ENDPOINT.clients.update,
        NON_API_ENDPOINT.tags.update,
      ],
      support: [
        NON_API_ENDPOINT.projects.list,
        NON_API_ENDPOINT.projects.get,
        NON_API_ENDPOINT.clients.list,
        NON_API_ENDPOINT.clients.get,
        NON_API_ENDPOINT.tags.list,
        NON_API_ENDPOINT.tags.get,
      ],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    }),
    primaryMutationCount: 1,
    compensationCount: 0,
  },
  {
    name: "assistant_show_permissions",
    exposure: "local",
    reason: "Reads only the caller's in-process assistant policy and performs no Clockify request.",
    endpoints: undefined,
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  },
  {
    name: "assistant_recent_outcomes",
    exposure: "local",
    reason: "Reads only locally audited assistant outcomes and performs no Clockify request.",
    endpoints: undefined,
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  },
  internalAnnotation({
    name: "clockify_period_report",
    exposure: "composite",
    reason: "Resolves a named period and selects summary, detailed, or weekly report execution; the exact report operations remain the API surface.",
    primary: [
      NON_API_ENDPOINT.reports.summary,
      NON_API_ENDPOINT.reports.detailed,
      NON_API_ENDPOINT.reports.weekly,
    ],
    support: [],
    availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
  }),
  {
    ...internalAnnotation({
      name: "clockify_onboard_user",
      exposure: "composite",
      reason: "Invites one user and may add them to up to 13 groups through independent membership POSTs; the atomic invite and single-membership operations remain the API surface.",
      primary: [NON_API_ENDPOINT.users.invite, NON_API_ENDPOINT.groups.addUser],
      support: [NON_API_ENDPOINT.users.list, NON_API_ENDPOINT.groups.list],
      availability: AVAILABLE_TO_BOTH_AUTH_CLASSES,
    }),
    primaryMutationCount: 14,
    compensationCount: 0,
  },
];

const ADAPTER_ENDPOINT_KEYS = new Set(
  extractAdapterEndpoints(fileURLToPath(new URL("../..", import.meta.url)))
    .map(adapterRequestShapeKey),
);

function withoutApiMetadata(definition: ActionDefinition): object {
  const {
    apiExposure: _apiExposure,
    apiExposureReason: _apiExposureReason,
    apiOperation: _apiOperation,
    adapterEndpoints: _adapterEndpoints,
    availabilityByAuthClass: _availabilityByAuthClass,
    boundedArgumentDictionaries: _boundedArgumentDictionaries,
    materialFields: _materialFields,
    normalizedOperationMaterialContract: _normalizedOperationMaterialContract,
    presentation: _presentation,
    ...legacyDefinition
  } = definition;
  return legacyDefinition;
}

describe("API action inventory normalization", () => {
  it("fails closed when the repository-owned official OpenAPI snapshot is missing", async () => {
    const generator = await loadInventoryGeneratorModule();
    const repositoryRoot = mkdtempSync(join(tmpdir(), "missing-official-openapi-"));
    try {
      const verifySnapshot = generator.verifyOfficialOpenApiSnapshot;
      expect(verifySnapshot).toBeTypeOf("function");
      if (!verifySnapshot) {
        throw new Error("missing_official_openapi_verifier");
      }
      expect(() => verifySnapshot(repositoryRoot, []))
        .toThrowError("official_openapi_source_missing");
    } finally {
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  });

  it("keeps undo as a local service outside the action-definition inventory", () => {
    expect(getAction("undo")).toBeUndefined();
    expect(ACTION_CATALOG.some((definition) => definition.name === "undo")).toBe(false);
  });

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
    ...TIME_OFF_APPROVAL_ANNOTATIONS,
    ...SCHEDULING_ANNOTATIONS,
    ...NON_API_ANNOTATIONS,
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
        expect(definition.normalizedOperationMaterialContract ?? []).toHaveLength(
          definition.kind === "read" ? 0 : expected.materialFields.length,
        );
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
      const changedExposure = definition.apiExposure === "local" ? "generic" : "local";
      expect(actionFingerprintForDefinition(definition)).not.toBe(
        actionFingerprintForDefinition({ ...definition, apiExposure: changedExposure }),
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

  it("freezes a scalar normalized-operation contract for every material write field", () => {
    expect(fixtureAction("clockify_tags_create")).toMatchObject({
      normalizedOperationMaterialContract: [{
        kind: "value",
        path: "/body/name",
        scalarType: "string",
      }],
    });
  });

  it("rejects a material pointer outside the frozen normalized-operation contract", async () => {
    const registry = await loadRegistryModule();
    expect(() => registry.normalizeRegistryAction({
      ...fixtureAction("clockify_tags_create"),
      ...TAG_METADATA,
      normalizedOperationMaterialContract: [{
        kind: "value",
        path: "/body/name",
        scalarType: "string",
      }],
      materialFields: [{
        kind: "value",
        path: "/definitely/not/in/the/prepared-operation",
        label: "Invented",
        formatterId: "text",
        formatterVersion: 1,
        requiredInPreview: true,
      }],
    }, "v2-api")).toThrowError(
      "undeclared_material_pointer:clockify_tags_create:/definitely/not/in/the/prepared-operation",
    );
  });

  it("rejects incomplete or scalar-incompatible normalized-operation contracts", async () => {
    const registry = await loadRegistryModule();
    const definition = fixtureAction("clockify_tags_create");
    expect(() => registry.normalizeRegistryAction({
      ...definition,
      ...TAG_METADATA,
      normalizedOperationMaterialContract: [
        { kind: "value", path: "/body/name", scalarType: "string" },
        { kind: "value", path: "/body/color", scalarType: "string" },
      ],
    }, "v2-api")).toThrowError(
      "missing_material_field:clockify_tags_create:/body/color",
    );
    expect(() => registry.normalizeRegistryAction({
      ...definition,
      ...TAG_METADATA,
      normalizedOperationMaterialContract: [{
        kind: "value",
        path: "/body/name",
        scalarType: "number",
      }],
    }, "v2-api")).toThrowError(
      "material_scalar_type_mismatch:clockify_tags_create:/body/name",
    );
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

  it("rejects material array maxima that differ from the strict action schema", async () => {
    const registry = await loadRegistryModule();
    expect(() => registry.normalizeRegistryAction({
      ...fixtureAction("clockify_tags_create"),
      ...TAG_METADATA,
      schema: z.object({
        name: z.string().min(1),
        tagIds: z.array(z.string()).max(2),
      }).strict(),
      materialFields: [
        {
          kind: "value",
          path: "/name",
          label: "Name",
          formatterId: "text",
          formatterVersion: 1,
          requiredInPreview: true,
        },
        {
          kind: "array_item",
          containerPath: "/tagIds",
          itemPath: "",
          labelTemplate: "Tag {index}",
          maxItems: 3,
          formatterId: "entity",
          formatterVersion: 1,
          requiredInPreview: true,
        },
      ],
    }, "v2-api")).toThrowError(
      "material_array_max_mismatch:clockify_tags_create:/tagIds",
    );
  });

  it("rejects bounded dictionaries without an equal strict schema maximum", async () => {
    const registry = await loadRegistryModule();
    expect(() => registry.normalizeRegistryAction({
      ...fixtureAction("clockify_tags_create"),
      ...TAG_METADATA,
      schema: z.object({
        name: z.string().min(1),
        attributes: z.record(z.string().regex(/^[a-z]+$/u), z.string()),
      }).strict(),
      boundedArgumentDictionaries: [{
        path: "/attributes",
        keyPattern: "^[a-z]+$",
        maxKeyUtf8Bytes: 16,
        maxEntries: 1,
        valueSchemaFingerprint: "00404e686415370f1711c4d7acfa2905444d3cf23cef2e10c47d445ebe690f96",
      }],
      materialFields: [
        {
          kind: "value",
          path: "/name",
          label: "Name",
          formatterId: "text",
          formatterVersion: 1,
          requiredInPreview: true,
        },
        {
          kind: "dictionary_entry",
          containerPath: "/attributes",
          valuePath: "",
          labelTemplate: "Attribute {key}",
          maxEntries: 1,
          formatterId: "text",
          formatterVersion: 1,
          requiredInPreview: true,
        },
      ],
    }, "v2-api")).toThrowError(
      "bounded_dictionary_schema_max_missing:clockify_tags_create:/attributes",
    );
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
      normalizedOperationMaterialContract: [{
        kind: "value",
        path: "/projectId",
        scalarType: "string",
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

  it("projects every action and raw adapter shape into one deterministic generated inventory", async () => {
    const generator = await loadInventoryGeneratorModule();
    const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
    const evidence = generator.buildApiActionInventoryEvidence(repositoryRoot);
    const secondEvidence = generator.buildApiActionInventoryEvidence(repositoryRoot);
    const artifacts = generator.renderApiActionInventoryArtifacts(evidence);
    const secondArtifacts = generator.renderApiActionInventoryArtifacts(secondEvidence);

    expect(evidence).toEqual(secondEvidence);
    expect(artifacts).toEqual(secondArtifacts);
    expect(evidence.schemaVersion).toBe(2);
    expect(evidence.generatorVersion).toBe(2);
    expect(evidence.catalogHash).toBe(catalogHash());
    expect(evidence.catalogHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(evidence.officialOpenApi).toEqual({
      version: "v1",
      sha256: "044e2d2e3de91325c0ac26ab84dfe676d6a36432d678cced8ea8f37a3a640de2",
      corroborationPath: "evidence/openapi/clockify.official.openapi.yaml",
    });
    expect(evidence.counts).toEqual({
      actions: 160,
      rawAdapterCallSites: 150,
      rawAdapterShapes: 126,
      unclassifiedActions: 0,
      unclassifiedAdapterShapes: 0,
      exposures: { api: 108, composite: 24, generic: 24, local: 4 },
    });
    expect(evidence.actions).toHaveLength(evidence.counts.actions);
    expect(evidence.adapterRequestShapes).toHaveLength(evidence.counts.rawAdapterShapes);
    expect(evidence.openApiCorrelations).toHaveLength(evidence.counts.rawAdapterShapes);

    const actionSortKeys = evidence.actions.map((action) => {
      const anchor = action.operation ?? action.adapterShapes[0];
      return [
        anchor?.host ?? "local",
        anchor?.path ?? "",
        anchor?.method ?? "",
        action.name,
      ].join("\0");
    });
    expect(actionSortKeys).toEqual([...actionSortKeys].sort(compareText));
    expect(new Set(evidence.actions.map((action) => action.name)).size)
      .toBe(evidence.counts.actions);
    for (const action of evidence.actions) {
      expect(action.workflowModule).toMatch(/^[a-z0-9-]+(?:\/[a-z0-9-]+)?\.ts$/u);
      expect(action.decisionReason.trim()).not.toBe("");
      expect(action.primaryMutationCount).toBeGreaterThanOrEqual(0);
      expect(action.compensationCount).toBeGreaterThanOrEqual(0);
      expect(["closed", "open", "not_applicable"]).toContain(action.openSchemaVerdict);
      if (action.exposure === "api") {
        expect(action.operation).not.toBeNull();
        expect(action.presentation).not.toBeNull();
        expect(action.normalizedOperationMaterialContract).toHaveLength(
          action.kind === "read" ? 0 : action.materialFields.length,
        );
      }
    }

    const adapterSortKeys = evidence.adapterRequestShapes.map((row) => [
      row.host,
      row.path,
      row.method,
      row.mappedModelActionNames[0] ?? row.internalSupportConsumers[0] ?? "",
      row.key,
    ].join("\0"));
    expect(adapterSortKeys).toEqual([...adapterSortKeys].sort(compareText));
    expect(evidence.adapterRequestShapes.reduce(
      (sum, row) => sum + row.sourceCallSites.length,
      0,
    )).toBe(evidence.counts.rawAdapterCallSites);
    expect(evidence.adapterRequestShapes.every((row) =>
      row.sourceCallSites.every((site) =>
        Number.isSafeInteger(site.sourceColumn) && site.sourceColumn > 0)))
      .toBe(true);
    expect(evidence.adapterRequestShapes.every((row) =>
      ["model_api", "internal_support", "unavailable"].includes(row.decision)))
      .toBe(true);
    expect(evidence.openApiCorrelations.map((row) => row.adapterKey))
      .toEqual(evidence.adapterRequestShapes.map((row) => row.key));
    expect(evidence.openApiCorrelations.every((row) =>
      row.operations.length > 0 || row.unavailableReason === "official_operation_id_missing"))
      .toBe(true);

    const membershipRead = evidence.adapterRequestShapes.find((row) => row.key === [
      "read",
      "api",
      "GET",
      "/workspaces/{workspaceId}/projects/{projectId}",
      "projects.ts",
    ].join("\0"));
    expect(membershipRead).toMatchObject({ decision: "internal_support" });
    expect(membershipRead?.internalSupportConsumers).toEqual(expect.arrayContaining([
      "clockify_projects_memberships_update",
      "clockify_projects_rate_update",
      "clockify_setup_project",
    ]));

    const calendarRead = evidence.adapterRequestShapes.find((row) => row.key === [
      "read",
      "api",
      "GET",
      "/workspaces/{workspaceId}",
      "users.ts",
    ].join("\0"));
    expect(calendarRead).toMatchObject({
      decision: "internal_support",
      internalSupportConsumers: ["src/routes/chat-pipeline.ts", "src/routes/component.ts"],
    });

    const auditSearch = evidence.adapterRequestShapes.find((row) => row.key === [
      "read",
      "audit",
      "POST",
      "/workspaces/{workspaceId}/audit-log",
      "audit.ts",
    ].join("\0"));
    expect(auditSearch).toMatchObject({ decision: "unavailable" });
    expect(evidence.openApiCorrelations.find((row) => row.adapterKey === auditSearch?.key))
      .toMatchObject({ operations: [], unavailableReason: "official_operation_id_missing" });

    expect(artifacts.evidenceJson).toBe(`${JSON.stringify(evidence, null, 2)}\n`);
    expect(artifacts.apiCatalogSource).not.toMatch(/\b(?:handler|executor|zod)\b/iu);
    expect(JSON.stringify(artifacts)).not.toMatch(/generatedAt|timestamp/iu);
    expect(artifacts.inventoryMarkdown).toContain(`Catalog hash: \`${evidence.catalogHash}\``);
    expect(readFileSync(new URL("../../src/harness/api-catalog.generated.ts", import.meta.url), "utf8"))
      .toBe(artifacts.apiCatalogSource);
    expect(readFileSync(new URL("../../evidence/api-action-inventory.json", import.meta.url), "utf8"))
      .toBe(artifacts.evidenceJson);
    expect(readFileSync(new URL("../../docs/API_ACTION_INVENTORY.md", import.meta.url), "utf8"))
      .toBe(artifacts.inventoryMarkdown);

    const packageSource = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
    expect(packageSource).toContain(
      '"generate:api-action-inventory": "tsx scripts/generate-api-action-inventory.ts"',
    );
    expect(packageSource).toContain(
      '"check:api-action-inventory": "tsx scripts/generate-api-action-inventory.ts --check"',
    );
    expect(packageSource.indexOf("npm run check:scope-contract"))
      .toBeLessThan(packageSource.indexOf("npm run check:api-action-inventory"));
  });
});
