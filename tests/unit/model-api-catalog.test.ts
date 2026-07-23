import { describe, expect, it } from "vitest";

import {
  INTERNAL_ACTION_CATALOG,
  LOCAL_ASSISTANT_ACTIONS,
  MODEL_API_ACTION_CATALOG,
  registryCompatibilityIdentity,
  type ActionRegistry,
} from "../../src/harness/api-catalog.js";
import { ACTION_CATALOG, catalogForModel } from "../../src/harness/catalog.js";
import { toolsForModel } from "../../src/harness/tools.js";

const INTERNAL_ONLY_EXCLUSIONS = [
  "clockify_period_report",
  "clockify_onboard_user",
  "clockify_setup_project",
  "clockify_setup_task",
  "clockify_create_work_package",
  "clockify_list_entities",
  "clockify_get_entity",
  "clockify_update_entity",
  "clockify_delete_entity",
  "clockify_clients_create",
  "clockify_clients_delete",
  "clockify_invoices_create",
  "clockify_invoices_update",
  "clockify_projects_delete",
  "clockify_projects_rate_update",
  "clockify_projects_memberships_update",
  "clockify_tasks_delete",
  "clockify_tasks_rate_update",
  "clockify_users_rate_update",
  "clockify_expenses_categories_update",
  "clockify_expenses_categories_delete",
  "clockify_groups_add_user",
  "clockify_time_off_requests_create",
  "clockify_approvals_get",
  "clockify_approvals_approve_pending",
  "clockify_scheduling_assignments_get",
  "clockify_scheduling_project_totals",
] as const;

const LOCAL_ASSISTANT_NAMES = [
  "assistant_update_permissions",
  "assistant_show_permissions",
  "assistant_recent_outcomes",
] as const;

function namesOf(registry: ActionRegistry): string[] {
  return registry.actions.map((action) => action.name);
}

