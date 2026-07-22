import { z } from "zod";
import { describe, expect, it } from "vitest";

import {
  defineReadAction,
  defineRiskyAction,
  defineSafeWriteAction,
  type DurableMutationContract,
} from "../../src/harness/action.js";
import { actionFingerprint, getAction } from "../../src/harness/catalog.js";
import { defineDurableSafeWriteAction } from "../../src/harness/durable-safe-write.js";

const BASE_OPERATION = {
  operationId: "createTag",
  host: "api",
  method: "POST",
  path: "/workspaces/{workspaceId}/tags",
  access: "write",
  exposure: "api",
} as const;

const BASE_METADATA: readonly (readonly [string, unknown])[] = [
  ["apiExposure", "api"],
  ["apiOperation", BASE_OPERATION],
  ["adapterEndpoints", {
    primary: ["write\0api\0POST\0/workspaces/{workspaceId}/tags\0tags.ts"],
    support: ["read\0api\0GET\0/workspaces/{workspaceId}/tags\0tags.ts"],
  }],
  ["availabilityByAuthClass", {
    addon: { available: true },
    api_key: { available: false, reason: "unsupported_auth_class" },
  }],
  ["boundedArgumentDictionaries", [{
    path: "/attributes",
    keyPattern: "^[a-z]+$",
    maxKeyUtf8Bytes: 16,
    maxEntries: 3,
    valueSchemaFingerprint: "a".repeat(64),
  }]],
  ["materialFields", [
    {
      kind: "value",
      path: "/body/name",
      label: "Name",
      formatterId: "text",
      formatterVersion: 1,
      requiredInPreview: true,
    },
    {
      kind: "array_item",
      containerPath: "/body/tagIds",
      itemPath: "",
      labelTemplate: "Tag {index}",
      maxItems: 2,
      formatterId: "identifier",
      formatterVersion: 1,
      requiredInPreview: false,
    },
    {
      kind: "dictionary_entry",
      containerPath: "/attributes",
      valuePath: "/value",
      labelTemplate: "Attribute {key}",
      maxEntries: 3,
      formatterId: "text",
      formatterVersion: 2,
      requiredInPreview: true,
    },
  ]],
  ["presentation", { presenterId: "tag-write", version: 1 }],
];

function metadataFingerprint(changes: readonly (readonly [string, unknown])[]): string {
  const action = getAction("clockify_tags_create");
  if (!action) throw new Error("clockify_tags_create fixture missing");
  const keys = [...new Set([...BASE_METADATA, ...changes].map(([key]) => key))];
  const descriptors = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(action, key)]));
  try {
    for (const [key, value] of [...BASE_METADATA, ...changes]) {
      Object.defineProperty(action, key, { configurable: true, enumerable: true, value });
    }
    const result = actionFingerprint(action.name);
    if (!result) throw new Error("clockify_tags_create fingerprint missing");
    return result;
  } finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(action, key, descriptor);
      else Reflect.deleteProperty(action, key);
    }
  }
}

