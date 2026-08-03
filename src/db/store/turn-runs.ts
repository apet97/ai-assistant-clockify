import { durableLinkColumns } from "./context.js";
import type { DurableResultLink, StoreContext, TurnRun, TurnRunClaimInput, TurnRunClaimResult, TurnRunStatus } from "./context.js";

interface TurnRunRow {
  request_id: string;
  session_id: string;
  workspace_id: string;
  admin_user_id: string;
  intent_hash: string;
  status: TurnRunStatus;
  response_envelope_json: string | null;
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
    response: row.response_envelope_json ? JSON.parse(row.response_envelope_json) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function buildTurnRunStore(ctx: StoreContext): {
  claimTurnRun(input: TurnRunClaimInput): TurnRunClaimResult;
  markTurnRunExecuting(sessionId: string, requestId: string): void;
  finishTurnRun(sessionId: string, requestId: string, status: "succeeded" | "failed" | "outcome_unknown", response: unknown, resultLinks?: DurableResultLink[]): void;
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
      if (existing.response_envelope_json) {
        const response = JSON.parse(existing.response_envelope_json) as Record<string, unknown>;
        const body = response.body && typeof response.body === "object"
          ? response.body as Record<string, unknown>
          : undefined;
        const links = db.prepare(
          `SELECT l.descriptor_kind, l.descriptor_json, a.result_json
             FROM turn_run_result_links l
             LEFT JOIN action_results a ON a.id = l.action_result_id
            WHERE l.session_id = ? AND l.request_id = ?
            ORDER BY l.result_index ASC`,
        ).all(input.sessionId, input.requestId) as Array<{
          descriptor_kind: string;
          descriptor_json: string | null;
          result_json: string | null;
        }>;
        const results = links.flatMap((link) => {
          // Confirmation links are re-served by the replay path's own nonce
          // rotation, never replayed as raw id-only descriptors.
          if (link.descriptor_kind === "confirmation") return [];
          const encoded = link.descriptor_kind === "action_result" ? link.result_json : link.descriptor_json;
          return encoded ? [JSON.parse(encoded) as unknown] : [];
        });
        return {
          state: "replay",
          response: body ? { ...response, body: { ...body, results } } : response,
        };
      }
      return { state: "outcome_unknown" };
    }
    const timestamp = nowIso();
    db.prepare(
      `INSERT INTO turn_runs (
         request_id, session_id, workspace_id, admin_user_id, intent_hash, status,
         response_envelope_json, created_at, updated_at
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
    finishTurnRun(sessionId, requestId, status, response, resultLinks = []) {
      db.transaction(() => {
        const value = response && typeof response === "object" ? response as Record<string, unknown> : {};
        const body = value.body && typeof value.body === "object" ? value.body as Record<string, unknown> : undefined;
        // T07: strip both `results` (v1's inline result array) and `runEvents`
        // (v2's hydrated event page — replayed events, incl. any live
        // confirmation nonce, must never be persisted) while retaining the
        // non-secret `runId` marker a replay uses to rebuild a fresh page.
        const envelope = body
          ? { ...value, body: Object.fromEntries(Object.entries(body).filter(([key]) => key !== "results" && key !== "runEvents")) }
          : value;
        db.prepare(
          "UPDATE turn_runs SET status = ?, response_envelope_json = ?, updated_at = ? WHERE session_id = ? AND request_id = ?",
        ).run(status, JSON.stringify(envelope), nowIso(), sessionId, requestId);
        db.prepare("DELETE FROM turn_run_result_links WHERE session_id = ? AND request_id = ?").run(sessionId, requestId);
        const insert = db.prepare(
          `INSERT INTO turn_run_result_links (
             session_id, request_id, result_index, descriptor_kind, action_result_id, descriptor_json
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        );
        for (const [index, link] of resultLinks.entries()) {
          const columns = durableLinkColumns(link);
          insert.run(sessionId, requestId, index, link.kind, columns.actionResultId, columns.descriptorJson);
        }
      })();
    },
    getTurnRun(sessionId, requestId) {
      const row = db
        .prepare("SELECT * FROM turn_runs WHERE session_id = ? AND request_id = ?")
        .get(sessionId, requestId) as TurnRunRow | undefined;
      return row ? toTurnRun(row) : undefined;
    },
  };
}
