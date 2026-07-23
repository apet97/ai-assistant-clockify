import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { zodToJsonSchema } from "zod-to-json-schema";

import type { ActionDefinition } from "../src/harness/action.js";
import {
  actionArgumentSchemaVerdict,
  inventoryActionDefinitions,
  normalizeRegistryAction,
} from "../src/harness/action-registry.js";
import type {
  ActionRegistryId,
  ApiAvailability,
  ApiHost,
  ApiMethod,
  ApiOperationMetadata,
  AvailabilityByAuthClass,
  BoundedDictionaryMetadata,
  MaterialFieldMetadata,
  NormalizedOperationMaterialContractEntry,
} from "../src/harness/api-operation.js";
import {
  actionFingerprintForDefinition,
  ACTION_CATALOG,
  catalogHash,
} from "../src/harness/catalog.js";
import { ADMIN_ACTIONS } from "../src/harness/workflows/admin.js";
import { APPROVAL_ACTIONS } from "../src/harness/workflows/approvals.js";
import { AUDIT_ACTIONS } from "../src/harness/workflows/audit.js";
import { CLIENT_ACTIONS } from "../src/harness/workflows/clients.js";
import { CURATED_ACTIONS } from "../src/harness/workflows/curated.js";
import { CUSTOM_FIELD_ACTIONS } from "../src/harness/workflows/custom-fields.js";
import { CUSTOM_FIELD_API_ACTIONS } from "../src/harness/api-actions/custom-fields.js";
import { ENTRY_ACTIONS } from "../src/harness/workflows/entries.js";
import { EXPENSE_ACTIONS } from "../src/harness/workflows/expenses.js";
import { EXPENSE_API_ACTIONS } from "../src/harness/api-actions/expenses.js";
import { HOLIDAY_ACTIONS } from "../src/harness/workflows/holidays.js";
import { INVOICE_ACTIONS } from "../src/harness/workflows/invoices.js";
import { INVOICE_API_ACTIONS } from "../src/harness/api-actions/invoices.js";
import { PROJECT_ACTIONS } from "../src/harness/workflows/projects.js";
import { PROJECT_API_ACTIONS } from "../src/harness/api-actions/projects.js";
import { TASK_API_ACTIONS } from "../src/harness/api-actions/tasks.js";
import { CLIENT_API_ACTIONS } from "../src/harness/api-actions/clients.js";
import { ENTRY_API_ACTIONS } from "../src/harness/api-actions/time-entries.js";
import { USER_GROUP_ACTIONS } from "../src/harness/workflows/users.js";
import { USER_API_ACTIONS } from "../src/harness/api-actions/users.js";
import { REPORT_ACTIONS } from "../src/harness/workflows/reports.js";
import { SCHEDULING_ACTIONS } from "../src/harness/workflows/scheduling.js";
import { SETUP_PROJECT_ACTIONS } from "../src/harness/workflows/setup-project.js";
import { SETUP_TASK_ACTIONS } from "../src/harness/workflows/setup-task.js";
import { TAG_ACTIONS } from "../src/harness/workflows/tags.js";
import { TASK_ACTIONS } from "../src/harness/workflows/tasks.js";
import { TIME_OFF_ACTIONS } from "../src/harness/workflows/time-off.js";
import { TIME_TRACKING_ACTIONS } from "../src/harness/workflows/time-tracking.js";
import { WEBHOOK_ACTIONS } from "../src/harness/workflows/webhooks.js";
import { WORK_STRUCTURE_ACTIONS } from "../src/harness/workflows/work-structure.js";
import { WORKSPACE_ACTIONS } from "../src/harness/workflows/workspace.js";
import {
  adapterRequestShapeKey,
  canonicalOpenApiPath,
  correlateAdapterEndpointPaths,
  expandReviewedDynamicAdapterPath,
  extractAdapterEndpoints,
  extractOpenApiDescriptionOperations,
  INTERNAL_OPENAPI_OPERATIONS,
  NON_ACTION_ADAPTER_DISPOSITIONS,
  OFFICIAL_OPENAPI_SOURCE,
  type AdapterEndpointPagination,
  type CanonicalOpenApiOperation,
} from "./lib/adapter-endpoints.js";

const INVENTORY_SCHEMA_VERSION = 2;
const INVENTORY_GENERATOR_VERSION = 2;

type ActionExposure = "api" | "composite" | "generic" | "local";
type AdapterDecision = "model_api" | "internal_support" | "unavailable";
type AdapterRole = "primary" | "support";

interface ActionAdapterShape {
  key: string;
  role: AdapterRole;
  access: "read" | "write";
  host: ApiHost;
  method: ApiMethod;
  path: string;
  sourceModule: string;
}

