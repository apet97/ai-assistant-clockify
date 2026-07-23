import { createHash } from "node:crypto";
import type { ActionDefinition } from "./action.js";
import type {
  ApiHost,
  ApiMethod,
  BoundedDictionaryMetadata,
  MaterialFieldMetadata,
} from "./api-operation.js";
import { fromMinor } from "./money.js";

/** Canonical presentation-rules version hashed into fingerprints and inventory. */
export const PRESENTATION_RULES_VERSION = 1;

export const MATERIAL_FACT_LIMIT = 22;
export const PUBLIC_FACT_LIMIT = 24;
export const MATERIAL_LABEL_MAX_UTF8_BYTES = 128;
export const FORMATTER_OUTPUT_MAX_UTF8_BYTES = 2_048;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export type FieldProvenance =
  | { source: "direct_user_input"; authoredSegment: number; byteStart: number; byteEnd: number }
  | { source: "model_inference" }
  | { source: "prior_clockify_result"; actionResultId: string; referenceId?: string }
  | { source: "server_default"; ruleId: string };

export type FieldProvenanceMap = Readonly<Record<string, FieldProvenance>>;

export interface ResolvedTargetView {
  path: string;
  id: string;
  label: string;
  entityType: string;
}

export interface ServerDefaultView {
  path: string;
  ruleId: string;
  value: JsonValue;
}

export interface PreparedWriteFact {
  path: string;
  label: string;
  value: string;
  provenance: FieldProvenance;
}

export interface PreparedWritePresentation {
  title: string;
  facts: PreparedWriteFact[];
  warnings: Array<{ code: string; message: string }>;
  reversibility: { reversible: boolean; explanation: string };
  endpoint: { host: ApiHost; method: ApiMethod; path: string };
}

export type PresentPreparedWrite = (input: {
  definition: ActionDefinition;
  normalizedOperation: JsonObject;
  fieldProvenance: FieldProvenanceMap;
  resolvedTargets: readonly ResolvedTargetView[];
  serverDefaults: readonly ServerDefaultView[];
}) => PreparedWritePresentation;

export interface PreparedWritePresenterRegistration {
  presenterId: string;
  version: number;
  presentPreparedWrite: PresentPreparedWrite;
}

export interface MaterialFormatterRegistration {
  formatterId: string;
  version: number;
  maxOutputUtf8Bytes: number;
  format(input: {
    path: string;
    value: null | boolean | number | string;
    resolvedTarget?: ResolvedTargetView;
    serverDefault?: ServerDefaultView;
  }): string;
}

export interface ExpandedMaterialField {
  path: string;
  label: string;
  formatterId: string;
  formatterVersion: number;
  requiredInPreview: boolean;
  present: boolean;
  scalarValue: null | boolean | number | string | undefined;
}

export type PreparedWriteValidationError =
  | { code: "presentation_limit_exceeded"; detail: string }
  | { code: "invalid_material_expansion"; detail: string }
  | { code: "missing_presenter"; detail: string }
  | { code: "presenter_version_mismatch"; detail: string }
  | { code: "missing_formatter"; detail: string }
  | { code: "formatter_version_mismatch"; detail: string }
  | { code: "duplicate_material_pointer"; detail: string }
  | { code: "undeclared_material_fact"; detail: string }
  | { code: "undeclared_provenance_pointer"; detail: string }
  | { code: "missing_required_fact"; detail: string }
  | { code: "missing_required_provenance"; detail: string }
  | { code: "optional_fact_mismatch"; detail: string }
  | { code: "duplicate_fact"; detail: string }
  | { code: "formatter_output_mismatch"; detail: string }
  | { code: "provenance_mismatch"; detail: string }
  | { code: "unresolved_target_omitted"; detail: string }
  | { code: "server_default_omitted"; detail: string }
  | { code: "server_default_provenance_mismatch"; detail: string }
  | { code: "normalized_material_value_omitted"; detail: string };

