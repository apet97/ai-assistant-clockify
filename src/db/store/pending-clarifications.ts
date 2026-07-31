import { randomUUID } from "node:crypto";
import type { StoreContext } from "./context.js";

/** A clarification is actionable for five minutes (canonical plan, Task 14). */
export const CLARIFICATION_TTL_MS = 5 * 60 * 1000;

export interface ClarificationScope {
  sessionId: string;
  runId: string;
  workspaceId: string;
  adminUserId: string;
}

export interface ClarificationCandidate {
  optionId: string;
  externalId: string;
  label: string;
}

export interface CreatePendingClarificationInput extends ClarificationScope {
  id?: string;
  originalToolName: string;
  partialArguments: unknown;
  missingField: string;
  candidates: readonly ClarificationCandidate[];
}

export type ClarificationStatus =
  | "pending"
  | "resolving"
  | "resolved"
  | "continued"
  | "expired"
  | "cancelled";

export type ClarificationTerminalReason =
  | "selected_option"
  | "free_text_continuation"
  | "expired"
  | "superseded"
  | "stale_replaced"
  | "user_cancelled";

export type ClarificationCancelReason = Extract<
  ClarificationTerminalReason,
  "superseded" | "stale_replaced" | "user_cancelled"
>;

export interface PendingClarificationRecord extends ClarificationScope {
  id: string;
  originalToolName: string;
  partialArguments: unknown;
  missingField: string;
  candidates: ClarificationCandidate[];
  status: ClarificationStatus;
  selectedOptionId?: string;
  terminalReason?: ClarificationTerminalReason;
  actionResultId?: string;
  operationId?: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

export class PendingClarificationStoreError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "PendingClarificationStoreError";
  }
}

function fail(code: string): never {
  throw new PendingClarificationStoreError(code);
}

interface ClarificationRow {
  id: string;
  session_id: string;
  run_id: string;
  workspace_id: string;
  admin_user_id: string;
  original_tool_name: string;
  partial_arguments_json: string;
  missing_field: string;
  candidates_json: string;
  status: ClarificationStatus;
  selected_option_id: string | null;
  terminal_reason: ClarificationTerminalReason | null;
  action_result_id: string | null;
  operation_id: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

function toRecord(row: ClarificationRow): PendingClarificationRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id,
    workspaceId: row.workspace_id,
    adminUserId: row.admin_user_id,
    originalToolName: row.original_tool_name,
    partialArguments: JSON.parse(row.partial_arguments_json) as unknown,
    missingField: row.missing_field,
    candidates: JSON.parse(row.candidates_json) as ClarificationCandidate[],
    status: row.status,
    selectedOptionId: row.selected_option_id ?? undefined,
    terminalReason: row.terminal_reason ?? undefined,
    actionResultId: row.action_result_id ?? undefined,
    operationId: row.operation_id ?? undefined,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at ?? undefined,
  };
}

function assertScope(row: ClarificationRow, scope: ClarificationScope): void {
  if (row.session_id !== scope.sessionId) fail("clarification_session_drift");
  if (row.run_id !== scope.runId) fail("clarification_run_drift");
  if (row.workspace_id !== scope.workspaceId) fail("clarification_workspace_drift");
  if (row.admin_user_id !== scope.adminUserId) fail("clarification_admin_drift");
}

/**
 * Durable state machine for exact-choice clarifications: `pending` (one active
 * per run, enforced by `idx_pending_clarifications_one_active_per_run`) ->
 * `resolving` (claimed for work) -> a single terminal status. The route/runner
 * layer (T14-D/E) owns actually executing the resolved read/write; this store
 * only owns the durable transitions and the terminal-JSON scrub the DB triggers
 * also enforce as a second layer.
 */