describe("explicit ActionRegistry surfaces", () => {
  it("exports three registries with distinct ids", () => {
    expect(INTERNAL_ACTION_CATALOG.id).toBe("v1-internal");
    expect(MODEL_API_ACTION_CATALOG.id).toBe("v2-api");
    expect(LOCAL_ASSISTANT_ACTIONS.id).toBe("v2-local");
    expect(new Set([
      INTERNAL_ACTION_CATALOG.id,
      MODEL_API_ACTION_CATALOG.id,
      LOCAL_ASSISTANT_ACTIONS.id,
    ]).size).toBe(3);
  });

  it("keeps the full v1 catalog on the internal registry", () => {
    expect(INTERNAL_ACTION_CATALOG.actions).toHaveLength(ACTION_CATALOG.length);
    expect(namesOf(INTERNAL_ACTION_CATALOG).sort()).toEqual(
      ACTION_CATALOG.map((action) => action.name).sort(),
    );
  });

  it("keeps named composites and generics out of the model API registry", () => {
    const modelNames = new Set(namesOf(MODEL_API_ACTION_CATALOG));
    for (const name of INTERNAL_ONLY_EXCLUSIONS) {
      expect(INTERNAL_ACTION_CATALOG.get(name), name).toBeDefined();
      expect(modelNames.has(name), name).toBe(false);
    }
  });

  it("exposes assistant local actions only on the local registry, never as model API tools", () => {
    const modelNames = new Set(namesOf(MODEL_API_ACTION_CATALOG));
    for (const name of LOCAL_ASSISTANT_NAMES) {
      expect(modelNames.has(name), name).toBe(false);
      expect(LOCAL_ASSISTANT_ACTIONS.get(name), name).toBeDefined();
      expect(INTERNAL_ACTION_CATALOG.get(name), name).toBeDefined();
    }
    expect(MODEL_API_ACTION_CATALOG.get("assistant_undo")).toBeUndefined();
    expect(LOCAL_ASSISTANT_ACTIONS.get("assistant_undo")).toBeUndefined();
    expect(INTERNAL_ACTION_CATALOG.get("assistant_undo")).toBeUndefined();
  });

  it("keeps model API and local registries semantically disjoint", () => {
    const modelNames = new Set(namesOf(MODEL_API_ACTION_CATALOG));
    const localNames = new Set(namesOf(LOCAL_ASSISTANT_ACTIONS));
    for (const name of modelNames) {
      expect(localNames.has(name), name).toBe(false);
    }
    for (const action of LOCAL_ASSISTANT_ACTIONS.actions) {
      expect(action.apiExposure).toBe("local");
      expect(action.adapterEndpoints?.primary ?? []).toHaveLength(0);
    }
  });

  it("admits only exact atomic available API actions into the model registry", () => {
    expect(MODEL_API_ACTION_CATALOG.actions.length).toBeGreaterThan(0);
    for (const action of MODEL_API_ACTION_CATALOG.actions) {
      expect(action.apiExposure).toBe("api");
      expect(action.apiOperation).toEqual(expect.objectContaining({
        operationId: expect.any(String),
        host: expect.any(String),
        method: expect.any(String),
        path: expect.any(String),
        access: expect.any(String),
        exposure: "api",
      }));
      expect(action.adapterEndpoints?.primary).toHaveLength(1);
      expect(
        action.availabilityByAuthClass.addon.available
          || action.availabilityByAuthClass.api_key.available,
      ).toBe(true);
      expect(action.presentation).toEqual(expect.objectContaining({
        presenterId: expect.any(String),
        version: expect.any(Number),
      }));
      if (action.kind !== "read") {
        expect(action.materialFields?.length).toBeGreaterThan(0);
        expect(action.normalizedOperationMaterialContract?.length).toBeGreaterThan(0);
      }
    }
  });

  it("preserves handler identity for reusable atomic definitions", () => {
    for (const action of MODEL_API_ACTION_CATALOG.actions) {
      const internal = INTERNAL_ACTION_CATALOG.get(action.name);
      expect(internal).toBeDefined();
      if (action.kind === "safe_write") {
        expect(action.prepareSafeWrite).toBe(internal?.prepareSafeWrite);
        expect(action.executeSafeWrite).toBe(internal?.executeSafeWrite);
      } else {
        expect(action.handler).toBe(internal?.handler);
        if (action.kind === "risky_write") {
          expect(action.commit).toBe(internal?.commit);
        }
      }
    }
  });

  it("hashes registries from action fingerprints plus availability maps", () => {
    const modelHash = MODEL_API_ACTION_CATALOG.hash();
    const localHash = LOCAL_ASSISTANT_ACTIONS.hash();
    const internalHash = INTERNAL_ACTION_CATALOG.hash();
    expect(modelHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(localHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(internalHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(new Set([modelHash, localHash, internalHash]).size).toBe(3);

    for (const action of MODEL_API_ACTION_CATALOG.actions) {
      expect(MODEL_API_ACTION_CATALOG.fingerprint(action.name)).toMatch(/^[a-f0-9]{64}$/u);
      expect(MODEL_API_ACTION_CATALOG.availability(action.name, "addon")).toEqual(
        action.availabilityByAuthClass.addon.available
          ? { available: true }
          : {
              available: false,
              reason: action.availabilityByAuthClass.addon.reason,
            },
      );
    }

    expect(registryCompatibilityIdentity(MODEL_API_ACTION_CATALOG)).toBe(
      `v2-api:${modelHash}`,
    );
    expect(registryCompatibilityIdentity(LOCAL_ASSISTANT_ACTIONS)).toBe(
      `v2-local:${localHash}`,
    );
    expect(registryCompatibilityIdentity(INTERNAL_ACTION_CATALOG)).toBe(
      `v1-internal:${internalHash}`,
    );
  });

  it("derives the model registry from reviewed apiExposure metadata, not a name allowlist", () => {
    const expected = ACTION_CATALOG
      .filter((action) => action.apiExposure === "api")
      .map((action) => action.name)
      .sort();
    expect(namesOf(MODEL_API_ACTION_CATALOG).sort()).toEqual(expected);
    expect(MODEL_API_ACTION_CATALOG.actions).toHaveLength(127);
  });

  it("rejects catalog/tool construction without an exact registry", () => {
    expect(() => catalogForModel(undefined as never)).toThrowError(
      "catalog_for_model_registry_required",
    );
    expect(() => toolsForModel(undefined as never)).toThrowError(
      "tools_for_model_registry_required",
    );
    expect(() => catalogForModel({ id: "v2-api" } as never)).toThrowError(
      "catalog_for_model_registry_required",
    );
  });

  it("keeps local and non-api definitions out of the model API tool schemas", () => {
    const modelTools = toolsForModel(MODEL_API_ACTION_CATALOG);
    const modelNames = new Set(modelTools.map((tool) => tool.name));
    expect(modelTools).toHaveLength(127);
    for (const name of LOCAL_ASSISTANT_NAMES) {
      expect(modelNames.has(name)).toBe(false);
    }
    for (const name of INTERNAL_ONLY_EXCLUSIONS) {
      expect(modelNames.has(name)).toBe(false);
    }
    expect(toolsForModel(LOCAL_ASSISTANT_ACTIONS).map((tool) => tool.name).sort()).toEqual(
      [...LOCAL_ASSISTANT_NAMES, "clockify_webhooks_events"].sort(),
    );
  });
});
