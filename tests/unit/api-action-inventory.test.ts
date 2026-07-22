import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { z } from "zod";
import { describe, expect, it } from "vitest";

import type { ActionDefinition } from "../../src/harness/action.js";
import { ACTION_CATALOG, getAction } from "../../src/harness/catalog.js";

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
    expect(() => registry.normalizeRegistryAction(fixtureAction("clockify_tags_create"), "v2-api"))
      .toThrowError("missing_api_exposure:clockify_tags_create");
  });

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
