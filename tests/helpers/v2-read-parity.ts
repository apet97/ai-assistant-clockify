import { expect } from "vitest";
import { buildApiOperationIndex } from "../../src/assistant-v2/discovery/api-index.js";
import { searchApiOperations } from "../../src/assistant-v2/discovery/api-search.js";
import { executeV2Read, type ReadExecutionDeps } from "../../src/assistant-v2/read-execution.js";
import { executeReadsConcurrently } from "../../src/services/action-execution-service.js";
import type { ReadExecutionOutcome, RunScope } from "../../src/assistant-v2/protocol.js";
import { capToolResultForModel, TOOL_RESULT_MAX_BYTES } from "../../src/assistant/tool-results.js";
import { executeAction } from "../../src/harness/actions.js";
import type { ActionDefinition } from "../../src/harness/action.js";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import { toolsForV2LoadedSet } from "../../src/harness/tools.js";
import { initialV2ToolSet } from "../../src/assistant-v2/discovery/api-search-tool.js";
import {
  defaultAdminPolicy,
  type AdminPolicy,
  type FeatureGroup,
  type PermissionLevel,
} from "../../src/harness/permissions.js";
import type { ErrorReceipt, SuccessReceipt } from "../../src/harness/receipts.js";
import type { ToolCall } from "../../src/assistant/model-client.js";
import type { FakeWorkspaceSeed } from "./fake-clockify.js";
import {
  READ_PARITY_BASE_SEED,
  READ_PARITY_FIXTURES,
  expectedUnicodeSubstring,
  unicodeArgsForAction,
  unicodeSeedForAction,
  type ReadParityFixture,
} from "./v2-read-parity-fixtures.js";
import { createFakeWorkspace, type FakeWorkspace } from "./fake-clockify.js";
import type { ActionContext } from "../../src/harness/action.js";
import { mockRunnerDeps } from "./v2-runner-deps.js";

export const READ_PARITY_DOMAIN_GROUPS: Record<string, readonly FeatureGroup[]> = {
  structure: ["work_structure"],
  time: ["time_tracking"],
  reporting: ["reports", "audit_log", "workspace_settings", "webhooks"],
  invoices: ["invoices"],
  expenses: ["expenses", "custom_fields"],
  users: ["users_groups"],
  leave: ["time_off_approvals", "scheduling", "approvals"],
};

const NOW = new Date("2026-06-06T00:00:00.000Z");
const index = buildApiOperationIndex(MODEL_API_ACTION_CATALOG);

export function catalogReadsForDomain(domain: keyof typeof READ_PARITY_DOMAIN_GROUPS): ActionDefinition[] {
  const groups = new Set(READ_PARITY_DOMAIN_GROUPS[domain]);
  return MODEL_API_ACTION_CATALOG.actions.filter(
    (action) => action.apiOperation?.access === "read" && groups.has(action.featureGroup),
  );
}

export function assertDomainFixturesComplete(domain: keyof typeof READ_PARITY_DOMAIN_GROUPS): void {
  const reads = catalogReadsForDomain(domain);
  const missing = reads.filter((action) => !READ_PARITY_FIXTURES[action.name]);
  expect(missing.map((action) => action.name), `missing read parity fixtures for ${domain}`).toEqual([]);
  expect(reads.length).toBeGreaterThan(0);
}

export function discoveryQueriesForAction(action: ActionDefinition): {
  canonical: string;
  paraphrase: string;
  typo: string;
} {
  const canonical = action.name.replace(/^clockify_/, "").replace(/_/g, " ");
  const descriptionLead = action.description
    .replace(/\([^)]*\)/gu, "")
    .split(/[.;]/u)[0]
    ?.trim();
  const paraphrase = descriptionLead && descriptionLead.length >= 8
    ? descriptionLead.slice(0, 80)
    : canonical;
  const words = canonical.split(" ").filter(Boolean);
  const target = words.reduce((longest, word) => (word.length > longest.length ? word : longest), words[0] ?? "list");
  const typoWord = target.length > 4
    ? `${target.slice(0, 2)}${target.slice(3)}`
    : `${target}x`;
  const typo = canonical.replace(target, typoWord);
  return { canonical, paraphrase, typo };
}

