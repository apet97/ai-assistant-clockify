import type {
  RunEventPayloadMap,
  RunEventType,
  RunEventView,
  SequencedRunEvent,
} from "../../assistant-v2/events.js";
import {
  encodeRunEventPayload,
  parseRunEventPayload,
} from "../../assistant-v2/events.js";
import type {
  CompletedToolResult,
  RunBudget,
  RunContinuation,
  RunPhase,
  RunState,
  UnfinishedOperation,
} from "../../assistant-v2/state.js";
import { createEmptyRunBudget } from "../../assistant-v2/state.js";
import type { StoreContext } from "./context.js";
import type { AssistantRunScope, StartAssistantRunInput } from "./runs.js";

interface RunEventRow {
  session_id: string;
  run_id: string;
  sequence: number;
  workspace_id: string;
  admin_user_id: string;
  event_type: RunEventType;
  payload_json: string;
  created_at: string;
}

export interface ListRunEventsStoreInput {
  scope: AssistantRunScope;
  after: number;
  limit: number;
}

export interface RunEventPageStoreResult {
  runId: string;
  events: SequencedRunEvent[];
  nextAfter: number;
  hasMore: boolean;
  lastSequence: number;
}

function scopeWhere(scope: AssistantRunScope): { sql: string; params: unknown[] } {
  return {
    sql: `session_id = ? AND run_id = ? AND workspace_id = ? AND admin_user_id = ?
          AND installation_generation = ? AND auth_class = ?`,
    params: [
      scope.sessionId,
      scope.runId,
      scope.workspaceId,
      scope.adminUserId,
      scope.installationGeneration,
      scope.authClass,
    ],
  };
}

function rowToSequencedEvent(row: RunEventRow): SequencedRunEvent {
  const payload = parseRunEventPayload(row.event_type, JSON.parse(row.payload_json));
  const event = {
    eventType: row.event_type,
    payload,
    createdAt: row.created_at,
  } as RunEventView;
  return {
    runId: row.run_id,
    sequence: row.sequence,
    event,
  };
}