const formatterRegistry = new Map<string, MaterialFormatterRegistration>();
const presenterRegistry = new Map<string, PreparedWritePresenterRegistration>();

function formatterKey(formatterId: string, version: number): string {
  return `${formatterId}\0${version}`;
}

function isJsonScalar(value: unknown): value is null | boolean | number | string {
  return value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
}

export function escapeRfc6901(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function decodeRfc6901Segment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

export function joinPointer(base: string, segment: string): string {
  return `${base}/${escapeRfc6901(segment)}`;
}

export function getValueAtPointer(
  root: unknown,
  pointer: string,
): { present: boolean; value: unknown } {
  if (!pointer.startsWith("/")) {
    throw new Error(`invalid_pointer:${pointer}`);
  }
  if (pointer === "/") return { present: true, value: root };
  let current: unknown = root;
  for (const encoded of pointer.slice(1).split("/")) {
    const segment = decodeRfc6901Segment(encoded);
    if (current === null || typeof current !== "object") {
      return { present: false, value: undefined };
    }
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return { present: false, value: undefined };
      }
      current = current[index];
      continue;
    }
    const record = current as Record<string, unknown>;
    if (!(segment in record)) return { present: false, value: undefined };
    current = record[segment];
  }
  return { present: true, value: current };
}

function setValueAtPointer(root: JsonObject, pointer: string, value: JsonValue): void {
  if (!pointer.startsWith("/")) throw new Error(`invalid_pointer:${pointer}`);
  if (pointer === "/") throw new Error("cannot_replace_root");
  const segments = pointer.slice(1).split("/").map(decodeRfc6901Segment);
  let current: JsonValue = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]!;
    if (Array.isArray(current)) {
      const slot = Number(segment);
      if (!Number.isInteger(slot) || slot < 0 || slot >= current.length) throw new Error(`invalid_pointer:${pointer}`);
      current = current[slot]!;
      continue;
    }
    if (!current || typeof current !== "object") throw new Error(`invalid_pointer:${pointer}`);
    const record = current as JsonObject;
    if (!(segment in record)) throw new Error(`invalid_pointer:${pointer}`);
    current = record[segment]!;
  }
  const leaf = segments[segments.length - 1]!;
  if (Array.isArray(current)) {
    const slot = Number(leaf);
    if (!Number.isInteger(slot) || slot < 0 || slot >= current.length) throw new Error(`invalid_pointer:${pointer}`);
    current[slot] = value;
    return;
  }
  if (!current || typeof current !== "object") throw new Error(`invalid_pointer:${pointer}`);
  (current as JsonObject)[leaf] = value;
}

function omitUndefinedJson(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const items = value
      .map((entry) => omitUndefinedJson(entry))
      .filter((entry): entry is JsonValue => entry !== undefined);
    return items;
  }
  if (typeof value === "object") {
    const out: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
      const cleaned = omitUndefinedJson(child);
      if (cleaned !== undefined) out[key] = cleaned;
    }
    return out;
  }
  return undefined;
}

function itemPathKey(itemPath: string): string {
  if (itemPath === "" || itemPath === "/") return "";
  return itemPath.startsWith("/") ? itemPath.slice(1) : itemPath;
}

function promotedPresentationFields(payload: JsonObject): JsonObject {
  const promoted: JsonObject = {};
  for (const key of ["input", "patch"] as const) {
    const nested = payload[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      Object.assign(promoted, nested as JsonObject);
    }
  }
  return promoted;
}

function coerceMaterialArrayContainers(
  definition: ActionDefinition,
  normalizedOperation: JsonObject,
): void {
  for (const field of definition.materialFields ?? []) {
    if (field.kind !== "array_item") continue;
    const container = getValueAtPointer(normalizedOperation, field.containerPath);
    if (!container.present) continue;
    const key = itemPathKey(field.itemPath);
    if (Array.isArray(container.value)) {
      if (key && container.value.every((entry) => isJsonScalar(entry))) {
        setValueAtPointer(
          normalizedOperation,
          field.containerPath,
          container.value.map((entry) => ({ [key]: entry })),
        );
      }
      continue;
    }
    if (isJsonScalar(container.value)) {
      const item = key ? ({ [key]: container.value } as JsonObject) : container.value;
      setValueAtPointer(normalizedOperation, field.containerPath, [item]);
    }
  }
}

