import { describe, expect, it } from "vitest";

import { buildApiOperationIndex } from "../../src/assistant-v2/discovery/api-index.js";
import {
  DISCOVERY_META_TOOL,
  DISCOVERY_STATUS_TEXT,
  findApiOperationsInputSchema,
  initialV2ToolSet,
  parseFindApiOperationsInput,
  refineLoadedToolSet,
  runDiscoverySearch,
  validateLoadedToolCall,
} from "../../src/assistant-v2/discovery/api-search-tool.js";
import {
  INTERNAL_ACTION_CATALOG,
  LOCAL_ASSISTANT_ACTIONS,
  LOCAL_ASSISTANT_TOOL_NAMES,
  MODEL_API_ACTION_CATALOG,
} from "../../src/harness/api-catalog.js";
import { DISCOVERY_META_TOOL_NAME } from "../../src/harness/api-operation.js";
import {
  toolsForModel,
  toolsForV2LoadedSet,
} from "../../src/harness/tools.js";
import { createApp } from "../../src/server.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore } from "../../src/db/store.js";
import { selectModelClient } from "../../src/assistant/select-model-client.js";
import { makeTestConfig } from "../helpers/config.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";
import { testKeys } from "../helpers/test-keys.js";

const index = buildApiOperationIndex(MODEL_API_ACTION_CATALOG);
const catalogHash = MODEL_API_ACTION_CATALOG.hash();

describe("assistant_find_api_operations schema", () => {
  it("uses a strict closed object with trimmed bounded query and limit 1..12", () => {
    expect(findApiOperationsInputSchema.parse({
      query: "  list projects  ",
      access: "read",
      groups: ["work_structure"],
      limit: 3,
    })).toEqual({
      query: "list projects",
      access: "read",
      groups: ["work_structure"],
      limit: 3,
    });

    expect(() => findApiOperationsInputSchema.parse({ query: "projects", extra: true }))
      .toThrow();
    expect(() => findApiOperationsInputSchema.parse({ query: "" })).toThrow();
    expect(() => findApiOperationsInputSchema.parse({ query: "x", limit: 0 })).toThrow();
    expect(() => findApiOperationsInputSchema.parse({ query: "x", limit: 13 })).toThrow();
    expect(() => findApiOperationsInputSchema.parse({ query: "x", limit: 1.5 })).toThrow();
  });

  it("exposes the sole discovery meta-tool with generated JSON Schema parameters", () => {
    expect(DISCOVERY_META_TOOL.name).toBe(DISCOVERY_META_TOOL_NAME);
    expect(DISCOVERY_META_TOOL.parameters.type).toBe("object");
    expect(DISCOVERY_META_TOOL.parameters.additionalProperties).toBe(false);
    expect(DISCOVERY_STATUS_TEXT).toBe("Finding the relevant Clockify API operations.");
  });
});

describe("initialV2ToolSet", () => {
  it("returns only discovery plus still-valid cached API names", () => {
    const loaded = initialV2ToolSet(MODEL_API_ACTION_CATALOG, [
      "clockify_projects_list",
      "assistant_show_permissions",
      "missing_action",
    ]);
    expect([...loaded]).toEqual([
      DISCOVERY_META_TOOL_NAME,
      "clockify_projects_list",
    ]);
  });

  it("never exposes the full model API catalog", () => {
    const loaded = initialV2ToolSet(MODEL_API_ACTION_CATALOG, MODEL_API_ACTION_CATALOG.actions.map((a) => a.name));
    expect(loaded.size).toBeLessThanOrEqual(13);
    expect(loaded.size).toBeLessThan(MODEL_API_ACTION_CATALOG.actions.length);
  });
});

describe("refineLoadedToolSet", () => {
  it("preserves used tools, adds ranked matches, and caps API tools at 12", () => {
    const search = runDiscoverySearch(index, { query: "clockify", limit: 12 }, "addon");
    expect(search.kind).toBe("matches");
    const current = initialV2ToolSet(MODEL_API_ACTION_CATALOG, ["clockify_projects_list"]);
    const used = new Set(["clockify_projects_list"]);
    const refined = refineLoadedToolSet(current, used, search);
    expect(refined.has("clockify_projects_list")).toBe(true);
    expect(refined.has(DISCOVERY_META_TOOL_NAME)).toBe(true);
    expect([...refined].filter((name) => name !== DISCOVERY_META_TOOL_NAME)).toHaveLength(12);
  });
});