export function semanticReceipt(receipt: SuccessReceipt | ErrorReceipt): unknown {
  return JSON.parse(JSON.stringify(receipt)) as unknown;
}

export function receiptsSemanticallyEqual(
  left: SuccessReceipt | ErrorReceipt,
  right: SuccessReceipt | ErrorReceipt,
): boolean {
  return JSON.stringify(semanticReceipt(left)) === JSON.stringify(semanticReceipt(right));
}

export function mergeSeed(...parts: Array<FakeWorkspaceSeed | undefined>): FakeWorkspaceSeed {
  return structuredClone(parts.reduce<FakeWorkspaceSeed>((acc, part) => ({ ...acc, ...part }), { ...READ_PARITY_BASE_SEED }));
}

export function fixtureFor(actionName: string): ReadParityFixture {
  const fixture = READ_PARITY_FIXTURES[actionName];
  if (!fixture) throw new Error(`missing_read_parity_fixture:${actionName}`);
  return fixture;
}

export function makeV1Context(
  fake: FakeWorkspace,
  policy: AdminPolicy = defaultAdminPolicy(),
  extras: Partial<ActionContext> = {},
): ActionContext {
  return {
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    policy,
    clockify: fake.client,
    now: () => NOW,
    timeZone: "UTC",
    weekStartsOn: 1,
    saveArtifact: () => ({ id: "artifact-test-1", expiresAt: "2026-06-06T01:00:00.000Z" }),
    ...extras,
  };
}

export function baseScope(authClass: "addon" | "api_key" = "addon"): RunScope {
  return {
    sessionId: "session-1",
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    installationGeneration: 1,
    authClass,
  };
}

export function buildReadDeps(input: {
  fake: FakeWorkspace;
  store: ReadExecutionDeps["store"];
  authClass?: "addon" | "api_key";
}): ReadExecutionDeps {
  return {
    registry: MODEL_API_ACTION_CATALOG,
    store: input.store,
    clockifyForScope: () => input.fake.client,
    now: () => NOW,
    loadCalendarContext: async () => ({ timeZone: "UTC", weekStartsOn: 1 }),
    saveArtifact: () => ({ id: "artifact-test-1", expiresAt: "2026-06-06T01:00:00.000Z" }),
  };
}

export async function runV1Read(
  actionName: string,
  args: Record<string, unknown>,
  fake: FakeWorkspace,
  policy?: AdminPolicy,
): Promise<SuccessReceipt | ErrorReceipt> {
  const result = await executeAction({
    actionName,
    args,
    context: makeV1Context(fake, policy),
  });
  if (result.kind !== "receipt") throw new Error(`expected receipt for ${actionName}`);
  return result.receipt;
}

export async function runV2ReadReceipt(
  actionName: string,
  args: Record<string, unknown>,
  deps: ReadExecutionDeps,
  scope: RunScope,
): Promise<{ outcome: ReadExecutionOutcome; receipt: SuccessReceipt | ErrorReceipt }> {
  const call: ToolCall = { id: "tool-1", name: actionName, arguments: args };
  const outcome = await executeV2Read(call, scope, deps);
  if (!("actionResultId" in outcome)) throw new Error(`missing actionResultId for ${actionName}`);
  const stored = deps.store.getActionResult(outcome.actionResultId);
  if (!stored || typeof stored !== "object" || (stored as { kind?: string }).kind !== "receipt") {
    throw new Error(`missing stored receipt for ${actionName}`);
  }
  return {
    outcome,
    receipt: (stored as { receipt: SuccessReceipt | ErrorReceipt }).receipt,
  };
}

export function policyWithGroupOff(group: FeatureGroup): AdminPolicy {
  const policy = defaultAdminPolicy();
  policy.groups[group] = "off" as PermissionLevel;
  return policy;
}

