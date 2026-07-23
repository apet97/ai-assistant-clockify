import type { ActionDefinition } from "./action.js";
import {
  definitionsForRegistry,
  normalizeRegistryAction,
  registryHashForActions,
  type NormalizedRegistryAction,
} from "./action-registry.js";
import { initializePreparedWritePresentationRegistries } from "./prepared-write-presentation.js";
import type {
  ActionRegistryId,
  AuthClass,
  AvailabilityReason,
} from "./api-operation.js";
import {
  ACTION_CATALOG,
  actionFingerprintForDefinition,
  type CatalogRegistry,
} from "./catalog.js";

export interface ActionRegistry extends CatalogRegistry {
  readonly id: ActionRegistryId;
  readonly actions: readonly ActionDefinition[];
  get(name: string): ActionDefinition | undefined;
  fingerprint(name: string): string | undefined;
  availability(
    name: string,
    authClass: AuthClass,
  ): { available: boolean; reason?: AvailabilityReason };
  hash(): string;
}

/** Compatibility identity for selected-registry binding: `registryId + hash()`. */
export function registryCompatibilityIdentity(registry: ActionRegistry): string {
  return `${registry.id}:${registry.hash()}`;
}

function createActionRegistry(registryId: ActionRegistryId): ActionRegistry {
  const normalized: readonly NormalizedRegistryAction[] = Object.freeze(
    definitionsForRegistry(ACTION_CATALOG, registryId).map((definition) =>
      normalizeRegistryAction(definition, registryId)),
  );
  const byName = new Map(normalized.map((action) => [action.name, action]));
  if (byName.size !== normalized.length) {
    throw new Error(`duplicate_registry_action:${registryId}`);
  }
  const registryHash = registryHashForActions(normalized);
  return Object.freeze({
    id: registryId,
    actions: normalized,
    get(name: string): ActionDefinition | undefined {
      return byName.get(name);
    },
    fingerprint(name: string): string | undefined {
      const action = byName.get(name);
      return action ? actionFingerprintForDefinition(action) : undefined;
    },
    availability(
      name: string,
      authClass: AuthClass,
    ): { available: boolean; reason?: AvailabilityReason } {
      const action = byName.get(name);
      if (!action) return { available: false, reason: "unavailable_endpoint" };
      const availability = action.availabilityByAuthClass[authClass];
      return availability.available
        ? { available: true }
        : { available: false, reason: availability.reason };
    },
    hash(): string {
      return registryHash;
    },
  });
}

/** Full v1 coexistence surface — every assembled definition. */
export const INTERNAL_ACTION_CATALOG: ActionRegistry = createActionRegistry("v1-internal");

/**
 * V2 Clockify model-API surface — only reviewed `apiExposure === "api"`
 * definitions that pass normalizeRegistryAction atomicity/availability gates.
 */
export const MODEL_API_ACTION_CATALOG: ActionRegistry = createActionRegistry("v2-api");

initializePreparedWritePresentationRegistries(MODEL_API_ACTION_CATALOG.actions);

/**
 * V2 local-only surface — permissions, recent outcomes, and other
 * `apiExposure === "local"` definitions. Never sent as Clockify model tools.
 */
export const LOCAL_ASSISTANT_ACTIONS: ActionRegistry = createActionRegistry("v2-local");

/** Names that must never appear in Clockify API discovery results. */
export const LOCAL_ASSISTANT_TOOL_NAMES: ReadonlySet<string> = Object.freeze(
  new Set(LOCAL_ASSISTANT_ACTIONS.actions.map((action) => action.name)),
);