interface InventoryActionRow {
  sourceSurface: ActionRegistryId;
  name: string;
  description: string;
  kind: ActionDefinition["kind"];
  featureGroup: string;
  workflowModule: string;
  actionFingerprint: string;
  exposure: ActionExposure;
  decisionReason: string;
  operation: ApiOperationMetadata | null;
  availabilityByAuthClass: AvailabilityByAuthClass;
  adapterShapes: readonly ActionAdapterShape[];
  boundedArgumentDictionaries: readonly BoundedDictionaryMetadata[];
  openSchemaVerdict: "closed" | "open" | "not_applicable";
  openSchemaDetail: string | null;
  materialFields: readonly MaterialFieldMetadata[];
  normalizedOperationMaterialContract:
    readonly NormalizedOperationMaterialContractEntry[];
  presentation: { presenterId: string; version: number } | null;
  requiredArguments: readonly string[];
  primaryMutationCount: number;
  compensationCount: number;
}

interface AdapterSourceCallSite {
  sourceModule: string;
  sourceLine: number;
  sourceColumn: number;
  pagination: AdapterEndpointPagination;
}

interface InventoryAdapterRow {
  key: string;
  access: "read" | "write";
  host: ApiHost;
  method: ApiMethod;
  path: string;
  sourceModule: string;
  sourceCallSites: readonly AdapterSourceCallSite[];
  mappedModelActionNames: readonly string[];
  internalSupportConsumers: readonly string[];
  availabilityByAuthClass: AvailabilityByAuthClass;
  decision: AdapterDecision;
  decisionReason: string;
}

interface InventoryCorrelationRow {
  adapterKey: string;
  expandedPaths: readonly string[];
  operations: readonly CanonicalOpenApiOperation[];
  unavailableReason?: "official_operation_id_missing";
}

export interface ApiActionInventoryEvidence {
  schemaVersion: number;
  generatorVersion: number;
  catalogHash: string;
  officialOpenApi: typeof OFFICIAL_OPENAPI_SOURCE;
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

export interface ApiActionInventoryArtifacts {
  apiCatalogSource: string;
  evidenceJson: string;
  inventoryMarkdown: string;
}

interface WorkflowOwner {
  workflowModule: string;
  definitions: readonly ActionDefinition[];
}

const WORKFLOW_OWNERS: readonly WorkflowOwner[] = [
  { workflowModule: "time-tracking.ts", definitions: TIME_TRACKING_ACTIONS },
  { workflowModule: "entries.ts", definitions: ENTRY_ACTIONS },
  { workflowModule: "work-structure.ts", definitions: WORK_STRUCTURE_ACTIONS },
  { workflowModule: "projects.ts", definitions: PROJECT_ACTIONS },
  { workflowModule: "api-actions/projects.ts", definitions: PROJECT_API_ACTIONS },
  { workflowModule: "tasks.ts", definitions: TASK_ACTIONS },
  { workflowModule: "api-actions/tasks.ts", definitions: TASK_API_ACTIONS },
  { workflowModule: "clients.ts", definitions: CLIENT_ACTIONS },
  { workflowModule: "api-actions/clients.ts", definitions: CLIENT_API_ACTIONS },
  { workflowModule: "api-actions/time-entries.ts", definitions: ENTRY_API_ACTIONS },
  { workflowModule: "tags.ts", definitions: TAG_ACTIONS },
  { workflowModule: "invoices.ts", definitions: INVOICE_ACTIONS },
  { workflowModule: "api-actions/invoices.ts", definitions: INVOICE_API_ACTIONS },
  { workflowModule: "expenses.ts", definitions: EXPENSE_ACTIONS },
  { workflowModule: "api-actions/expenses.ts", definitions: EXPENSE_API_ACTIONS },
  { workflowModule: "custom-fields.ts", definitions: CUSTOM_FIELD_ACTIONS },
  { workflowModule: "api-actions/custom-fields.ts", definitions: CUSTOM_FIELD_API_ACTIONS },
  { workflowModule: "time-off.ts", definitions: TIME_OFF_ACTIONS },
  { workflowModule: "holidays.ts", definitions: HOLIDAY_ACTIONS },
  { workflowModule: "scheduling.ts", definitions: SCHEDULING_ACTIONS },
  { workflowModule: "approvals.ts", definitions: APPROVAL_ACTIONS },
  { workflowModule: "webhooks.ts", definitions: WEBHOOK_ACTIONS },
  { workflowModule: "users.ts", definitions: USER_GROUP_ACTIONS },
  { workflowModule: "api-actions/users.ts", definitions: USER_API_ACTIONS },
  { workflowModule: "reports.ts", definitions: REPORT_ACTIONS },
  { workflowModule: "audit.ts", definitions: AUDIT_ACTIONS },
  { workflowModule: "workspace.ts", definitions: WORKSPACE_ACTIONS },
  { workflowModule: "admin.ts", definitions: ADMIN_ACTIONS },
  { workflowModule: "curated.ts", definitions: CURATED_ACTIONS },
  { workflowModule: "setup-project.ts", definitions: SETUP_PROJECT_ACTIONS },
  { workflowModule: "setup-task.ts", definitions: SETUP_TASK_ACTIONS },
];

interface RawAdapterShape {
  key: string;
  access: "read" | "write";
  host: ApiHost;
  method: ApiMethod;
  path: string;
  sourceModule: string;
  sourceCallSites: readonly AdapterSourceCallSite[];
}

interface AdapterConsumer {
  action: InventoryActionRow;
  role: AdapterRole;
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function uniqueSorted<const Value extends string>(values: readonly Value[]): Value[] {
  return [...new Set(values)].sort(compareText);
}

function isApiHost(value: string): value is ApiHost {
  return value === "api" || value === "reports" || value === "audit";
}

function isApiMethod(value: string): value is ApiMethod {
  return value === "GET"
    || value === "POST"
    || value === "PUT"
    || value === "PATCH"
    || value === "DELETE";
}

function isActionExposure(value: string): value is ActionExposure {
  return value === "api" || value === "composite" || value === "generic" || value === "local";
}

function ownerByActionName(): ReadonlyMap<string, string> {
  const owners = new Map<string, string>();
  for (const owner of WORKFLOW_OWNERS) {
    for (const definition of owner.definitions) {
      const previous = owners.get(definition.name);
      if (previous !== undefined) {
        throw new Error(`duplicate_action_workflow_owner:${definition.name}:${previous}:${owner.workflowModule}`);
      }
      owners.set(definition.name, owner.workflowModule);
    }
  }
  const catalogNames = new Set(ACTION_CATALOG.map((action) => action.name));
  const missing = [...catalogNames].filter((name) => !owners.has(name)).sort(compareText);
  const extra = [...owners.keys()].filter((name) => !catalogNames.has(name)).sort(compareText);
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`action_workflow_owner_mismatch:missing=${missing.join(",")};extra=${extra.join(",")}`);
  }
  return owners;
}

