import { randomUUID } from "node:crypto";
import type { ToolCall } from "../assistant/model-client.js";
import type {
  PrepareBatchInput,
  PreparedBatch,
  RunScope,
  ValidatedWriteCall,
  WritePreparationOutcome,
} from "../assistant-v2/protocol.js";
import type { RunState } from "../assistant-v2/state.js";
import { releaseHostCallReservation } from "../assistant-v2/budgets.js";
import type { Store } from "../db/store.js";
import type { AssistantRunScope } from "../db/store/runs.js";
import type { PreparedAssistantWriteInput } from "../db/store/assistant-write-preparation.js";
import { executeV2ApiAction, validateV2RawActionArguments } from "../harness/actions.js";
import type { ActionContext, ActionDefinition, ConfirmableOperation } from "../harness/action.js";
import { MODEL_API_ACTION_CATALOG, type ActionRegistry } from "../harness/api-catalog.js";
import { actionFingerprintForDefinition } from "../harness/catalog.js";
import { createPendingConfirmation } from "../harness/confirmations.js";
import { exactNonsecretJson } from "../harness/safe-json.js";
import { defaultAdminPolicy, type AdminPolicy } from "../harness/permissions.js";
import {
  buildModelInferenceProvenance,
  buildNormalizedOperationForPresentation,
  hashFieldProvenanceMap,
  metadataDrivenPresentPreparedWrite,
  validatePreparedWritePresentation,
  type FieldProvenanceMap,
} from "../harness/prepared-write-presentation.js";
import type { WorkspaceClient } from "../clockify/client.js";
import { errorReceipt } from "../harness/receipts.js";
import { buildV2ActionContext } from "../assistant-v2/action-context.js";
import { createClarificationRow } from "../assistant-v2/read-execution.js";

/** Carries a durable write clarification out of the batch builder (F19): the
 * question and its chips already exist; `prepare()` maps this to the
 * `clarification` outcome instead of a generic denial. */
class WriteClarificationPending extends Error {
  constructor(
    readonly clarificationId: string,
    readonly actionResultId: string,
  ) {
    super("write_clarification_pending");
  }
}

