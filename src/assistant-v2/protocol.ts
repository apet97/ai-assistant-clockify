import { z } from "zod";
import type { ModelClient, ToolCall } from "../assistant/model-client.js";
import type {
  ApiSearchResult,
  AuthClass,
  FindApiOperationsInput,
} from "../harness/api-operation.js";
import type { ActionRegistry } from "../harness/api-catalog.js";
import type {
  ListRunEventsInput,
  RunEventPage,
  RunEventPayloadMap,
  RunEventType,
  RunEventViewPort,
  SequencedRunEvent,
} from "./events.js";

export type { ListRunEventsInput, RunEventPage, RunEventViewPort, SequencedRunEvent };

export interface RunScope {
  sessionId: string;
  workspaceId: string;
  adminUserId: string;
  installationGeneration: number;
  authClass: AuthClass;
}

/**
 * The one runtime validator for a run scope (T16-A). Every security-scoping
 * field is REQUIRED and unknown keys are rejected: a service can never receive
 * a scope that silently dropped its tenant binding.
 */
export const runScopeSchema = z.object({
  sessionId: z.string().min(1),
  workspaceId: z.string().min(1),
  adminUserId: z.string().min(1),
  installationGeneration: z.number().int().nonnegative(),
  authClass: z.enum(["addon", "api_key"]),
}).strict();

export type PresentationRef =
  | { kind: "action_result"; id: string }
  | { kind: "assistant_message"; id: string }
  | { kind: "confirmation"; id: string };

export type RunOutcome =
  | { kind: "completed"; runId: string; lastSequence: number; presentationRefs: PresentationRef[] }
  | {
      kind: "suspended";
      runId: string;
      lastSequence: number;
      reason: "awaiting_confirmation" | "awaiting_clarification";
      continuationId: string;
      presentationRefs: PresentationRef[];
    }
  | { kind: "failed"; runId: string; lastSequence: number; code: string; presentationRefs: PresentationRef[] };

export type ReadExecutionOutcome =
  | { kind: "succeeded"; actionResultId: string }
  | { kind: "clarification"; clarificationId: string }
  | { kind: "denied"; code: string; actionResultId: string }
  | { kind: "validation_failed"; code: string; actionResultId: string }
  | { kind: "failed"; code: string; actionResultId: string };

export type WritePreparationOutcome =
  | {
      kind: "prepared";
      operationIds: string[];
      confirmationIds: string[];
      batchId?: string;
    }
  | { kind: "denied"; code: string; actionResultId: string }
  | { kind: "not_ready"; code: "write_port_not_ready"; actionResultId: string };

export interface ValidatedWriteCall {
  runId: string;
  toolCallId: string;
  actionName: string;
  apiOperationId: string;
  access: "write";
  registryId: "v2-api";
  catalogHash: string;
  actionFingerprint: string;
  rawArguments: Record<string, unknown>;
}

export interface PrepareBatchInput {
  scope: RunScope;
  runId: string;
  calls: ValidatedWriteCall[];
}

export interface PreparedOperationRef {
  operationId: string;
  confirmationId: string;
  actionName: string;
  actionFingerprint: string;
  maxHostCalls: number;
  expiresAt: string;
}

export interface PreparedBatch {
  runId: string;
  batchId?: string;
  items: PreparedOperationRef[];
  expiresAt: string;
  lastSequence: number;
}

export type NativeToolModelClient = ModelClient &
  Required<Pick<ModelClient, "completeWithTools">>;

export interface RequestGovernorPort {
  runRead<T>(
    scope: RunScope,
    operation: () => Promise<T>,
    options?: { signal?: AbortSignal; onDispatch?: () => void },
  ): Promise<T>;
  remainingHostCalls(scope: RunScope): number;
  persistHostCallAllowance(scope: RunScope, remaining: number): void;
}