function rawAdapterShapes(repositoryRoot: string): {
  callSiteCount: number;
  shapes: readonly RawAdapterShape[];
} {
  const endpoints = extractAdapterEndpoints(repositoryRoot);
  const grouped = new Map<string, typeof endpoints>();
  for (const endpoint of endpoints) {
    const key = adapterRequestShapeKey(endpoint);
    const group = grouped.get(key) ?? [];
    group.push(endpoint);
    grouped.set(key, group);
  }
  const shapes = [...grouped.entries()].map(([key, group]): RawAdapterShape => {
    const first = group[0];
    if (!first || !isApiHost(first.host) || !isApiMethod(first.method)) {
      throw new Error(`invalid_raw_adapter_shape:${key}`);
    }
    return {
      key,
      access: first.access,
      host: first.host,
      method: first.method,
      path: first.rawPath,
      sourceModule: first.sourceModule,
      sourceCallSites: group.map((endpoint) => ({
        sourceModule: endpoint.sourceModule,
        sourceLine: endpoint.sourceLine,
        sourceColumn: endpoint.sourceColumn,
        pagination: endpoint.pagination,
      })).sort((left, right) => left.sourceLine - right.sourceLine
        || left.sourceColumn - right.sourceColumn
        || compareText(left.pagination, right.pagination)),
    };
  });
  return { callSiteCount: endpoints.length, shapes };
}

function requiredArgumentsFor(action: ActionDefinition): readonly string[] {
  const schema = zodToJsonSchema(action.schema, {
    $refStrategy: "none",
    target: "jsonSchema7",
  });
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)
    || !("required" in schema) || !Array.isArray(schema.required)) {
    return [];
  }
  return schema.required
    .filter((value): value is string => typeof value === "string")
    .sort(compareText);
}

function mutationCount(
  action: ActionDefinition,
  kind: "primary" | "compensation",
): number {
  const plans = action.writeAuthority?.mutationPlans ?? [];
  return Math.max(0, ...plans.map((plan) => plan.steps
    .filter((step) => step.kind === kind)
    .reduce((sum, step) => sum + step.max, 0)));
}

function registryIdFor(exposure: ActionExposure): ActionRegistryId {
  if (exposure === "api") return "v2-api";
  if (exposure === "local") return "v2-local";
  return "v1-internal";
}

function actionDecisionReason(action: ActionDefinition): string {
  if (action.apiExposure === "api" && action.apiOperation !== undefined) {
    return `One logical Clockify operation: ${action.apiOperation.method} ${action.apiOperation.path} (${action.apiOperation.operationId}).`;
  }
  if (typeof action.apiExposureReason === "string" && action.apiExposureReason.trim() !== "") {
    return action.apiExposureReason;
  }
  throw new Error(`missing_action_decision_reason:${action.name}`);
}

