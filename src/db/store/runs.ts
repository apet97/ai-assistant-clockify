import type {
  CompletedToolResult,
  RunBudget,
  RunContinuation,
  RunPhase,
  RunState,
  UnfinishedOperation,
} from "../../assistant-v2/state.js";
import type { AuthClass } from "../../harness/api-operation.js";
import type { StoreContext } from "./context.js";

export interface AssistantRunScope {
  sessionId: string;
  runId: string;
  workspaceId: string;
  adminUserId: string;
  installationGeneration: number;
  authClass: AuthClass;
}

export interface StartAssistantRunInput {
  scope: AssistantRunScope;
  originalRequest: string;
  requestHash: string;
  catalogHash: string;
  loadedToolNames: string[];
  intentHash: string;
  /** The claimed HTTP request id that initiated this run. The `initial`
   * request link binds it to the freshly minted run id; absent (direct
   * invocations without a claimed turn) the link stays self-referential. */
  requestId?: string;
}

interface AssistantRunRow {
  session_id: string;
  run_id: string;
  workspace_id: string;
  admin_user_id: string;
  installation_generation: number;
  auth_class: AuthClass;
  original_request: string;
  request_hash: string;
  phase: RunPhase;
  registry_id: string;
  catalog_hash: string;
  loaded_tool_names_json: string;
  used_tool_names_json: string;
  continuation_json: string;
  budget_json: string;
  unfinished_operations_json: string;
  created_at: string;
  updated_at: string;
}

function parseJsonArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error("Invalid string array JSON in assistant run row");
  }
  return parsed;
}