/** Build the material-field view used by the v2 assistant presentation gate. */
export function buildNormalizedOperationForPresentation(
  definition: ActionDefinition,
  rawArgs: Record<string, unknown>,
  operationPayload: unknown,
): JsonObject {
  const parsed = definition.schema.safeParse(rawArgs);
  const argsObj = omitUndefinedJson(parsed.success ? parsed.data : rawArgs);
  const payloadObj = (
    operationPayload && typeof operationPayload === "object" && !Array.isArray(operationPayload)
  )
    ? omitUndefinedJson(operationPayload) as JsonObject
    : {};
  const merged = omitUndefinedJson({
    ...payloadObj,
    ...promotedPresentationFields(payloadObj),
    ...(argsObj && typeof argsObj === "object" && !Array.isArray(argsObj) ? argsObj : {}),
  }) as JsonObject;
  coerceMaterialArrayContainers(definition, merged);
  return merged;
}

function relativePointer(base: string, relative: string): string {
  if (relative === "") return base;
  if (!relative.startsWith("/")) {
    throw new Error(`invalid_relative_pointer:${base}:${relative}`);
  }
  return `${base}${relative}`;
}

function dictionaryForPointer(
  dictionaries: readonly BoundedDictionaryMetadata[] | undefined,
  containerPath: string,
): BoundedDictionaryMetadata | undefined {
  return dictionaries?.find((entry) => entry.path === containerPath);
}

function validateDictionaryKey(
  dictionary: BoundedDictionaryMetadata,
  key: string,
): string | undefined {
  if (Buffer.byteLength(key, "utf8") > dictionary.maxKeyUtf8Bytes) {
    return `dictionary_key_too_large:${dictionary.path}:${key}`;
  }
  try {
    if (!new RegExp(dictionary.keyPattern, "u").test(key)) {
      return `dictionary_key_pattern_mismatch:${dictionary.path}:${key}`;
    }
  } catch {
    return `dictionary_key_pattern_invalid:${dictionary.path}`;
  }
  return undefined;
}