function actionSortKey(action: InventoryActionRow): string {
  const anchor = action.operation ?? action.adapterShapes[0];
  return [
    anchor?.host ?? "local",
    anchor?.path ?? "",
    anchor?.method ?? "",
    action.name,
  ].join("\0");
}

function buildActionRows(
  rawShapes: readonly RawAdapterShape[],
): readonly InventoryActionRow[] {
  const owners = ownerByActionName();
  const shapeByKey = new Map(rawShapes.map((shape) => [shape.key, shape]));
  const entries = inventoryActionDefinitions();
  const seen = new Set<string>();
  const rows = entries.map(({ sourceSurface, definition }): InventoryActionRow => {
    const inventoryKey = `${sourceSurface}\0${definition.name}`;
    if (seen.has(inventoryKey)) throw new Error(`duplicate_inventory_action:${inventoryKey}`);
    seen.add(inventoryKey);
    if (!isActionExposure(definition.apiExposure)) {
      throw new Error(`unclassified_inventory_action:${definition.name}`);
    }
    const normalized = normalizeRegistryAction(
      definition,
      registryIdFor(definition.apiExposure),
    );
    const adapterShapes: ActionAdapterShape[] = [];
    for (const [role, keys] of [
      ["primary", normalized.adapterEndpoints?.primary ?? []],
      ["support", normalized.adapterEndpoints?.support ?? []],
    ] as const) {
      for (const key of keys) {
        const shape = shapeByKey.get(key);
        if (!shape) throw new Error(`unknown_inventory_adapter_shape:${normalized.name}:${key}`);
        adapterShapes.push({
          key,
          role,
          access: shape.access,
          host: shape.host,
          method: shape.method,
          path: shape.path,
          sourceModule: shape.sourceModule,
        });
      }
    }
    adapterShapes.sort((left, right) => compareText(
      `${left.host}\0${left.path}\0${left.method}\0${left.role}\0${left.key}`,
      `${right.host}\0${right.path}\0${right.method}\0${right.role}\0${right.key}`,
    ));
    const schemaVerdict = actionArgumentSchemaVerdict(normalized);
    const workflowModule = owners.get(normalized.name);
    if (workflowModule === undefined) throw new Error(`missing_action_workflow_owner:${normalized.name}`);
    return {
      sourceSurface,
      name: normalized.name,
      description: normalized.description,
      kind: normalized.kind,
      featureGroup: normalized.featureGroup,
      workflowModule,
      actionFingerprint: actionFingerprintForDefinition(normalized),
      exposure: normalized.apiExposure,
      decisionReason: actionDecisionReason(normalized),
      operation: normalized.apiOperation ?? null,
      availabilityByAuthClass: normalized.availabilityByAuthClass,
      adapterShapes,
      boundedArgumentDictionaries: normalized.boundedArgumentDictionaries ?? [],
      openSchemaVerdict: schemaVerdict.verdict,
      openSchemaDetail: schemaVerdict.verdict === "open" ? schemaVerdict.detail : null,
      materialFields: normalized.materialFields ?? [],
      normalizedOperationMaterialContract:
        normalized.normalizedOperationMaterialContract ?? [],
      presentation: normalized.presentation ?? null,
      requiredArguments: requiredArgumentsFor(normalized),
      primaryMutationCount: mutationCount(normalized, "primary"),
      compensationCount: mutationCount(normalized, "compensation"),
    };
  });
  return rows.sort((left, right) => compareText(actionSortKey(left), actionSortKey(right)));
}

function unionAvailability(
  decisions: readonly AvailabilityByAuthClass[],
  authClass: "addon" | "api_key",
  adapterKey: string,
): ApiAvailability {
  const values = decisions.map((decision) => decision[authClass]);
  if (values.some((value) => value.available)) return { available: true };
  const reasons = uniqueSorted(values.flatMap((value) => value.available ? [] : [value.reason]));
  if (reasons.length !== 1) {
    throw new Error(`conflicting_adapter_availability:${adapterKey}:${authClass}:${reasons.join(",")}`);
  }
  const reason = reasons[0];
  if (reason === undefined) throw new Error(`missing_adapter_availability:${adapterKey}:${authClass}`);
  return { available: false, reason };
}

function adapterDecisionReason(
  decision: AdapterDecision,
  consumers: readonly AdapterConsumer[],
  explicitReason: string | undefined,
): string {
  if (explicitReason !== undefined) return explicitReason;
  if (decision === "model_api") {
    return "At least one atomic API action binds this raw shape as its reviewed primary endpoint.";
  }
  const reason = consumers
    .map(({ action }) => action.decisionReason)
    .find((candidate) => candidate.trim() !== "");
  if (decision === "unavailable" && reason !== undefined) return reason;
  return "Used only by support reads or by a composite, generic, or otherwise internal action.";
}

