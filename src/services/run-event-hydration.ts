import type {
  JsonValue,
  PresentedResult,
  PresentedResultEnvelope,
  RunEventAttachment,
  RunEventType,
  RunEventView,
  SequencedRunEvent,
} from "../assistant-v2/events.js";
import { rotatePendingNonce } from "../harness/confirmations.js";
import type { Store } from "../db/store.js";
import type { AssistantRunScope } from "../db/store/runs.js";

export interface HydrationContext {
  store: Store;
  scope: AssistantRunScope;
  sessionSecret: string;
  now: Date;
}

function chatResultToPresentation(result: unknown, actionName: string): PresentedResult {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const row = result as Record<string, unknown>;
    if (row.kind === "receipt" && row.receipt && typeof row.receipt === "object") {
      const receipt = row.receipt as Record<string, unknown>;
      const ok = receipt.ok === true;
      return {
        status: ok ? "succeeded" : "failed",
        title: typeof receipt.action === "string" ? receipt.action : actionName,
        summary: typeof receipt.message === "string" ? receipt.message : "",
        facts: [],
        warnings: Array.isArray(receipt.warnings)
          ? receipt.warnings.slice(0, 12).map((w, index) => {
              const item = w as Record<string, unknown>;
              return {
                code: typeof item.code === "string" ? item.code.slice(0, 256) : `warning_${index}`,
                message: typeof item.message === "string" ? item.message.slice(0, 256) : "",
              };
            })
          : [],
        references: [],
      };
    }
    if (row.kind === "preview" && row.preview && typeof row.preview === "object") {
      const preview = row.preview as Record<string, unknown>;
      return {
        status: "pending_confirmation",
        title: typeof preview.actionLabel === "string" ? preview.actionLabel : actionName,
        summary: Array.isArray(preview.expectedChanges)
          ? preview.expectedChanges.slice(0, 12).map(String).join("; ")
          : "",
        facts: [],
        warnings: Array.isArray(preview.warnings)
          ? preview.warnings.slice(0, 12).map((w, index) => ({
              code: `preview_${index}`,
              message: String(w).slice(0, 256),
            }))
          : [],
        references: [],
      };
    }
    if (row.kind === "clarify") {
      return {
        status: "succeeded",
        title: actionName,
        summary: typeof row.message === "string" ? row.message : "",
        facts: [],
        warnings: [],
        references: [],
      };
    }
  }
  return {
    status: "succeeded",
    title: actionName,
    summary: "",
    facts: [],
    warnings: [],
    references: [],
  };
}

function envelopeFromActionResult(
  actionResultId: string,
  actionName: string,
  result: unknown,
): PresentedResultEnvelope {
  const presentation = chatResultToPresentation(result, actionName);
  return {
    presentation,
    actionResultId,
    diagnostic: {
      kind: "sanitized_receipt",
      // diagnosticViewSchema requires the EXACT UTF-8 byte length of `value`
      // (T15-E flagged the prior UTF-16 code-unit count as a latent mismatch).
      byteLength: Buffer.byteLength(JSON.stringify(result ?? null), "utf8"),
      value: (result ?? null) as JsonValue,
    },
  };
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
        envelope: envelopeFromActionResult(actionResultId, actionName, result),
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
          presentation: chatResultToPresentation({ kind: "preview", preview: record.preview }, record.id),
          confirmation: {
            id: record.id,
            nonce: rotated.nonce,
            expiresAt: record.expiresAt,
          },
        },
      };
    }
    case "clarification.required":
      return undefined;
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