export function buildPendingClarificationStore(ctx: StoreContext): {
  createPendingClarification(input: CreatePendingClarificationInput): PendingClarificationRecord;
  getPendingClarification(id: string, scope: ClarificationScope): PendingClarificationRecord | undefined;
  getActiveClarificationForRun(
    scope: Pick<ClarificationScope, "sessionId" | "runId" | "workspaceId" | "adminUserId">,
  ): PendingClarificationRecord | undefined;
  claimClarificationResolving(id: string, scope: ClarificationScope): PendingClarificationRecord;
  resetClarificationToPending(id: string, scope: ClarificationScope): PendingClarificationRecord;
  resolveClarificationWithOption(input: {
    id: string;
    scope: ClarificationScope;
    selectedOptionId: string;
    actionResultId: string;
    operationId?: string;
  }): PendingClarificationRecord;
  cancelClarification(input: {
    id: string;
    scope: ClarificationScope;
    reason: ClarificationCancelReason;
  }): PendingClarificationRecord;
  continueClarificationWithFreeText(id: string, scope: ClarificationScope): PendingClarificationRecord;
} {
  const { db, nowIso } = ctx;

  const byId = (id: string): ClarificationRow | undefined => db.prepare(
    "SELECT * FROM pending_clarifications WHERE id = ?",
  ).get(id) as ClarificationRow | undefined;

  const scoped = (id: string, scope: ClarificationScope): ClarificationRow => {
    const row = byId(id);
    if (!row) return fail("clarification_not_found");
    assertScope(row, scope);
    return row;
  };

  return {
    createPendingClarification(input) {
      const id = input.id ?? randomUUID();
      const timestamp = nowIso();
      const expiresAt = new Date(Date.parse(timestamp) + CLARIFICATION_TTL_MS).toISOString();
      try {
        db.prepare(
          `INSERT INTO pending_clarifications (
             id, session_id, run_id, workspace_id, admin_user_id, original_tool_name,
             partial_arguments_json, missing_field, candidates_json, status,
             expires_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        ).run(
          id,
          input.sessionId,
          input.runId,
          input.workspaceId,
          input.adminUserId,
          input.originalToolName,
          JSON.stringify(input.partialArguments ?? {}),
          input.missingField,
          JSON.stringify(input.candidates),
          expiresAt,
          timestamp,
          timestamp,
        );
      } catch (error) {
        if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
          fail("clarification_already_active");
        }
        throw error;
      }
      return toRecord(byId(id)!);
    },

    getPendingClarification(id, scope) {
      const row = byId(id);
      if (!row) return undefined;
      assertScope(row, scope);
      return toRecord(row);
    },

    getActiveClarificationForRun(scope) {
      const row = db.prepare(
        `SELECT * FROM pending_clarifications
          WHERE session_id = ? AND run_id = ? AND workspace_id = ? AND admin_user_id = ?
            AND status IN ('pending', 'resolving')`,
      ).get(scope.sessionId, scope.runId, scope.workspaceId, scope.adminUserId) as ClarificationRow | undefined;
      return row ? toRecord(row) : undefined;
    },

    claimClarificationResolving(id, scope) {
      return db.transaction((): PendingClarificationRecord => {
        const row = scoped(id, scope);
        if (row.status !== "pending") fail("clarification_not_pending");
        if (Date.parse(row.expires_at) <= Date.parse(nowIso())) fail("clarification_expired");
        const timestamp = nowIso();
        const changes = db.prepare(
          `UPDATE pending_clarifications SET status = 'resolving', updated_at = ?
            WHERE id = ? AND status = 'pending'`,
        ).run(timestamp, id).changes;
        if (changes !== 1) fail("clarification_not_pending");
        return toRecord(byId(id)!);
      })();
    },

    resetClarificationToPending(id, scope) {
      return db.transaction((): PendingClarificationRecord => {
        const row = scoped(id, scope);
        if (row.status !== "resolving") fail("clarification_not_resolving");
        if (Date.parse(row.expires_at) <= Date.parse(nowIso())) fail("clarification_expired");
        const timestamp = nowIso();
        const changes = db.prepare(
          `UPDATE pending_clarifications SET status = 'pending', updated_at = ?
            WHERE id = ? AND status = 'resolving'`,
        ).run(timestamp, id).changes;
        if (changes !== 1) fail("clarification_not_resolving");
        return toRecord(byId(id)!);
      })();
    },

    resolveClarificationWithOption(input) {
      return db.transaction((): PendingClarificationRecord => {
        const row = scoped(input.id, input.scope);
        if (row.status !== "resolving") fail("clarification_not_resolving");
        const timestamp = nowIso();
        const changes = db.prepare(
          `UPDATE pending_clarifications SET
             status = 'resolved', selected_option_id = ?, terminal_reason = 'selected_option',
             action_result_id = ?, operation_id = ?, partial_arguments_json = '{}',
             candidates_json = '[]', updated_at = ?, resolved_at = ?
           WHERE id = ? AND status = 'resolving'`,
        ).run(
          input.selectedOptionId,
          input.actionResultId,
          input.operationId ?? null,
          timestamp,
          timestamp,
          input.id,
        ).changes;
        if (changes !== 1) fail("clarification_not_resolving");
        return toRecord(byId(input.id)!);
      })();
    },

    cancelClarification(input) {
      return db.transaction((): PendingClarificationRecord => {
        const row = scoped(input.id, input.scope);
        if (row.status !== "pending" && row.status !== "resolving") fail("clarification_not_active");
        const timestamp = nowIso();
        db.prepare(
          `UPDATE pending_clarifications SET
             status = 'cancelled', terminal_reason = ?, partial_arguments_json = '{}',
             candidates_json = '[]', updated_at = ?, resolved_at = ?
           WHERE id = ?`,
        ).run(input.reason, timestamp, timestamp, input.id);
        return toRecord(byId(input.id)!);
      })();
    },

    continueClarificationWithFreeText(id, scope) {
      return db.transaction((): PendingClarificationRecord => {
        const row = scoped(id, scope);
        if (row.status !== "pending") fail("clarification_not_pending");
        const timestamp = nowIso();
        const changes = db.prepare(
          `UPDATE pending_clarifications SET
             status = 'continued', terminal_reason = 'free_text_continuation',
             partial_arguments_json = '{}', candidates_json = '[]',
             updated_at = ?, resolved_at = ?
           WHERE id = ? AND status = 'pending'`,
        ).run(timestamp, timestamp, id).changes;
        if (changes !== 1) fail("clarification_not_pending");
        return toRecord(byId(id)!);
      })();
    },
  };
}

export type PendingClarificationStore = ReturnType<typeof buildPendingClarificationStore>;