function buildAdapterRows(
  rawShapes: readonly RawAdapterShape[],
  actions: readonly InventoryActionRow[],
): readonly InventoryAdapterRow[] {
  const consumersByKey = new Map<string, AdapterConsumer[]>();
  for (const action of actions) {
    for (const shape of action.adapterShapes) {
      const consumers = consumersByKey.get(shape.key) ?? [];
      consumers.push({ action, role: shape.role });
      consumersByKey.set(shape.key, consumers);
    }
  }
  const explicitByKey = new Map(NON_ACTION_ADAPTER_DISPOSITIONS.map((row) => [row.adapterKey, row]));
  const shapeKeys = new Set(rawShapes.map((shape) => shape.key));
  const staleExplicit = [...explicitByKey.keys()].filter((key) => !shapeKeys.has(key));
  if (staleExplicit.length > 0) {
    throw new Error(`stale_non_action_adapter_disposition:${staleExplicit.join(",")}`);
  }

  const rows = rawShapes.map((shape): InventoryAdapterRow => {
    const consumers = consumersByKey.get(shape.key) ?? [];
    const explicit = explicitByKey.get(shape.key);
    if (consumers.length === 0 && explicit === undefined) {
      throw new Error(`unclassified_adapter_shape:${shape.key}`);
    }
    const mappedModelActionNames = uniqueSorted(consumers.flatMap(({ action, role }) =>
      action.exposure === "api" && role === "primary" ? [action.name] : []));
    const internalSupportConsumers = uniqueSorted([
      ...consumers.flatMap(({ action, role }) =>
        action.exposure !== "api" || role === "support" ? [action.name] : []),
      ...(explicit?.consumers ?? []),
    ]);
    const availabilityInputs = [
      ...consumers.map(({ action }) => action.availabilityByAuthClass),
      ...(explicit === undefined ? [] : [explicit.availabilityByAuthClass]),
    ];
    const availabilityByAuthClass: AvailabilityByAuthClass = {
      addon: unionAvailability(availabilityInputs, "addon", shape.key),
      api_key: unionAvailability(availabilityInputs, "api_key", shape.key),
    };
    const available = availabilityByAuthClass.addon.available
      || availabilityByAuthClass.api_key.available;
    const decision: AdapterDecision = mappedModelActionNames.length > 0
      ? "model_api"
      : available
        ? "internal_support"
        : "unavailable";
    if (explicit !== undefined && decision !== explicit.decision) {
      throw new Error(`non_action_adapter_disposition_mismatch:${shape.key}:${decision}`);
    }
    return {
      ...shape,
      mappedModelActionNames,
      internalSupportConsumers,
      availabilityByAuthClass,
      decision,
      decisionReason: adapterDecisionReason(decision, consumers, explicit?.reason),
    };
  });
  return rows.sort((left, right) => compareText(
    [
      left.host,
      left.path,
      left.method,
      left.mappedModelActionNames[0] ?? left.internalSupportConsumers[0] ?? "",
      left.key,
    ].join("\0"),
    [
      right.host,
      right.path,
      right.method,
      right.mappedModelActionNames[0] ?? right.internalSupportConsumers[0] ?? "",
      right.key,
    ].join("\0"),
  ));
}

function operationKey(operation: CanonicalOpenApiOperation): string {
  return [operation.host, operation.path, operation.method, operation.operationId].join("\0");
}

function correlatedOperations(
  adapter: InventoryAdapterRow,
  operations: readonly CanonicalOpenApiOperation[],
): readonly CanonicalOpenApiOperation[] {
  const paths = correlateAdapterEndpointPaths(
    adapter.path,
    canonicalOpenApiPath,
    expandReviewedDynamicAdapterPath,
  );
  return [...new Map(operations
    .filter((operation) => operation.host === adapter.host
      && operation.method === adapter.method
      && paths.includes(canonicalOpenApiPath(operation.path)))
    .map((operation) => [operationKey(operation), operation])).values()]
    .sort((left, right) => compareText(operationKey(left), operationKey(right)));
}

