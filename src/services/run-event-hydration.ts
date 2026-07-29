import type {
  RunEventAttachment,
  RunEventType,
  RunEventView,
  SequencedRunEvent,
} from "../assistant-v2/events.js";
import { rotatePendingNonce } from "../harness/confirmations.js";
import { MODEL_API_ACTION_CATALOG } from "../harness/api-catalog.js";
import { createResultViewService, type ResultViewService } from "./result-view-service.js";
import type { Store } from "../db/store.js";
import type { AssistantRunScope } from "../db/store/runs.js";

export interface HydrationContext {
  store: Store;
  scope: AssistantRunScope;
  sessionSecret: string;
  now: Date;
  /** Injectable for tests; defaults to the production catalog-backed view. */
  resultViews?: ResultViewService;
}

function resultViewsFor(ctx: HydrationContext): ResultViewService {
  return ctx.resultViews ?? createResultViewService({ registry: MODEL_API_ACTION_CATALOG });
}

/** The clarify question is owned by the canonical `action_results` row the
 * `clarification.required` event references — the event itself carries only the
 * bounded link, never Clockify-derived prose. */
function clarifyQuestionFromActionResult(store: Store, actionResultId: string): string | undefined {
  const stored = store.getActionResult(actionResultId);
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return undefined;
  const row = stored as Record<string, unknown>;
  if (row.kind !== "clarify" || typeof row.message !== "string" || row.message.length === 0) return undefined;
  return row.message;
}

function findAssistantMessage(
  store: Store,
  scope: AssistantRunScope,
  messageId: string,
): { content: string } | undefined {
  const rows = store.getRecentMessages(scope.sessionId, 500, true);
  const match = rows.find((row) => (row as { id?: string }).id === messageId);
  if (!match) return undefined;
  return { content: match.content };
}

function hydrateAttachment(
  ctx: HydrationContext,
  event: RunEventView,
): RunEventAttachment | undefined {
  const { store, scope, sessionSecret, now } = ctx;
  switch (event.eventType) {
    case "model.completed": {
      const messageId = event.payload.chatMessageId;
      if (!messageId) return undefined;
      const message = findAssistantMessage(store, scope, messageId);
      if (!message) return undefined;
      return { kind: "assistant_message", messageId, text: message.content };
    }
    case "tool.completed":
    case "operation.completed": {
      const actionResultId = event.payload.actionResultId;
      const result = store.getActionResult(actionResultId);
      if (!result) return undefined;
      const actionName = event.eventType === "tool.completed"
        ? event.payload.actionName
        : "operation";
      return {
        kind: "presented_result",
        actionResultId,
        envelope: resultViewsFor(ctx).presentActionResult(actionName, actionResultId, result),
      };
    }
    case "operation.prepared": {
      const record = store.getPendingConfirmation(event.payload.confirmationId);
      if (!record || record.status !== "pending") return undefined;
      const rotated = rotatePendingNonce({
        record,
        sessionId: scope.sessionId,
        workspaceId: scope.workspaceId,
        adminUserId: scope.adminUserId,
        sessionSecret,
        now,
      });
      if (!rotated.ok) return undefined;
      if (!store.updateConfirmationNonceHash(record.id, rotated.record.nonceHash)) return undefined;
      return {
        kind: "pending_confirmation",
        confirmationId: record.id,
        envelope: {
          presentation: resultViewsFor(ctx).presentPendingConfirmation(record),
          confirmation: {
            id: record.id,
            nonce: rotated.nonce,
            expiresAt: record.expiresAt,
          },
        },
      };
    }
    case "clarification.required": {
      // Mirror `operation.prepared`: a SETTLED clarification must never render as
      // live again. Only `pending`/`resolving` rows produce an attachment.
      const row = store.getPendingClarification(event.payload.clarificationId, {
        sessionId: scope.sessionId,
        runId: scope.runId,
        workspaceId: scope.workspaceId,
        adminUserId: scope.adminUserId,
      });
      if (!row || (row.status !== "pending" && row.status !== "resolving")) return undefined;
      // Status alone is not liveness. Expiry is enforced at claim time and only
      // lazily by the retention sweep, so an expired-but-unswept row would
      // render live chips that 410 on click. `operation.prepared` already gets
      // this via rotatePendingNonce -> checkConfirmationGate({now}); mirror
      // `claimClarificationResolving`'s comparison exactly (expired when
      // expiresAt <= now) so a row this drops could not have resolved anyway.
      if (Date.parse(row.expiresAt) <= now.getTime()) return undefined;
      const question = clarifyQuestionFromActionResult(store, event.payload.actionResultId);
      // The question lives only in the canonical `action_results` row. Without it
      // there is nothing truthful to ask, so drop the attachment rather than
      // invent copy (a 5-minute-lived row cannot outlive 30-day retention, so
      // this is a fail-closed guard, not an expected path).
      if (question === undefined) return undefined;
      return {
        kind: "pending_clarification",
        clarificationId: row.id,
        status: row.status,
        question,
        missingField: row.missingField,
        // Never `externalId`, never `partialArguments` — display data only.
        candidates: row.candidates.map(({ optionId, label, referenceId }) => ({
          optionId,
          label,
          ...(referenceId ? { referenceId } : {}),
        })),
        expiresAt: row.expiresAt,
      };
    }
    default:
      return undefined;
  }
}

export function hydrateRunEventAttachments(
  ctx: HydrationContext,
  events: SequencedRunEvent[],
): SequencedRunEvent[] {
  const presented = new Set<string>();
  return events.map((entry) => {
    const attachment = hydrateAttachment(ctx, entry.event);
    if (!attachment) return entry;
    if (attachment.kind === "presented_result" || attachment.kind === "pending_confirmation") {
      const key = attachment.kind === "presented_result"
        ? attachment.actionResultId
        : attachment.confirmationId;
      if (presented.has(key)) return { ...entry, attachment: undefined };
      presented.add(key);
    }
    return { ...entry, attachment };
  });
}

export function eventTypeAllowsAttachment(eventType: RunEventType): boolean {
  return eventType === "model.completed"
    || eventType === "tool.completed"
    || eventType === "operation.completed"
    || eventType === "operation.prepared"
    || eventType === "clarification.required";
}
