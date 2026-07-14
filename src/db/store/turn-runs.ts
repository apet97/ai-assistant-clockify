import type { StoreContext, TurnRun, TurnRunClaimInput, TurnRunClaimResult, TurnRunStatus } from "./context.js";

interface TurnRunRow {
  request_id: string;
  session_id: string;
  workspace_id: string;
  admin_user_id: string;
  intent_hash: string;
  status: TurnRunStatus;
  response_json: string | null;
  created_at: string;
  updated_at: string;
}

function toTurnRun(row: TurnRunRow): TurnRun {
  return {
    requestId: row.request_id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    adminUserId: row.admin_user_id,
    intentHash: row.intent_hash,
    status: row.status,
    response: row.response_json ? JSON.parse(row.response_json) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function buildTurnRunStore(ctx: StoreContext): {
  claimTurnRun(input: TurnRunClaimInput): TurnRunClaimResult;
  markTurnRunExecuting(sessionId: string, requestId: string): void;
  finishTurnRun(sessionId: string, requestId: string, status: "succeeded" | "failed" | "outcome_unknown", response: unknown): void;
  getTurnRun(sessionId: string, requestId: string): TurnRun | undefined;
} {
  const { db, nowIso } = ctx;
  const claim = db.transaction((input: TurnRunClaimInput): TurnRunClaimResult => {
    const existing = db
      .prepare("SELECT * FROM turn_runs WHERE session_id = ? AND request_id = ?")
      .get(input.sessionId, input.requestId) as TurnRunRow | undefined;
    if (existing) {
      if (existing.intent_hash !== input.intentHash) return { state: "conflict" };
      if (existing.status === "prepared" || existing.status === "executing") return { state: "in_flight" };
      if (existing.response_json) return { state: "replay", response: JSON.parse(existing.response_json) };
      return { state: "outcome_unknown" };
    }
    const timestamp = nowIso();
    db.prepare(
      `INSERT INTO turn_runs (
         request_id, session_id, workspace_id, admin_user_id, intent_hash, status,
         response_json, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'prepared', NULL, ?, ?)`,
    ).run(
      input.requestId,
      input.sessionId,
      input.workspaceId,
      input.adminUserId,
      input.intentHash,
      timestamp,
      timestamp,
    );
    return { state: "won" };
  });

  return {
    claimTurnRun: claim,
    markTurnRunExecuting(sessionId, requestId) {
      db.prepare(
        "UPDATE turn_runs SET status = 'executing', updated_at = ? WHERE session_id = ? AND request_id = ? AND status = 'prepared'",
      ).run(nowIso(), sessionId, requestId);
    },
    finishTurnRun(sessionId, requestId, status, response) {
      db.prepare(
        "UPDATE turn_runs SET status = ?, response_json = ?, updated_at = ? WHERE session_id = ? AND request_id = ?",
      ).run(status, JSON.stringify(response), nowIso(), sessionId, requestId);
    },
    getTurnRun(sessionId, requestId) {
      const row = db
        .prepare("SELECT * FROM turn_runs WHERE session_id = ? AND request_id = ?")
        .get(sessionId, requestId) as TurnRunRow | undefined;
      return row ? toTurnRun(row) : undefined;
    },
  };
}
