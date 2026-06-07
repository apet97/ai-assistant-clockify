import type { ActionCatalogEntry, ActionDefinition } from "./action.js";
import { TIME_TRACKING_ACTIONS } from "./workflows/time-tracking.js";
import { ENTRY_ACTIONS } from "./workflows/entries.js";
import { WORK_STRUCTURE_ACTIONS } from "./workflows/work-structure.js";
import { PROJECT_ACTIONS } from "./workflows/projects.js";
import { TASK_ACTIONS } from "./workflows/tasks.js";
import { CLIENT_ACTIONS } from "./workflows/clients.js";
import { ADMIN_ACTIONS } from "./workflows/admin.js";

/**
 * MCP-shaped action catalog (SPEC "Action Catalog Strategy"). Each action maps
 * to one deterministic handler that owns target resolution and risk
 * classification. The harness — not the model — validates and executes.
 *
 * Action contracts and `defineAction` live in ./action.ts; this module assembles
 * the registry from the workflow modules and exposes lookup + the model-visible
 * view. Re-exported here so `./catalog.js` remains the public entry point.
 */
export * from "./action.js";

export const ACTION_CATALOG: ReadonlyArray<ActionDefinition> = [
  ...TIME_TRACKING_ACTIONS,
  ...ENTRY_ACTIONS,
  ...WORK_STRUCTURE_ACTIONS,
  ...PROJECT_ACTIONS,
  ...TASK_ACTIONS,
  ...CLIENT_ACTIONS,
  ...ADMIN_ACTIONS,
];

const CATALOG_BY_NAME = new Map<string, ActionDefinition>(
  ACTION_CATALOG.map((action) => [action.name, action]),
);

export function getAction(name: string): ActionDefinition | undefined {
  return CATALOG_BY_NAME.get(name);
}

export function catalogForModel(): ActionCatalogEntry[] {
  return ACTION_CATALOG.map((action) => ({
    name: action.name,
    description: action.description,
    featureGroup: action.featureGroup,
    risks: action.risks,
  }));
}