export function assertDiscoveryReturnsAction(
  actionName: string,
  query: string,
  authClass: "addon" | "api_key" = "addon",
): void {
  const result = searchApiOperations(index, { query, access: "read", limit: 12 }, authClass);
  if (result.kind === "notice") {
    throw new Error(`discovery notice for ${actionName}: ${result.code}`);
  }
  expect(result.operations.map((operation) => operation.toolName)).toContain(actionName);
}

export function assertUnavailableHiddenFromDiscovery(actionName: string): void {
  const action = MODEL_API_ACTION_CATALOG.get(actionName);
  if (!action) throw new Error(`missing action ${actionName}`);
  const query = action.name.replace(/^clockify_/, "").replace(/_/g, " ");
  const result = searchApiOperations(index, { query, access: "read", limit: 12 }, "addon");
  if (result.kind === "notice") return;
  expect(result.operations.map((operation) => operation.toolName)).not.toContain(actionName);
}

export function assertLoadedSchemaStrict(actionName: string): void {
  const loaded = initialV2ToolSet(MODEL_API_ACTION_CATALOG, [actionName]);
  const tools = toolsForV2LoadedSet(MODEL_API_ACTION_CATALOG, loaded);
  const tool = tools.find((candidate) => candidate.name === actionName);
  expect(tool?.parameters.additionalProperties).toBe(false);
}

export function assertFullCatalogNotExposed(): void {
  const loaded = initialV2ToolSet(
    MODEL_API_ACTION_CATALOG,
    MODEL_API_ACTION_CATALOG.actions.map((action) => action.name),
  );
  expect(loaded.size).toBeLessThan(MODEL_API_ACTION_CATALOG.actions.length);
  expect(loaded.size).toBeLessThanOrEqual(13);
}

export function assertCanonicalLinkPreserved(
  receipt: SuccessReceipt | ErrorReceipt,
  stored: SuccessReceipt | ErrorReceipt,
  actionResultId: string,
): void {
  expect(receiptsSemanticallyEqual(receipt, stored)).toBe(true);
  const modelJson = capToolResultForModel(stored);
  expect(Buffer.byteLength(modelJson, "utf8")).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES + 1);
  if (Buffer.byteLength(JSON.stringify(stored), "utf8") > TOOL_RESULT_MAX_BYTES) {
    expect(modelJson).toContain("truncatedForModel");
  }
  expect(actionResultId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  );
}

export async function assertConcurrentReadsPreserveOrder(
  actionNames: readonly string[],
  deps: ReadExecutionDeps,
  scope: RunScope,
): Promise<void> {
  let active = 0;
  let maxActive = 0;
  const governor = {
    runRead: async <T>(_scope: RunScope, op: () => Promise<T>): Promise<T> => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        return await op();
      } finally {
        active -= 1;
      }
    },
    remainingHostCalls: () => 60,
    persistHostCallAllowance: () => undefined,
  };
  const calls = actionNames.map((name, index) => ({
    id: `read-${index}`,
    name,
    arguments: fixtureFor(name).args,
  }));
  const order: string[] = [];
  await executeReadsConcurrently(
    calls,
    scope,
    { ...mockRunnerDeps(), requestGovernor: governor, reads: { execute: (call, runScope) => executeV2Read(call, runScope, deps) } },
    undefined,
    (call) => order.push(call.id),
  );
  expect(maxActive).toBeLessThanOrEqual(4);
  expect(order).toEqual(calls.map((call) => call.id));
}

export function receiptContainsUnicode(receipt: SuccessReceipt, needle: string): boolean {
  return JSON.stringify(receipt.data).includes(needle);
}

export type ReadParityDomain = keyof typeof READ_PARITY_DOMAIN_GROUPS;

export function readActionNames(domain: ReadParityDomain): string[] {
  return catalogReadsForDomain(domain).map((action) => action.name).sort();
}

export {
  READ_PARITY_BASE_SEED,
  READ_PARITY_FIXTURES,
  expectedUnicodeSubstring,
  unicodeArgsForAction,
  unicodeSeedForAction,
  index,
  NOW,
};
