import { z } from "zod";
import type { ModelClient, ToolCall } from "../assistant/model-client.js";
import type { RunBudgetOverrides } from "./budgets.js";
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
  /** `replyText` is the model's own final answer. Without it the turn had
   * nothing to show and substituted a canned "Completed.", so a read that
   * really ran and really answered rendered as if nothing had happened. */
  | { kind: "completed"; runId: string; lastSequence: number; presentationRefs: PresentationRef[]; replyText?: string }
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
  /** `modelSummary` is the bounded model-visible copy of what the read
   * returned. Without it the runner can only tell the model that *something*
   * completed, which is not enough to answer the admin or to stop asking. */
  | { kind: "succeeded"; actionResultId: string; modelSummary?: string }
  /** A durable `pending_clarifications` row exists (CP-A). `actionResultId`
   * links the canonical clarify result that owns the admin-visible question —
   * events carry the reference, never the prose. */
  | { kind: "clarification"; clarificationId: string; actionResultId: string }
  /** `actionResultId` is absent only for governor-level denials synthesized
   * OUTSIDE the read port (budget/cancellation before the read began) — no
   * canonical row exists because nothing executed (closure-plan PR 5). */
  | { kind: "denied"; code: string; actionResultId?: string }
  | { kind: "validation_failed"; code: string; actionResultId: string }
  | { kind: "failed"; code: string; actionResultId?: string };

export type WritePreparationOutcome =
  | {
      kind: "prepared";
      operationIds: string[];
      confirmationIds: string[];
      batchId?: string;
    }
  /** F19: an ambiguous write produced a DURABLE clarification (grounded
   * chips), not a generic denial. The run suspends awaiting the answer. */
  | { kind: "clarification"; clarificationId: string; actionResultId: string }
  /** `actionResultId` absent only for pre-persistence denials (e.g. a revoked
   * installation, F07) where creating a row would violate the boundary. */
  | { kind: "denied"; code: string; actionResultId?: string }
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

/** Closure-plan PR 6 (F04): ONE accounting mechanism. `runRead` installs the
 * persisted run-scoped ledger; every physical charge is a durable conditional
 * store write. The old in-memory allowance mirror is gone. */
export interface RequestGovernorPort {
  runRead<T>(
    scope: RunScope,
    operation: () => Promise<T>,
    options?: {
      signal?: AbortSignal;
      onDispatch?: () => void;
      /** Plan B1: the run's VALIDATED host-call ceiling, always ≤
       * `V2_LIMITS.maxHostCalls`. The production governor ignores it — its
       * durable ledger owns the hard 60-call cap, and production runs never
       * carry an override — while the eval harness narrows its charge hook
       * on it. It can only ever narrow, never widen. */
      maxHostCalls?: number;
    },
  ): Promise<T>;
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
  /** Canonical stored result content, for resumed-run model feedback
   * (closure-plan PR 3 / F22): a resumed model request receives the bounded
   * receipt itself, never an opaque result id. */
  getActionResult(actionResultId: string): unknown;
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
  requireClarification(input: RunEventCommand<"clarification.required">): SequencedRunEvent;
  /** F23: the question and the run's suspension commit in ONE transaction. */
  requireClarificationAndSuspend(
    input: RunEventCommand<"clarification.required">,
  ): { required: SequencedRunEvent; suspended: SequencedRunEvent };
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
    /** `runId` is REQUIRED: a clarify outcome persists a run-scoped
     * `pending_clarifications` row, so the producer must know its run. */
    execute(call: ToolCall, scope: RunScope & { runId: string }): Promise<ReadExecutionOutcome>;
  };
  preparations: {
    /** `runId` is REQUIRED, exactly as for `reads`: preparation loads the
     * durable run to reserve its host-call budget. This was declared as a bare
     * `RunScope` while the implementation required the run id, and TypeScript
     * accepted the mismatch because method parameters are checked bivariantly
     * — so production silently passed a scope with no `runId` and every
     * assistant write threw `assistant_run_not_found`. */
    prepare(calls: ToolCall[], scope: RunScope & { runId: string }): Promise<WritePreparationOutcome>;
  };
  installationGuard: {
    assertCurrent(scope: RunScope): void;
    /** Closure-plan PR 8 (F07): synchronous post-await recheck — false when
     * the installation went inactive or its generation moved. */
    isCurrent?(): boolean;
  };
  requestGovernor: RequestGovernorPort;
  clock: { now(): Date; monotonicMs(): number };
}

export interface RunAssistantInput {
  runId: string;
  scope: RunScope;
  originalRequest?: string;
  /** The claimed HTTP request id that initiated this run (closure-plan PR 2).
   * A fresh run's `initial` request link binds it to the minted run id so the
   * request → run → message identity chain is explicit; absent, the link
   * stays self-referential (direct invocations without a claimed turn). */
  requestId?: string;
  /** Admin-authored free text answering a clarification, surfaced to the model
   * only on the first model call of a resumed invocation (T14-E). */
  continuationMessage?: string;
  signal?: AbortSignal;
  /** EVAL-ONLY (plan B1): a validated NARROWING budget override for this run.
   * The runner rejects non-integers, negatives, and anything above the
   * `V2_LIMITS` default before any durable state exists, so it can never widen
   * a production ceiling. No config or environment feeds it; the sole caller
   * is the v2 eval harness (pinned by
   * `tests/unit/v2-budget-override-pin.test.ts`). */
  budgetOverrides?: RunBudgetOverrides;
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
