import type { SessionClaims } from "../auth/sessions.js";
import type { ChatMessage } from "../db/store.js";
import type { Store } from "../db/store.js";
import { isV2PreviewAuthority, rotatePendingNonce } from "../harness/confirmations.js";
import { isTransientErrorMessage } from "../routes/history-sanitizer.js";
import { sanitizeResultsForHistory } from "../routes/chat-results.js";
import { chatReceiptFromEnvelope, type ResultViewService } from "./result-view-service.js";
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
  /** Presentation boundary for v2-owned rows (PR 12: the restore serves the
   * SAME authoritative card the live stream delivered). */
  resultViews: ResultViewService;
  now(): Date;
}

/** Restore results for one stored message. A v2-owned row (payload.engine ===
 * "v2") re-presents each linked canonical result through the result-view
 * service — human title, facts, fail-closed status — exactly like the live
 * `tool.completed` attachment. v1 rows keep the byte-identical legacy
 * hydration. Presentation failure falls back to the sanitized legacy shape
 * rather than dropping the record. */
function restoredResults(resultViews: ResultViewService, message: ChatMessage): unknown[] {
  const payload = message.payload as { results?: unknown[]; engine?: unknown } | undefined;
  if (payload?.engine === "v2" && message.actionResults && message.actionResults.length > 0) {
    try {
      return message.actionResults.map(({ id, result }) => {
        const receipt = (result as { receipt?: { action?: unknown } } | undefined)?.receipt;
        const actionName = typeof receipt?.action === "string" ? receipt.action : "";
        return chatReceiptFromEnvelope(resultViews.presentActionResult(actionName, id, result));
      });
    } catch {
      return sanitizeResultsForHistory(payload?.results ?? []);
    }
  }
  return sanitizeResultsForHistory(payload?.results ?? []);
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
        results: restoredResults(deps.resultViews, m),
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
