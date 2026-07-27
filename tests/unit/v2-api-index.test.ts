import { describe, expect, it } from "vitest";

import {
  buildApiOperationIndex,
  isOperationAvailableForAuth,
  toApiOperationDescriptor,
} from "../../src/assistant-v2/discovery/api-index.js";
import {
  LOCAL_ASSISTANT_ACTIONS,
  MODEL_API_ACTION_CATALOG,
} from "../../src/harness/api-catalog.js";

describe("buildApiOperationIndex", () => {
  const index = buildApiOperationIndex(MODEL_API_ACTION_CATALOG);

  it("indexes every model API action with trusted metadata and the registry hash", () => {
    expect(index.registryId).toBe("v2-api");
    expect(index.catalogHash).toBe(MODEL_API_ACTION_CATALOG.hash());
    expect(index.operations).toHaveLength(MODEL_API_ACTION_CATALOG.actions.length);
    for (const operation of index.operations) {
      expect(operation.toolName).toMatch(/^clockify_/u);
      expect(operation.operationId.length).toBeGreaterThan(0);
      expect(operation.searchFields.operationId.length).toBeGreaterThan(0);
      expect(operation.searchFields.toolName.length).toBeGreaterThan(0);
    }
  });

  it("never indexes local assistant actions", () => {
    const indexedNames = new Set(index.operations.map((operation) => operation.toolName));
    for (const localName of LOCAL_ASSISTANT_ACTIONS.actions.map((action) => action.name)) {
      expect(indexedNames.has(localName)).toBe(false);
    }
  });

  it("records per-auth availability on every indexed operation", () => {
    for (const operation of index.operations) {
      expect(typeof operation.availabilityByAuthClass.addon.available).toBe("boolean");
      expect(typeof operation.availabilityByAuthClass.api_key.available).toBe("boolean");
    }
  });

  it("derives requiredArguments from the Zod schema", () => {
    const create = index.operations.find((operation) =>
      operation.toolName === "clockify_projects_create");
    expect(create?.requiredArguments).toEqual(["name"]);
  });

  it("maps descriptors without availability internals", () => {
    const operation = index.operations[0];
    expect(toApiOperationDescriptor(operation)).toEqual({
      toolName: operation.toolName,
      operationId: operation.operationId,
      host: operation.host,
      method: operation.method,
      path: operation.path,
      description: operation.description,
      requiredArguments: operation.requiredArguments,
      access: operation.access,
      risks: operation.risks,
    });
  });

  it("rejects non-v2 registries", () => {
    expect(() => buildApiOperationIndex(LOCAL_ASSISTANT_ACTIONS))
      .toThrow("discovery_index_registry_required:v2-api");
  });
});

describe("isOperationAvailableForAuth", () => {
  const index = buildApiOperationIndex(MODEL_API_ACTION_CATALOG);

  it("reflects generated addon availability decisions", () => {
    const blocked = index.operations.find((operation) =>
      operation.toolName === "clockify_custom_fields_create");
    expect(blocked).toBeDefined();
    expect(isOperationAvailableForAuth(blocked!, "addon")).toBe(false);
    expect(isOperationAvailableForAuth(blocked!, "api_key")).toBe(true);
  });
});
