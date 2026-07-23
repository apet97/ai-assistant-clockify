import { createHash } from "node:crypto";

import { zodToJsonSchema } from "zod-to-json-schema";

import type { ActionDefinition } from "./action.js";
import {
  type ActionPresentationMetadata,
  type ActionRegistryId,
  type AdapterEndpointBinding,
  type ApiAccess,
  type ApiAvailability,
  type ApiExposure,
  type ApiHost,
  type ApiMethod,
  type ApiOperationMetadata,
  type AvailabilityByAuthClass,
  type AvailabilityReason,
  type BoundedDictionaryMetadata,
  materialScalarTypeForFormatter,
  type MaterialFieldMetadata,
  type MaterialScalarType,
  type NormalizedOperationMaterialContractEntry,
} from "./api-operation.js";
import {
  ACTION_CATALOG,
  actionFingerprintForDefinition,
} from "./catalog.js";
import { writeAuthorityFor } from "./write-authority.js";

const MATERIAL_FACT_LIMIT = 22;
const MATERIAL_LABEL_MAX_UTF8_BYTES = 128;
const SHA_256_PATTERN = /^[a-f0-9]{64}$/u;

const API_EXPOSURES: readonly ApiExposure[] = ["api", "composite", "generic", "local"];
const API_HOSTS: readonly ApiHost[] = ["api", "reports", "audit"];
const API_METHODS: readonly ApiMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const API_ACCESSES: readonly ApiAccess[] = ["read", "write"];
const AVAILABILITY_REASONS: readonly AvailabilityReason[] = [
  "unsupported_auth_class",
  "unavailable_endpoint",
  "official_operation_id_missing",
];

export type NormalizedRegistryAction = ActionDefinition & {
  apiExposure: ApiExposure;
  availabilityByAuthClass: AvailabilityByAuthClass;
};

export interface InventoryActionDefinition {
  sourceSurface: ActionRegistryId;
  definition: ActionDefinition;
}

interface ParsedAdapterEndpoint {
  access: ApiAccess;
  host: ApiHost;
  method: ApiMethod;
  path: string;
  sourceModule: string;
}

interface NormalizedDictionaries {
  values: readonly BoundedDictionaryMetadata[];
  byPath: ReadonlyMap<string, BoundedDictionaryMetadata>;
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isApiExposure(value: unknown): value is ApiExposure {
  return typeof value === "string" && API_EXPOSURES.some((candidate) => candidate === value);
}

function isApiHost(value: unknown): value is ApiHost {
  return typeof value === "string" && API_HOSTS.some((candidate) => candidate === value);
}

function isApiMethod(value: unknown): value is ApiMethod {
  return typeof value === "string" && API_METHODS.some((candidate) => candidate === value);
}

function isApiAccess(value: unknown): value is ApiAccess {
  return typeof value === "string" && API_ACCESSES.some((candidate) => candidate === value);
}

function isAvailabilityReason(value: unknown): value is AvailabilityReason {
  return typeof value === "string"
    && AVAILABILITY_REASONS.some((candidate) => candidate === value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function isNormalizedPath(value: unknown): value is string {
  return typeof value === "string"
    && value.startsWith("/")
    && !value.includes("?")
    && !value.includes("#")
    && !hasControlCharacter(value);
}

function isRfc6901Pointer(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("/")) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "~") continue;
    const escaped = value[index + 1];
    if (escaped !== "0" && escaped !== "1") return false;
    index += 1;
  }
  return !hasControlCharacter(value);
}

function isRelativeRfc6901Pointer(value: unknown): value is string {
  return value === "" || isRfc6901Pointer(value);
}

function placeholderCount(template: string, placeholder: string): number {
  return template.split(placeholder).length - 1;
}

function normalizeAvailabilityDecision(
  actionName: string,
  authClass: "addon" | "api_key",
  value: unknown,
): ApiAvailability {
  if (!isObject(value) || !("available" in value) || typeof value.available !== "boolean") {
    throw new Error(`invalid_auth_availability:${actionName}:${authClass}`);
  }
  const reason = "reason" in value ? value.reason : undefined;
  if (value.available) {
    if (reason !== undefined) {
      throw new Error(`invalid_auth_availability:${actionName}:${authClass}`);
    }
    return Object.freeze({ available: true });
  }
  if (!isAvailabilityReason(reason)) {
    throw new Error(`invalid_auth_availability:${actionName}:${authClass}`);
  }
  return Object.freeze({ available: false, reason });
}

function normalizeAvailability(
  actionName: string,
  value: unknown,
): AvailabilityByAuthClass {
  if (!isObject(value) || !("addon" in value) || !("api_key" in value)) {
    throw new Error(`missing_auth_availability:${actionName}`);
  }
  return Object.freeze({
    addon: normalizeAvailabilityDecision(actionName, "addon", value.addon),
    api_key: normalizeAvailabilityDecision(actionName, "api_key", value.api_key),
  });
}

