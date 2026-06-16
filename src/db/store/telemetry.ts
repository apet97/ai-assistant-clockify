import { randomUUID } from "node:crypto";
import type { TurnTelemetry } from "../../metrics/metrics.js";
import type { StoreContext } from "./context.js";

/** Per-turn model telemetry concern (cost + latency; see metrics.ts TurnTelemetry). */
export function buildTelemetryStore(ctx: StoreContext): {
  recordTurnTelemetry(input: {
    sessionId: string;
    workspaceId: string;
    adminUserId: string;
    kind: "chat" | "resume";
    modelCalls: number;
    promptTokens?: number;
    completionTokens?: number;
    /** Prompt tokens served from the provider's cache; omit when the backend reported none. */
    cachedPromptTokens?: number;
    turnMs: number;
    modelMs: number;
  }): void;
  listTurnTelemetry(workspaceId: string, adminUserId: string, sinceIso?: string): TurnTelemetry[];
} {
  const { db, nowIso } = ctx;
  return {
    recordTurnTelemetry(input) {
      db.prepare(
        `INSERT INTO turn_telemetry (
           id, session_id, workspace_id, admin_user_id, kind, model_calls,
           prompt_tokens, completion_tokens, cached_prompt_tokens, turn_ms, model_ms, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        input.sessionId,
        input.workspaceId,
        input.adminUserId,
        input.kind,
        input.modelCalls,
        input.promptTokens ?? null,
        input.completionTokens ?? null,
        input.cachedPromptTokens ?? null,
        input.turnMs,
        input.modelMs,
        nowIso(),
      );
    },

    listTurnTelemetry(workspaceId, adminUserId, sinceIso) {
      // Conditional bound, same shape as actionOutcomesSql: appending the range
      // predicate only when bounded keeps the index seek (see that comment).
      const bounded = sinceIso !== undefined;
      const rows = db
        .prepare(
          `SELECT kind, model_calls, prompt_tokens, completion_tokens, cached_prompt_tokens, turn_ms, model_ms, created_at
             FROM turn_telemetry
            WHERE workspace_id = ? AND admin_user_id = ?${bounded ? " AND created_at >= ?" : ""}
            ORDER BY created_at ASC`,
        )
        .all(...(bounded ? [workspaceId, adminUserId, sinceIso] : [workspaceId, adminUserId])) as Array<{
        kind: "chat" | "resume";
        model_calls: number;
        prompt_tokens: number | null;
        completion_tokens: number | null;
        cached_prompt_tokens: number | null;
        turn_ms: number;
        model_ms: number;
        created_at: string;
      }>;
      return rows.map((row) => ({
        kind: row.kind,
        modelCalls: row.model_calls,
        promptTokens: row.prompt_tokens ?? undefined,
        completionTokens: row.completion_tokens ?? undefined,
        cachedPromptTokens: row.cached_prompt_tokens ?? undefined,
        turnMs: row.turn_ms,
        modelMs: row.model_ms,
        createdAt: row.created_at,
      }));
    },
  };
}
