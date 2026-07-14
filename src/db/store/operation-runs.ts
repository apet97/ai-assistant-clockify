import { randomUUID } from "node:crypto";
import type {
  OperationRun,
  OperationRunStatus,
  OperationStep,
  PrepareCompensationStepInput,
  PrepareOperationRunInput,
  PrepareOperationStepInput,
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
  operation_json: string;
  reconciled_at: string | null;
  reconciliation_json: string | null;
  capability_hash: string | null;
  created_at: string;
  updated_at: string;
}

interface OperationStepRow {
  id: string;
  operation_id: string;
  step_index: number;
  plan_step_id: string;
  name: string;
  kind: OperationStep["kind"];
  status: OperationStep["status"];
  external_id: string | null;
  target_fingerprint: string | null;
  effect_json: string | null;
  detail_json: string | null;
  dispatched_at: string | null;
  settled_at: string | null;
  compensates_step_id: string | null;
  created_at: string;
  updated_at: string;
}

function toRun(row: OperationRunRow): OperationRun {
  const persisted = JSON.parse(row.operation_json) as {
    operation?: unknown;
    mutationPlan?: PrepareOperationRunInput["mutationPlan"];
  };
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
    ...(Object.hasOwn(persisted, "operation") ? { operation: persisted.operation } : {}),
    ...(persisted.mutationPlan ? { mutationPlan: persisted.mutationPlan } : {}),
    ...(row.capability_hash ? { capabilityHash: row.capability_hash } : {}),
    status: row.status,
    ...(row.action_result_id ? { actionResultId: row.action_result_id } : {}),
    ...(row.reconciled_at ? { reconciledAt: row.reconciled_at } : {}),
    ...(row.reconciliation_json ? { reconciliation: JSON.parse(row.reconciliation_json) } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toStep(row: OperationStepRow): OperationStep {
  return {
    id: row.id,
    operationId: row.operation_id,
    planStepId: row.plan_step_id,
    index: row.step_index,
    name: row.name,
    kind: row.kind,
    status: row.status,
    ...(row.target_fingerprint ? { targetFingerprint: row.target_fingerprint } : {}),
    ...(row.compensates_step_id ? { compensatesStepId: row.compensates_step_id } : {}),
    ...(row.external_id ? { externalId: row.external_id } : {}),
    ...(row.effect_json ? { effect: JSON.parse(row.effect_json) } : {}),
    ...(row.detail_json ? { detail: JSON.parse(row.detail_json) } : {}),
    ...(row.dispatched_at ? { dispatchedAt: row.dispatched_at } : {}),
    ...(row.settled_at ? { settledAt: row.settled_at } : {}),
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
  recordOperationReconciliation(id: string, result: unknown, authoritative: boolean): void;
  prepareOperationStep(input: PrepareOperationStepInput): string;
  markOperationStepExecuting(id: string, operationId?: string): boolean;
  settleOperationStep(
    id: string,
    status: "succeeded" | "definitive_failed" | "outcome_unknown",
    detail?: { externalId?: string; effect?: unknown; detail?: unknown },
    operationId?: string,
  ): void;
  prepareCompensationStep(input: PrepareCompensationStepInput): string;
  markOperationStepCompensating(id: string, operationId?: string): boolean;
  settleCompensationStep(
    id: string,
    status: "compensated" | "compensation_failed" | "outcome_unknown",
    detail?: { externalId?: string; effect?: unknown; detail?: unknown },
    operationId?: string,
  ): void;
  listOperationSteps(operationId: string): OperationStep[];
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
           action_name, action_fingerprint, catalog_hash, operation_hash,
           operation_json, capability_hash, status, action_result_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', NULL, ?, ?)`,
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
        actionResultJson({
          ...(input.operation !== undefined ? { operation: input.operation } : {}),
          ...(input.mutationPlan ? { mutationPlan: input.mutationPlan } : {}),
        }),
        input.capabilityHash ?? null,
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
    recordOperationReconciliation(id, result, authoritative) {
      const updated = db.prepare(
        `UPDATE operation_runs
            SET reconciled_at = ?, reconciliation_json = ?, updated_at = ?
          WHERE id = ?`,
      ).run(nowIso(), actionResultJson({ authoritative, result }), nowIso(), id);
      if (updated.changes !== 1) throw new Error("operation_not_found");
    },
    prepareOperationStep(input) {
      if (input.kind !== "primary") throw new Error("compensation_requires_eligibility");
      const id = input.id ?? randomUUID();
      const timestamp = nowIso();
      db.prepare(
        `INSERT INTO operation_steps (
           id, operation_id, step_index, plan_step_id, name, kind, status,
           target_fingerprint, compensates_step_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?)`,
      ).run(
        id,
        input.operationId,
        input.index,
        input.planStepId,
        input.name,
        input.kind,
        input.targetFingerprint ?? null,
        input.compensatesStepId ?? null,
        timestamp,
        timestamp,
      );
      return id;
    },
    markOperationStepExecuting(id, operationId) {
      const timestamp = nowIso();
      return db.prepare(
        `UPDATE operation_steps
            SET status = 'executing', dispatched_at = ?, updated_at = ?
          WHERE id = ? AND (? IS NULL OR operation_id = ?) AND status = 'prepared'
            AND kind = 'primary'
            AND EXISTS (
              SELECT 1 FROM operation_runs
               WHERE operation_runs.id = operation_steps.operation_id
                 AND operation_runs.status = 'executing'
            )`,
      ).run(timestamp, timestamp, id, operationId ?? null, operationId ?? null).changes === 1;
    },
    settleOperationStep(id, status, detail = {}, operationId) {
      const timestamp = nowIso();
      const updated = db.prepare(
        `UPDATE operation_steps
            SET status = ?, external_id = ?, effect_json = ?, detail_json = ?,
                settled_at = ?, updated_at = ?
          WHERE id = ? AND (? IS NULL OR operation_id = ?)
            AND status = 'executing' AND kind = 'primary'`,
      ).run(
        status,
        detail.externalId ?? null,
        detail.effect === undefined ? null : actionResultJson(detail.effect),
        detail.detail === undefined ? null : actionResultJson(detail.detail),
        timestamp,
        timestamp,
        id,
        operationId ?? null,
        operationId ?? null,
      );
      if (updated.changes !== 1) throw new Error("operation_step_not_executing");
    },
    prepareCompensationStep(input) {
      return db.transaction((): string => {
        const source = db.prepare(
          `SELECT s.status AS step_status, s.operation_id, o.status AS operation_status,
                  o.reconciliation_json
             FROM operation_steps s
             JOIN operation_runs o ON o.id = s.operation_id
            WHERE s.id = ? AND s.operation_id = ? AND s.kind = 'primary'`,
        ).get(input.compensatesStepId, input.operationId) as {
          step_status: OperationStep["status"];
          operation_status: OperationRunStatus;
          reconciliation_json: string | null;
        } | undefined;
        const reconciliation = source?.reconciliation_json
          ? JSON.parse(source.reconciliation_json) as { authoritative?: unknown }
          : undefined;
        const eligible = source?.step_status === "succeeded" && (
          source.operation_status === "definitive_failed" || reconciliation?.authoritative === true
        );
        if (!eligible) throw new Error("compensation_not_eligible");
        const id = input.id ?? randomUUID();
        const timestamp = nowIso();
        db.prepare(
          `INSERT INTO operation_steps (
             id, operation_id, step_index, plan_step_id, name, kind, status,
             target_fingerprint, compensates_step_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'compensation', 'prepared', ?, ?, ?, ?)`,
        ).run(
          id,
          input.operationId,
          input.index,
          input.planStepId,
          input.name,
          input.targetFingerprint ?? null,
          input.compensatesStepId,
          timestamp,
          timestamp,
        );
        return id;
      })();
    },
    markOperationStepCompensating(id, operationId) {
      return db.transaction((): boolean => {
        const row = db.prepare(
          `SELECT compensates_step_id
             FROM operation_steps
            WHERE id = ? AND (? IS NULL OR operation_id = ?)
              AND status = 'prepared' AND kind = 'compensation'`,
        ).get(id, operationId ?? null, operationId ?? null) as { compensates_step_id: string | null } | undefined;
        if (!row?.compensates_step_id) return false;
        const timestamp = nowIso();
        const compensation = db.prepare(
          `UPDATE operation_steps
              SET status = 'executing', dispatched_at = ?, updated_at = ?
            WHERE id = ? AND status = 'prepared' AND kind = 'compensation'`,
        ).run(timestamp, timestamp, id);
        const source = db.prepare(
          `UPDATE operation_steps
              SET status = 'compensating', updated_at = ?
            WHERE id = ? AND status = 'succeeded' AND kind = 'primary'`,
        ).run(timestamp, row.compensates_step_id);
        if (compensation.changes !== 1 || source.changes !== 1) {
          throw new Error("compensation_step_not_prepared");
        }
        return true;
      })();
    },
    settleCompensationStep(id, status, detail, operationId) {
      db.transaction(() => {
        const timestamp = nowIso();
        const row = db.prepare(
          `SELECT compensates_step_id FROM operation_steps
            WHERE id = ? AND (? IS NULL OR operation_id = ?)
              AND status = 'executing' AND kind = 'compensation'`,
        ).get(id, operationId ?? null, operationId ?? null) as { compensates_step_id: string | null } | undefined;
        if (!row?.compensates_step_id) throw new Error("compensation_step_not_executing");
        const updated = db.prepare(
          `UPDATE operation_steps
              SET status = ?, external_id = ?, effect_json = ?, detail_json = ?,
                  settled_at = ?, updated_at = ?
            WHERE id = ? AND status = 'executing' AND kind = 'compensation'`,
        ).run(
          status,
          detail?.externalId ?? null,
          detail?.effect === undefined ? null : actionResultJson(detail.effect),
          detail?.detail === undefined ? null : actionResultJson(detail.detail),
          timestamp,
          timestamp,
          id,
        );
        if (updated.changes !== 1) throw new Error("compensation_step_not_executing");
        // The primary effect was known to have succeeded before compensation.
        // A definitive/ambiguous compensation failure does not erase that truth;
        // only an authoritative successful compensation changes the source state.
        const sourceStatus = status === "compensated" ? "compensated" : "succeeded";
        const source = db.prepare(
          `UPDATE operation_steps
              SET status = ?, settled_at = CASE WHEN ? = 'compensated' THEN ? ELSE settled_at END,
                  updated_at = ?
            WHERE id = ? AND status = 'compensating'`,
        ).run(sourceStatus, status, timestamp, timestamp, row.compensates_step_id);
        if (source.changes !== 1) throw new Error("compensation_source_not_executing");
      })();
    },
    listOperationSteps(operationId) {
      const rows = db.prepare(
        "SELECT * FROM operation_steps WHERE operation_id = ? ORDER BY step_index, rowid",
      ).all(operationId) as OperationStepRow[];
      return rows.map(toStep);
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