export function verifyOfficialOpenApiSnapshot(
  repositoryRoot: string,
  operations: readonly CanonicalOpenApiOperation[],
): void {
  const sourcePath = resolve(repositoryRoot, OFFICIAL_OPENAPI_SOURCE.corroborationPath);
  if (!existsSync(sourcePath)) {
    throw new Error(`official_openapi_source_missing:${sourcePath}`);
  }
  const source = readFileSync(sourcePath, "utf8");
  const digest = createHash("sha256").update(source).digest("hex");
  if (digest !== OFFICIAL_OPENAPI_SOURCE.sha256) {
    throw new Error(`official_openapi_hash_mismatch:${digest}`);
  }
  const official = extractOpenApiDescriptionOperations(source);
  for (const operation of operations) {
    const found = official.some((candidate) =>
      candidate.method === operation.method
      && candidate.operationId === operation.operationId
      && canonicalOpenApiPath(candidate.path) === canonicalOpenApiPath(operation.path));
    if (!found) {
      throw new Error(`official_openapi_correlation_mismatch:${operationKey(operation)}`);
    }
  }
}

function buildCorrelations(
  repositoryRoot: string,
  adapters: readonly InventoryAdapterRow[],
  actions: readonly InventoryActionRow[],
): readonly InventoryCorrelationRow[] {
  const actionOperations = actions.flatMap((action) => action.operation === null
    ? []
    : [action.operation]);
  const operations: CanonicalOpenApiOperation[] = [
    ...actionOperations,
    ...INTERNAL_OPENAPI_OPERATIONS,
  ];
  verifyOfficialOpenApiSnapshot(repositoryRoot, operations);
  const usedInternalOperationKeys = new Set<string>();
  const internalOperationKeys = new Set(INTERNAL_OPENAPI_OPERATIONS.map(operationKey));
  const actionByName = new Map(actions.map((action) => [action.name, action]));
  const rows = adapters.map((adapter): InventoryCorrelationRow => {
    const correlated = correlatedOperations(adapter, operations);
    for (const operation of correlated) {
      const key = operationKey(operation);
      if (internalOperationKeys.has(key)) usedInternalOperationKeys.add(key);
    }
    for (const actionName of adapter.mappedModelActionNames) {
      const action = actionByName.get(actionName);
      if (action?.operation === null || action?.operation === undefined
        || !correlated.some((operation) => operation.operationId === action.operation?.operationId)) {
        throw new Error(`model_action_openapi_correlation_mismatch:${actionName}:${adapter.key}`);
      }
    }
    if (correlated.length === 0) {
      const missingOperationId = !adapter.availabilityByAuthClass.addon.available
        && adapter.availabilityByAuthClass.addon.reason === "official_operation_id_missing"
        && !adapter.availabilityByAuthClass.api_key.available
        && adapter.availabilityByAuthClass.api_key.reason === "official_operation_id_missing";
      if (!missingOperationId || adapter.decision !== "unavailable") {
        throw new Error(`missing_openapi_correlation:${adapter.key}`);
      }
      return {
        adapterKey: adapter.key,
        expandedPaths: expandReviewedDynamicAdapterPath(adapter.path),
        operations: [],
        unavailableReason: "official_operation_id_missing",
      };
    }
    if (correlated.length > 1
      && !adapter.path.includes("{changeType}")
      && !adapter.path.includes("{kind}")) {
      throw new Error(`ambiguous_openapi_correlation:${adapter.key}`);
    }
    return {
      adapterKey: adapter.key,
      expandedPaths: expandReviewedDynamicAdapterPath(adapter.path),
      operations: correlated,
    };
  });
  const staleInternal = [...internalOperationKeys]
    .filter((key) => !usedInternalOperationKeys.has(key))
    .sort(compareText);
  if (staleInternal.length > 0) {
    throw new Error(`stale_internal_openapi_operation:${staleInternal.join(",")}`);
  }
  return rows;
}

function exposureCounts(actions: readonly InventoryActionRow[]): {
  api: number;
  composite: number;
  generic: number;
  local: number;
} {
  return {
    api: actions.filter((action) => action.exposure === "api").length,
    composite: actions.filter((action) => action.exposure === "composite").length,
    generic: actions.filter((action) => action.exposure === "generic").length,
    local: actions.filter((action) => action.exposure === "local").length,
  };
}

export function buildApiActionInventoryEvidence(
  repositoryRoot: string,
): ApiActionInventoryEvidence {
  const raw = rawAdapterShapes(repositoryRoot);
  const actions = buildActionRows(raw.shapes);
  const adapterRequestShapes = buildAdapterRows(raw.shapes, actions);
  const openApiCorrelations = buildCorrelations(
    repositoryRoot,
    adapterRequestShapes,
    actions,
  );
  return {
    schemaVersion: INVENTORY_SCHEMA_VERSION,
    generatorVersion: INVENTORY_GENERATOR_VERSION,
    catalogHash: catalogHash(),
    officialOpenApi: OFFICIAL_OPENAPI_SOURCE,
    counts: {
      actions: actions.length,
      rawAdapterCallSites: raw.callSiteCount,
      rawAdapterShapes: adapterRequestShapes.length,
      unclassifiedActions: 0,
      unclassifiedAdapterShapes: 0,
      exposures: exposureCounts(actions),
    },
    actions,
    adapterRequestShapes,
    openApiCorrelations,
  };
}

