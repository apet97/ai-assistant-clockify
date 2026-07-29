import type { SessionClaims } from "../auth/sessions.js";
import type { Store } from "../db/store.js";
import { isV2PreviewAuthority, rotatePendingNonce } from "../harness/confirmations.js";
import { isTransientErrorMessage } from "../routes/history-sanitizer.js";
import { sanitizeResultsForHistory } from "../routes/chat-results.js";
import type { HistoryPendingPreview, HistoryView } from "../shared/contracts.js";

/**
 * HistoryService (T16-D): the session-restore view extracted from
 * `routes/api.ts`. History is a record, not a control surface — stored results
 * arrive sanitized (no undo handles, no nonce substrings) and each still-live
 * preview is re-served with a freshly ROTATED one-use nonce whose old
 * plaintext dies atomically. Hydration is batched; scope is the caller's
 * session only.
 */

/**
 * How many stored messages the restore view replays after an iframe reload.
 * Distinct from the MODEL context window (`HISTORY_WINDOW_MESSAGES`, 12) —
 * this is the human's restored VIEW. Named *_RESTORE_* so it is never mistaken
 * for the LLM window.
 */
export const CHAT_HISTORY_RESTORE_LIMIT = 50;

export interface HistoryServiceDeps {
  store: Pick<
    Store,
    | "getRecentMessages"
    | "listPendingConfirmations"
    | "updateConfirmationNonceHash"
    | "listScopedOperationRuns"
    | "getActiveRunForSession"
  >;
  sessionSecret: string;
  now(): Date;
}

export function createHistoryService(deps: HistoryServiceDeps) {
  function view(claims: SessionClaims): HistoryView {
    const messages = deps.store
      .getRecentMessages(claims.sessionId, CHAT_HISTORY_RESTORE_LIMIT, true)
      // Drop transient model-failure rows (payload.kind="error"): they are an
      // out-of-band notice the admin already saw live, not a reply to resurrect
      // on reload (finding r2-new-session-restore-05).
      .filter((m) => (m.role === "user" || m.role === "assistant") && !isTransientErrorMessage(m))
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
        results: sanitizeResultsForHistory((m.payload as { results?: unknown[] } | undefined)?.results ?? []),
      }));
    const pendingPreviews: HistoryPendingPreview[] = [];
    for (const record of deps.store.listPendingConfirmations(claims.sessionId, deps.now().toISOString())) {
      // ONE v2 control source (closure-plan PR 3 / F06): a v2 assistant
      // preview hydrates ONLY from its run-event page (`activeRun` +
      // GET /api/runs/:id/events, which rotates the one nonce). Serving it
      // here too minted a second nonce that invalidated the first, so one
      // reload rendered two cards where only the later one could confirm.
      // v1 previews keep this legacy source unchanged.
      if (isV2PreviewAuthority(record)) continue;
      const rotated = rotatePendingNonce({
        record,
        sessionId: claims.sessionId,
        workspaceId: claims.workspaceId,
        adminUserId: claims.adminUserId,
        sessionSecret: deps.sessionSecret,
        now: deps.now(),
      });
      if (!rotated.ok) continue;
      // Conditional swap: a concurrent confirm/cancel wins and the card is dropped.
      if (!deps.store.updateConfirmationNonceHash(record.id, rotated.record.nonceHash)) continue;
      pendingPreviews.push({
        kind: "preview",
        previewId: record.id,
        nonce: rotated.nonce,
        expiresAt: record.expiresAt,
        preview: record.preview,
      });
    }
    const operationRuns = deps.store.listScopedOperationRuns(
      claims.workspaceId,
      claims.adminUserId,
      claims.sessionId,
    ).map((operation) => ({
      id: operation.id,
      actionName: operation.actionName,
      status: operation.status,
      steps: operation.steps.map((step) => ({
        planStepId: step.planStepId,
        name: step.name,
        status: step.status,
      })),
      ...(operation.stepsTruncated ? { stepsTruncated: true } : {}),
      ...(operation.reconciliation ? { reconciliation: operation.reconciliation } : {}),
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
    }));
    const activeRun = deps.store.getActiveRunForSession(
      claims.sessionId,
      claims.workspaceId,
      claims.adminUserId,
    );
    return {
      messages,
      pendingPreviews,
      ...(operationRuns.length > 0 ? { operationRuns } : {}),
      ...(activeRun ? { activeRun } : {}),
    };
  }

  return { view };
}

export type HistoryService = ReturnType<typeof createHistoryService>;