function allocateAndInsertEvent(
  db: StoreContext["db"],
  scope: AssistantRunScope,
  eventType: RunEventType,
  payload: RunEventPayloadMap[RunEventType],
  timestamp: string,
): { sequence: number; event: SequencedRunEvent } {
  const nextRow = db.prepare(
    `SELECT COALESCE(MAX(sequence), 0) + 1 AS next
       FROM run_events
      WHERE session_id = ? AND run_id = ?`,
  ).get(scope.sessionId, scope.runId) as { next: number };
  const sequence = nextRow.next;
  const payloadJson = encodeRunEventPayload(eventType, payload);
  db.prepare(
    `INSERT INTO run_events (
       session_id, run_id, sequence, workspace_id, admin_user_id,
       event_type, payload_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    scope.sessionId,
    scope.runId,
    sequence,
    scope.workspaceId,
    scope.adminUserId,
    eventType,
    payloadJson,
    timestamp,
  );
  return {
    sequence,
    event: {
      runId: scope.runId,
      sequence,
      event: {
        eventType,
        payload,
        createdAt: timestamp,
      } as RunEventView,
    },
  };
}

function updateRunState(
  db: StoreContext["db"],
  scope: AssistantRunScope,
  patch: {
    phase?: RunPhase;
    catalogHash?: string;
    loadedToolNames?: string[];
    usedToolNames?: string[];
    continuation?: RunContinuation;
    budget?: RunBudget;
    unfinishedOperations?: UnfinishedOperation[];
    completedResults?: CompletedToolResult[];
  },
  timestamp: string,
): void {
  const where = scopeWhere(scope);
  const current = db.prepare(
    `SELECT * FROM assistant_runs WHERE ${where.sql}`,
  ).get(...where.params) as {
    catalog_hash: string;
    loaded_tool_names_json: string;
    used_tool_names_json: string;
    continuation_json: string;
    budget_json: string;
    unfinished_operations_json: string;
    phase: RunPhase;
  } | undefined;
  if (!current) throw new Error("assistant_run_not_found");
  db.prepare(
    `UPDATE assistant_runs SET
       phase = ?, catalog_hash = ?, loaded_tool_names_json = ?, used_tool_names_json = ?,
       continuation_json = ?, budget_json = ?, unfinished_operations_json = ?, updated_at = ?
     WHERE ${where.sql}`,
  ).run(
    patch.phase ?? current.phase,
    patch.catalogHash ?? current.catalog_hash,
    JSON.stringify(patch.loadedToolNames ?? JSON.parse(current.loaded_tool_names_json)),
    JSON.stringify(patch.usedToolNames ?? JSON.parse(current.used_tool_names_json)),
    JSON.stringify(patch.continuation ?? JSON.parse(current.continuation_json)),
    JSON.stringify(patch.budget ?? JSON.parse(current.budget_json)),
    JSON.stringify(patch.unfinishedOperations ?? JSON.parse(current.unfinished_operations_json)),
    timestamp,
    ...where.params,
  );
  if (patch.completedResults) {
    for (const [index, result] of patch.completedResults.entries()) {
      db.prepare(
        `INSERT INTO assistant_run_result_links (
           session_id, run_id, sequence, workspace_id, admin_user_id,
           tool_call_id, action_name, action_result_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, run_id, tool_call_id) DO NOTHING`,
      ).run(
        scope.sessionId,
        scope.runId,
        index + 1,
        scope.workspaceId,
        scope.adminUserId,
        result.toolCallId,
        result.actionName,
        result.actionResultId,
      );
    }
  }
}

export function buildRunEventStore(ctx: StoreContext) {
  const { db, nowIso } = ctx;

  const getLastSequence = (scope: Pick<AssistantRunScope, "sessionId" | "runId" | "workspaceId" | "adminUserId">): number => {
    const row = db.prepare(
      `SELECT COALESCE(MAX(sequence), 0) AS last
         FROM run_events
        WHERE session_id = ? AND run_id = ? AND workspace_id = ? AND admin_user_id = ?`,
    ).get(scope.sessionId, scope.runId, scope.workspaceId, scope.adminUserId) as { last: number };
    return row.last;
  };

  const listEvents = (input: ListRunEventsStoreInput): RunEventPageStoreResult => {
    const { scope, after, limit } = input;
    const exists = db.prepare(
      `SELECT 1 FROM assistant_runs WHERE ${scopeWhere(scope).sql}`,
    ).get(...scopeWhere(scope).params);
    if (!exists) {
      throw new Error("run_not_found");
    }
    const lastSequence = getLastSequence(scope);
    const rows = db.prepare(
      `SELECT * FROM run_events
        WHERE session_id = ? AND run_id = ? AND workspace_id = ? AND admin_user_id = ?
          AND sequence > ?
        ORDER BY sequence ASC
        LIMIT ?`,
    ).all(scope.sessionId, scope.runId, scope.workspaceId, scope.adminUserId, after, limit + 1) as RunEventRow[];
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const events = pageRows.map(rowToSequencedEvent);
    const nextAfter = events.length > 0 ? events[events.length - 1]!.sequence : after;
    return {
      runId: scope.runId,
      events,
      nextAfter,
      hasMore,
      lastSequence,
    };
  };

  const startRunWithEvent = db.transaction((input: StartAssistantRunInput): SequencedRunEvent => {
    const timestamp = nowIso();
    const { scope } = input;
    db.prepare(
      `INSERT INTO turn_runs (
         request_id, session_id, workspace_id, admin_user_id, intent_hash, status,
         response_envelope_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'prepared', NULL, ?, ?)`,
    ).run(
      scope.runId,
      scope.sessionId,
      scope.workspaceId,
      scope.adminUserId,
      input.intentHash,
      timestamp,
      timestamp,
    );
    const emptyBudget = createEmptyRunBudget();
    db.prepare(
      `INSERT INTO assistant_runs (
         session_id, run_id, workspace_id, admin_user_id, installation_generation, auth_class,
         original_request, request_hash, phase, registry_id, catalog_hash,
         loaded_tool_names_json, used_tool_names_json, continuation_json, budget_json,
         unfinished_operations_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'model', 'v2-api', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      scope.sessionId,
      scope.runId,
      scope.workspaceId,
      scope.adminUserId,
      scope.installationGeneration,
      scope.authClass,
      input.originalRequest,
      input.requestHash,
      input.catalogHash,
      JSON.stringify(input.loadedToolNames),
      JSON.stringify([]),
      JSON.stringify({ kind: "none" }),
      JSON.stringify(emptyBudget),
      JSON.stringify([]),
      timestamp,
      timestamp,
    );
    db.prepare(
      `INSERT INTO assistant_run_request_links (
         session_id, request_id, run_id, workspace_id, admin_user_id, kind, created_at
       ) VALUES (?, ?, ?, ?, ?, 'initial', ?)`,
    ).run(
      scope.sessionId,
      scope.runId,
      scope.runId,
      scope.workspaceId,
      scope.adminUserId,
      timestamp,
    );
    return allocateAndInsertEvent(db, scope, "run.started", { requestHash: input.requestHash }, timestamp).event;
  });

  type EventCommand<K extends RunEventType> = {
    scope: AssistantRunScope;
    state: RunState;
    payload: RunEventPayloadMap[K];
    eventType: K;
    phase?: RunPhase;
  };

  const commitStateEvent = db.transaction(<K extends RunEventType>(command: EventCommand<K>): SequencedRunEvent => {
    const timestamp = nowIso();
    updateRunState(db, command.scope, {
      phase: command.phase ?? command.state.phase,
      catalogHash: command.state.catalogHash,
      loadedToolNames: command.state.loadedToolNames,
      usedToolNames: command.state.usedToolNames,
      continuation: command.state.continuation,
      budget: command.state.budget,
      unfinishedOperations: command.state.unfinishedOperations,
      completedResults: command.state.completedResults,
    }, timestamp);
    return allocateAndInsertEvent(db, command.scope, command.eventType, command.payload, timestamp).event;
  });

  /**
   * T17-E: a bounded, workspace+admin-scoped run-event feed for metrics. This
   * returns rows ONLY — every formula lives in `src/metrics/run-metrics.ts`.
   */
  const listEventsForMetrics = (input: {
    workspaceId: string;
    adminUserId: string;
    since: string;
    limit: number;
  }): Array<{
    sessionId: string;
    runId: string;
    sequence: number;
    eventType: RunEventType;
    payload: RunEventPayloadMap[RunEventType];
    createdAt: string;
  }> => {
    const rows = db.prepare(
      `SELECT session_id, run_id, sequence, event_type, payload_json, created_at
         FROM run_events
        WHERE workspace_id = ? AND admin_user_id = ? AND created_at >= ?
        ORDER BY created_at ASC, session_id ASC, run_id ASC, sequence ASC
        LIMIT ?`,
    ).all(input.workspaceId, input.adminUserId, input.since, input.limit) as Array<{
      session_id: string;
      run_id: string;
      sequence: number;
      event_type: RunEventType;
      payload_json: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      sessionId: row.session_id,
      runId: row.run_id,
      sequence: row.sequence,
      eventType: row.event_type,
      payload: parseRunEventPayload(row.event_type, JSON.parse(row.payload_json)),
      createdAt: row.created_at,
    }));
  };

  return {
    listEvents,
    listEventsForMetrics,
    getLastRunEventSequence(scope: Pick<AssistantRunScope, "sessionId" | "runId" | "workspaceId" | "adminUserId">): number {
      return getLastSequence(scope);
    },
    startRunWithEvent,
    reserveModelCallWithEvent(
      scope: AssistantRunScope,
      state: RunState,
      payload: RunEventPayloadMap["model.started"],
    ): SequencedRunEvent {
      const budget = payload.providerAttempt === 1
        ? { ...state.budget, modelCallsUsed: state.budget.modelCallsUsed + 1 }
        : state.budget;
      return commitStateEvent({
        scope,
        state: { ...state, budget, phase: "model" },
        payload,
        eventType: "model.started",
        phase: "model",
      });
    },
    completeModelCallWithEvent(
      scope: AssistantRunScope,
      state: RunState,
      payload: RunEventPayloadMap["model.completed"],
    ): SequencedRunEvent {
      return commitStateEvent({ scope, state, payload, eventType: "model.completed" });
    },
    reserveDiscoveryCallWithEvent(
      scope: AssistantRunScope,
      state: RunState,
      payload: RunEventPayloadMap["api.search_started"],
    ): SequencedRunEvent {
      const budget = { ...state.budget, discoveryCallsUsed: state.budget.discoveryCallsUsed + 1 };
      return commitStateEvent({
        scope,
        state: { ...state, budget, phase: "discovering" },
        payload,
        eventType: "api.search_started",
        phase: "discovering",
      });
    },
    loadOperationsWithEvent(
      scope: AssistantRunScope,
      state: RunState,
      payload: RunEventPayloadMap["api.operations_loaded"],
    ): SequencedRunEvent {
      return commitStateEvent({ scope, state, payload, eventType: "api.operations_loaded" });
    },
    requestToolWithEvent(
      scope: AssistantRunScope,
      state: RunState,
      payload: RunEventPayloadMap["tool.requested"],
    ): SequencedRunEvent {
      return commitStateEvent({ scope, state, payload, eventType: "tool.requested" });
    },
    denyToolWithEvent(
      scope: AssistantRunScope,
      state: RunState,
      payload: RunEventPayloadMap["tool.denied"],
    ): SequencedRunEvent {
      return commitStateEvent({ scope, state, payload, eventType: "tool.denied" });
    },
    startToolWithEvent(
      scope: AssistantRunScope,
      state: RunState,
      payload: RunEventPayloadMap["tool.started"],
    ): SequencedRunEvent {
      const budget = { ...state.budget, apiCallsUsed: state.budget.apiCallsUsed + 1 };
      return commitStateEvent({
        scope,
        state: { ...state, budget, phase: "executing_reads" },
        payload,
        eventType: "tool.started",
        phase: "executing_reads",
      });
    },
    completeToolWithEvent(
      scope: AssistantRunScope,
      state: RunState,
      payload: RunEventPayloadMap["tool.completed"],
    ): SequencedRunEvent {
      const link = state.completedResults.find((r) => r.toolCallId === payload.toolCallId);
      const completedResults = link
        ? state.completedResults
        : [...state.completedResults, {
            toolCallId: payload.toolCallId,
            actionName: payload.actionName,
            actionResultId: payload.actionResultId,
          }];
      return commitStateEvent({
        scope,
        state: { ...state, completedResults },
        payload,
        eventType: "tool.completed",
      });
    },
    /** CP-A: journal that a read resolved to a durable clarification. This
     * carries NO phase change — `suspendRunWithEvent` still owns the single
     * `awaiting_clarification` transition, so the two can never disagree. */
    requireClarificationWithEvent(
      scope: AssistantRunScope,
      state: RunState,
      payload: RunEventPayloadMap["clarification.required"],
    ): SequencedRunEvent {
      return commitStateEvent({ scope, state, payload, eventType: "clarification.required" });
    },
    suspendRunWithEvent(
      scope: AssistantRunScope,
      state: RunState,
      payload: RunEventPayloadMap["run.suspended"],
    ): SequencedRunEvent {
      const phase = payload.reason === "awaiting_confirmation" ? "awaiting_confirmation" : "awaiting_clarification";
      return commitStateEvent({
        scope,
        state: { ...state, phase },
        payload,
        eventType: "run.suspended",
        phase,
      });
    },
    completeRunWithEvent(
      scope: AssistantRunScope,
      state: RunState,
      payload: RunEventPayloadMap["run.completed"],
    ): SequencedRunEvent {
      return commitStateEvent({
        scope,
        state: { ...state, phase: "completed" },
        payload,
        eventType: "run.completed",
        phase: "completed",
      });
    },
    failRunWithEvent(
      scope: AssistantRunScope,
      state: RunState,
      payload: RunEventPayloadMap["run.failed"],
    ): SequencedRunEvent {
      return commitStateEvent({
        scope,
        state: { ...state, phase: "failed" },
        payload,
        eventType: "run.failed",
        phase: "failed",
      });
    },
    getActiveRunForSession(
      sessionId: string,
      workspaceId: string,
      adminUserId: string,
    ): { runId: string; phase: RunPhase; lastSequence: number; updatedAt: string } | undefined {
      const rows = db.prepare(
        `SELECT run_id, phase, updated_at FROM assistant_runs
          WHERE session_id = ? AND workspace_id = ? AND admin_user_id = ?
            AND phase NOT IN ('completed', 'failed')`,
      ).all(sessionId, workspaceId, adminUserId) as Array<{ run_id: string; phase: RunPhase; updated_at: string }>;
      if (rows.length === 0) return undefined;
      if (rows.length > 1) throw new Error("active_run_integrity_violation");
      const row = rows[0]!;
      const lastSequence = getLastSequence({
        sessionId,
        runId: row.run_id,
        workspaceId,
        adminUserId,
      });
      return {
        runId: row.run_id,
        phase: row.phase,
        lastSequence,
        updatedAt: row.updated_at,
      };
    },
  };
}

export type RunEventStore = ReturnType<typeof buildRunEventStore>;
