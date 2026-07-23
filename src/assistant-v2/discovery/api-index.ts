import type { ActionDefinition } from "../../harness/action.js";
import type { ActionRegistry } from "../../harness/api-catalog.js";
import type {
  ApiAccess,
  ApiHost,
  ApiMethod,
  AuthClass,
  AvailabilityByAuthClass,
} from "../../harness/api-operation.js";
import type { FeatureGroup } from "../../harness/permissions.js";
import type { RiskLabel } from "../../harness/risk.js";
import { requiredArgumentsFromSchema } from "../../harness/tool-schema.js";
import { normalizeSearchText, tokenizeSearchText } from "./api-text.js";

export interface IndexedSearchFields {
  readonly operationId: readonly string[];
  readonly toolName: readonly string[];
  readonly methodPath: readonly string[];
  readonly groupArgumentAccess: readonly string[];
  readonly description: readonly string[];
  readonly operationIdText: string;
  readonly toolNameText: string;
  readonly methodPathText: string;
  readonly groupArgumentAccessText: string;
  readonly descriptionText: string;
}

export interface IndexedApiOperation {
  readonly toolName: string;
  readonly operationId: string;
  readonly host: ApiHost;
  readonly method: ApiMethod;
  readonly path: string;
  readonly description: string;
  readonly requiredArguments: readonly string[];
  readonly access: ApiAccess;
  readonly risks: readonly RiskLabel[];
  readonly featureGroup: FeatureGroup;
  readonly availabilityByAuthClass: AvailabilityByAuthClass;
  readonly searchFields: IndexedSearchFields;
}

export interface ApiOperationIndex {
  readonly registryId: "v2-api";
  readonly catalogHash: string;
  readonly operations: readonly IndexedApiOperation[];
}

function requiredArgumentsFor(action: ActionDefinition): readonly string[] {
  return requiredArgumentsFromSchema(action.schema);
}

function pathSegmentText(path: string): string {
  return path
    .split("/")
    .flatMap((segment) => segment.replace(/[{}]/gu, " ").split(/\s+/u))
    .filter(Boolean)
    .join(" ");
}

function buildSearchFields(action: ActionDefinition): IndexedSearchFields {
  const operationId = action.apiOperation?.operationId ?? "";
  const toolName = action.name;
  const method = action.apiOperation?.method ?? "";
  const pathSegments = pathSegmentText(action.apiOperation?.path ?? "");
  const featureGroup = action.featureGroup.replace(/_/gu, " ");
  const requiredArguments = requiredArgumentsFor(action).join(" ");
  const access = action.apiOperation?.access ?? "";
  const description = action.description;

  const operationIdText = normalizeSearchText(operationId);
  const toolNameText = normalizeSearchText(toolName.replace(/_/gu, " "));
  const methodPathText = normalizeSearchText(`${method} ${pathSegments}`);
  const groupArgumentAccessText = normalizeSearchText(
    `${featureGroup} ${requiredArguments} ${access}`,
  );
  const descriptionText = normalizeSearchText(description);

  return Object.freeze({
    operationId: Object.freeze(tokenizeSearchText(operationIdText)),
    toolName: Object.freeze(tokenizeSearchText(toolNameText)),
    methodPath: Object.freeze(tokenizeSearchText(methodPathText)),
    groupArgumentAccess: Object.freeze(tokenizeSearchText(groupArgumentAccessText)),
    description: Object.freeze(tokenizeSearchText(descriptionText)),
    operationIdText,
    toolNameText,
    methodPathText,
    groupArgumentAccessText,
    descriptionText,
  });
}

function indexAction(action: ActionDefinition): IndexedApiOperation {
  const apiOperation = action.apiOperation;
  if (!apiOperation) {
    throw new Error(`discovery_index_missing_api_operation:${action.name}`);
  }
  return Object.freeze({
    toolName: action.name,
    operationId: apiOperation.operationId,
    host: apiOperation.host,
    method: apiOperation.method,
    path: apiOperation.path,
    description: action.description,
    requiredArguments: requiredArgumentsFor(action),
    access: apiOperation.access,
    risks: Object.freeze([...action.risks]),
    featureGroup: action.featureGroup,
    availabilityByAuthClass: action.availabilityByAuthClass,
    searchFields: buildSearchFields(action),
  });
}

/** Immutable trusted metadata index built once from the model API registry. */
export function buildApiOperationIndex(registry: ActionRegistry): ApiOperationIndex {
  if (registry.id !== "v2-api") {
    throw new Error(`discovery_index_registry_required:v2-api`);
  }
  const operations = Object.freeze(registry.actions.map(indexAction));
  return Object.freeze({
    registryId: "v2-api",
    catalogHash: registry.hash(),
    operations,
  });
}

export function isOperationAvailableForAuth(
  operation: IndexedApiOperation,
  authClass: AuthClass,
): boolean {
  return operation.availabilityByAuthClass[authClass].available;
}

export function toApiOperationDescriptor(
  operation: IndexedApiOperation,
): {
  toolName: string;
  operationId: string;
  host: ApiHost;
  method: ApiMethod;
  path: string;
  description: string;
  requiredArguments: readonly string[];
  access: ApiAccess;
  risks: readonly RiskLabel[];
} {
  return Object.freeze({
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
}