function normalizeApiOperation(
  action: ActionDefinition,
  value: unknown,
): ApiOperationMetadata {
  if (!isObject(value)
    || !("operationId" in value) || !isNonemptyString(value.operationId)
    || !("host" in value) || !isApiHost(value.host)
    || !("method" in value) || !isApiMethod(value.method)
    || !("path" in value) || !isNormalizedPath(value.path)
    || !("access" in value) || !isApiAccess(value.access)
    || !("exposure" in value) || !isApiExposure(value.exposure)) {
    throw new Error(`invalid_api_operation:${action.name}`);
  }
  if (value.exposure !== "api") {
    throw new Error(`invalid_api_operation_exposure:${action.name}`);
  }
  const expectedAccess: ApiAccess = action.kind === "read" ? "read" : "write";
  if (value.access !== expectedAccess) {
    throw new Error(`api_operation_access_mismatch:${action.name}`);
  }
  return Object.freeze({
    operationId: value.operationId,
    host: value.host,
    method: value.method,
    path: value.path,
    access: value.access,
    exposure: value.exposure,
  });
}

function parseAdapterEndpointKey(value: string): ParsedAdapterEndpoint | undefined {
  const [access, host, method, path, sourceModule, extra] = value.split("\0");
  if (extra !== undefined
    || !isApiAccess(access)
    || !isApiHost(host)
    || !isApiMethod(method)
    || !isNormalizedPath(path)
    || typeof sourceModule !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.ts$/u.test(sourceModule)) {
    return undefined;
  }
  return { access, host, method, path, sourceModule };
}

function normalizeEndpointBindings(
  actionName: string,
  value: unknown,
  operation?: ApiOperationMetadata,
): AdapterEndpointBinding {
  if (!isObject(value)
    || !("primary" in value) || !Array.isArray(value.primary)
    || !("support" in value) || !Array.isArray(value.support)
    || !value.primary.every((key) => typeof key === "string")
    || !value.support.every((key) => typeof key === "string")) {
    throw new Error(`invalid_adapter_endpoints:${actionName}`);
  }
  const primary = Object.freeze([...value.primary]);
  const support = Object.freeze([...value.support]);
  const all = [...primary, ...support];
  if (new Set(all).size !== all.length) {
    throw new Error(`duplicate_adapter_endpoint:${actionName}`);
  }
  const parsed = all.map(parseAdapterEndpointKey);
  if (parsed.some((endpoint) => endpoint === undefined)) {
    throw new Error(`unknown_adapter_endpoint:${actionName}`);
  }
  if (parsed.slice(primary.length).some((endpoint) => endpoint?.access === "write")) {
    throw new Error(`write_support_endpoint:${actionName}`);
  }
  if (operation) {
    if (primary.length !== 1) {
      throw new Error(`invalid_primary_endpoint_count:${actionName}`);
    }
    const endpoint = parseAdapterEndpointKey(primary[0] ?? "");
    if (!endpoint
      || endpoint.access !== operation.access
      || endpoint.host !== operation.host
      || endpoint.method !== operation.method
      || endpoint.path !== operation.path) {
      throw new Error(`unknown_adapter_endpoint:${actionName}`);
    }
  }
  return Object.freeze({ primary, support });
}

function normalizePresentation(
  actionName: string,
  value: unknown,
): ActionPresentationMetadata {
  if (!isObject(value)
    || !("presenterId" in value) || !isNonemptyString(value.presenterId)
    || !("version" in value) || !isPositiveInteger(value.version)) {
    throw new Error(`invalid_action_presentation:${actionName}`);
  }
  return Object.freeze({ presenterId: value.presenterId, version: value.version });
}

function normalizeDictionaries(
  actionName: string,
  value: unknown,
): NormalizedDictionaries {
  if (value === undefined) {
    return { values: Object.freeze([]), byPath: new Map() };
  }
  if (!Array.isArray(value)) throw new Error(`invalid_bounded_dictionary:${actionName}`);

  const values: BoundedDictionaryMetadata[] = [];
  const byPath = new Map<string, BoundedDictionaryMetadata>();
  for (const entry of value) {
    if (!isObject(entry)
      || !("path" in entry) || !isRfc6901Pointer(entry.path)
      || !("keyPattern" in entry) || !isNonemptyString(entry.keyPattern)
      || !entry.keyPattern.startsWith("^") || !entry.keyPattern.endsWith("$")
      || !("maxKeyUtf8Bytes" in entry) || !isPositiveInteger(entry.maxKeyUtf8Bytes)
      || !("maxEntries" in entry) || !isPositiveInteger(entry.maxEntries)
      || !("valueSchemaFingerprint" in entry)
      || typeof entry.valueSchemaFingerprint !== "string"
      || !SHA_256_PATTERN.test(entry.valueSchemaFingerprint)) {
      throw new Error(`invalid_bounded_dictionary:${actionName}`);
    }
    try {
      void new RegExp(entry.keyPattern, "u");
    } catch {
      throw new Error(`invalid_bounded_dictionary:${actionName}`);
    }
    if (byPath.has(entry.path)) {
      throw new Error(`duplicate_bounded_dictionary:${actionName}:${entry.path}`);
    }
    const normalized = Object.freeze({
      path: entry.path,
      keyPattern: entry.keyPattern,
      maxKeyUtf8Bytes: entry.maxKeyUtf8Bytes,
      maxEntries: entry.maxEntries,
      valueSchemaFingerprint: entry.valueSchemaFingerprint,
    });
    values.push(normalized);
    byPath.set(normalized.path, normalized);
  }
  return { values: Object.freeze(values), byPath };
}

function escapedPointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function childPointer(parent: string, segment: string): string {
  return `${parent}/${escapedPointerSegment(segment)}`;
}

function schemaFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function scalarSchemaTypes(value: unknown): readonly string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : [];
}

function isJsonScalar(value: unknown): boolean {
  return value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
}

function assertClosedSchema(
  actionName: string,
  node: unknown,
  pointer: string,
  dictionaries: ReadonlyMap<string, BoundedDictionaryMetadata>,
  matchedDictionaries: Set<string>,
  arrayMaxItems: Map<string, number | null>,
): void {
  if (!isObject(node)) {
    throw new Error(`unreviewed_open_schema:${actionName}:${pointer || "/"}`);
  }
  if ("$ref" in node && typeof node.$ref === "string") {
    throw new Error(`unreviewed_open_schema:${actionName}:${pointer || "/"}`);
  }
  const anyOf = "anyOf" in node ? node.anyOf : undefined;
  if (anyOf !== undefined) {
    if (!Array.isArray(anyOf)) {
      throw new Error(`unreviewed_open_schema:${actionName}:${pointer || "/"}`);
    }
    const branches: unknown[] = anyOf;
    for (const branch of branches) {
      assertClosedSchema(
        actionName,
        branch,
        pointer,
        dictionaries,
        matchedDictionaries,
        arrayMaxItems,
      );
    }
    return;
  }
  const allOf = "allOf" in node ? node.allOf : undefined;
  if (allOf !== undefined) {
    if (!Array.isArray(allOf)) {
      throw new Error(`unreviewed_open_schema:${actionName}:${pointer || "/"}`);
    }
    const branches: unknown[] = allOf;
    for (const branch of branches) {
      assertClosedSchema(
        actionName,
        branch,
        pointer,
        dictionaries,
        matchedDictionaries,
        arrayMaxItems,
      );
    }
    return;
  }

  const types = scalarSchemaTypes("type" in node ? node.type : undefined);
  if (types.includes("object")) {
    if (types.length !== 1) {
      throw new Error(`unreviewed_open_schema:${actionName}:${pointer || "/"}`);
    }
    const properties = "properties" in node ? node.properties : undefined;
    if (properties !== undefined && !isObject(properties)) {
      throw new Error(`unreviewed_open_schema:${actionName}:${pointer || "/"}`);
    }
    const propertyEntries: [string, unknown][] = properties ? Object.entries(properties) : [];
    const additional = "additionalProperties" in node ? node.additionalProperties : undefined;
    if (additional === false) {
      for (const [key, child] of propertyEntries) {
        assertClosedSchema(
          actionName,
          child,
          childPointer(pointer, key),
          dictionaries,
          matchedDictionaries,
          arrayMaxItems,
        );
      }
      return;
    }
    if (!additional || additional === true || propertyEntries.length > 0) {
      throw new Error(`unreviewed_open_schema:${actionName}:${pointer || "/"}`);
    }
    const dictionary = dictionaries.get(pointer);
    if (!dictionary) {
      throw new Error(`unreviewed_open_schema:${actionName}:${pointer || "/"}`);
    }
    const propertyNames = "propertyNames" in node ? node.propertyNames : undefined;
    const schemaKeyPattern = isObject(propertyNames) && "pattern" in propertyNames
      ? propertyNames.pattern
      : undefined;
    if (schemaKeyPattern !== dictionary.keyPattern
      || schemaFingerprint(additional) !== dictionary.valueSchemaFingerprint) {
      throw new Error(`bounded_dictionary_schema_mismatch:${actionName}:${pointer}`);
    }
    const schemaMaxEntries = "maxProperties" in node ? node.maxProperties : undefined;
    if (!isPositiveInteger(schemaMaxEntries)) {
      throw new Error(`bounded_dictionary_schema_max_missing:${actionName}:${pointer}`);
    }
    if (schemaMaxEntries !== dictionary.maxEntries) {
      throw new Error(`bounded_dictionary_schema_max_mismatch:${actionName}:${pointer}`);
    }
    matchedDictionaries.add(pointer);
    assertClosedSchema(
      actionName,
      additional,
      `${pointer}/*`,
      dictionaries,
      matchedDictionaries,
      arrayMaxItems,
    );
    return;
  }

  if (types.includes("array")) {
    if (types.length !== 1 || !("items" in node) || !node.items) {
      throw new Error(`unreviewed_open_schema:${actionName}:${pointer || "/"}`);
    }
    const schemaMaxItems = "maxItems" in node ? node.maxItems : undefined;
    arrayMaxItems.set(pointer, isPositiveInteger(schemaMaxItems) ? schemaMaxItems : null);
    assertClosedSchema(
      actionName,
      node.items,
      `${pointer}/0`,
      dictionaries,
      matchedDictionaries,
      arrayMaxItems,
    );
    return;
  }

  if (types.length > 0
    && types.every((type) => ["string", "number", "integer", "boolean", "null"].includes(type))) {
    return;
  }
  if ("const" in node && isJsonScalar(node.const)) return;
  if ("enum" in node && Array.isArray(node.enum)
    && node.enum.length > 0 && node.enum.every(isJsonScalar)) return;
  throw new Error(`unreviewed_open_schema:${actionName}:${pointer || "/"}`);
}

