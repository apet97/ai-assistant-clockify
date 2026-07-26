import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runAssistantV2 } from "../../src/assistant-v2/runner.js";
import { createReadExecutionPort } from "../../src/assistant-v2/read-execution.js";
import { buildApiOperationIndex } from "../../src/assistant-v2/discovery/api-index.js";
import { runDiscoverySearch } from "../../src/assistant-v2/discovery/api-search-tool.js";
import type { RunOutcome, RunScope } from "../../src/assistant-v2/protocol.js";
import { assertNativeToolClient } from "../../src/assistant-v2/protocol.js";
import { createRunEventService } from "../../src/services/run-event-service.js";
import { createRunEventViewService } from "../../src/services/run-event-view-service.js";
import { createOperationPreparationService } from "../../src/services/operation-preparation-service.js";
import { MODEL_API_ACTION_CATALOG } from "../../src/harness/api-catalog.js";
import { selectModelClient } from "../../src/assistant/select-model-client.js";
import type { ModelClient } from "../../src/assistant/model-client.js";
import { createStore, type Store } from "../../src/db/store.js";
import { createFakeWorkspace, type FakeWorkspaceSeed } from "../../tests/helpers/fake-clockify.js";
import { MISSING_CREDENTIAL_STATUS, type EvalIdentity } from "./report.js";

/**
 * T17-B/C/D: the ONE real-runner harness the v2 evaluators drive.
 *
 * This deliberately builds the SAME dependency set `buildV2RunnerDependencies`
 * assembles for a live HTTP turn — real `runAssistantV2`, real discovery index,
 * real read-execution port, real `OperationPreparationService` — against a fresh
 * fake Clockify workspace and a throwaway SQLite file. No evaluator may call
 * discovery directly, script the provider, or pre-load the catalog: the model
 * starts with the discovery meta-tool only, exactly as production does.
 */

const SESSION_SECRET = "eval-v2-session-secret-0123456789";

export interface HarnessRun {
  outcome: RunOutcome;
  /** Operation names the run durably journaled as loaded, in event order. */
  loadedOperationNames: string[];
  /** Tool names the run actually requested. */
  requestedToolNames: string[];
  /** Largest number of API tools offered to the model in a single completion. */
  maxLoadedApiTools: number;
  /** Terminal phase of the durable run row. */
  terminalPhase: string;
}

export interface ModelConfiguration {
  provider: string;
  model: string;
  thinkingMode?: string;
  seed?: number;
}

/** Reads the model configuration from the ambient environment ONLY — never sources a dotenv file. */
export function modelConfigurationFromEnvironment(): ModelConfiguration | undefined {
  const provider = process.env.LLM_PROVIDER ?? "http";
  if (provider === "gemini-cli") {
    // The Gemini CLI backend has no native tool mode, so it can never satisfy a v2 run.
    return undefined;
  }
  const baseUrl = process.env.LLM_BASE_URL;
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL;
  if (!baseUrl || !apiKey || !model) return undefined;
  return {
    provider,
    model,
    ...(process.env.LLM_THINKING_MODE ? { thinkingMode: process.env.LLM_THINKING_MODE } : {}),
    ...(process.env.LLM_SEED ? { seed: Number(process.env.LLM_SEED) } : {}),
  };
}

/** Human-readable configuration string bound into every report identity. */
export function describeModelConfiguration(configuration: ModelConfiguration | undefined): string {
  if (!configuration) return MISSING_CREDENTIAL_STATUS;
  const parts = [`provider=${configuration.provider}`, `model=${configuration.model}`];
  if (configuration.thinkingMode) parts.push(`thinking=${configuration.thinkingMode}`);
  if (configuration.seed !== undefined) parts.push(`seed=${configuration.seed}`);
  return parts.join(" ");
}