export interface OperationPreparationDeps {
  store: Store;
  registry: ActionRegistry;
  sessionSecret: string;
  clockifyForScope: (scope: RunScope) => WorkspaceClient;
  now?: () => Date;
  loadCalendarContext?: (scope: RunScope) => Promise<{ timeZone?: string; weekStartsOn?: number }>;
  getAdminPolicy?: (workspaceId: string, adminUserId: string) => AdminPolicy | undefined;
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

async function buildContext(scope: RunScope, deps: OperationPreparationDeps): Promise<ActionContext> {
  return buildV2ActionContext({
    scope,
    policy: deps.getAdminPolicy?.(scope.workspaceId, scope.adminUserId) ?? defaultAdminPolicy(),
    clockify: deps.clockifyForScope(scope),
    now: deps.now,
    loadCalendarContext: deps.loadCalendarContext,
  });
}

function executorKindFor(action: ActionDefinition): "prepared_safe_write" | "risky_commit" {
  return action.kind === "safe_write" ? "prepared_safe_write" : "risky_commit";
}

function buildPreparedWriteInput(input: {
  scope: RunScope & { runId: string };
  action: ActionDefinition;
  operation: ConfirmableOperation;
  preview: unknown;
  fieldProvenanceJson: string;
  fieldProvenanceHash: string;
  catalogHash: string;
  sessionSecret: string;
  now?: Date;
}): PreparedAssistantWriteInput {
  const mutationPlan = input.operation.mutationPlan!;
  const created = createPendingConfirmation({
    id: randomUUID(),
    sessionId: input.scope.sessionId,
    workspaceId: input.scope.workspaceId,
    adminUserId: input.scope.adminUserId,
    risk: input.operation.risks,
    preview: input.preview,
    operation: input.operation,
    installationGeneration: input.scope.installationGeneration,
    sessionSecret: input.sessionSecret,
    now: input.now,
    actionFingerprint: actionFingerprintForDefinition(input.action),
    catalogHash: input.catalogHash,
    origin: "assistant",
    registryId: "v2-api",
    authorityModel: "preview_confirmation_v2",
    executorKind: executorKindFor(input.action),
    runId: input.scope.runId,
  });
  const operationPayload = exactNonsecretJson(
    JSON.parse(JSON.stringify(input.operation.payload)),
  ) as Record<string, unknown>;
  return {
    hostCalls: mutationPlan.maxHostCalls,
    event: {
      operationId: input.operation.operationId,
      confirmationId: created.record.id,
    },
    operationRun: {
      id: input.operation.operationId,
      confirmationId: created.record.id,
      sessionId: input.scope.sessionId,
      workspaceId: input.scope.workspaceId,
      adminUserId: input.scope.adminUserId,
      actionName: input.action.name,
      actionFingerprint: actionFingerprintForDefinition(input.action),
      catalogHash: input.catalogHash,
      operationHash: created.record.operationHash,
      operation: operationPayload,
      mutationPlan,
      discriminator: {
        origin: "assistant",
        registryId: "v2-api",
        authorityModel: "preview_confirmation_v2",
        executorKind: executorKindFor(input.action),
        runId: input.scope.runId,
        fieldProvenanceJson: input.fieldProvenanceJson,
        fieldProvenanceHash: input.fieldProvenanceHash,
      },
    },
    confirmation: {
      ...created.record,
      operationId: input.operation.operationId,
    },
  };
}

export function createOperationPreparationService(deps: OperationPreparationDeps) {
  const catalogHash = deps.registry.hash();

  async function buildPreparedWrite(
    scope: RunScope & { runId: string },
    call: ValidatedWriteCall,
  ): Promise<
    | { ok: true; write: PreparedAssistantWriteInput }
    | { ok: false; code: string; actionResultId: string }
  > {
    const action = deps.registry.get(call.actionName);
    if (!action) {
      const ref = deps.store.recordActionResult({
        workspaceId: scope.workspaceId,
        adminUserId: scope.adminUserId,
        sessionId: scope.sessionId,
        actionName: call.actionName,
        status: "definitive_failed",
        result: { kind: "receipt", receipt: errorReceipt({ action: call.actionName, code: "unknown_action", message: "Unknown action." }) },
      });
      return { ok: false, code: "unknown_action", actionResultId: ref.id };
    }

    const rawError = validateV2RawActionArguments(action, call.rawArguments);
    if (rawError) {
      const ref = deps.store.recordActionResult({
        workspaceId: scope.workspaceId,
        adminUserId: scope.adminUserId,
        sessionId: scope.sessionId,
        actionName: call.actionName,
        status: "definitive_failed",
        result: { kind: "receipt", receipt: rawError },
      });
      return { ok: false, code: rawError.code, actionResultId: ref.id };
    }

    const availability = deps.registry.availability(call.actionName, scope.authClass);
    if (!availability.available) {
      const ref = deps.store.recordActionResult({
        workspaceId: scope.workspaceId,
        adminUserId: scope.adminUserId,
        sessionId: scope.sessionId,
        actionName: call.actionName,
        status: "definitive_failed",
        result: {
          kind: "receipt",
          receipt: errorReceipt({
            action: call.actionName,
            code: "unavailable_for_auth_class",
            message: "This operation is not available for the current Clockify auth class.",
            recovery: { hint: "Choose an operation available for this installation.", retryable: false },
          }),
        },
      });
      return { ok: false, code: "unavailable_for_auth_class", actionResultId: ref.id };
    }

    const context = await buildContext(scope, deps);
    const result = await executeV2ApiAction({
      origin: "assistant",
      registryId: "v2-api",
      actionName: call.actionName,
      args: call.rawArguments,
      context,
      installationGeneration: scope.installationGeneration,
      // PR 10 (F16): the injected registry entry executes — same source as
      // the fingerprint/availability checks above.
      definition: action,
    });

    if (result.kind === "clarify") {
      // Closure-plan PR 4 (F19): an ambiguous WRITE produces a real durable
      // clarification through the same producer reads use — grounded chips,
      // not a generic denial. The canonical clarify result owns the question
      // prose; the pending row carries the candidates.
      const ref = deps.store.recordActionResult({
        workspaceId: scope.workspaceId,
        adminUserId: scope.adminUserId,
        sessionId: scope.sessionId,
        actionName: call.actionName,
        status: "definitive_failed",
        result,
      });
      const clarificationId = createClarificationRow(
        { store: deps.store },
        scope,
        { name: call.actionName, arguments: call.rawArguments },
        result,
      );
      if (clarificationId !== undefined) {
        throw new WriteClarificationPending(clarificationId, ref.id);
      }
      // The run already owns an open question — report this write truthfully.
      return { ok: false, code: "clarification_already_active", actionResultId: ref.id };
    }
    if (result.kind !== "preview") {
      const ref = deps.store.recordActionResult({
        workspaceId: scope.workspaceId,
        adminUserId: scope.adminUserId,
        sessionId: scope.sessionId,
        actionName: call.actionName,
        status: "definitive_failed",
        result,
      });
      const code = result.kind === "receipt" && !result.receipt.ok ? result.receipt.code : "preparation_failed";
      return { ok: false, code, actionResultId: ref.id };
    }

    const operation = result.operation;
    if (!operation.mutationPlan) {
      const ref = deps.store.recordActionResult({
        workspaceId: scope.workspaceId,
        adminUserId: scope.adminUserId,
        sessionId: scope.sessionId,
        actionName: call.actionName,
        status: "definitive_failed",
        result: {
          kind: "receipt",
          receipt: errorReceipt({ action: call.actionName, code: "missing_mutation_plan", message: "Prepared write is missing its host plan." }),
        },
      });
      return { ok: false, code: "missing_mutation_plan", actionResultId: ref.id };
    }

    const normalizedOperation = buildNormalizedOperationForPresentation(
      action,
      call.rawArguments,
      operation.payload,
    );
    const provenanceResult = buildModelInferenceProvenance(action, normalizedOperation);
    if (typeof provenanceResult === "object" && "ok" in provenanceResult && provenanceResult.ok === false) {
      const detail = (provenanceResult as { ok: false; detail: string }).detail;
      const ref = deps.store.recordActionResult({
        workspaceId: scope.workspaceId,
        adminUserId: scope.adminUserId,
        sessionId: scope.sessionId,
        actionName: call.actionName,
        status: "definitive_failed",
        result: {
          kind: "receipt",
          receipt: errorReceipt({
            action: call.actionName,
            code: "presentation_limit_exceeded",
            message: detail,
          }),
        },
      });
      return { ok: false, code: "presentation_limit_exceeded", actionResultId: ref.id };
    }
    const fieldProvenance = provenanceResult as FieldProvenanceMap;
    const presentation = metadataDrivenPresentPreparedWrite({
      definition: action,
      normalizedOperation,
      fieldProvenance,
      resolvedTargets: [],
      serverDefaults: [],
    });
    const presentationGate = validatePreparedWritePresentation({
      definition: action,
      normalizedOperation,
      fieldProvenance,
      resolvedTargets: [],
      serverDefaults: [],
      presentation,
    });
    if (!presentationGate.ok) {
      const ref = deps.store.recordActionResult({
        workspaceId: scope.workspaceId,
        adminUserId: scope.adminUserId,
        sessionId: scope.sessionId,
        actionName: call.actionName,
        status: "definitive_failed",
        result: {
          kind: "receipt",
          receipt: errorReceipt({
            action: call.actionName,
            code: presentationGate.error.code,
            message: presentationGate.error.detail,
          }),
        },
      });
      return { ok: false, code: presentationGate.error.code, actionResultId: ref.id };
    }

    const fieldProvenanceJson = JSON.stringify(fieldProvenance);
    const fieldProvenanceHash = hashFieldProvenanceMap(fieldProvenance);
    const write = buildPreparedWriteInput({
      scope,
      action,
      operation,
      preview: result.preview,
      fieldProvenanceJson,
      fieldProvenanceHash,
      catalogHash,
      sessionSecret: deps.sessionSecret,
      now: deps.now?.(),
    });
    return { ok: true, write };
  }

  return {
    async prepareBatch(input: PrepareBatchInput): Promise<PreparedBatch> {
      if (input.calls.length === 0) throw new Error("empty_prepare_batch");
      const scope = { ...input.scope, runId: input.runId };
      const state = deps.store.getRun(toAssistantScope(scope));
      if (!state) throw new Error("assistant_run_not_found");

      let batchMeta: Omit<import("../db/store/context.js").CreateConfirmationBatchInput, "items"> | undefined;

      const writes: PreparedAssistantWriteInput[] = [];
      for (const call of input.calls) {
        if (call.runId !== input.runId) throw new Error("prepare_batch_run_mismatch");
        const built = await buildPreparedWrite(scope, call);
        if (!built.ok) throw new Error(built.code);
        writes.push(built.write);
      }

      if (writes.length > 1) {
        batchMeta = {
          sessionId: scope.sessionId,
          runId: scope.runId,
          workspaceId: scope.workspaceId,
          adminUserId: scope.adminUserId,
          orderedTupleHash: deps.store.computeOrderedTupleHash(writes.map((write) => ({
            confirmationId: write.confirmation.id,
            operationId: write.operationRun.id!,
          }))),
          expiresAt: writes.reduce((earliest, write) =>
            write.confirmation.expiresAt < earliest ? write.confirmation.expiresAt : earliest,
          writes[0]!.confirmation.expiresAt),
        };
      }

      // The store transaction owns the run row now (budget, continuation,
      // phase, run.suspended) — a post-transaction saveRun would only re-write
      // what already committed atomically (F23).
      const persisted = deps.store.prepareAssistantWriteBatchWithEvents({
        scope: toAssistantScope(scope),
        state,
        writes,
        ...(batchMeta ? { batch: batchMeta } : {}),
      });

      const batchId = persisted.batchId;
      if (batchId) {
        for (const write of writes) {
          write.confirmation.batchId = batchId;
          write.operationRun.discriminator!.batchId = batchId;
        }
      }

      return {
        runId: input.runId,
        ...(batchId ? { batchId } : {}),
        items: writes.map((write) => ({
          operationId: write.operationRun.id!,
          confirmationId: write.confirmation.id,
          actionName: write.operationRun.actionName,
          actionFingerprint: write.operationRun.actionFingerprint,
          maxHostCalls: write.hostCalls,
          expiresAt: write.confirmation.expiresAt,
        })),
        expiresAt: writes.reduce((earliest, write) =>
          write.confirmation.expiresAt < earliest ? write.confirmation.expiresAt : earliest,
        writes[0]!.confirmation.expiresAt),
        lastSequence: deps.store.getLastRunEventSequence(toAssistantScope(scope)),
      };
    },

    async prepare(calls: ToolCall[], scope: RunScope & { runId: string }): Promise<WritePreparationOutcome> {
      if (calls.length === 0) {
        return { kind: "not_ready", code: "write_port_not_ready", actionResultId: "empty-write-batch" };
      }
      const validated: ValidatedWriteCall[] = calls.map((call) => {
        const action = deps.registry.get(call.name);
        if (!action?.apiOperation) throw new Error(`unknown_tool:${call.name}`);
        return {
          runId: scope.runId,
          toolCallId: call.id,
          actionName: call.name,
          apiOperationId: action.apiOperation.operationId,
          access: "write",
          registryId: "v2-api",
          catalogHash: deps.registry.hash(),
          actionFingerprint: actionFingerprintForDefinition(action),
          rawArguments: call.arguments as Record<string, unknown>,
        };
      });
      try {
        const batch = await this.prepareBatch({ scope, runId: scope.runId, calls: validated });
        return {
          kind: "prepared",
          operationIds: batch.items.map((item) => item.operationId),
          confirmationIds: batch.items.map((item) => item.confirmationId),
          ...(batch.batchId ? { batchId: batch.batchId } : {}),
        };
      } catch (error) {
        if (error instanceof WriteClarificationPending) {
          return {
            kind: "clarification",
            clarificationId: error.clarificationId,
            actionResultId: error.actionResultId,
          };
        }
        const code = error instanceof Error ? error.message : "preparation_failed";        const ref = deps.store.recordActionResult({
          workspaceId: scope.workspaceId,
          adminUserId: scope.adminUserId,
          sessionId: scope.sessionId,
          actionName: calls[0]?.name ?? "unknown",
          status: "definitive_failed",
          result: {
            kind: "receipt",
            receipt: errorReceipt({
              action: calls[0]?.name ?? "unknown",
              code,
              message: code,
            }),
          },
        });
        if (
          code === "host_call_budget_exceeded" ||
          code === "clarification_required" ||
          code === "policy_denied" ||
          code === "unavailable_for_auth_class" ||
          code.startsWith("invalid_") ||
          code === "presentation_limit_exceeded"
        ) {
          return { kind: "denied", code, actionResultId: ref.id };
        }
        return { kind: "not_ready", code: "write_port_not_ready", actionResultId: ref.id };
      }
    },

    releaseHostReservations(state: RunState, count: number): RunState {
      const next = { ...state, budget: releaseHostCallReservation(state.budget, count) };
      deps.store.saveRun(next);
      return next;
    },
  };
}

export const defaultOperationPreparationRegistry = MODEL_API_ACTION_CATALOG;