export function expandMaterialFields(input: {
  materialFields: readonly MaterialFieldMetadata[];
  normalizedOperation: JsonObject;
  boundedArgumentDictionaries?: readonly BoundedDictionaryMetadata[];
}): { ok: true; fields: readonly ExpandedMaterialField[] } | { ok: false; detail: string } {
  const expanded: ExpandedMaterialField[] = [];
  const pointers = new Set<string>();

  for (const field of input.materialFields) {
    switch (field.kind) {
      case "value": {
        const resolved = getValueAtPointer(input.normalizedOperation, field.path);
        if (resolved.present && !isJsonScalar(resolved.value)) {
          return { ok: false, detail: `non_scalar_material_value:${field.path}` };
        }
        if (pointers.has(field.path)) {
          return { ok: false, detail: `duplicate_material_pointer:${field.path}` };
        }
        pointers.add(field.path);
        expanded.push(Object.freeze({
          path: field.path,
          label: field.label,
          formatterId: field.formatterId,
          formatterVersion: field.formatterVersion,
          requiredInPreview: field.requiredInPreview,
          present: resolved.present,
          scalarValue: resolved.present
            ? resolved.value as null | boolean | number | string
            : undefined,
        }));
        break;
      }
      case "array_item": {
        const container = getValueAtPointer(input.normalizedOperation, field.containerPath);
        if (!container.present) {
          if (field.requiredInPreview) {
            return { ok: false, detail: `missing_required_array:${field.containerPath}` };
          }
          break;
        }
        if (!Array.isArray(container.value)) {
          return { ok: false, detail: `non_array_material_container:${field.containerPath}` };
        }
        if (container.value.length > field.maxItems) {
          return { ok: false, detail: `array_length_exceeded:${field.containerPath}:${container.value.length}` };
        }
        for (let index = 0; index < container.value.length; index += 1) {
          const pointer = relativePointer(
            joinPointer(field.containerPath, String(index)),
            field.itemPath,
          );
          const resolved = getValueAtPointer(input.normalizedOperation, pointer);
          if (resolved.present && !isJsonScalar(resolved.value)) {
            return { ok: false, detail: `non_scalar_material_value:${pointer}` };
          }
          if (pointers.has(pointer)) {
            return { ok: false, detail: `duplicate_material_pointer:${pointer}` };
          }
          pointers.add(pointer);
          const label = field.labelTemplate.replace("{index}", String(index));
          if (Buffer.byteLength(label, "utf8") > MATERIAL_LABEL_MAX_UTF8_BYTES) {
            return { ok: false, detail: `material_label_limit_exceeded:${pointer}` };
          }
          expanded.push(Object.freeze({
            path: pointer,
            label,
            formatterId: field.formatterId,
            formatterVersion: field.formatterVersion,
            requiredInPreview: field.requiredInPreview,
            present: resolved.present,
            scalarValue: resolved.present
              ? resolved.value as null | boolean | number | string
              : undefined,
          }));
        }
        break;
      }
      case "dictionary_entry": {
        const dictionary = dictionaryForPointer(
          input.boundedArgumentDictionaries,
          field.containerPath,
        );
        if (!dictionary) {
          return { ok: false, detail: `unmatched_material_dictionary:${field.containerPath}` };
        }
        const container = getValueAtPointer(input.normalizedOperation, field.containerPath);
        if (!container.present) {
          if (field.requiredInPreview) {
            return { ok: false, detail: `missing_required_dictionary:${field.containerPath}` };
          }
          break;
        }
        if (!container.value || typeof container.value !== "object" || Array.isArray(container.value)) {
          return { ok: false, detail: `non_dictionary_material_container:${field.containerPath}` };
        }
        const keys = Object.keys(container.value as Record<string, unknown>).sort();
        if (keys.length > field.maxEntries) {
          return { ok: false, detail: `dictionary_length_exceeded:${field.containerPath}:${keys.length}` };
        }
        for (const key of keys) {
          const keyError = validateDictionaryKey(dictionary, key);
          if (keyError) return { ok: false, detail: keyError };
          const pointer = relativePointer(joinPointer(field.containerPath, key), field.valuePath);
          const resolved = getValueAtPointer(input.normalizedOperation, pointer);
          if (resolved.present && !isJsonScalar(resolved.value)) {
            return { ok: false, detail: `non_scalar_material_value:${pointer}` };
          }
          if (pointers.has(pointer)) {
            return { ok: false, detail: `duplicate_material_pointer:${pointer}` };
          }
          pointers.add(pointer);
          const label = field.labelTemplate.replace("{key}", key);
          if (Buffer.byteLength(label, "utf8") > MATERIAL_LABEL_MAX_UTF8_BYTES) {
            return { ok: false, detail: `material_label_limit_exceeded:${pointer}` };
          }
          expanded.push(Object.freeze({
            path: pointer,
            label,
            formatterId: field.formatterId,
            formatterVersion: field.formatterVersion,
            requiredInPreview: field.requiredInPreview,
            present: resolved.present,
            scalarValue: resolved.present
              ? resolved.value as null | boolean | number | string
              : undefined,
          }));
        }
        break;
      }
    }
  }

  if (expanded.length > MATERIAL_FACT_LIMIT) {
    return { ok: false, detail: `material_fact_limit_exceeded:${expanded.length}` };
  }
  return { ok: true, fields: Object.freeze(expanded) };
}

