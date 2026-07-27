import { expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApiOperationIndex } from "../../src/assistant-v2/discovery/api-index.js";
import { searchApiOperations } from "../../src/assistant-v2/discovery/api-search.js";
import { initialV2ToolSet } from "../../src/assistant-v2/discovery/api-search-tool.js";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import type { ActionDefinition } from "../../src/harness/action.js";
import { toolsForV2LoadedSet } from "../../src/harness/tools.js";
import { validateV2RawActionArguments } from "../../src/harness/actions.js";
import {
  defaultAdminPolicy,
  type AdminPolicy,
  type FeatureGroup,
  type PermissionLevel,
} from "../../src/harness/permissions.js";
import { createStore, type Store } from "../../src/db/store.js";
import { TYPED_CONSENT } from "../../src/routes/consent-guard.js";
import type { FakeWorkspace } from "./fake-clockify.js";
import {
  isAddonUnavailableWrite,
  WRITE_PREVIEW_BASE_SEED,
  WRITE_PREVIEW_FIXTURES,
  type WritePreviewFixture,
} from "./v2-write-preview-fixtures.js";
import { discoveryQueriesForAction } from "./v2-read-parity-fixtures.js";
import { READ_PARITY_DOMAIN_GROUPS } from "./v2-read-parity.js";

export const WRITE_PARITY_DOMAIN_GROUPS = READ_PARITY_DOMAIN_GROUPS;
export type WriteParityDomain = keyof typeof WRITE_PARITY_DOMAIN_GROUPS;

export const SESSION_SECRET = "test-session-secret";
export const WRITE_PARITY_NOW = new Date("2026-06-06T12:00:00.000Z");

const MUTATION_METHOD = /^(?:add|archive|create|deactivate|delete|import|invite|mark|publish|remove|resubmit|set|start|stop|submit|update)/;
const index = buildApiOperationIndex(MODEL_API_ACTION_CATALOG);

export function catalogWritesForDomain(domain: WriteParityDomain): ActionDefinition[] {
  const groups = new Set(WRITE_PARITY_DOMAIN_GROUPS[domain]);
  return MODEL_API_ACTION_CATALOG.actions.filter(
    (action) => action.apiOperation?.access === "write" && groups.has(action.featureGroup),
  );
}

export function writeActionNames(domain: WriteParityDomain): string[] {
  return catalogWritesForDomain(domain).map((action) => action.name).sort();
}

export function assertWriteDomainFixturesComplete(domain: WriteParityDomain): void {
  const writes = catalogWritesForDomain(domain);
  const missing = writes.filter((action) => !WRITE_PREVIEW_FIXTURES[action.name]);
  expect(missing.map((action) => action.name), `missing write parity fixtures for ${domain}`).toEqual([]);
  expect(writes.length).toBeGreaterThan(0);
}

export function fixtureForWrite(actionName: string): WritePreviewFixture {
  const fixture = WRITE_PREVIEW_FIXTURES[actionName];
  if (!fixture) throw new Error(`missing write fixture ${actionName}`);
  return fixture;
}

export function mergeWriteSeed(fixture: WritePreviewFixture) {
  return structuredClone({ ...WRITE_PREVIEW_BASE_SEED, ...fixture.seed });
}

export function mutationCallTotal(counts: Record<string, number>): number {
  // Durable dispatch bumps *Atomic; many fakes also bump a legacy alias for the
  // same host call. Count Atomic methods, plus non-Atomic only when no Atomic
  // sibling (or specific rate Atomic) was recorded.
  return Object.entries(counts).reduce((sum, [method, count]) => {
    if (!MUTATION_METHOD.test(method)) return sum;
    if (method.endsWith("Atomic")) return sum + count;
    if (counts[`${method}Atomic`] !== undefined) return sum;
    if (
      method === "updateWorkspaceMemberRate" &&
      (
        counts.updateWorkspaceMemberHourlyRateAtomic !== undefined ||
        counts.updateWorkspaceMemberCostRateAtomic !== undefined ||
        counts.updateWorkspaceMemberRateAtomic !== undefined
      )
    ) {
      return sum;
    }
    return sum + count;
  }, 0);
}

