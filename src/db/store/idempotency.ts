import type { ClaimState, CommitResult } from "../../harness/action.js";
import type { SuccessReceipt } from "../../harness/receipts.js";
import type { ActionResultRef } from "../action-results.js";
import type { StoreContext } from "./context.js";

const commitResultFromCanonical = (value: unknown): CommitResult | undefined => {
  if (!value || typeof value !== "object") return undefined;
  if (
    "kind" in value &&
    (value as { kind?: unknown }).kind === "partial" &&
    "receipt" in value &&
    (value as { receipt?: { ok?: unknown } }).receipt?.ok === true
  ) {
    return value as CommitResult;
  }
  const candidate = "receipt" in value ? (value as { receipt?: unknown }).receipt : value;
  return candidate && typeof candidate === "object" && (candidate as { ok?: unknown }).ok === true
    ? candidate as SuccessReceipt
    : undefined;
};

export function buildIdempotencyStore(ctx: StoreContext): {
  recordIdempotency(key: string, workspaceId: string, adminUserId: string, ref: ActionResultRef, committedAtEpochMs: number): void;
  lookupIdempotency(key: string, workspaceId: string, adminUserId: string, notBeforeEpochMs: number): SuccessReceipt | undefined;
  claimIdempotency(
    key: string,
    workspaceId: string,
    adminUserId: string,
    claimedAtEpochMs: number,
    completedNotBeforeEpochMs: number,
    claimNotBeforeEpochMs: number,
  ): ClaimState;
  claimIdempotencyReceipt(key: string, workspaceId: string, adminUserId: string): CommitResult | undefined;
  fillIdempotency(key: string, workspaceId: string, adminUserId: string, ref: ActionResultRef, committedAtEpochMs: number): void;
  releaseIdempotency(key: string, workspaceId: string, adminUserId: string): void;
  touchIdempotencyClaim(key: string, workspaceId: string, adminUserId: string, claimedAtEpochMs: number): void;
} {
  const { db } = ctx;
  const loadCommitResult = (key: string, workspaceId: string, adminUserId: string, notBefore?: number): CommitResult | undefined => {
    const row = db.prepare(
      `SELECT a.result_json
         FROM idempotency_keys i
         JOIN action_results a ON a.id = i.action_result_id
        WHERE i.key = ? AND i.workspace_id = ? AND i.admin_user_id = ?
          AND i.action_result_id IS NOT NULL
          ${notBefore === undefined ? "" : "AND i.committed_at >= ?"}`,
    ).get(...(
      notBefore === undefined
        ? [key, workspaceId, adminUserId]
        : [key, workspaceId, adminUserId, notBefore]
    )) as { result_json: string } | undefined;
    return row ? commitResultFromCanonical(JSON.parse(row.result_json)) : undefined;
  };

  return {
    recordIdempotency(key, workspaceId, adminUserId, ref, committedAtEpochMs) {
      db.prepare(
        `INSERT INTO idempotency_keys (
           key, workspace_id, admin_user_id, action_result_id, result_summary_json,
           committed_at, claimed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key, workspace_id, admin_user_id) DO UPDATE SET
           action_result_id = excluded.action_result_id,
           result_summary_json = excluded.result_summary_json,
           committed_at = excluded.committed_at,
           claimed_at = excluded.claimed_at`,
      ).run(key, workspaceId, adminUserId, ref.id, JSON.stringify(ref.summary), committedAtEpochMs, committedAtEpochMs);
    },

    lookupIdempotency(key, workspaceId, adminUserId, notBeforeEpochMs) {
      const result = loadCommitResult(key, workspaceId, adminUserId, notBeforeEpochMs);
      return result && !("kind" in result) && result.ok ? result : undefined;
    },

    claimIdempotency(key, workspaceId, adminUserId, claimedAtEpochMs, completedNotBeforeEpochMs, claimNotBeforeEpochMs) {
      return db.transaction((): ClaimState => {
        db.prepare(
          `DELETE FROM idempotency_keys
             WHERE key = ? AND workspace_id = ? AND admin_user_id = ?
               AND ((action_result_id IS NOT NULL AND committed_at < ?)
                 OR (action_result_id IS NULL AND claimed_at < ?))`,
        ).run(key, workspaceId, adminUserId, completedNotBeforeEpochMs, completedNotBeforeEpochMs);
        const inserted = db.prepare(
          `INSERT INTO idempotency_keys (
             key, workspace_id, admin_user_id, action_result_id, result_summary_json,
             committed_at, claimed_at
           ) VALUES (?, ?, ?, NULL, NULL, NULL, ?)
           ON CONFLICT(key, workspace_id, admin_user_id) DO NOTHING`,
        ).run(key, workspaceId, adminUserId, claimedAtEpochMs);
        if (inserted.changes === 1) return "won";
        const row = db.prepare(
          `SELECT i.action_result_id, i.claimed_at, a.kind AS action_result_kind
             FROM idempotency_keys i
             LEFT JOIN action_results a ON a.id = i.action_result_id
            WHERE i.key = ? AND i.workspace_id = ? AND i.admin_user_id = ?`,
        ).get(key, workspaceId, adminUserId) as {
          action_result_id: string | null;
          claimed_at: number;
          action_result_kind: string | null;
        } | undefined;
        if (!row) return "won";
        if (row.action_result_id !== null) {
          return row.action_result_kind === "outcome_unknown" ? "stale_unknown" : "replay";
        }
        return row.claimed_at < claimNotBeforeEpochMs ? "stale_unknown" : "in_flight";
      })();
    },

    claimIdempotencyReceipt(key, workspaceId, adminUserId) {
      return loadCommitResult(key, workspaceId, adminUserId);
    },

    fillIdempotency(key, workspaceId, adminUserId, ref, committedAtEpochMs) {
      db.prepare(
        `UPDATE idempotency_keys
            SET action_result_id = ?, result_summary_json = ?, committed_at = ?
          WHERE key = ? AND workspace_id = ? AND admin_user_id = ?
            AND action_result_id IS NULL`,
      ).run(ref.id, JSON.stringify(ref.summary), committedAtEpochMs, key, workspaceId, adminUserId);
    },

    releaseIdempotency(key, workspaceId, adminUserId) {
      db.prepare(
        `DELETE FROM idempotency_keys
          WHERE key = ? AND workspace_id = ? AND admin_user_id = ?
            AND action_result_id IS NULL`,
      ).run(key, workspaceId, adminUserId);
    },

    touchIdempotencyClaim(key, workspaceId, adminUserId, claimedAtEpochMs) {
      db.prepare(
        `UPDATE idempotency_keys SET claimed_at = ?
          WHERE key = ? AND workspace_id = ? AND admin_user_id = ?
            AND action_result_id IS NULL`,
      ).run(claimedAtEpochMs, key, workspaceId, adminUserId);
    },
  };
}