export function registerMaterialFormatter(registration: MaterialFormatterRegistration): void {
  if (!Number.isFinite(registration.maxOutputUtf8Bytes)
    || registration.maxOutputUtf8Bytes <= 0
    || registration.maxOutputUtf8Bytes > FORMATTER_OUTPUT_MAX_UTF8_BYTES) {
    throw new Error(`invalid_formatter_output_limit:${registration.formatterId}`);
  }
  const key = formatterKey(registration.formatterId, registration.version);
  if (formatterRegistry.has(key)) {
    throw new Error(`duplicate_material_formatter:${registration.formatterId}:${registration.version}`);
  }
  formatterRegistry.set(key, Object.freeze({ ...registration }));
}

export function getMaterialFormatter(
  formatterId: string,
  version: number,
): MaterialFormatterRegistration | undefined {
  return formatterRegistry.get(formatterKey(formatterId, version));
}

export function registerPreparedWritePresenter(registration: PreparedWritePresenterRegistration): void {
  const existing = presenterRegistry.get(registration.presenterId);
  if (existing) {
    throw new Error(`duplicate_prepared_write_presenter:${registration.presenterId}`);
  }
  presenterRegistry.set(registration.presenterId, Object.freeze({ ...registration }));
}

export function getPreparedWritePresenter(
  presenterId: string,
): PreparedWritePresenterRegistration | undefined {
  return presenterRegistry.get(presenterId);
}

function formatScalarValue(input: {
  formatterId: string;
  formatterVersion: number;
  path: string;
  value: null | boolean | number | string;
  resolvedTarget?: ResolvedTargetView;
  serverDefault?: ServerDefaultView;
}): { ok: true; value: string } | { ok: false; detail: string } {
  const formatter = getMaterialFormatter(input.formatterId, input.formatterVersion);
  if (!formatter) {
    return { ok: false, detail: `missing_formatter:${input.formatterId}:${input.formatterVersion}` };
  }
  const formatted = formatter.format({
    path: input.path,
    value: input.value,
    resolvedTarget: input.resolvedTarget,
    serverDefault: input.serverDefault,
  });
  const bytes = Buffer.byteLength(formatted, "utf8");
  if (bytes > formatter.maxOutputUtf8Bytes || bytes > FORMATTER_OUTPUT_MAX_UTF8_BYTES) {
    return { ok: false, detail: `presentation_limit_exceeded:formatter_output:${input.path}:${bytes}` };
  }
  return { ok: true, value: formatted };
}

function defaultReversibility(definition: ActionDefinition): { reversible: boolean; explanation: string } {
  if (definition.kind === "safe_write") {
    return {
      reversible: true,
      explanation: "Undo removes the created entity where supported.",
    };
  }
  if (definition.risks.includes("destructive")) {
    return { reversible: false, explanation: "This cannot be undone." };
  }
  if (definition.risks.includes("high_risk_write")) {
    return {
      reversible: false,
      explanation: "Editing replaces live data; there is no automatic undo.",
    };
  }
  return { reversible: false, explanation: "This change may be hard to reverse." };
}

function defaultTitle(definition: ActionDefinition): string {
  const firstSentence = definition.description.split(".")[0]?.trim();
  return firstSentence && firstSentence.length > 0 ? firstSentence : definition.name;
}