function validateClosedWriteSchema(
  action: ActionDefinition,
  dictionaries: NormalizedDictionaries,
): ReadonlyMap<string, number | null> {
  if ((action.argumentOpenPaths?.length ?? 0) > 0) {
    throw new Error(`legacy_open_argument_paths:${action.name}`);
  }
  const schema = zodToJsonSchema(action.schema, {
    $refStrategy: "none",
    target: "jsonSchema7",
  });
  const matched = new Set<string>();
  const arrayMaxItems = new Map<string, number | null>();
  assertClosedSchema(
    action.name,
    schema,
    "",
    dictionaries.byPath,
    matched,
    arrayMaxItems,
  );
  for (const dictionary of dictionaries.values) {
    if (!matched.has(dictionary.path)) {
      throw new Error(`unmatched_bounded_dictionary:${action.name}:${dictionary.path}`);
    }
  }
  return arrayMaxItems;
}

export type ActionArgumentSchemaVerdict =
  | { verdict: "not_applicable" }
  | { verdict: "closed" }
  | { verdict: "open"; detail: string };

const OPEN_SCHEMA_ERROR_PREFIXES = [
  "legacy_open_argument_paths:",
  "unreviewed_open_schema:",
  "bounded_dictionary_schema_mismatch:",
  "bounded_dictionary_schema_max_missing:",
  "bounded_dictionary_schema_max_mismatch:",
  "unmatched_bounded_dictionary:",
] as const;

/** Measure the current write schema without making an internal action visible. */
export function actionArgumentSchemaVerdict(
  action: ActionDefinition,
): ActionArgumentSchemaVerdict {
  if (action.kind === "read") return { verdict: "not_applicable" };
  const dictionaries = normalizeDictionaries(
    action.name,
    action.boundedArgumentDictionaries,
  );
  try {
    validateClosedWriteSchema(action, dictionaries);
    return { verdict: "closed" };
  } catch (error) {
    if (error instanceof Error
      && OPEN_SCHEMA_ERROR_PREFIXES.some((prefix) => error.message.startsWith(prefix))) {
      return { verdict: "open", detail: error.message };
    }
    throw error;
  }
}

function validateFormatter(
  actionName: string,
  field: MaterialFieldMetadata,
): void {
  if (!isNonemptyString(field.formatterId)
    || !isPositiveInteger(field.formatterVersion)
    || typeof field.requiredInPreview !== "boolean") {
    throw new Error(`invalid_material_formatter:${actionName}`);
  }
}

const MATERIAL_SCALAR_TYPES: readonly MaterialScalarType[] = [
  "string",
  "number",
  "boolean",
  "null",
];

