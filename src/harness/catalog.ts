import type { ActionCatalogEntry, ActionDefinition } from "./action.js";
import { summarizeArgs } from "./arg-summary.js";
import { nearestNames } from "./action-suggest.js";
import type { ActionRegistryId } from "./api-operation.js";
import { TIME_TRACKING_ACTIONS } from "./workflows/time-tracking.js";
import { ENTRY_ACTIONS } from "./workflows/entries.js";
import { WORK_STRUCTURE_ACTIONS } from "./workflows/work-structure.js";
import { PROJECT_ACTIONS } from "./workflows/projects.js";
import { PROJECT_API_ACTIONS } from "./api-actions/projects.js";
import { TASK_API_ACTIONS } from "./api-actions/tasks.js";
import { CLIENT_API_ACTIONS } from "./api-actions/clients.js";
import { ENTRY_API_ACTIONS } from "./api-actions/time-entries.js";
import { INVOICE_API_ACTIONS } from "./api-actions/invoices.js";
import { USER_GROUP_ACTIONS, USER_API_ACTIONS } from "./workflows/users.js";
import { TASK_ACTIONS } from "./workflows/tasks.js";
import { CLIENT_ACTIONS } from "./workflows/clients.js";
import { TAG_ACTIONS } from "./workflows/tags.js";
import { INVOICE_ACTIONS } from "./workflows/invoices.js";
import { EXPENSE_ACTIONS } from "./workflows/expenses.js";
import { EXPENSE_API_ACTIONS } from "./api-actions/expenses.js";
import { CUSTOM_FIELD_ACTIONS } from "./workflows/custom-fields.js";
import { TIME_OFF_ACTIONS } from "./workflows/time-off.js";
import { HOLIDAY_ACTIONS } from "./workflows/holidays.js";
import { SCHEDULING_ACTIONS } from "./workflows/scheduling.js";
import { APPROVAL_ACTIONS } from "./workflows/approvals.js";
import { WEBHOOK_ACTIONS } from "./workflows/webhooks.js";
import { REPORT_ACTIONS } from "./workflows/reports.js";
import { AUDIT_ACTIONS } from "./workflows/audit.js";
import { WORKSPACE_ACTIONS } from "./workflows/workspace.js";
import { ADMIN_ACTIONS } from "./workflows/admin.js";
import { CURATED_ACTIONS } from "./workflows/curated.js";
import { SETUP_PROJECT_ACTIONS } from "./workflows/setup-project.js";
import { SETUP_TASK_ACTIONS } from "./workflows/setup-task.js";
import { createHash } from "node:crypto";
import { writeAuthorityActionNames, writeAuthorityFor } from "./write-authority.js";

/** Structural registry view — avoids importing api-catalog (cycle with ACTION_CATALOG). */
export interface CatalogRegistry {
  readonly id: ActionRegistryId;
  readonly actions: readonly ActionDefinition[];
  hash(): string;
}

const REGISTRY_IDS: readonly ActionRegistryId[] = ["v1-internal", "v2-api", "v2-local"];

function assertCatalogRegistry(registry: unknown): asserts registry is CatalogRegistry {
  if (!registry || typeof registry !== "object"
    || !("id" in registry) || typeof registry.id !== "string"
    || !REGISTRY_IDS.some((id) => id === registry.id)
    || !("actions" in registry) || !Array.isArray(registry.actions)
    || !("hash" in registry) || typeof registry.hash !== "function") {
    throw new Error("catalog_for_model_registry_required");
  }
}

/**
 * MCP-shaped action catalog (SPEC "Action Catalog Strategy"). Each action maps
 * to one deterministic handler that owns target resolution and risk
 * classification. The harness — not the model — validates and executes.
 *
 * Action contracts and `defineAction` live in ./action.ts; this module assembles
 * the raw ACTION_CATALOG from the workflow modules and exposes lookup + the
 * model-visible view. Explicit registry surfaces (`INTERNAL_ACTION_CATALOG`,
 * `MODEL_API_ACTION_CATALOG`, `LOCAL_ASSISTANT_ACTIONS`) live in
 * `./api-catalog.ts` and are re-exported below after assembly completes.
 * Re-exported here so `./catalog.js` remains the public entry point.
 */
export * from "./action.js";

const ASSEMBLED_ACTIONS: ReadonlyArray<ActionDefinition> = [
  ...TIME_TRACKING_ACTIONS,
  ...ENTRY_ACTIONS,
  ...WORK_STRUCTURE_ACTIONS,
  ...PROJECT_ACTIONS,
  ...PROJECT_API_ACTIONS,
  ...TASK_ACTIONS,
  ...TASK_API_ACTIONS,
  ...CLIENT_ACTIONS,
  ...CLIENT_API_ACTIONS,
  ...ENTRY_API_ACTIONS,
  ...TAG_ACTIONS,
  ...INVOICE_ACTIONS,
  ...INVOICE_API_ACTIONS,
  ...EXPENSE_ACTIONS,
  ...EXPENSE_API_ACTIONS,
  ...CUSTOM_FIELD_ACTIONS,
  ...TIME_OFF_ACTIONS,
  ...HOLIDAY_ACTIONS,
  ...SCHEDULING_ACTIONS,
  ...APPROVAL_ACTIONS,
  ...WEBHOOK_ACTIONS,
  ...USER_GROUP_ACTIONS,
  ...USER_API_ACTIONS,
  ...REPORT_ACTIONS,
  ...AUDIT_ACTIONS,
  ...WORKSPACE_ACTIONS,
  ...ADMIN_ACTIONS,
  ...CURATED_ACTIONS,
  ...SETUP_PROJECT_ACTIONS,
  ...SETUP_TASK_ACTIONS,
];

