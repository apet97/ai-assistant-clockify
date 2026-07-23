import type {
  RunEventPayloadMap,
  RunEventType,
  SequencedRunEvent,
} from "../assistant-v2/events.js";
import { parseRunEventPayload } from "../assistant-v2/events.js";
import type { RunScope } from "../assistant-v2/protocol.js";
import type { RunState } from "../assistant-v2/state.js";
import type { Store } from "../db/store.js";
import type { AssistantRunScope, StartAssistantRunInput } from "../db/store/runs.js";

export interface StartRunEventCommand {
  scope: RunScope & { runId: string };
  input: Omit<StartAssistantRunInput, "scope">;
}

export interface RunEventCommand<K extends RunEventType> {
  scope: RunScope & { runId: string };
  state: RunState;
  payload: RunEventPayloadMap[K];
}

function toAssistantScope(scope: RunScope & { runId: string }): AssistantRunScope {
  return {
    sessionId: scope.sessionId,
    runId: scope.runId,
    workspaceId: scope.workspaceId,
    adminUserId: scope.adminUserId,
    installationGeneration: scope.installationGeneration,
    authClass: scope.authClass,
  };
}

type RunEventServiceStore = Pick<Store,
  | "startRunWithEvent"
  | "reserveModelCallWithEvent"
  | "completeModelCallWithEvent"
  | "reserveDiscoveryCallWithEvent"
  | "loadOperationsWithEvent"
  | "requestToolWithEvent"
  | "denyToolWithEvent"
  | "startToolWithEvent"
  | "completeToolWithEvent"
  | "suspendRunWithEvent"
  | "completeRunWithEvent"
  | "failRunWithEvent"
>;

export function createRunEventService(store: RunEventServiceStore) {
  return {
    startRun(input: StartRunEventCommand): SequencedRunEvent {
      parseRunEventPayload("run.started", { requestHash: input.input.requestHash });
      return store.startRunWithEvent({
        scope: toAssistantScope(input.scope),
        ...input.input,
      });
    },
    reserveModelCall(input: RunEventCommand<"model.started">): SequencedRunEvent {
      parseRunEventPayload("model.started", input.payload);
      return store.reserveModelCallWithEvent(toAssistantScope(input.scope), input.state, input.payload);
    },
    completeModelCall(input: RunEventCommand<"model.completed">): SequencedRunEvent {
      parseRunEventPayload("model.completed", input.payload);
      return store.completeModelCallWithEvent(toAssistantScope(input.scope), input.state, input.payload);
    },
    reserveDiscoveryCall(input: RunEventCommand<"api.search_started">): SequencedRunEvent {
      parseRunEventPayload("api.search_started", input.payload);
      return store.reserveDiscoveryCallWithEvent(toAssistantScope(input.scope), input.state, input.payload);
    },
    loadOperations(input: RunEventCommand<"api.operations_loaded">): SequencedRunEvent {
      parseRunEventPayload("api.operations_loaded", input.payload);
      return store.loadOperationsWithEvent(toAssistantScope(input.scope), input.state, input.payload);
    },
    requestTool(input: RunEventCommand<"tool.requested">): SequencedRunEvent {
      parseRunEventPayload("tool.requested", input.payload);
      return store.requestToolWithEvent(toAssistantScope(input.scope), input.state, input.payload);
    },
    denyTool(input: RunEventCommand<"tool.denied">): SequencedRunEvent {
      parseRunEventPayload("tool.denied", input.payload);
      return store.denyToolWithEvent(toAssistantScope(input.scope), input.state, input.payload);
    },
    startTool(input: RunEventCommand<"tool.started">): SequencedRunEvent {
      parseRunEventPayload("tool.started", input.payload);
      return store.startToolWithEvent(toAssistantScope(input.scope), input.state, input.payload);
    },
    completeTool(input: RunEventCommand<"tool.completed">): SequencedRunEvent {
      parseRunEventPayload("tool.completed", input.payload);
      return store.completeToolWithEvent(toAssistantScope(input.scope), input.state, input.payload);
    },
    suspendRun(input: RunEventCommand<"run.suspended">): SequencedRunEvent {
      parseRunEventPayload("run.suspended", input.payload);
      return store.suspendRunWithEvent(toAssistantScope(input.scope), input.state, input.payload);
    },
    completeRun(input: RunEventCommand<"run.completed">): SequencedRunEvent {
      parseRunEventPayload("run.completed", input.payload);
      return store.completeRunWithEvent(toAssistantScope(input.scope), input.state, input.payload);
    },
    failRun(input: RunEventCommand<"run.failed">): SequencedRunEvent {
      parseRunEventPayload("run.failed", input.payload);
      return store.failRunWithEvent(toAssistantScope(input.scope), input.state, input.payload);
    },
  };
}

export type RunEventService = ReturnType<typeof createRunEventService>;