export interface RunStateStore {
  startRunWithTurn(input: {
    scope: RunScope & { runId: string };
    originalRequest: string;
    requestHash: string;
    catalogHash: string;
    loadedToolNames: string[];
    intentHash: string;
  }): void;
  startRunWithEvent(input: {
    scope: RunScope & { runId: string };
    originalRequest: string;
    requestHash: string;
    catalogHash: string;
    loadedToolNames: string[];
    intentHash: string;
  }): SequencedRunEvent;
  getRun(scope: RunScope & { runId: string }): import("./state.js").RunState | undefined;
  saveRun(state: import("./state.js").RunState): void;
  getLastRunEventSequence(scope: RunScope & { runId: string }): number;
  findLatestEligibleRunForCache(
    sessionId: string,
    workspaceId: string,
    adminUserId: string,
    installationGeneration: number,
    authClass: AuthClass,
    catalogHash: string,
  ): import("./state.js").RunState | undefined;
  recoverOrphanedActiveRuns(scope: RunScope): number;
  failActiveRunsForSession(sessionId: string, workspaceId: string, adminUserId: string, code: string): number;
}

export interface RunEventCommand<K extends RunEventType = RunEventType> {
  scope: RunScope & { runId: string };
  state: import("./state.js").RunState;
  payload: RunEventPayloadMap[K];
}

export interface RunEventServicePort {
  startRun(input: {
    scope: RunScope & { runId: string };
    input: {
      originalRequest: string;
      requestHash: string;
      catalogHash: string;
      loadedToolNames: string[];
      intentHash: string;
    };
  }): SequencedRunEvent;
  reserveModelCall(input: RunEventCommand<"model.started">): SequencedRunEvent;
  completeModelCall(input: RunEventCommand<"model.completed">): SequencedRunEvent;
  reserveDiscoveryCall(input: RunEventCommand<"api.search_started">): SequencedRunEvent;
  loadOperations(input: RunEventCommand<"api.operations_loaded">): SequencedRunEvent;
  requestTool(input: RunEventCommand<"tool.requested">): SequencedRunEvent;
  denyTool(input: RunEventCommand<"tool.denied">): SequencedRunEvent;
  startTool(input: RunEventCommand<"tool.started">): SequencedRunEvent;
  completeTool(input: RunEventCommand<"tool.completed">): SequencedRunEvent;
  suspendRun(input: RunEventCommand<"run.suspended">): SequencedRunEvent;
  completeRun(input: RunEventCommand<"run.completed">): SequencedRunEvent;
  failRun(input: RunEventCommand<"run.failed">): SequencedRunEvent;
}

export interface RunnerDependencies {
  modelClient: NativeToolModelClient;
  runStore: RunStateStore;
  eventService: RunEventServicePort;
  eventViews: RunEventViewPort;
  actionRegistry: ActionRegistry;
  discovery: {
    search(input: FindApiOperationsInput, scope: RunScope): Promise<ApiSearchResult>;
  };
  reads: {
    execute(call: ToolCall, scope: RunScope): Promise<ReadExecutionOutcome>;
  };
  preparations: {
    prepare(calls: ToolCall[], scope: RunScope): Promise<WritePreparationOutcome>;
  };
  installationGuard: { assertCurrent(scope: RunScope): void };
  requestGovernor: RequestGovernorPort;
  clock: { now(): Date; monotonicMs(): number };
}

export interface RunAssistantInput {
  runId: string;
  scope: RunScope;
  originalRequest?: string;
  /** Admin-authored free text answering a clarification, surfaced to the model
   * only on the first model call of a resumed invocation (T14-E). */
  continuationMessage?: string;
  signal?: AbortSignal;
}

/** T16-A frozen start/resume DTOs: the two legal shapes of `RunAssistantInput`.
 * A start ALWAYS carries the admin's original request; a resume NEVER invents
 * one (the durable run row already owns it). */
export type StartRunInput = RunAssistantInput & { originalRequest: string };
export type ResumeRunInput = Omit<RunAssistantInput, "originalRequest">;

export function assertNativeToolClient(client: ModelClient): asserts client is NativeToolModelClient {
  if (typeof client.completeWithTools !== "function") {
    throw new Error("Assistant engine v2 requires a native tool-calling model client");
  }
}