const writeActionNames = ASSEMBLED_ACTIONS
  .filter((action) => action.kind !== "read")
  .map((action) => action.name)
  .sort();
const authorityNames = [...writeAuthorityActionNames()].sort();
if (JSON.stringify(writeActionNames) !== JSON.stringify(authorityNames)) {
  const writes = new Set(writeActionNames);
  const authority = new Set(authorityNames);
  const missing = writeActionNames.filter((name) => !authority.has(name));
  const extra = authorityNames.filter((name) => !writes.has(name));
  throw new Error(`write_authority_catalog_mismatch:missing=${missing.join(",")};extra=${extra.join(",")}`);
}

export const ACTION_CATALOG: ReadonlyArray<ActionDefinition> = ASSEMBLED_ACTIONS.map((action) =>
  action.kind !== "read"
    ? { ...action, writeAuthority: writeAuthorityFor(action) }
    : action);

const CATALOG_BY_NAME = new Map<string, ActionDefinition>(
  ACTION_CATALOG.map((action) => [action.name, action]),
);

export function getAction(name: string): ActionDefinition | undefined {
  return CATALOG_BY_NAME.get(name);
}

/**
 * Closest real action names to a non-catalog name (Phase 3 weak-model recovery) —
 * powers the `unknown_action` "did you mean". Empty when nothing is genuinely close.
 */
export function suggestActionNames(query: string, limit = 3): string[] {
  return nearestNames(query, [...CATALOG_BY_NAME.keys()], limit);
}

const cachedModelViewByRegistry = new WeakMap<CatalogRegistry, ActionCatalogEntry[]>();

/**
 * The model-visible catalog view (the JSON-mode prompt listing). Requires an
 * exact ActionRegistry — names alone are never sufficient. Memoized per registry.
 * With `actionNames`, returns the SUBSET in registry order.
 */
export function catalogForModel(
  registry: CatalogRegistry,
  actionNames?: ReadonlySet<string>,
): ActionCatalogEntry[] {
  assertCatalogRegistry(registry);
  let cachedModelView = cachedModelViewByRegistry.get(registry);
  if (!cachedModelView) {
    cachedModelView = registry.actions.map((action) => ({
      name: action.name,
      description: action.description,
      featureGroup: action.featureGroup,
      risks: action.risks,
      args: summarizeArgs(action.schema),
    }));
    cachedModelViewByRegistry.set(registry, cachedModelView);
  }
  return actionNames ? cachedModelView.filter((entry) => actionNames.has(entry.name)) : cachedModelView;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function actionFingerprintContract(action: ActionDefinition) {
  const hasApiMetadata = action.apiExposure !== undefined
    || action.apiExposureReason !== undefined
    || action.apiOperation !== undefined
    || action.adapterEndpoints !== undefined
    || action.availabilityByAuthClass !== undefined
    || action.boundedArgumentDictionaries !== undefined
    || action.materialFields !== undefined
    || action.normalizedOperationMaterialContract !== undefined
    || action.presentation !== undefined;
  return {
    name: action.name,
    args: summarizeArgs(action.schema),
    featureGroup: action.featureGroup,
    risks: action.risks,
    argumentAliases: action.argumentAliases ?? [],
    argumentOpenPaths: action.argumentOpenPaths ?? [],
    semanticLiteralAliases: action.semanticLiteralAliases ?? [],
    mutationWorkflow: action.mutationWorkflow,
    mutationContract: action.mutationContract,
    writeAuthority: action.writeAuthority,
    preparedSafeWrite: !!action.prepareSafeWrite && !!action.executeSafeWrite,
    ...(hasApiMetadata
      ? {
          apiExposure: action.apiExposure ?? null,
          apiExposureReason: action.apiExposureReason ?? null,
          apiOperation: action.apiOperation ?? null,
          adapterEndpoints: action.adapterEndpoints ?? null,
          availabilityByAuthClass: action.availabilityByAuthClass ?? null,
          boundedArgumentDictionaries: action.boundedArgumentDictionaries ?? [],
          materialFields: action.materialFields ?? [],
          normalizedOperationMaterialContract:
            action.normalizedOperationMaterialContract ?? [],
          presentation: action.presentation ?? null,
        }
      : {}),
  };
}

/** Stable compatibility fingerprint for a raw or normalized definition. */
export function actionFingerprintForDefinition(action: ActionDefinition): string {
  return fingerprint(actionFingerprintContract(action));
}

/** Stable confirmation compatibility hash over name/schema summary/group/risk metadata. */
export function actionFingerprint(name: string): string | undefined {
  const action = getAction(name);
  return action ? actionFingerprintForDefinition(action) : undefined;
}

let cachedCatalogHash: string | undefined;
export function catalogHash(): string {
  cachedCatalogHash ??= fingerprint(
    ACTION_CATALOG.map(actionFingerprintContract),
  );
  return cachedCatalogHash;
}
