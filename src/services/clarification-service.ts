import type { ToolCall } from "../assistant/model-client.js";
import type { ReadExecutionOutcome, RunOutcome, RunScope, WritePreparationOutcome } from "../assistant-v2/protocol.js";
import type { ActionRegistry } from "../harness/api-catalog.js";
import type { Store } from "../db/store.js";
import { PendingClarificationStoreError, type ClarificationScope } from "../db/store/pending-clarifications.js";
import { successReceipt } from "../harness/receipts.js";

export interface ClarificationServiceDeps {
  store: Store;
  registry: ActionRegistry;
  reads: { execute(call: ToolCall, scope: RunScope): Promise<ReadExecutionOutcome> };
  preparations: { prepare(calls: ToolCall[], scope: RunScope & { runId: string }): Promise<WritePreparationOutcome> };
  runner: { resume(input: { runId: string; scope: RunScope; signal?: AbortSignal }): Promise<RunOutcome> };
}

export interface ResolveClarificationOptionInput {
  clarificationId: string;
  scope: RunScope;
  runId: string;
  optionId: string;
  signal?: AbortSignal;
}

export type ResolveClarificationOptionResult =
  | { ok: true; outcome: RunOutcome }
  | { ok: false; status: number; code: string; message: string };

function claimScopeFor(input: ResolveClarificationOptionInput): ClarificationScope {
  return {
    sessionId: input.scope.sessionId,
    runId: input.runId,
    workspaceId: input.scope.workspaceId,
    adminUserId: input.scope.adminUserId,
  };
}

// Best-effort transient reset (canonical plan §14 resolution/recovery point 1):
// a definitive rejection found BEFORE any durable result exists returns the
// clarification to `pending` so the admin can try another option. If the claim
// already expired or a concurrent request moved it past `resolving`, resetting
// would fail on its own guard — that failure is expected and not surfaced.
function safeResetToPending(store: Store, id: string, scope: ClarificationScope): void {
  try {
    store.resetClarificationToPending(id, scope);
  } catch {
    // Already past `resolving` (expired/raced) — nothing to reset.
  }
}

function mapClaimError(error: unknown): { status: number; code: string; message: string } {
  const code = error instanceof PendingClarificationStoreError ? error.code : "clarification_error";
  switch (code) {
    case "clarification_not_found":
      return { status: 404, code, message: "No such pending clarification." };
    case "clarification_not_pending":
      return { status: 409, code, message: "That clarification has already been resolved or is in progress." };
    case "clarification_expired":
      return { status: 410, code, message: "That clarification has expired." };
    default:
      return { status: 403, code, message: "That clarification does not belong to this session." };
  }
}

/**
 * Canonical plan §14 "Clarification contract": exact `optionId` -> authoritative
 * external ID resolution, never the model-invented or admin-tampered label.
 * Never dispatches a Clockify mutation itself — a write resolution only prepares
 * an operation (button-confirm still gates the actual write).
 */
export function createClarificationService(deps: ClarificationServiceDeps): {
  resolveOption(input: ResolveClarificationOptionInput): Promise<ResolveClarificationOptionResult>;
} {
  return {
    async resolveOption(input) {
      const claimScope = claimScopeFor(input);
      let clarification;
      try {
        clarification = deps.store.claimClarificationResolving(input.clarificationId, claimScope);
      } catch (error) {
        return { ok: false, ...mapClaimError(error) };
      }

      const candidate = clarification.candidates.find((c) => c.optionId === input.optionId);
      if (!candidate) {
        safeResetToPending(deps.store, input.clarificationId, claimScope);
        return { ok: false, status: 400, code: "unknown_option", message: "That option is no longer available." };
      }

      const action = deps.registry.get(clarification.originalToolName);
      if (!action?.apiOperation) {
        safeResetToPending(deps.store, input.clarificationId, claimScope);
        return { ok: false, status: 409, code: "action_unavailable", message: "That action is no longer available." };
      }

      const base = clarification.partialArguments && typeof clarification.partialArguments === "object"
        ? clarification.partialArguments as Record<string, unknown>
        : {};
      const rawArgs: Record<string, unknown> = { ...base, [clarification.missingField]: candidate.externalId };

      const parsed = action.schema.safeParse(rawArgs);
      if (!parsed.success) {
        safeResetToPending(deps.store, input.clarificationId, claimScope);
        return { ok: false, status: 400, code: "invalid_args", message: "The selected option no longer matches this action." };
      }

      const runScope = { ...input.scope, runId: input.runId };
      const toolCallId = `clarification:${input.clarificationId}`;
      const call: ToolCall = {
        id: toolCallId,
        name: clarification.originalToolName,
        arguments: parsed.data as Record<string, unknown>,
      };

      let actionResultId: string;
      let operationId: string | undefined;

      if (action.apiOperation.access === "read") {
        const outcome = await deps.reads.execute(call, runScope);
        if (outcome.kind !== "succeeded") {
          safeResetToPending(deps.store, input.clarificationId, claimScope);
          const code = "code" in outcome ? outcome.code : "clarification_still_ambiguous";
          return { ok: false, status: 409, code, message: "The selected option could not be resolved." };
        }
        actionResultId = outcome.actionResultId;
      } else {
        const outcome = await deps.preparations.prepare([call], runScope);
        if (outcome.kind !== "prepared") {
          safeResetToPending(deps.store, input.clarificationId, claimScope);
          const code = "code" in outcome ? outcome.code : "write_port_not_ready";
          return { ok: false, status: 409, code, message: "The selected option could not be prepared." };
        }
        operationId = outcome.operationIds[0];
        const confirmationId = outcome.confirmationIds[0];
        // A prepared write has no linked action_result yet (only the eventual
        // confirm settles one) — record a bounded marker now so the clarification
        // row's required action_result_id links to something durable and
        // canonical `action_results` stays the sole result-of-record owner.
        const ref = deps.store.recordActionResult({
          workspaceId: runScope.workspaceId,
          adminUserId: runScope.adminUserId,
          sessionId: runScope.sessionId,
          actionName: clarification.originalToolName,
          status: "succeeded",
          result: {
            kind: "receipt",
            receipt: successReceipt({
              action: clarification.originalToolName,
              data: { status: "prepared", operationId, confirmationId },
            }),
          },
        });
        actionResultId = ref.id;
      }

      const state = deps.store.getRun({
        sessionId: runScope.sessionId,
        runId: runScope.runId,
        workspaceId: runScope.workspaceId,
        adminUserId: runScope.adminUserId,
        installationGeneration: runScope.installationGeneration,
        authClass: runScope.authClass,
      });
      if (!state) {
        return { ok: false, status: 404, code: "run_not_found", message: "That run is no longer active." };
      }

      // One transaction: link the result, resolve the clarification, clear the
      // run's suspension, and append the durable `tool.completed` event.
      deps.store.resolveClarificationOption({
        clarificationId: input.clarificationId,
        scope: {
          sessionId: runScope.sessionId,
          runId: runScope.runId,
          workspaceId: runScope.workspaceId,
          adminUserId: runScope.adminUserId,
          installationGeneration: runScope.installationGeneration,
          authClass: runScope.authClass,
        },
        state,
        selectedOptionId: input.optionId,
        actionResultId,
        operationId,
        toolCallId,
        actionName: clarification.originalToolName,
      });

      const outcome = await deps.runner.resume({ runId: input.runId, scope: input.scope, signal: input.signal });
      return { ok: true, outcome };
    },
  };
}
