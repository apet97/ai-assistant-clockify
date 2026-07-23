import type { ModelClient, ToolCall } from "../assistant/model-client.js";
import type {
  ApiSearchResult,
  AuthClass,
  FindApiOperationsInput,
} from "../harness/api-operation.js";
import type { ActionRegistry } from "../harness/catalog.js";

export interface RunScope {
  sessionId: string;
  workspaceId: string;
  adminUserId: string;
  installationGeneration: number;
  authClass: AuthClass;
}

export type PresentationRef =
  | { kind: "action_result"; id: string }
  | { kind: "assistant_message"; id: string }
  | { kind: "confirmation"; id: string };

export type RunOutcome =
  | { kind: "completed"; runId: string; presentationRefs: PresentationRef[] }
  | {
      kind: "suspended";
      runId: string;
      reason: "awaiting_confirmation" | "awaiting_clarification";
      continuationId: string;
      presentationRefs: PresentationRef[];
    }
  | { kind: "failed"; runId: string; code: string; presentationRefs: PresentationRef[] };

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
  getRun(scope: RunScope, runId: string): import("./state.js").RunState | undefined;
  saveRun(state: import("./state.js").RunState): void;
  findLatestEligibleRunForCache(scope: RunScope, catalogHash: string): import("./state.js").RunState | undefined;
  recoverOrphanedActiveRuns(scope: RunScope): number;
}

export interface RunnerDependencies {
  modelClient: NativeToolModelClient;
  runStore: RunStateStore;
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
  resumeResultId?: string;
  signal?: AbortSignal;
}

export function assertNativeToolClient(client: ModelClient): asserts client is NativeToolModelClient {
  if (typeof client.completeWithTools !== "function") {
    throw new Error("Assistant engine v2 requires a native tool-calling model client");
  }
}