function apiCatalogSource(evidence: ApiActionInventoryEvidence): string {
  const apiActions = evidence.actions.filter((action) => action.exposure === "api");
  const descriptors = Object.fromEntries(apiActions.map((action) => {
    if (action.operation === null || action.presentation === null) {
      throw new Error(`incomplete_generated_api_descriptor:${action.name}`);
    }
    return [action.name, {
      toolName: action.name,
      operationId: action.operation.operationId,
      host: action.operation.host,
      method: action.operation.method,
      path: action.operation.path,
      description: action.description,
      requiredArguments: action.requiredArguments,
      access: action.operation.access,
      featureGroup: action.featureGroup,
      actionFingerprint: action.actionFingerprint,
      adapterEndpoints: {
        primary: action.adapterShapes
          .filter((shape) => shape.role === "primary")
          .map((shape) => shape.key),
        support: action.adapterShapes
          .filter((shape) => shape.role === "support")
          .map((shape) => shape.key),
      },
      availabilityByAuthClass: action.availabilityByAuthClass,
      presentation: action.presentation,
    }];
  }));
  const actionsByOperationId = new Map<string, string[]>();
  for (const action of apiActions) {
    if (action.operation === null) throw new Error(`missing_generated_api_operation:${action.name}`);
    const names = actionsByOperationId.get(action.operation.operationId) ?? [];
    names.push(action.name);
    actionsByOperationId.set(action.operation.operationId, names);
  }
  const operationIndex = Object.fromEntries([...actionsByOperationId.entries()].map(
    ([operationId, names]) => [operationId, names.sort(compareText)],
  ));
  return [
    "// GENERATED by scripts/generate-api-action-inventory.ts; do not edit manually.",
    `export const API_ACTION_INVENTORY_SCHEMA_VERSION = ${evidence.schemaVersion} as const;`,
    `export const API_ACTION_INVENTORY_GENERATOR_VERSION = ${evidence.generatorVersion} as const;`,
    `export const API_ACTION_CATALOG_HASH = ${JSON.stringify(evidence.catalogHash)} as const;`,
    "",
    `export const API_ACTION_DESCRIPTORS_BY_NAME = ${JSON.stringify(descriptors, null, 2)} as const;`,
    "",
    `export const API_ACTION_NAMES_BY_OPERATION_ID = ${JSON.stringify(operationIndex, null, 2)} as const;`,
    "",
  ].join("\n");
}

function markdownText(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll(/\r?\n/gu, "<br>");
}

function authSummary(availability: AvailabilityByAuthClass): string {
  const render = (authClass: "addon" | "api_key"): string => {
    const decision = availability[authClass];
    return decision.available ? `${authClass}=yes` : `${authClass}=no:${decision.reason}`;
  };
  return `${render("addon")}<br>${render("api_key")}`;
}