export { isAddonUnavailableWrite };

/** Identical to `discoveryQueriesForAction` — one shared pure implementation. */
export const discoveryQueriesForWrite = discoveryQueriesForAction;

export function assertWriteDiscoveryReturnsAction(
  actionName: string,
  query: string,
  authClass: "addon" | "api_key" = "addon",
): void {
  const result = searchApiOperations(index, { query, access: "write", limit: 12 }, authClass);
  if (result.kind === "notice") {
    throw new Error(`discovery notice for ${actionName}: ${result.code}`);
  }
  expect(result.operations.map((operation) => operation.toolName)).toContain(actionName);
}

export function assertWriteUnavailableHiddenFromDiscovery(actionName: string): void {
  const action = MODEL_API_ACTION_CATALOG.get(actionName);
  if (!action) throw new Error(`missing action ${actionName}`);
  const query = action.name.replace(/^clockify_/, "").replace(/_/g, " ");
  const result = searchApiOperations(index, { query, access: "write", limit: 12 }, "addon");
  if (result.kind === "notice") return;
  expect(result.operations.map((operation) => operation.toolName)).not.toContain(actionName);
}

export function assertWriteLoadedSchemaStrict(actionName: string): void {
  const loaded = initialV2ToolSet(MODEL_API_ACTION_CATALOG, [actionName]);
  const tools = toolsForV2LoadedSet(MODEL_API_ACTION_CATALOG, loaded);
  const tool = tools.find((candidate) => candidate.name === actionName);
  expect(tool?.parameters.additionalProperties).toBe(false);
}

export function assertFullWriteCatalogNotExposed(): void {
  const loaded = initialV2ToolSet(
    MODEL_API_ACTION_CATALOG,
    MODEL_API_ACTION_CATALOG.actions.map((action) => action.name),
  );
  expect(toolsForV2LoadedSet(MODEL_API_ACTION_CATALOG, loaded).length).toBeLessThan(
    MODEL_API_ACTION_CATALOG.actions.length,
  );
}

export function policyWithGroupOff(group: FeatureGroup): AdminPolicy {
  const policy = defaultAdminPolicy();
  policy.groups[group] = "off" as PermissionLevel;
  return policy;
}

export function assertTypedConsentNeverExecutes(): void {
  expect(TYPED_CONSENT.test("yes")).toBe(true);
  expect(TYPED_CONSENT.test("confirm")).toBe(true);
  expect(TYPED_CONSENT.test("do it")).toBe(true);
  expect(TYPED_CONSENT.test("create a tag named alpha")).toBe(false);
}

export function createWriteParityStore(): Store {
  return createStore(join(mkdtempSync(join(tmpdir(), "v2-write-parity-")), "db.sqlite"), {
    encryptionKey: "k",
    now: () => WRITE_PARITY_NOW,
  });
}

export function seedInvoicePaymentExtras(actionName: string, fake: FakeWorkspace): void {
  if (actionName === "clockify_invoices_payments_delete") {
    fake.state.invoicePayments.inv1 = [{
      id: "pay1",
      amount: 10000,
      paymentDate: "2026-06-06T00:00:00.000Z",
    }];
  }
}

export function assertUnknownFieldRejected(action: ActionDefinition, args: Record<string, unknown>): void {
  const denial = validateV2RawActionArguments(action, { ...args, unexpectedField: true });
  expect(denial?.code).toBe("invalid_args");
}

export function unicodeWriteArgs(actionName: string, args: Record<string, unknown>): Record<string, unknown> {
  if ("name" in args && typeof args.name === "string") {
    return { ...args, name: `${args.name} 東京` };
  }
  if ("description" in args && typeof args.description === "string") {
    return { ...args, description: `${args.description} 東京` };
  }
  if ("notes" in args && typeof args.notes === "string") {
    return { ...args, notes: `${args.notes} 東京` };
  }
  return args;
}