export const metadataDrivenPresentPreparedWrite: PresentPreparedWrite = (input) => {
  const operation = input.definition.apiOperation;
  if (!operation) throw new Error(`missing_api_operation:${input.definition.name}`);
  const materialFields = input.definition.materialFields ?? [];
  const expansion = expandMaterialFields({
    materialFields,
    normalizedOperation: input.normalizedOperation,
    boundedArgumentDictionaries: input.definition.boundedArgumentDictionaries,
  });
  if (!expansion.ok) throw new Error(expansion.detail);

  const facts: PreparedWriteFact[] = [];
  for (const field of expansion.fields) {
    if (!field.present && !field.requiredInPreview) continue;
    const provenance = input.fieldProvenance[field.path];
    if (!provenance) throw new Error(`missing_provenance:${field.path}`);
    const scalarValue = field.present
      ? field.scalarValue as null | boolean | number | string
      : null;
    const formatted = formatScalarValue({
      formatterId: field.formatterId,
      formatterVersion: field.formatterVersion,
      path: field.path,
      value: scalarValue,
      resolvedTarget: input.resolvedTargets.find((target) => target.path === field.path),
      serverDefault: input.serverDefaults.find((entry) => entry.path === field.path),
    });
    if (!formatted.ok) throw new Error(formatted.detail);
    facts.push(Object.freeze({
      path: field.path,
      label: field.label,
      value: formatted.value,
      provenance,
    }));
  }

  const warnings = input.definition.risks.includes("destructive")
    ? [{ code: "destructive_write", message: "This action changes or removes live workspace data." }]
    : input.definition.risks.includes("high_risk_write")
      ? [{ code: "high_risk_write", message: "This action overwrites existing workspace data." }]
      : [];

  return {
    title: defaultTitle(input.definition),
    facts,
    warnings,
    reversibility: defaultReversibility(input.definition),
    endpoint: {
      host: operation.host,
      method: operation.method,
      path: operation.path,
    },
  };
};