function inventoryMarkdown(evidence: ApiActionInventoryEvidence): string {
  const actionRows = evidence.actions.map((action) => {
    const operation = action.operation;
    const anchor = operation ?? action.adapterShapes[0];
    const dictionaries = markdownText(JSON.stringify(action.boundedArgumentDictionaries));
    const materialFields = markdownText(JSON.stringify({
      fields: action.materialFields,
      normalizedOperationContract: action.normalizedOperationMaterialContract,
    }));
    const presenter = action.presentation === null
      ? "—"
      : `${action.presentation.presenterId}@${action.presentation.version}`;
    return `| ${anchor?.host ?? "local"} | \`${anchor?.path ?? "—"}\` | ${anchor?.method ?? "—"} | \`${action.name}\` | ${action.kind} / ${action.featureGroup} / \`${action.workflowModule}\` | ${action.exposure} | ${operation?.operationId ?? "—"} | ${authSummary(action.availabilityByAuthClass)} | ${action.primaryMutationCount} / ${action.compensationCount} | ${action.openSchemaVerdict}${action.openSchemaDetail === null ? "" : `<br>\`${markdownText(action.openSchemaDetail)}\``} | \`${dictionaries}\` | \`${materialFields}\` | ${presenter} | ${markdownText(action.decisionReason)} |`;
  });
  const adapterRows = evidence.adapterRequestShapes.map((row) => {
    const callSites = row.sourceCallSites
      .map((site) =>
        `\`${site.sourceModule}:${site.sourceLine}:${site.sourceColumn}:${site.pagination}\``)
      .join("<br>");
    return `| ${row.host} | \`${row.path}\` | ${row.method} | \`${row.key.replaceAll("\0", " ␀ ")}\` | ${callSites} | ${row.mappedModelActionNames.map((name) => `\`${name}\``).join("<br>") || "—"} | ${row.internalSupportConsumers.map((name) => `\`${name}\``).join("<br>") || "—"} | ${authSummary(row.availabilityByAuthClass)} | ${row.decision} | ${markdownText(row.decisionReason)} |`;
  });
  const correlations = evidence.openApiCorrelations.map((row) => {
    const adapter = evidence.adapterRequestShapes.find((candidate) => candidate.key === row.adapterKey);
    if (!adapter) throw new Error(`missing_markdown_adapter:${row.adapterKey}`);
    const operations = row.operations.length === 0
      ? row.unavailableReason ?? "—"
      : row.operations.map((operation) =>
        `\`${operation.method} ${operation.path} (${operation.operationId})\``).join("<br>");
    return `| ${adapter.host} | \`${adapter.path}\` | ${adapter.method} | ${row.expandedPaths.map((path) => `\`${path}\``).join("<br>")} | ${operations} |`;
  });
  return [
    "<!-- GENERATED by scripts/generate-api-action-inventory.ts; do not edit manually. -->",
    "# API action inventory",
    "",
    `Schema version: **${evidence.schemaVersion}**. Generator version: **${evidence.generatorVersion}**.`,
    "",
    `Catalog hash: \`${evidence.catalogHash}\``,
    "",
    `Official OpenAPI: ${evidence.officialOpenApi.version}, SHA-256 \`${evidence.officialOpenApi.sha256}\`.`,
    "",
    `Inventory: **${evidence.counts.actions} actions** (${evidence.counts.exposures.api} API, ${evidence.counts.exposures.composite} composite, ${evidence.counts.exposures.generic} generic, ${evidence.counts.exposures.local} local), **${evidence.counts.rawAdapterCallSites} raw call sites**, **${evidence.counts.rawAdapterShapes} raw request shapes**, **${evidence.counts.unclassifiedActions} unclassified actions**, and **${evidence.counts.unclassifiedAdapterShapes} unclassified request shapes**.`,
    "",
    "## Actions",
    "",
    "| Host | Path | Method | Action | Kind / group / workflow | Exposure | Operation ID | Auth availability | Primary / compensation max | Schema | Bounded dictionaries | Material fields | Presenter | Decision |",
    "|---|---|---|---|---|---|---|---|---:|---|---|---|---|---|",
    ...actionRows,
    "",
    "## Raw adapter request shapes",
    "",
    "| Host | Path | Method | Raw key | Source call sites | Model API actions | Internal-support consumers | Auth availability | Decision | Reason |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...adapterRows,
    "",
    "## OpenAPI correlations",
    "",
    "| Host | Raw path | Method | Reviewed expansion(s) | Canonical operation(s) |",
    "|---|---|---|---|---|",
    ...correlations,
    "",
  ].join("\n");
}

export function renderApiActionInventoryArtifacts(
  evidence: ApiActionInventoryEvidence,
): ApiActionInventoryArtifacts {
  return {
    apiCatalogSource: apiCatalogSource(evidence),
    evidenceJson: `${JSON.stringify(evidence, null, 2)}\n`,
    inventoryMarkdown: inventoryMarkdown(evidence),
  };
}

function outputFiles(repositoryRoot: string, artifacts: ApiActionInventoryArtifacts): readonly {
  path: string;
  contents: string;
}[] {
  return [
    {
      path: resolve(repositoryRoot, "src/harness/api-catalog.generated.ts"),
      contents: artifacts.apiCatalogSource,
    },
    {
      path: resolve(repositoryRoot, "evidence/api-action-inventory.json"),
      contents: artifacts.evidenceJson,
    },
    {
      path: resolve(repositoryRoot, "docs/API_ACTION_INVENTORY.md"),
      contents: artifacts.inventoryMarkdown,
    },
  ];
}

function runGenerator(repositoryRoot: string, check: boolean): void {
  const evidence = buildApiActionInventoryEvidence(repositoryRoot);
  const artifacts = renderApiActionInventoryArtifacts(evidence);
  const outputs = outputFiles(repositoryRoot, artifacts);
  if (check) {
    const stale = outputs.filter((output) =>
      !existsSync(output.path) || readFileSync(output.path, "utf8") !== output.contents);
    if (stale.length > 0) {
      throw new Error(`API action inventory is stale; run npm run generate:api-action-inventory (${stale.map((output) => relative(repositoryRoot, output.path)).join(", ")}).`);
    }
    return;
  }
  for (const output of outputs) {
    mkdirSync(dirname(output.path), { recursive: true });
    writeFileSync(output.path, output.contents, "utf8");
  }
}

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  runGenerator(repositoryRoot, process.argv.includes("--check"));
}
