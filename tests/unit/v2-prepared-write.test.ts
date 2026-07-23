import { describe, expect, it } from "vitest";
import { defineRiskyAction } from "../../src/harness/action.js";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import { getAction } from "../../src/harness/catalog.js";
import {
  escapeRfc6901,
  expandMaterialFields,
  getMaterialFormatter,
  getPreparedWritePresenter,
  joinPointer,
  MATERIAL_FACT_LIMIT,
  MATERIAL_LABEL_MAX_UTF8_BYTES,
  metadataDrivenPresentPreparedWrite,
  PRESENTATION_RULES_VERSION,
  registerMaterialFormatter,
  registerPreparedWritePresenter,
  toPublicPresentationFacts,
  validatePreparedWritePresentation,
} from "../../src/harness/prepared-write-presentation.js";

function tagDefinition() {
  const action = getAction("clockify_tags_create");
  if (!action) throw new Error("clockify_tags_create missing");
  return action;
}

describe("prepared write presentation", () => {
  it("exports the canonical presentation-rules version", () => {
    expect(PRESENTATION_RULES_VERSION).toBe(1);
  });

  it("escapes RFC6901 pointer segments", () => {
    expect(escapeRfc6901("a/b~c")).toBe("a~1b~0c");
    expect(joinPointer("/attributes", "a/b~c")).toBe("/attributes/a~1b~0c");
  });

  it("expands value, array_item, and dictionary_entry material fields in order", () => {
    const result = expandMaterialFields({
      materialFields: [
        { kind: "value", path: "/body/name", label: "Name", formatterId: "text", formatterVersion: 1, requiredInPreview: true },
        {
          kind: "array_item",
          containerPath: "/tagIds",
          itemPath: "",
          labelTemplate: "Tag {index}",
          maxItems: 2,
          formatterId: "entity",
          formatterVersion: 1,
          requiredInPreview: false,
        },
        {
          kind: "dictionary_entry",
          containerPath: "/attributes",
          valuePath: "",
          labelTemplate: "Attribute {key}",
          maxEntries: 2,
          formatterId: "text",
          formatterVersion: 1,
          requiredInPreview: false,
        },
      ],
      normalizedOperation: {
        body: { name: "Alpha" },
        tagIds: ["t1", "t2"],
        attributes: { "z/key~a": "v1", a: "v2" },
      },
      boundedArgumentDictionaries: [{
        path: "/attributes",
        keyPattern: "^[a-z/~-]+$",
        maxKeyUtf8Bytes: 16,
        maxEntries: 2,
        valueSchemaFingerprint: "00404e686415370f1711c4d7acfa2905444d3cf23cef2e10c47d445ebe690f96",
      }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields.map((field) => field.path)).toEqual([
      "/body/name",
      "/tagIds/0",
      "/tagIds/1",
      "/attributes/a",
      "/attributes/z~1key~0a",
    ]);
  });

  it("rejects out-of-range arrays, invalid dictionary keys, and more than 22 facts", () => {
    expect(expandMaterialFields({
      materialFields: [{
        kind: "array_item",
        containerPath: "/items",
        itemPath: "",
        labelTemplate: "Item {index}",
        maxItems: 1,
        formatterId: "text",
        formatterVersion: 1,
        requiredInPreview: true,
      }],
      normalizedOperation: { items: ["a", "b"] },
    })).toEqual({ ok: false, detail: "array_length_exceeded:/items:2" });

    expect(expandMaterialFields({
      materialFields: [{
        kind: "dictionary_entry",
        containerPath: "/attributes",
        valuePath: "",
        labelTemplate: "Attribute {key}",
        maxEntries: 1,
        formatterId: "text",
        formatterVersion: 1,
        requiredInPreview: true,
      }],
      normalizedOperation: { attributes: { BAD: "x" } },
      boundedArgumentDictionaries: [{
        path: "/attributes",
        keyPattern: "^[a-z]+$",
        maxKeyUtf8Bytes: 8,
        maxEntries: 1,
        valueSchemaFingerprint: "00404e686415370f1711c4d7acfa2905444d3cf23cef2e10c47d445ebe690f96",
      }],
    }).ok).toBe(false);

    expect(expandMaterialFields({
      materialFields: Array.from({ length: MATERIAL_FACT_LIMIT + 1 }, (_, index) => ({
        kind: "value" as const,
        path: `/f${index}`,
        label: `Field ${index}`,
        formatterId: "text",
        formatterVersion: 1,
        requiredInPreview: true,
      })),
      normalizedOperation: Object.fromEntries(
        Array.from({ length: MATERIAL_FACT_LIMIT + 1 }, (_, index) => [`f${index}`, index]),
      ),
    })).toEqual({
      ok: false,
      detail: `material_fact_limit_exceeded:${MATERIAL_FACT_LIMIT + 1}`,
    });
  });

  it("registers built-in formatters and model-api presenters at catalog startup", () => {
    for (const formatterId of ["text", "entity", "boolean", "number", "money-minor"]) {
      expect(getMaterialFormatter(formatterId, 1), formatterId).toBeDefined();
    }
    for (const action of MODEL_API_ACTION_CATALOG.actions) {
      const presenter = getPreparedWritePresenter(action.presentation!.presenterId);
      expect(presenter, action.name).toBeDefined();
      expect(presenter?.version).toBe(action.presentation!.version);
    }
  });

  it("rejects duplicate formatter and presenter registrations", () => {
    expect(() => registerMaterialFormatter({
      formatterId: "duplicate-test-formatter",
      version: 1,
      maxOutputUtf8Bytes: 32,
      format: () => "x",
    })).not.toThrow();
    expect(() => registerMaterialFormatter({
      formatterId: "duplicate-test-formatter",
      version: 1,
      maxOutputUtf8Bytes: 32,
      format: () => "y",
    })).toThrowError("duplicate_material_formatter:duplicate-test-formatter:1");

    expect(() => registerPreparedWritePresenter({
      presenterId: "duplicate-test-presenter",
      version: 1,
      presentPreparedWrite: metadataDrivenPresentPreparedWrite,
    })).not.toThrow();
    expect(() => registerPreparedWritePresenter({
      presenterId: "duplicate-test-presenter",
      version: 1,
      presentPreparedWrite: metadataDrivenPresentPreparedWrite,
    })).toThrowError("duplicate_prepared_write_presenter:duplicate-test-presenter");
  });

  it("validates exact fact, provenance, target, and server-default coverage", () => {
    const definition = tagDefinition();
    const normalizedOperation = { body: { name: "Alpha" } };
    const fieldProvenance = {
      "/body/name": { source: "direct_user_input" as const, authoredSegment: 0, byteStart: 0, byteEnd: 5 },
    };
    const presentation = metadataDrivenPresentPreparedWrite({
      definition,
      normalizedOperation,
      fieldProvenance,
      resolvedTargets: [],
      serverDefaults: [],
    });
    expect(validatePreparedWritePresentation({
      definition,
      normalizedOperation,
      fieldProvenance,
      resolvedTargets: [],
      serverDefaults: [],
      presentation,
    })).toEqual({ ok: true });
  });

  it("requires resolved targets and server defaults to appear in formatted facts", () => {
    const definition = defineRiskyAction({
      ...tagDefinition(),
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
      preview: async () => ({ clarify: "unused" }),
      commit: async () => ({ ok: true as const, action: "test", entity: "project", summary: "ok" }),
    });
    const normalizedOperation = { projectId: "0123456789abcdef01234567" };
    const fieldProvenance = {
      "/projectId": { source: "model_inference" as const },
    };
    const resolvedTargets = [{
      path: "/projectId",
      id: "0123456789abcdef01234567",
      label: "Roadmap",
      entityType: "project",
    }];
    const presentation = metadataDrivenPresentPreparedWrite({
      definition,
      normalizedOperation,
      fieldProvenance,
      resolvedTargets,
      serverDefaults: [],
    });
    expect(presentation.facts[0]?.value).toBe("Roadmap (0123456789abcdef01234567)");

    const defaultDefinition = defineRiskyAction({
      ...tagDefinition(),
      materialFields: [{
        kind: "value",
        path: "/body/billable",
        label: "Billable",
        formatterId: "boolean",
        formatterVersion: 1,
        requiredInPreview: true,
      }],
      normalizedOperationMaterialContract: [{
        kind: "value",
        path: "/body/billable",
        scalarType: "boolean",
      }],
      preview: async () => ({ clarify: "unused" }),
      commit: async () => ({ ok: true as const, action: "test", entity: "entry", summary: "ok" }),
    });
    const defaultOperation = { body: { billable: true } };
    const defaultProvenance = {
      "/body/billable": { source: "server_default" as const, ruleId: "billable_default_true" },
    };
    const serverDefaults = [{
      path: "/body/billable",
      ruleId: "billable_default_true",
      value: true,
    }];
    const defaultPresentation = metadataDrivenPresentPreparedWrite({
      definition: defaultDefinition,
      normalizedOperation: defaultOperation,
      fieldProvenance: defaultProvenance,
      resolvedTargets: [],
      serverDefaults,
    });
    expect(validatePreparedWritePresentation({
      definition: defaultDefinition,
      normalizedOperation: defaultOperation,
      fieldProvenance: defaultProvenance,
      resolvedTargets: [],
      serverDefaults,
      presentation: defaultPresentation,
    })).toEqual({ ok: true });
  });

  it("fails closed without truncating oversized formatter output", () => {
    const formatterId = "oversized-test-formatter";
    registerMaterialFormatter({
      formatterId,
      version: 1,
      maxOutputUtf8Bytes: 8,
      format: () => "0123456789",
    });
    const definition = defineRiskyAction({
      ...tagDefinition(),
      materialFields: [{
        kind: "value",
        path: "/body/name",
        label: "Tag name",
        formatterId,
        formatterVersion: 1,
        requiredInPreview: true,
      }],
      preview: async () => ({ clarify: "unused" }),
      commit: async () => ({ ok: true as const, action: "test", entity: "tag", summary: "ok" }),
    });
    expect(() => metadataDrivenPresentPreparedWrite({
      definition,
      normalizedOperation: { body: { name: "Alpha" } },
      fieldProvenance: {
        "/body/name": { source: "model_inference" },
      },
      resolvedTargets: [],
      serverDefaults: [],
    })).toThrowError("presentation_limit_exceeded:formatter_output:/body/name:10");
  });

  it("rejects duplicate facts, undeclared facts, and provenance mismatches", () => {
    const definition = tagDefinition();
    const normalizedOperation = { body: { name: "Alpha" } };
    const fieldProvenance = {
      "/body/name": { source: "direct_user_input" as const, authoredSegment: 0, byteStart: 0, byteEnd: 5 },
    };
    const basePresentation = metadataDrivenPresentPreparedWrite({
      definition,
      normalizedOperation,
      fieldProvenance,
      resolvedTargets: [],
      serverDefaults: [],
    });

    expect(validatePreparedWritePresentation({
      definition,
      normalizedOperation,
      fieldProvenance,
      resolvedTargets: [],
      serverDefaults: [],
      presentation: {
        ...basePresentation,
        facts: [...basePresentation.facts, ...basePresentation.facts],
      },
    })).toMatchObject({ ok: false, error: { code: "duplicate_fact" } });

    expect(validatePreparedWritePresentation({
      definition,
      normalizedOperation,
      fieldProvenance: { "/extra": { source: "model_inference" } },
      resolvedTargets: [],
      serverDefaults: [],
      presentation: basePresentation,
    })).toMatchObject({ ok: false, error: { code: "undeclared_provenance_pointer" } });

    expect(validatePreparedWritePresentation({
      definition,
      normalizedOperation,
      fieldProvenance,
      resolvedTargets: [],
      serverDefaults: [],
      presentation: {
        ...basePresentation,
        facts: [{
          ...basePresentation.facts[0]!,
          provenance: { source: "model_inference" },
        }],
      },
    })).toMatchObject({ ok: false, error: { code: "provenance_mismatch" } });
  });

  it("converts validated internal facts to the public 24-fact envelope order", () => {
    const definition = getAction("clockify_tags_create");
    expect(definition).toBeDefined();
    const normalizedOperation = { body: { name: "Alpha" } };
    const presentation = metadataDrivenPresentPreparedWrite({
      definition: definition!,
      normalizedOperation,
      fieldProvenance: {
        "/body/name": { source: "direct_user_input", authoredSegment: 0, byteStart: 0, byteEnd: 5 },
      },
      resolvedTargets: [],
      serverDefaults: [],
    });
    const facts = toPublicPresentationFacts(presentation);
    expect(facts).toHaveLength(3);
    expect(facts[0]).toEqual({ label: "Tag name", value: "Alpha" });
    expect(facts[1]?.label).toBe("API endpoint");
    expect(facts[1]?.value).toBe("POST api/workspaces/{workspaceId}/tags");
    expect(facts[2]?.label).toBe("Reversibility");
  });

  it("bounds substituted labels without truncation", () => {
    expect(expandMaterialFields({
      materialFields: [{
        kind: "array_item",
        containerPath: "/items",
        itemPath: "",
        labelTemplate: `${"x".repeat(MATERIAL_LABEL_MAX_UTF8_BYTES)} {index}`,
        maxItems: 2,
        formatterId: "text",
        formatterVersion: 1,
        requiredInPreview: true,
      }],
      normalizedOperation: { items: ["a"] },
    })).toEqual({ ok: false, detail: "material_label_limit_exceeded:/items/0" });
  });
});