export function candidateSha(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

export function evalIdentity(
  configuration: ModelConfiguration | undefined,
  cohortOrder: readonly string[],
): EvalIdentity {
  return {
    candidateSha: candidateSha(),
    catalogHash: MODEL_API_ACTION_CATALOG.hash(),
    registryId: "v2-api",
    modelConfiguration: describeModelConfiguration(configuration),
    cohortOrder: [...cohortOrder],
  };
}

function nativeModelClient(): ModelClient {
  const client = selectModelClient({
    llmProvider: (process.env.LLM_PROVIDER as "http" | "gemini-cli" | undefined) ?? "http",
    llmBaseUrl: process.env.LLM_BASE_URL,
    llmApiKey: process.env.LLM_API_KEY,
    llmModel: process.env.LLM_MODEL,
    llmMode: "tool",
    ...(process.env.LLM_TIMEOUT_MS ? { llmTimeoutMs: Number(process.env.LLM_TIMEOUT_MS) } : {}),
    ...(process.env.LLM_THINKING_MODE
      ? { llmThinkingMode: process.env.LLM_THINKING_MODE as "disabled" | "enabled" }
      : {}),
    ...(process.env.LLM_SEED ? { llmSeed: Number(process.env.LLM_SEED) } : {}),
  } as Parameters<typeof selectModelClient>[0]);
  assertNativeToolClient(client);
  return client;
}

export interface HarnessOptions {
  seed: FakeWorkspaceSeed;
  request: string;
  runId: string;
  signal?: AbortSignal;
  /** Test-only override so the harness itself can be exercised without a provider. */
  modelClient?: ModelClient;
  /** Host-call budget for the turn; the production default is 60. */
  maxHostCalls?: number;
}

/**
 * Drive ONE real v2 run to its terminal state and return what the durable
 * journal recorded. Every artifact inspected here comes from `run_events` /
 * `assistant_runs`, never from an in-memory spy.
 */
export async function runRealAssistantTurn(options: HarnessOptions): Promise<HarnessRun> {
  const directory = mkdtempSync(join(tmpdir(), "eval-v2-"));
  const store: Store = createStore(join(directory, "eval.sqlite"), { encryptionKey: "eval-key" });
  try {
    store.saveInstallation({
      workspaceId: "ws-eval",
      addonId: "addon-eval",
      addonUserId: "addon-user-eval",
      addonToken: "addon-token-eval",
    });
    const session = store.createSession({ workspaceId: "ws-eval", adminUserId: "admin-eval" });
    const scope: RunScope = {
      sessionId: session.id,
      workspaceId: "ws-eval",
      adminUserId: "admin-eval",
      installationGeneration: 1,
      authClass: "addon",
    };
    const runScope = { ...scope, runId: options.runId };
    const fake = createFakeWorkspace(options.seed);
    const index = buildApiOperationIndex(MODEL_API_ACTION_CATALOG);
    const eventService = createRunEventService(store);
    const eventViews = createRunEventViewService(store, { sessionSecret: SESSION_SECRET, now: () => new Date() });
    let remainingHostCalls = options.maxHostCalls ?? 60;
    let maxLoadedApiTools = 0;

    const outcome = await runAssistantV2({
      runId: options.runId,
      scope,
      originalRequest: options.request,
      ...(options.signal ? { signal: options.signal } : {}),
    }, {
      modelClient: (options.modelClient ?? nativeModelClient()) as Parameters<typeof runAssistantV2>[1]["modelClient"],
      runStore: store,
      eventService,
      eventViews,
      actionRegistry: MODEL_API_ACTION_CATALOG,
      discovery: {
        search: async (input, discoveryScope) => runDiscoverySearch(index, input, discoveryScope.authClass),
      },
      reads: createReadExecutionPort({
        registry: MODEL_API_ACTION_CATALOG,
        store,
        clockifyForScope: () => fake.client,
        loadCalendarContext: async () => ({ timeZone: "UTC", weekStartsOn: 1 }),
      }),
      preparations: createOperationPreparationService({
        store,
        registry: MODEL_API_ACTION_CATALOG,
        sessionSecret: SESSION_SECRET,
        clockifyForScope: () => fake.client,
        loadCalendarContext: async () => ({ timeZone: "UTC", weekStartsOn: 1 }),
      }),
      installationGuard: { assertCurrent: () => undefined },
      requestGovernor: {
        runRead: async (_readScope, operation) => {
          remainingHostCalls -= 1;
          return operation();
        },
        remainingHostCalls: () => remainingHostCalls,
        persistHostCallAllowance: (_readScope, remaining) => {
          remainingHostCalls = remaining;
        },
      },
      clock: { now: () => new Date(), monotonicMs: () => Math.round(performance.now()) },
    });

    const page = store.listRunEvents({ scope: runScope, after: 0, limit: 500 });
    const loadedOperationNames: string[] = [];
    const requestedToolNames: string[] = [];
    for (const entry of page.events) {
      if (entry.event.eventType === "api.operations_loaded") {
        const names = entry.event.payload.operationIds;
        loadedOperationNames.push(...names);
        maxLoadedApiTools = Math.max(maxLoadedApiTools, names.length);
      }
      if (entry.event.eventType === "tool.requested") {
        requestedToolNames.push(entry.event.payload.actionName);
      }
    }
    const state = store.getRun(runScope);
    return {
      outcome,
      loadedOperationNames,
      requestedToolNames,
      maxLoadedApiTools,
      terminalPhase: state?.phase ?? "unknown",
    };
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