describe("API operation metadata fingerprints", () => {
  it("threads the optional Task 4 carrier through every current action builder without defaults", () => {
    const carrier = {
      apiExposure: "local" as const,
      availabilityByAuthClass: {
        addon: { available: true as const },
        api_key: { available: true as const },
      },
    };
    const read = defineReadAction(Object.assign({
      name: "metadata_read_fixture",
      description: "fixture",
      group: "time_tracking" as const,
      schema: z.object({}),
      async handler() {
        return { ok: true as const, action: "metadata_read_fixture" };
      },
    }, carrier));
    const safe = defineSafeWriteAction(Object.assign({
      name: "metadata_safe_fixture",
      description: "fixture",
      group: "time_tracking" as const,
      schema: z.object({}),
      prepare() {
        return { kind: "clarify" as const, clarify: "fixture" };
      },
      async execute() {
        return { ok: true as const, action: "metadata_safe_fixture" };
      },
    }, carrier));
    const risky = defineRiskyAction(Object.assign({
      name: "metadata_risky_fixture",
      description: "fixture",
      group: "time_tracking" as const,
      risks: ["high_risk_write" as const],
      schema: z.object({}),
      async preview() {
        return { clarify: "fixture" };
      },
      async commit() {
        return { ok: true as const, action: "metadata_risky_fixture" };
      },
    }, carrier));
    const durable = defineDurableSafeWriteAction(Object.assign({
      name: "metadata_durable_fixture",
      description: "fixture",
      group: "time_tracking" as const,
      schema: z.object({}),
      stepName: "Fixture",
      mutationContract: {
        operationData: { source: "prepared_safe_write" as const, normalized: true as const, nonsecret: true as const },
        mutationPlan: { source: "prepared_safe_write" as const, exact: true as const },
        targeting: { mode: "create_no_target" as const },
        reconciliation: {
          strategies: ["create" as const],
          stepBound: true as const,
          requiresCompleteEvidence: true as const,
        },
      } satisfies DurableMutationContract,
      prepare() {
        return { kind: "clarify" as const, clarify: "fixture" };
      },
      async dispatch() {
        return { result: { ok: true as const, action: "metadata_durable_fixture" } };
      },
    }, carrier));

    for (const action of [read, safe, risky, durable]) {
      expect(action).toMatchObject(carrier);
    }
  });

  it.each([
    ["exposure", [["apiExposure", "generic"]]],
    ["exposure reason", [["apiExposureReason", "multi-endpoint workflow"]]],
    ["operation id", [["apiOperation", { ...BASE_OPERATION, operationId: "createTagV2" }]]],
    ["operation host", [["apiOperation", { ...BASE_OPERATION, host: "audit" }]]],
    ["operation method", [["apiOperation", { ...BASE_OPERATION, method: "PUT" }]]],
    ["operation path", [["apiOperation", { ...BASE_OPERATION, path: "/workspaces/{workspaceId}/labels" }]]],
    ["operation access", [["apiOperation", { ...BASE_OPERATION, access: "read" }]]],
    ["operation exposure", [["apiOperation", { ...BASE_OPERATION, exposure: "generic" }]]],
    ["primary endpoint", [["adapterEndpoints", {
      primary: ["write\0api\0POST\0/workspaces/{workspaceId}/labels\0tags.ts"],
      support: ["read\0api\0GET\0/workspaces/{workspaceId}/tags\0tags.ts"],
    }]]],
    ["support endpoint", [["adapterEndpoints", {
      primary: ["write\0api\0POST\0/workspaces/{workspaceId}/tags\0tags.ts"],
      support: ["read\0api\0GET\0/workspaces/{workspaceId}/tags/{tagId}\0tags.ts"],
    }]]],
    ["add-on availability", [["availabilityByAuthClass", {
      addon: { available: false, reason: "unavailable_endpoint" },
      api_key: { available: false, reason: "unsupported_auth_class" },
    }]]],
    ["API-key availability reason", [["availabilityByAuthClass", {
      addon: { available: true },
      api_key: { available: false, reason: "unavailable_endpoint" },
    }]]],
    ["dictionary path", [["boundedArgumentDictionaries", [{
      path: "/customAttributes",
      keyPattern: "^[a-z]+$",
      maxKeyUtf8Bytes: 16,
      maxEntries: 3,
      valueSchemaFingerprint: "a".repeat(64),
    }]]]],
    ["dictionary key pattern", [["boundedArgumentDictionaries", [{
      path: "/attributes",
      keyPattern: "^[A-Z]+$",
      maxKeyUtf8Bytes: 16,
      maxEntries: 3,
      valueSchemaFingerprint: "a".repeat(64),
    }]]]],
    ["dictionary key byte bound", [["boundedArgumentDictionaries", [{
      path: "/attributes",
      keyPattern: "^[a-z]+$",
      maxKeyUtf8Bytes: 17,
      maxEntries: 3,
      valueSchemaFingerprint: "a".repeat(64),
    }]]]],
    ["dictionary entry bound", [["boundedArgumentDictionaries", [{
      path: "/attributes",
      keyPattern: "^[a-z]+$",
      maxKeyUtf8Bytes: 16,
      maxEntries: 4,
      valueSchemaFingerprint: "a".repeat(64),
    }]]]],
    ["dictionary value schema", [["boundedArgumentDictionaries", [{
      path: "/attributes",
      keyPattern: "^[a-z]+$",
      maxKeyUtf8Bytes: 16,
      maxEntries: 3,
      valueSchemaFingerprint: "b".repeat(64),
    }]]]],
    ["material kind", [["materialFields", [{
      kind: "value",
      path: "/body/tagIds/0",
      label: "Tag 0",
      formatterId: "identifier",
      formatterVersion: 1,
      requiredInPreview: false,
    }]]]],
    ["material value path", [["materialFields", [{
      kind: "value",
      path: "/body/title",
      label: "Name",
      formatterId: "text",
      formatterVersion: 1,
      requiredInPreview: true,
    }]]]],
    ["material value label", [["materialFields", [{
      kind: "value",
      path: "/body/name",
      label: "Tag name",
      formatterId: "text",
      formatterVersion: 1,
      requiredInPreview: true,
    }]]]],
    ["material array container", [["materialFields", [{
      kind: "array_item",
      containerPath: "/tagIds",
      itemPath: "",
      labelTemplate: "Tag {index}",
      maxItems: 2,
      formatterId: "identifier",
      formatterVersion: 1,
      requiredInPreview: false,
    }]]]],
    ["material array relative path", [["materialFields", [{
      kind: "array_item",
      containerPath: "/body/tagIds",
      itemPath: "/id",
      labelTemplate: "Tag {index}",
      maxItems: 2,
      formatterId: "identifier",
      formatterVersion: 1,
      requiredInPreview: false,
    }]]]],
    ["material array label template", [["materialFields", [{
      kind: "array_item",
      containerPath: "/body/tagIds",
      itemPath: "",
      labelTemplate: "Label {index}",
      maxItems: 2,
      formatterId: "identifier",
      formatterVersion: 1,
      requiredInPreview: false,
    }]]]],
    ["material array maximum", [["materialFields", [{
      kind: "array_item",
      containerPath: "/body/tagIds",
      itemPath: "",
      labelTemplate: "Tag {index}",
      maxItems: 3,
      formatterId: "identifier",
      formatterVersion: 1,
      requiredInPreview: false,
    }]]]],
    ["material dictionary container", [["materialFields", [{
      kind: "dictionary_entry",
      containerPath: "/customAttributes",
      valuePath: "/value",
      labelTemplate: "Attribute {key}",
      maxEntries: 3,
      formatterId: "text",
      formatterVersion: 2,
      requiredInPreview: true,
    }]]]],
    ["material dictionary relative path", [["materialFields", [{
      kind: "dictionary_entry",
      containerPath: "/attributes",
      valuePath: "/label",
      labelTemplate: "Attribute {key}",
      maxEntries: 3,
      formatterId: "text",
      formatterVersion: 2,
      requiredInPreview: true,
    }]]]],
    ["material dictionary label template", [["materialFields", [{
      kind: "dictionary_entry",
      containerPath: "/attributes",
      valuePath: "/value",
      labelTemplate: "Field {key}",
      maxEntries: 3,
      formatterId: "text",
      formatterVersion: 2,
      requiredInPreview: true,
    }]]]],
    ["material dictionary maximum", [["materialFields", [{
      kind: "dictionary_entry",
      containerPath: "/attributes",
      valuePath: "/value",
      labelTemplate: "Attribute {key}",
      maxEntries: 4,
      formatterId: "text",
      formatterVersion: 2,
      requiredInPreview: true,
    }]]]],
    ["material formatter id", [["materialFields", [{
      kind: "value",
      path: "/body/name",
      label: "Name",
      formatterId: "tag-name",
      formatterVersion: 1,
      requiredInPreview: true,
    }]]]],
    ["material formatter version", [["materialFields", [{
      kind: "value",
      path: "/body/name",
      label: "Name",
      formatterId: "text",
      formatterVersion: 2,
      requiredInPreview: true,
    }]]]],
    ["material required flag", [["materialFields", [{
      kind: "value",
      path: "/body/name",
      label: "Name",
      formatterId: "text",
      formatterVersion: 1,
      requiredInPreview: false,
    }]]]],
    ["presenter id", [["presentation", { presenterId: "tag-write-v2", version: 1 }]]],
    ["presenter version", [["presentation", { presenterId: "tag-write", version: 2 }]]],
  ] satisfies readonly (readonly [string, readonly (readonly [string, unknown])[]])[])(
    "changes the fingerprint when %s changes",
    (_label, changes) => {
      expect(metadataFingerprint(changes)).not.toBe(metadataFingerprint([]));
    },
  );
});