describe("validateLoadedToolCall", () => {
  const loaded = initialV2ToolSet(MODEL_API_ACTION_CATALOG, ["clockify_projects_list"]);

  it("rejects unloaded, unknown, stale-hash, and unavailable tools", () => {
    expect(validateLoadedToolCall({
      toolName: "clockify_tasks_list",
      loadedNames: loaded,
      expectedCatalogHash: catalogHash,
      currentCatalogHash: catalogHash,
      registry: MODEL_API_ACTION_CATALOG,
      authClass: "addon",
    })).toEqual({ ok: false, reason: "tool_not_loaded" });

    expect(validateLoadedToolCall({
      toolName: "clockify_not_real",
      loadedNames: new Set([...loaded, "clockify_not_real"]),
      expectedCatalogHash: catalogHash,
      currentCatalogHash: catalogHash,
      registry: MODEL_API_ACTION_CATALOG,
      authClass: "addon",
    })).toEqual({ ok: false, reason: "unknown_tool" });

    expect(validateLoadedToolCall({
      toolName: "clockify_projects_list",
      loadedNames: loaded,
      expectedCatalogHash: "stale",
      currentCatalogHash: catalogHash,
      registry: MODEL_API_ACTION_CATALOG,
      authClass: "addon",
    })).toEqual({ ok: false, reason: "stale_catalog_hash" });

    expect(validateLoadedToolCall({
      toolName: "clockify_webhooks_list",
      loadedNames: new Set([...loaded, "clockify_webhooks_list"]),
      expectedCatalogHash: catalogHash,
      currentCatalogHash: catalogHash,
      registry: MODEL_API_ACTION_CATALOG,
      authClass: "addon",
    })).toEqual({ ok: false, reason: "unavailable_for_auth_class" });
  });

  it("accepts discovery and loaded available API tools", () => {
    expect(validateLoadedToolCall({
      toolName: DISCOVERY_META_TOOL_NAME,
      loadedNames: loaded,
      expectedCatalogHash: catalogHash,
      currentCatalogHash: catalogHash,
      registry: MODEL_API_ACTION_CATALOG,
      authClass: "addon",
    })).toEqual({ ok: true });

    expect(validateLoadedToolCall({
      toolName: "clockify_projects_list",
      loadedNames: loaded,
      expectedCatalogHash: catalogHash,
      currentCatalogHash: catalogHash,
      registry: MODEL_API_ACTION_CATALOG,
      authClass: "addon",
    })).toEqual({ ok: true });
  });
});

describe("toolsForV2LoadedSet", () => {
  it("returns schemas only for the explicit loaded-name set", () => {
    const loaded = initialV2ToolSet(MODEL_API_ACTION_CATALOG, ["clockify_projects_list"]);
    const tools = toolsForV2LoadedSet(MODEL_API_ACTION_CATALOG, loaded);
    expect(tools.map((tool) => tool.name)).toEqual([
      DISCOVERY_META_TOOL_NAME,
      "clockify_projects_list",
    ]);
    expect(toolsForModel(MODEL_API_ACTION_CATALOG).length).toBeGreaterThan(tools.length);
  });

  /**
   * C2: this is the assertion the runner now relies on every iteration.
   * Until C2 the runner called the UNGUARDED `discoveryToolsForLoadedSet`,
   * so `initialV2ToolSet`'s registry-id guard protected only the fresh-run
   * branch and the throw string below was pinned nowhere.
   */
  it("refuses a registry that is not the v2 model-API surface", () => {
    const loaded = initialV2ToolSet(MODEL_API_ACTION_CATALOG, ["clockify_projects_list"]);
    expect(() => toolsForV2LoadedSet(INTERNAL_ACTION_CATALOG, loaded))
      .toThrow("tools_for_v2_loaded_set_registry_required:v2-api");
    expect(() => toolsForV2LoadedSet(LOCAL_ASSISTANT_ACTIONS, loaded))
      .toThrow("tools_for_v2_loaded_set_registry_required:v2-api");
  });

  it("never returns local assistant actions as API endpoints", () => {
    const loaded = initialV2ToolSet(MODEL_API_ACTION_CATALOG, [
      "assistant_show_permissions",
      "clockify_projects_list",
    ]);
    const tools = toolsForV2LoadedSet(MODEL_API_ACTION_CATALOG, loaded);
    for (const tool of tools) {
      expect(LOCAL_ASSISTANT_TOOL_NAMES.has(tool.name)).toBe(false);
    }
  });
});

describe("startup discovery injection", () => {
  it("builds the trusted index in createApp without exposing the raw global catalog", async () => {
    const keys = await testKeys();
    const config = makeTestConfig({ clockifyAddonPublicKeyPem: keys.pem });
    const store = createStore(":memory:", { encryptionKey: "test-key" });
    const fake = createFakeWorkspace();
    const app = createApp({
      config,
      store,
      parser: createSignatureParser(config.clockifyAddonKey, keys.pem),
      modelClient: selectModelClient(config),
      clockifyForWorkspace: () => fake.client,
    });
    expect(app).toBeDefined();
    const loaded = initialV2ToolSet(MODEL_API_ACTION_CATALOG);
    expect(toolsForV2LoadedSet(MODEL_API_ACTION_CATALOG, loaded)).toHaveLength(1);
    store.close();
  });
});

describe("parseFindApiOperationsInput", () => {
  it("rejects invalid limits at the strict boundary", () => {
    expect(() => parseFindApiOperationsInput({ query: "projects", limit: 0 })).toThrow();
    expect(() => parseFindApiOperationsInput({ query: "projects", limit: 13 })).toThrow();
  });
});