function toRunState(row: AssistantRunRow, completedResults: CompletedToolResult[], pendingOperationIds: string[]): RunState {
  return {
    version: 2,
    runId: row.run_id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    adminUserId: row.admin_user_id,
    installationGeneration: row.installation_generation,
    authClass: row.auth_class,
    originalRequest: row.original_request,
    requestHash: row.request_hash,
    phase: row.phase,
    registryId: "v2-api",
    catalogHash: row.catalog_hash,
    loadedToolNames: parseJsonArray(row.loaded_tool_names_json),
    usedToolNames: parseJsonArray(row.used_tool_names_json),
    completedResults,
    pendingOperationIds,
    unfinishedOperations: JSON.parse(row.unfinished_operations_json) as UnfinishedOperation[],
    continuation: JSON.parse(row.continuation_json) as RunContinuation,
    budget: JSON.parse(row.budget_json) as RunBudget,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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

export function buildAssistantRunStore(ctx: StoreContext): {
  startRunWithTurn(input: StartAssistantRunInput): void;
  getRun(scope: AssistantRunScope): RunState | undefined;
  saveRun(state: RunState): void;
  findLatestEligibleRunForCache(
    sessionId: string,
    workspaceId: string,
    adminUserId: string,
    installationGeneration: number,
    authClass: AuthClass,
    catalogHash: string,
  ): RunState | undefined;
  recoverOrphanedActiveRuns(scope: Omit<AssistantRunScope, "runId">): number;
  failActiveRunsForSession(sessionId: string, workspaceId: string, adminUserId: string, code: string): number;
} {
  const { db, nowIso } = ctx;

  const loadCompletedResults = (
    sessionId: string,
    runId: string,
  ): CompletedToolResult[] => {
    const rows = db.prepare(
      `SELECT tool_call_id, action_name, action_result_id
         FROM assistant_run_result_links
        WHERE session_id = ? AND run_id = ?
        ORDER BY sequence ASC`,
    ).all(sessionId, runId) as Array<{ tool_call_id: string; action_name: string; action_result_id: string }>;
    return rows.map((row) => ({
      toolCallId: row.tool_call_id,
      actionName: row.action_name,
      actionResultId: row.action_result_id,
    }));
  };

  const getRunRow = (scope: AssistantRunScope): RunState | undefined => {
    const where = scopeWhere(scope);
    const row = db.prepare(
      `SELECT * FROM assistant_runs WHERE ${where.sql}`,
    ).get(...where.params) as AssistantRunRow | undefined;
    if (!row) return undefined;
    const continuation = JSON.parse(row.continuation_json) as RunContinuation;
    const pendingOperationIds = continuation.kind === "awaiting_operations"
      ? continuation.operationIds
      : [];
    return toRunState(row, loadCompletedResults(scope.sessionId, scope.runId), pendingOperationIds);
  };

  const startRunWithTurn = db.transaction((input: StartAssistantRunInput): void => {
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
    const emptyBudget: RunBudget = {
      modelCallsUsed: 0,
      discoveryCallsUsed: 0,
      apiCallsUsed: 0,
      hostCallsUsed: 0,
      hostCallsReserved: 0,
      promptTokensUsed: 0,
      completionTokensUsed: 0,
      estimatedTokensUsed: 0,
      activeWallMsUsed: 0,
    };
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
  });

  return {
    startRunWithTurn,
    getRun: getRunRow,
    saveRun(state) {
      const scope: AssistantRunScope = {
        sessionId: state.sessionId,
        runId: state.runId,
        workspaceId: state.workspaceId,
        adminUserId: state.adminUserId,
        installationGeneration: state.installationGeneration,
        authClass: state.authClass,
      };
      const where = scopeWhere(scope);
      db.transaction(() => {
        // Closure-plan PR 6 (F04): the durable ledger owns `hostCallsUsed`;
        // a stale in-memory budget must never clobber it.
        const currentRow = db.prepare(
          `SELECT budget_json FROM assistant_runs WHERE ${where.sql}`,
        ).get(...where.params) as { budget_json: string } | undefined;
        const ledgerUsed = currentRow
          ? (JSON.parse(currentRow.budget_json) as RunBudget).hostCallsUsed
          : state.budget.hostCallsUsed;
        db.prepare(
          `UPDATE assistant_runs SET
             phase = ?, catalog_hash = ?, loaded_tool_names_json = ?, used_tool_names_json = ?,
             continuation_json = ?, budget_json = ?, unfinished_operations_json = ?, updated_at = ?
           WHERE ${where.sql}`,
        ).run(
          state.phase,
          state.catalogHash,
          JSON.stringify(state.loadedToolNames),
          JSON.stringify(state.usedToolNames),
          JSON.stringify(state.continuation),
          JSON.stringify({ ...state.budget, hostCallsUsed: ledgerUsed }),
          JSON.stringify(state.unfinishedOperations),
          nowIso(),
          ...where.params,
        );
        for (const [index, result] of state.completedResults.entries()) {
          db.prepare(
            `INSERT INTO assistant_run_result_links (
               session_id, run_id, sequence, workspace_id, admin_user_id,
               tool_call_id, action_name, action_result_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(session_id, run_id, tool_call_id) DO NOTHING`,
          ).run(
            state.sessionId,
            state.runId,
            index + 1,
            state.workspaceId,
            state.adminUserId,
            result.toolCallId,
            result.actionName,
            result.actionResultId,
          );
        }
      })();
    },
    findLatestEligibleRunForCache(sessionId, workspaceId, adminUserId, installationGeneration, authClass, catalogHash) {
      const row = db.prepare(
        `SELECT * FROM assistant_runs
          WHERE session_id = ? AND workspace_id = ? AND admin_user_id = ?
            AND installation_generation = ? AND auth_class = ?
            AND registry_id = 'v2-api' AND catalog_hash = ?
          ORDER BY updated_at DESC LIMIT 1`,
      ).get(sessionId, workspaceId, adminUserId, installationGeneration, authClass, catalogHash) as AssistantRunRow | undefined;
      if (!row) return undefined;
      const scope: AssistantRunScope = {
        sessionId,
        runId: row.run_id,
        workspaceId,
        adminUserId,
        installationGeneration,
        authClass,
      };
      return getRunRow(scope);
    },
    recoverOrphanedActiveRuns(scope) {
      const rows = db.prepare(
        `SELECT run_id FROM assistant_runs
          WHERE session_id = ? AND workspace_id = ? AND admin_user_id = ?
            AND installation_generation = ? AND auth_class = ?
            AND phase IN ('model', 'discovering', 'executing_reads', 'preparing_writes')`,
      ).all(scope.sessionId, scope.workspaceId, scope.adminUserId, scope.installationGeneration, scope.authClass) as Array<{ run_id: string }>;
      let count = 0;
      for (const row of rows) {
        db.prepare(
          `UPDATE assistant_runs SET phase = 'failed', updated_at = ?
           WHERE session_id = ? AND run_id = ? AND workspace_id = ? AND admin_user_id = ?`,
        ).run(nowIso(), scope.sessionId, row.run_id, scope.workspaceId, scope.adminUserId);
        db.prepare(
          `UPDATE turn_runs SET status = 'failed', updated_at = ?
           WHERE session_id = ? AND request_id = ?`,
        ).run(nowIso(), scope.sessionId, row.run_id);
        count += 1;
      }
      return count;
    },
    failActiveRunsForSession(sessionId, workspaceId, adminUserId, code) {
      void code;
      return db.prepare(
        `UPDATE assistant_runs SET phase = 'failed', updated_at = ?
         WHERE session_id = ? AND workspace_id = ? AND admin_user_id = ?
           AND phase NOT IN ('completed', 'failed')`,
      ).run(nowIso(), sessionId, workspaceId, adminUserId).changes;
    },
  };
}

export type AssistantRunStore = ReturnType<typeof buildAssistantRunStore>;
