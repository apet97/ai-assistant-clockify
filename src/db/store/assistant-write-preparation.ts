import type { RunEventPayloadMap, SequencedRunEvent } from "../../assistant-v2/events.js";
import { encodeRunEventPayload, parseRunEventPayload } from "../../assistant-v2/events.js";
import type { RunBudget, RunState } from "../../assistant-v2/state.js";
import { canReserveHostCalls, reserveHostCalls } from "../../assistant-v2/budgets.js";
import type { PendingConfirmationRecord } from "../../harness/confirmations.js";
import { computeOrderedTupleHash } from "./confirmation-batches.js";
import type { CreateConfirmationBatchInput, PrepareOperationRunInput } from "./context.js";
import type { StoreContext } from "./context.js";
import type { AssistantRunScope } from "./runs.js";

export interface PreparedAssistantWriteInput {
  operationRun: PrepareOperationRunInput;
  confirmation: PendingConfirmationRecord;
  hostCalls: number;
  event: RunEventPayloadMap["operation.prepared"];
}

export interface PreparedAssistantWriteResult {
  state: RunState;
  event: SequencedRunEvent;
  operationId: string;
  confirmationId: string;
}

function updateBudget(db: StoreContext["db"], scope: AssistantRunScope, budget: RunBudget, timestamp: string): void {
  db.prepare(
    `UPDATE assistant_runs SET budget_json = ?, updated_at = ?
      WHERE session_id = ? AND run_id = ? AND workspace_id = ? AND admin_user_id = ?
        AND installation_generation = ? AND auth_class = ?`,
  ).run(
    JSON.stringify(budget),
    timestamp,
    scope.sessionId,
    scope.runId,
    scope.workspaceId,
    scope.adminUserId,
    scope.installationGeneration,
    scope.authClass,
  );
}

function insertPreparedEvent(
  db: StoreContext["db"],
  scope: AssistantRunScope,
  payload: RunEventPayloadMap["operation.prepared"],
  timestamp: string,
): SequencedRunEvent {
  const nextRow = db.prepare(
    `SELECT COALESCE(MAX(sequence), 0) + 1 AS next
       FROM run_events WHERE session_id = ? AND run_id = ?`,
  ).get(scope.sessionId, scope.runId) as { next: number };
  const sequence = nextRow.next;
  const payloadJson = encodeRunEventPayload("operation.prepared", payload);
  db.prepare(
    `INSERT INTO run_events (
       session_id, run_id, sequence, workspace_id, admin_user_id,
       event_type, payload_json, created_at
     ) VALUES (?, ?, ?, ?, ?, 'operation.prepared', ?, ?)`,
  ).run(
    scope.sessionId,
    scope.runId,
    sequence,
    scope.workspaceId,
    scope.adminUserId,
    payloadJson,
    timestamp,
  );
  return {
    runId: scope.runId,
    sequence,
    event: {
      eventType: "operation.prepared",
      payload: parseRunEventPayload("operation.prepared", payload),
      createdAt: timestamp,
    },
  };
}

function applyPreparedWrite(
  db: StoreContext["db"],
  scope: AssistantRunScope,
  state: RunState,
  write: PreparedAssistantWriteInput,
  timestamp: string,
  deps: {
    prepareOperationRun(input: PrepareOperationRunInput): string;
    savePendingConfirmation(record: PendingConfirmationRecord): void;
  },
): PreparedAssistantWriteResult {
  if (!canReserveHostCalls(state.budget, write.hostCalls)) {
    throw new Error("host_call_budget_exceeded");
  }
  const budget = reserveHostCalls(state.budget, write.hostCalls);
  const operationId = deps.prepareOperationRun(write.operationRun);
  deps.savePendingConfirmation({ ...write.confirmation, operationId });
  updateBudget(db, scope, budget, timestamp);
  const event = insertPreparedEvent(db, scope, {
    ...write.event,
    operationId,
    confirmationId: write.confirmation.id,
  }, timestamp);
  return {
    state: { ...state, budget },
    event,
    operationId,
    confirmationId: write.confirmation.id,
  };
}

export function buildAssistantWritePreparationStore(
  ctx: StoreContext,
  deps: {
    prepareOperationRun(input: PrepareOperationRunInput): string;
    savePendingConfirmation(record: PendingConfirmationRecord): void;
    insertConfirmationBatch(input: CreateConfirmationBatchInput): ReturnType<
      ReturnType<typeof import("./confirmation-batches.js").buildConfirmationBatchStore>["insertConfirmationBatch"]
    >;
  },
): {
  prepareAssistantWriteWithEvent(input: {
    scope: AssistantRunScope;
    state: RunState;
    write: PreparedAssistantWriteInput;
  }): PreparedAssistantWriteResult;
  prepareAssistantWriteBatchWithEvents(input: {
    scope: AssistantRunScope;
    state: RunState;
    writes: readonly PreparedAssistantWriteInput[];
    batch?: Omit<CreateConfirmationBatchInput, "items">;
  }): {
    state: RunState;
    events: SequencedRunEvent[];
    items: Array<{ operationId: string; confirmationId: string }>;
    batchId?: string;
  };
} {
  const { db, nowIso } = ctx;

  return {
    prepareAssistantWriteWithEvent(input) {
      return db.transaction(() =>
        applyPreparedWrite(db, input.scope, input.state, input.write, nowIso(), deps),
      )();
    },
    prepareAssistantWriteBatchWithEvents(input) {
      return db.transaction(() => {
        let state = input.state;
        const events: SequencedRunEvent[] = [];
        const items: Array<{ operationId: string; confirmationId: string }> = [];
        const timestamp = nowIso();
        for (const write of input.writes) {
          const result = applyPreparedWrite(db, input.scope, state, write, timestamp, deps);
          state = result.state;
          events.push(result.event);
          items.push({ operationId: result.operationId, confirmationId: result.confirmationId });
        }

        let batchId: string | undefined;
        if (input.batch && input.writes.length > 1) {
          const batchItems = items.map(({ confirmationId, operationId }) => ({
            confirmationId,
            operationId,
          }));
          const orderedTupleHash = computeOrderedTupleHash(batchItems);
          if (orderedTupleHash !== input.batch.orderedTupleHash) {
            throw new Error("ordered_tuple_hash_mismatch");
          }
          const batch = deps.insertConfirmationBatch({
            ...input.batch,
            items: batchItems,
            orderedTupleHash,
          });
          batchId = batch.id;
          for (const write of input.writes) {
            write.confirmation.batchId = batch.id;
            if (write.operationRun.discriminator) write.operationRun.discriminator.batchId = batch.id;
          }
        }

        return { state, events, items, ...(batchId ? { batchId } : {}) };
      })();
    },
  };
}