export function validatePreparedWritePresentation(input: {
  definition: ActionDefinition;
  normalizedOperation: JsonObject;
  fieldProvenance: FieldProvenanceMap;
  resolvedTargets: readonly ResolvedTargetView[];
  serverDefaults: readonly ServerDefaultView[];
  presentation: PreparedWritePresentation;
}): { ok: true } | { ok: false; error: PreparedWriteValidationError } {
  const fail = (
    code: PreparedWriteValidationError["code"],
    detail: string,
  ): { ok: false; error: PreparedWriteValidationError } => ({
    ok: false,
    error: { code, detail } as PreparedWriteValidationError,
  });

  const presentationMeta = input.definition.presentation;
  if (!presentationMeta) return fail("missing_presenter", input.definition.name);
  const presenter = getPreparedWritePresenter(presentationMeta.presenterId);
  if (!presenter) {
    return fail("missing_presenter", `${input.definition.name}:${presentationMeta.presenterId}`);
  }
  if (presenter.version !== presentationMeta.version) {
    return fail(
      "presenter_version_mismatch",
      `${presentationMeta.presenterId}:${presentationMeta.version}`,
    );
  }

  const materialFields = input.definition.materialFields ?? [];
  const expansion = expandMaterialFields({
    materialFields,
    normalizedOperation: input.normalizedOperation,
    boundedArgumentDictionaries: input.definition.boundedArgumentDictionaries,
  });
  if (!expansion.ok) {
    return fail("invalid_material_expansion", expansion.detail);
  }

  const expandedByPath = new Map(expansion.fields.map((field) => [field.path, field]));
  const factByPath = new Map<string, PreparedWriteFact>();
  for (const fact of input.presentation.facts) {
    if (factByPath.has(fact.path)) {
      return fail("duplicate_fact", fact.path);
    }
    factByPath.set(fact.path, fact);
    if (!expandedByPath.has(fact.path)) {
      return fail("undeclared_material_fact", fact.path);
    }
    const expanded = expandedByPath.get(fact.path)!;
    const formatter = getMaterialFormatter(expanded.formatterId, expanded.formatterVersion);
    if (!formatter) {
      return fail(
        "missing_formatter",
        `${expanded.formatterId}:${expanded.formatterVersion}`,
      );
    }
    const expected = formatScalarValue({
      formatterId: expanded.formatterId,
      formatterVersion: expanded.formatterVersion,
      path: fact.path,
      value: expanded.present
        ? expanded.scalarValue as null | boolean | number | string
        : null,
      resolvedTarget: input.resolvedTargets.find((target) => target.path === fact.path),
      serverDefault: input.serverDefaults.find((entry) => entry.path === fact.path),
    });
    if (!expected.ok) {
      return fail("presentation_limit_exceeded", expected.detail);
    }
    if (fact.value !== expected.value) {
      return fail("formatter_output_mismatch", `${fact.path}:${fact.value}:${expected.value}`);
    }
    const mapProvenance = input.fieldProvenance[fact.path];
    if (!mapProvenance) {
      return fail("undeclared_provenance_pointer", fact.path);
    }
    if (JSON.stringify(mapProvenance) !== JSON.stringify(fact.provenance)) {
      return fail("provenance_mismatch", fact.path);
    }
    if (Buffer.byteLength(fact.label, "utf8") > MATERIAL_LABEL_MAX_UTF8_BYTES) {
      return fail("presentation_limit_exceeded", `label:${fact.path}`);
    }
    if (Buffer.byteLength(fact.value, "utf8") > FORMATTER_OUTPUT_MAX_UTF8_BYTES) {
      return fail("presentation_limit_exceeded", `fact_value:${fact.path}`);
    }
  }

  for (const field of expansion.fields) {
    const hasFact = factByPath.has(field.path);
    const hasProvenance = Object.prototype.hasOwnProperty.call(input.fieldProvenance, field.path);
    if (field.requiredInPreview && !hasFact) {
      return fail("missing_required_fact", field.path);
    }
    if (field.requiredInPreview && !hasProvenance) {
      return fail("missing_required_provenance", field.path);
    }
    if (!field.requiredInPreview && field.present !== hasFact) {
      return fail("optional_fact_mismatch", field.path);
    }
    if (!field.requiredInPreview && field.present !== hasProvenance) {
      return fail("optional_fact_mismatch", `${field.path}:provenance`);
    }
    if (field.present && !hasFact) {
      return fail("normalized_material_value_omitted", field.path);
    }
  }

  for (const pointer of Object.keys(input.fieldProvenance)) {
    if (!expandedByPath.has(pointer)) {
      return fail("undeclared_provenance_pointer", pointer);
    }
  }

  for (const target of input.resolvedTargets) {
    const fact = factByPath.get(target.path);
    if (!fact) return fail("unresolved_target_omitted", target.path);
    if (!fact.value.includes(target.id) || !fact.value.includes(target.label)) {
      return fail("unresolved_target_omitted", `${target.path}:${target.id}`);
    }
  }

  for (const serverDefault of input.serverDefaults) {
    const fact = factByPath.get(serverDefault.path);
    if (!fact) return fail("server_default_omitted", serverDefault.path);
    const provenance = input.fieldProvenance[serverDefault.path];
    if (!provenance || provenance.source !== "server_default") {
      return fail("server_default_provenance_mismatch", serverDefault.path);
    }
    if (provenance.ruleId !== serverDefault.ruleId) {
      return fail("server_default_provenance_mismatch", `${serverDefault.path}:${provenance.ruleId}`);
    }
    const formattedDefault = formatScalarValue({
      formatterId: expandedByPath.get(serverDefault.path)!.formatterId,
      formatterVersion: expandedByPath.get(serverDefault.path)!.formatterVersion,
      path: serverDefault.path,
      value: isJsonScalar(serverDefault.value)
        ? serverDefault.value
        : null,
      serverDefault,
    });
    if (!formattedDefault.ok) {
      return fail("presentation_limit_exceeded", formattedDefault.detail);
    }
  }

  if (input.presentation.facts.length > MATERIAL_FACT_LIMIT) {
    return fail("presentation_limit_exceeded", `facts:${input.presentation.facts.length}`);
  }

  return { ok: true };
}

export function toPublicPresentationFacts(
  presentation: PreparedWritePresentation,
): Array<{ label: string; value: string }> {
  const materialFacts = presentation.facts.map(({ label, value }) => ({ label, value }));
  const endpointValue = `${presentation.endpoint.method} ${presentation.endpoint.host}${presentation.endpoint.path}`;
  return [
    ...materialFacts,
    { label: "API endpoint", value: endpointValue },
    { label: "Reversibility", value: presentation.reversibility.explanation },
  ];
}