function isMaterialScalarType(value: unknown): value is MaterialScalarType {
  return typeof value === "string"
    && MATERIAL_SCALAR_TYPES.some((candidate) => candidate === value);
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function materialContractIdentity(
  field: MaterialFieldMetadata | NormalizedOperationMaterialContractEntry,
): string {
  switch (field.kind) {
    case "value":
      return `${field.kind}\0${field.path}`;
    case "array_item":
      return `${field.kind}\0${field.containerPath}\0${field.itemPath}`;
    case "dictionary_entry":
      return `${field.kind}\0${field.containerPath}\0${field.valuePath}`;
  }
}

function materialContractPointer(
  field: MaterialFieldMetadata | NormalizedOperationMaterialContractEntry,
): string {
  switch (field.kind) {
    case "value":
      return field.path;
    case "array_item":
      return `${field.containerPath}${field.itemPath}`;
    case "dictionary_entry":
      return `${field.containerPath}${field.valuePath}`;
  }
}

function normalizeMaterialContract(
  actionName: string,
  value: unknown,
  required: boolean,
): readonly NormalizedOperationMaterialContractEntry[] | undefined {
  if (value === undefined) {
    if (required) throw new Error(`missing_normalized_operation_material_contract:${actionName}`);
    return undefined;
  }
  if (!Array.isArray(value) || (required && value.length === 0)) {
    throw new Error(`invalid_normalized_operation_material_contract:${actionName}`);
  }

  const normalized: NormalizedOperationMaterialContractEntry[] = [];
  const identities = new Set<string>();
  for (const rawField of value) {
    if (!isObject(rawField) || !("kind" in rawField) || !("scalarType" in rawField)
      || !isMaterialScalarType(rawField.scalarType)) {
      throw new Error(`invalid_normalized_operation_material_contract:${actionName}`);
    }
    let field: NormalizedOperationMaterialContractEntry;
    if (rawField.kind === "value") {
      if (!hasExactKeys(rawField, ["kind", "path", "scalarType"])
        || !("path" in rawField) || !isRfc6901Pointer(rawField.path)) {
        throw new Error(`invalid_normalized_operation_material_contract:${actionName}`);
      }
      field = Object.freeze({
        kind: rawField.kind,
        path: rawField.path,
        scalarType: rawField.scalarType,
      });
    } else if (rawField.kind === "array_item") {
      if (!hasExactKeys(rawField, [
        "kind",
        "containerPath",
        "itemPath",
        "maxItems",
        "scalarType",
      ])
        || !("containerPath" in rawField) || !isRfc6901Pointer(rawField.containerPath)
        || !("itemPath" in rawField) || !isRelativeRfc6901Pointer(rawField.itemPath)
        || !("maxItems" in rawField) || !isPositiveInteger(rawField.maxItems)) {
        throw new Error(`invalid_normalized_operation_material_contract:${actionName}`);
      }
      field = Object.freeze({
        kind: rawField.kind,
        containerPath: rawField.containerPath,
        itemPath: rawField.itemPath,
        maxItems: rawField.maxItems,
        scalarType: rawField.scalarType,
      });
    } else if (rawField.kind === "dictionary_entry") {
      if (!hasExactKeys(rawField, [
        "kind",
        "containerPath",
        "valuePath",
        "maxEntries",
        "scalarType",
      ])
        || !("containerPath" in rawField) || !isRfc6901Pointer(rawField.containerPath)
        || !("valuePath" in rawField) || !isRelativeRfc6901Pointer(rawField.valuePath)
        || !("maxEntries" in rawField) || !isPositiveInteger(rawField.maxEntries)) {
        throw new Error(`invalid_normalized_operation_material_contract:${actionName}`);
      }
      field = Object.freeze({
        kind: rawField.kind,
        containerPath: rawField.containerPath,
        valuePath: rawField.valuePath,
        maxEntries: rawField.maxEntries,
        scalarType: rawField.scalarType,
      });
    } else {
      throw new Error(`invalid_normalized_operation_material_contract:${actionName}`);
    }
    const identity = materialContractIdentity(field);
    if (identities.has(identity)) {
      throw new Error(`duplicate_normalized_operation_material_contract:${actionName}`);
    }
    identities.add(identity);
    normalized.push(field);
  }
  return Object.freeze(normalized);
}

function validateMaterialContractCoverage(
  actionName: string,
  fields: readonly MaterialFieldMetadata[],
  contract: readonly NormalizedOperationMaterialContractEntry[],
): void {
  const contractByIdentity = new Map(
    contract.map((entry) => [materialContractIdentity(entry), entry]),
  );
  const matched = new Set<string>();
  for (const field of fields) {
    const identity = materialContractIdentity(field);
    const contractEntry = contractByIdentity.get(identity);
    const pointer = materialContractPointer(field);
    if (!contractEntry) {
      throw new Error(`undeclared_material_pointer:${actionName}:${pointer}`);
    }
    if (materialScalarTypeForFormatter(field.formatterId) !== contractEntry.scalarType) {
      throw new Error(`material_scalar_type_mismatch:${actionName}:${pointer}`);
    }
    if ((field.kind === "array_item" && contractEntry.kind === "array_item"
        && field.maxItems !== contractEntry.maxItems)
      || (field.kind === "dictionary_entry" && contractEntry.kind === "dictionary_entry"
        && field.maxEntries !== contractEntry.maxEntries)) {
      throw new Error(`material_contract_max_mismatch:${actionName}:${pointer}`);
    }
    matched.add(identity);
  }
  for (const contractEntry of contract) {
    const identity = materialContractIdentity(contractEntry);
    if (!matched.has(identity)) {
      throw new Error(
        `missing_material_field:${actionName}:${materialContractPointer(contractEntry)}`,
      );
    }
  }
}

function validateMaterialFields(
  actionName: string,
  value: unknown,
  dictionaries: ReadonlyMap<string, BoundedDictionaryMetadata>,
  required: boolean,
  schemaArrayMaxItems?: ReadonlyMap<string, number | null>,
): readonly MaterialFieldMetadata[] | undefined {
  if (value === undefined) {
    if (required) throw new Error(`missing_material_fields:${actionName}`);
    return undefined;
  }
  if (!Array.isArray(value) || (required && value.length === 0)) {
    throw new Error(`missing_material_fields:${actionName}`);
  }

  const normalized: MaterialFieldMetadata[] = [];
  const identities = new Set<string>();
  const matchedDictionaries = new Set<string>();
  let worstCaseFacts = 0;
  for (const rawField of value) {
    if (!isObject(rawField) || !("kind" in rawField)) {
      throw new Error(`invalid_material_field:${actionName}`);
    }
    if (rawField.kind === "value") {
      if (!("path" in rawField) || !isRfc6901Pointer(rawField.path)
        || !("label" in rawField) || !isNonemptyString(rawField.label)
        || Buffer.byteLength(rawField.label, "utf8") > MATERIAL_LABEL_MAX_UTF8_BYTES
        || !("formatterId" in rawField) || typeof rawField.formatterId !== "string"
        || !("formatterVersion" in rawField) || typeof rawField.formatterVersion !== "number"
        || !("requiredInPreview" in rawField)
        || typeof rawField.requiredInPreview !== "boolean") {
        throw new Error(`invalid_material_field:${actionName}`);
      }
      const field = Object.freeze({
        kind: rawField.kind,
        path: rawField.path,
        label: rawField.label,
        formatterId: rawField.formatterId,
        formatterVersion: rawField.formatterVersion,
        requiredInPreview: rawField.requiredInPreview,
      });
      validateFormatter(actionName, field);
      normalized.push(field);
      worstCaseFacts += 1;
    } else if (rawField.kind === "array_item") {
      if (!("containerPath" in rawField) || !isRfc6901Pointer(rawField.containerPath)
        || !("itemPath" in rawField) || !isRelativeRfc6901Pointer(rawField.itemPath)
        || !("labelTemplate" in rawField) || !isNonemptyString(rawField.labelTemplate)
        || placeholderCount(rawField.labelTemplate, "{index}") !== 1
        || !("maxItems" in rawField) || !isPositiveInteger(rawField.maxItems)
        || !("formatterId" in rawField) || typeof rawField.formatterId !== "string"
        || !("formatterVersion" in rawField) || typeof rawField.formatterVersion !== "number"
        || !("requiredInPreview" in rawField)
        || typeof rawField.requiredInPreview !== "boolean") {
        throw new Error(`invalid_material_field:${actionName}`);
      }
      const worstCaseLabel = rawField.labelTemplate.replace(
        "{index}",
        String(rawField.maxItems - 1),
      );
      if (Buffer.byteLength(worstCaseLabel, "utf8") > MATERIAL_LABEL_MAX_UTF8_BYTES) {
        throw new Error(`material_label_limit_exceeded:${actionName}`);
      }
      if (schemaArrayMaxItems) {
        const schemaMaxItems = schemaArrayMaxItems.get(rawField.containerPath);
        if (schemaMaxItems === undefined || schemaMaxItems === null) {
          throw new Error(
            `material_array_schema_max_missing:${actionName}:${rawField.containerPath}`,
          );
        }
        if (schemaMaxItems !== rawField.maxItems) {
          throw new Error(
            `material_array_max_mismatch:${actionName}:${rawField.containerPath}`,
          );
        }
      }
      const field = Object.freeze({
        kind: rawField.kind,
        containerPath: rawField.containerPath,
        itemPath: rawField.itemPath,
        labelTemplate: rawField.labelTemplate,
        maxItems: rawField.maxItems,
        formatterId: rawField.formatterId,
        formatterVersion: rawField.formatterVersion,
        requiredInPreview: rawField.requiredInPreview,
      });
      validateFormatter(actionName, field);
      normalized.push(field);
      worstCaseFacts += field.maxItems;
    } else if (rawField.kind === "dictionary_entry") {
      if (!("containerPath" in rawField) || !isRfc6901Pointer(rawField.containerPath)
        || !("valuePath" in rawField) || !isRelativeRfc6901Pointer(rawField.valuePath)
        || !("labelTemplate" in rawField) || !isNonemptyString(rawField.labelTemplate)
        || placeholderCount(rawField.labelTemplate, "{key}") !== 1
        || !("maxEntries" in rawField) || !isPositiveInteger(rawField.maxEntries)
        || !("formatterId" in rawField) || typeof rawField.formatterId !== "string"
        || !("formatterVersion" in rawField) || typeof rawField.formatterVersion !== "number"
        || !("requiredInPreview" in rawField)
        || typeof rawField.requiredInPreview !== "boolean") {
        throw new Error(`invalid_material_field:${actionName}`);
      }
      const dictionary = dictionaries.get(rawField.containerPath);
      if (!dictionary || dictionary.maxEntries !== rawField.maxEntries) {
        throw new Error(`unmatched_material_dictionary:${actionName}:${rawField.containerPath}`);
      }
      const literalLabelBytes = Buffer.byteLength(
        rawField.labelTemplate.replace("{key}", ""),
        "utf8",
      );
      if (literalLabelBytes + dictionary.maxKeyUtf8Bytes > MATERIAL_LABEL_MAX_UTF8_BYTES) {
        throw new Error(`material_label_limit_exceeded:${actionName}`);
      }
      const field = Object.freeze({
        kind: rawField.kind,
        containerPath: rawField.containerPath,
        valuePath: rawField.valuePath,
        labelTemplate: rawField.labelTemplate,
        maxEntries: rawField.maxEntries,
        formatterId: rawField.formatterId,
        formatterVersion: rawField.formatterVersion,
        requiredInPreview: rawField.requiredInPreview,
      });
      validateFormatter(actionName, field);
      normalized.push(field);
      matchedDictionaries.add(field.containerPath);
      worstCaseFacts += field.maxEntries;
    } else {
      throw new Error(`invalid_material_field:${actionName}`);
    }

    const field = normalized.at(-1);
    if (!field) throw new Error(`invalid_material_field:${actionName}`);
    const identity = field.kind === "value"
      ? `${field.kind}\0${field.path}`
      : field.kind === "array_item"
        ? `${field.kind}\0${field.containerPath}\0${field.itemPath}`
        : `${field.kind}\0${field.containerPath}\0${field.valuePath}`;
    if (identities.has(identity)) throw new Error(`duplicate_material_field:${actionName}`);
    identities.add(identity);
  }
  if (worstCaseFacts > MATERIAL_FACT_LIMIT) {
    throw new Error(`material_fact_limit_exceeded:${actionName}:${worstCaseFacts}`);
  }
  if (required) {
    for (const path of dictionaries.keys()) {
      if (!matchedDictionaries.has(path)) {
        throw new Error(`unmatched_material_dictionary:${actionName}:${path}`);
      }
    }
  }
  return Object.freeze(normalized);
}

function assertAtomicWriteAuthority(
  actionName: string,
  action: Exclude<ActionDefinition, { kind: "read" }>,
): ReturnType<typeof writeAuthorityFor> {
  const authority = writeAuthorityFor(action);
  const primaryStepIds = new Set<string>();
  let sawPrimary = false;
  for (const plan of authority.mutationPlans) {
    let primaryCount = 0;
    for (const step of plan.steps) {
      if (step.kind !== "primary") continue;
      sawPrimary = true;
      primaryCount += step.max;
      primaryStepIds.add(step.id);
    }
    if (primaryCount > 1) throw new Error(`multiple_primary_mutations:${actionName}`);
  }
  if (!sawPrimary) throw new Error(`missing_primary_mutation:${actionName}`);
  if (primaryStepIds.size > 1) throw new Error(`primary_mutation_selection:${actionName}`);
  return authority;
}

function validateRegistryExposure(
  actionName: string,
  registryId: ActionRegistryId,
  exposure: ApiExposure,
): void {
  if ((registryId === "v2-api" && exposure !== "api")
    || (registryId === "v2-local" && exposure !== "local")) {
    throw new Error(`registry_exposure_mismatch:${registryId}:${actionName}:${exposure}`);
  }
}

/**
 * The sole raw-definition -> registry boundary. It supplies no classification
 * defaults, recomputes write authority from the reviewed table, and returns a
 * fresh immutable definition only after all surface-specific invariants pass.
 */
export function normalizeRegistryAction(
  definition: ActionDefinition,
  registryId: ActionRegistryId,
): NormalizedRegistryAction {
  const exposure = definition.apiExposure;
  if (!isApiExposure(exposure)) throw new Error(`missing_api_exposure:${definition.name}`);
  validateRegistryExposure(definition.name, registryId, exposure);
  const availability = normalizeAvailability(definition.name, definition.availabilityByAuthClass);
  const dictionaries = normalizeDictionaries(
    definition.name,
    definition.boundedArgumentDictionaries,
  );

  if (exposure === "api") {
    if (definition.apiExposureReason !== undefined) {
      throw new Error(`unexpected_api_exposure_reason:${definition.name}`);
    }
    const operation = normalizeApiOperation(definition, definition.apiOperation);
    const endpoints = normalizeEndpointBindings(
      definition.name,
      definition.adapterEndpoints,
      operation,
    );
    const presentation = normalizePresentation(definition.name, definition.presentation);
    if (!availability.addon.available && !availability.api_key.available) {
      throw new Error(`api_action_unavailable:${definition.name}`);
    }
    if (definition.kind === "read") {
      if (definition.writeAuthority !== undefined) {
        throw new Error(`unexpected_write_authority:${definition.name}`);
      }
      if (definition.normalizedOperationMaterialContract !== undefined) {
        throw new Error(
          `unexpected_normalized_operation_material_contract:${definition.name}`,
        );
      }
      const materialFields = validateMaterialFields(
        definition.name,
        definition.materialFields,
        dictionaries.byPath,
        false,
      );
      return Object.freeze({
        ...definition,
        apiExposure: exposure,
        apiOperation: operation,
        adapterEndpoints: endpoints,
        availabilityByAuthClass: availability,
        boundedArgumentDictionaries: dictionaries.values,
        ...(materialFields === undefined ? {} : { materialFields }),
        presentation,
      });
    }
    const schemaArrayMaxItems = validateClosedWriteSchema(definition, dictionaries);
    const normalizedOperationMaterialContract = normalizeMaterialContract(
      definition.name,
      definition.normalizedOperationMaterialContract,
      true,
    );
    const materialFields = validateMaterialFields(
      definition.name,
      definition.materialFields,
      dictionaries.byPath,
      true,
      schemaArrayMaxItems,
    );
    validateMaterialContractCoverage(
      definition.name,
      materialFields ?? [],
      normalizedOperationMaterialContract ?? [],
    );
    const writeAuthority = assertAtomicWriteAuthority(definition.name, definition);
    return Object.freeze({
      ...definition,
      apiExposure: exposure,
      apiOperation: operation,
      adapterEndpoints: endpoints,
      availabilityByAuthClass: availability,
      boundedArgumentDictionaries: dictionaries.values,
      materialFields,
      normalizedOperationMaterialContract,
      presentation,
      writeAuthority,
    });
  }

  if (definition.apiOperation !== undefined) {
    throw new Error(`unexpected_api_operation:${definition.name}`);
  }
  if (definition.normalizedOperationMaterialContract !== undefined) {
    throw new Error(`unexpected_normalized_operation_material_contract:${definition.name}`);
  }
  if ((exposure === "composite" || exposure === "generic")
    && !isNonemptyString(definition.apiExposureReason)) {
    throw new Error(`missing_api_exposure_reason:${definition.name}`);
  }
  if (exposure === "local"
    && definition.apiExposureReason !== undefined
    && !isNonemptyString(definition.apiExposureReason)) {
    throw new Error(`invalid_api_exposure_reason:${definition.name}`);
  }
  const endpoints = definition.adapterEndpoints === undefined
    ? undefined
    : normalizeEndpointBindings(definition.name, definition.adapterEndpoints);
  if (exposure === "local" && (endpoints?.primary.length ?? 0) > 0) {
    throw new Error(`local_primary_endpoint:${definition.name}`);
  }
  const presentation = definition.presentation === undefined
    ? undefined
    : normalizePresentation(definition.name, definition.presentation);
  const materialFields = validateMaterialFields(
    definition.name,
    definition.materialFields,
    dictionaries.byPath,
    false,
  );
  const normalizedDefinition = {
    ...definition,
    apiExposure: exposure,
    availabilityByAuthClass: availability,
    boundedArgumentDictionaries: dictionaries.values,
    ...(endpoints === undefined ? {} : { adapterEndpoints: endpoints }),
    ...(presentation === undefined ? {} : { presentation }),
    ...(materialFields === undefined ? {} : { materialFields }),
  };
  if (definition.kind === "read") {
    if (definition.writeAuthority !== undefined) {
      throw new Error(`unexpected_write_authority:${definition.name}`);
    }
    return Object.freeze(normalizedDefinition);
  }
  return Object.freeze({
    ...normalizedDefinition,
    writeAuthority: writeAuthorityFor(definition),
  });
}

/** Hash input used by Task 5's immutable ActionRegistry implementation. */
export function registryHashForActions(actions: readonly NormalizedRegistryAction[]): string {
  return createHash("sha256").update(JSON.stringify(actions.map((action) => ({
    name: action.name,
    fingerprint: actionFingerprintForDefinition(action),
    availabilityByAuthClass: action.availabilityByAuthClass,
  })))).digest("hex");
}

/** Duplicate-safe inventory boundary; future split definitions join here. */
export function inventoryActionDefinitions(): readonly InventoryActionDefinition[] {
  const entries: InventoryActionDefinition[] = [];
  const keys = new Set<string>();
  for (const definition of ACTION_CATALOG) {
    const sourceSurface: ActionRegistryId = "v1-internal";
    const key = `${sourceSurface}\0${definition.name}`;
    if (keys.has(key)) throw new Error(`duplicate_inventory_action:${key}`);
    keys.add(key);
    entries.push(Object.freeze({ sourceSurface, definition }));
  }
  return Object.freeze(entries);
}
