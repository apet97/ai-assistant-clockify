import { randomUUID } from "node:crypto";
import type {
  OperationRun,
  OperationRunStatus,
  PrepareOperationRunInput,
  StoreContext,
} from "./context.js";
import {
  actionResultJson,
  buildActionResultSummary,
  type ActionResultRef,
} from "../action-results.js";

interface OperationRunRow {
  id: string;
  request_id: string | null;
  confirmation_id: string | null;
  session_id: string;
  workspace_id: string;
  admin_user_id: string;
  action_name: string;
  action_fingerprint: string;
  catalog_hash: string;
  operation_hash: string;
  status: OperationRunStatus;
  action_result_id: string | null;
  created_at: string;
  updated_at: string;
}

function toRun(row: OperationRunRow): OperationRun {
  return {
    id: row.id,
    ...(row.request_id ? { requestId: row.request_id } : {}),
    ...(row.confirmation_id ? { confirmationId: row.confirmation_id } : {}),
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    adminUserId: row.admin_user_id,
    actionName: row.action_name,
    actionFingerprint: row.action_fingerprint,
    catalogHash: row.catalog_hash,
    operationHash: row.operation_hash,
    status: row.status,
    ...(row.action_result_id ? { actionResultId: row.action_result_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function buildOperationRunStore(ctx: StoreContext): {
  prepareOperationRun(input: PrepareOperationRunInput): string;
  markOperationExecuting(id: string): boolean;
  settleOperationRun(id: string, status: Exclude<OperationRunStatus, "prepared" | "executing">, actionResultId?: string): void;
  settleOperationResult(
    id: string,
    status: Exclude<OperationRunStatus, "prepared" | "executing">,
    result: unknown,
  ): ActionResultRef;
  getOperationRun(id: string): OperationRun | undefined;
  recordActionResult(input: {
    workspaceId: string;
    adminUserId: string;
    sessionId?: string;
    actionName: string;
    status: Exclude<OperationRunStatus, "prepared" | "executing">;
    result: unknown;
    operationId?: string;
  }): ActionResultRef;
} {
  const { db, nowIso } = ctx;
  return {
    prepareOperationRun(input) {
      const id = input.id ?? randomUUID();
      const timestamp = nowIso();
      db.prepare(
        `INSERT INTO operation_runs (
           id, request_id, confirmation_id, session_id, workspace_id, admin_user_id,
           action_name, action_fingerprint, catalog_hash, operation_hash, status,
           action_result_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', NULL, ?, ?)`,
      ).run(
        id,
        input.requestId ?? null,
        input.confirmationId ?? null,
        input.sessionId,
        input.workspaceId,
        input.adminUserId,
        input.actionName,
        input.actionFingerprint,
        input.catalogHash,
        input.operationHash,
        timestamp,
        timestamp,
      );
      return id;
    },
    markOperationExecuting(id) {
      return db.prepare(
        "UPDATE operation_runs SET status = 'executing', updated_at = ? WHERE id = ? AND status = 'prepared'",
      ).run(nowIso(), id).changes === 1;
    },
    settleOperationRun(id, status, actionResultId) {
      db.prepare(
        "UPDATE operation_runs SET status = ?, action_result_id = ?, updated_at = ? WHERE id = ?",
      ).run(status, actionResultId ?? null, nowIso(), id);
    },
    settleOperationResult(id, status, result) {
      return db.transaction((): ActionResultRef => {
        const operation = db.prepare(
          `SELECT session_id, workspace_id, admin_user_id, action_name, status, action_result_id
             FROM operation_runs WHERE id = ?`,
        ).get(id) as {
          session_id: string;
          workspace_id: string;
          admin_user_id: string;
          action_name: string;
          status: OperationRunStatus;
          action_result_id: string | null;
        } | undefined;
        if (!operation) throw new Error("operation_not_found");
        if (operation.action_result_id) {
          const existing = db.prepare(
            "SELECT kind, summary_json FROM action_results WHERE id = ?",
          ).get(operation.action_result_id) as { kind: ActionResultRef["kind"]; summary_json: string } | undefined;
          if (!existing) throw new Error("operation_result_not_found");
          return { id: operation.action_result_id, kind: existing.kind, summary: JSON.parse(existing.summary_json) };
        }
        if (operation.status !== "executing") throw new Error("operation_not_executing");
        const actionResultId = randomUUID();
        const summary = buildActionResultSummary(actionResultId, result);
        db.prepare(
          `INSERT INTO action_results (
             id, operation_id, workspace_id, admin_user_id, session_id, action_name, kind,
             result_json, summary_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          actionResultId,
          id,
          operation.workspace_id,
          operation.admin_user_id,
          operation.session_id,
          operation.action_name,
          status,
          actionResultJson(result),
          actionResultJson(summary),
          nowIso(),
        );
        const update = db.prepare(
          `UPDATE operation_runs SET status = ?, action_result_id = ?, updated_at = ?
            WHERE id = ? AND status = 'executing' AND action_result_id IS NULL`,
        ).run(status, actionResultId, nowIso(), id);
        if (update.changes !== 1) throw new Error("operation_not_executing");
        return { id: actionResultId, kind: status, summary };
      })();
    },
    getOperationRun(id) {
      const row = db.prepare("SELECT * FROM operation_runs WHERE id = ?").get(id) as OperationRunRow | undefined;
      return row ? toRun(row) : undefined;
    },
    recordActionResult(input) {
      const id = randomUUID();
      const resultJson = actionResultJson(input.result);
      const summary = buildActionResultSummary(id, input.result);
      db.prepare(
        `INSERT INTO action_results (
           id, operation_id, workspace_id, admin_user_id, session_id, action_name, kind,
           result_json, summary_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.operationId ?? null,
        input.workspaceId,
        input.adminUserId,
        input.sessionId ?? null,
        input.actionName,
        input.status,
        resultJson,
        actionResultJson(summary),
        nowIso(),
      );
      return { id, kind: input.status, summary };
    },
  };
}