function registerBuiltInFormatters(): void {
  registerMaterialFormatter({
    formatterId: "text",
    version: 1,
    maxOutputUtf8Bytes: 512,
    format: ({ value }) => value === null ? "(empty)" : String(value),
  });
  registerMaterialFormatter({
    formatterId: "number",
    version: 1,
    maxOutputUtf8Bytes: 64,
    format: ({ value }) => value === null ? "(empty)" : String(value),
  });
  registerMaterialFormatter({
    formatterId: "boolean",
    version: 1,
    maxOutputUtf8Bytes: 16,
    format: ({ value }) => value === null ? "(empty)" : value ? "true" : "false",
  });
  registerMaterialFormatter({
    formatterId: "money-minor",
    version: 1,
    maxOutputUtf8Bytes: 64,
    format: ({ value }) => value === null ? "(empty)" : fromMinor(Number(value)),
  });
  registerMaterialFormatter({
    formatterId: "entity",
    version: 1,
    maxOutputUtf8Bytes: 512,
    format: ({ value, resolvedTarget }) => {
      if (resolvedTarget) {
        return `${resolvedTarget.label} (${resolvedTarget.id})`;
      }
      return value === null ? "(empty)" : String(value);
    },
  });
}

export function validateCatalogPresentationRegistries(
  actions: readonly ActionDefinition[],
): void {
  for (const action of actions) {
    if (action.apiExposure !== "api" || !action.presentation) continue;
    const presenter = getPreparedWritePresenter(action.presentation.presenterId);
    if (!presenter) {
      throw new Error(`missing_prepared_write_presenter:${action.name}:${action.presentation.presenterId}`);
    }
    if (presenter.version !== action.presentation.version) {
      throw new Error(
        `prepared_write_presenter_version_mismatch:${action.name}:${action.presentation.presenterId}`,
      );
    }
    for (const field of action.materialFields ?? []) {
      const formatter = getMaterialFormatter(field.formatterId, field.formatterVersion);
      if (!formatter) {
        throw new Error(
          `missing_material_formatter:${action.name}:${field.formatterId}:${field.formatterVersion}`,
        );
      }
    }
  }
}

export function initializePreparedWritePresentationRegistries(
  actions: readonly ActionDefinition[],
): void {
  if (formatterRegistry.size === 0) {
    registerBuiltInFormatters();
  }
  for (const action of actions) {
    const presentation = action.presentation;
    if (!presentation || getPreparedWritePresenter(presentation.presenterId)) continue;
    registerPreparedWritePresenter({
      presenterId: presentation.presenterId,
      version: presentation.version,
      presentPreparedWrite: metadataDrivenPresentPreparedWrite,
    });
  }
  validateCatalogPresentationRegistries(actions);
}

function canonicalProvenanceJson(value: FieldProvenanceMap): string {
  const sorted: Record<string, FieldProvenance> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = value[key]!;
  }
  return JSON.stringify(sorted);
}

export function hashFieldProvenanceMap(map: FieldProvenanceMap): string {
  return createHash("sha256").update(canonicalProvenanceJson(map)).digest("hex");
}

/** Default v2 assistant provenance: every expanded material pointer is model inference. */
export function buildModelInferenceProvenance(
  definition: ActionDefinition,
  normalizedOperation: JsonObject,
): FieldProvenanceMap | { ok: false; detail: string } {
  const expansion = expandMaterialFields({
    materialFields: definition.materialFields ?? [],
    normalizedOperation,
    boundedArgumentDictionaries: definition.boundedArgumentDictionaries,
  });
  if (!expansion.ok) return expansion;
  const map: Record<string, FieldProvenance> = {};
  for (const field of expansion.fields) {
    if (field.requiredInPreview || field.present) {
      map[field.path] = { source: "model_inference" };
    }
  }
  return map;
}
