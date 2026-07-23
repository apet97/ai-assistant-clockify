import { randomUUID } from "node:crypto";
import type { ChatMessage, ChatRole, DurableResultLink, NewMessageInput, StoreContext } from "./context.js";

interface ResultLinkRow {
  descriptor_kind: DurableResultLink["kind"];
  action_result_id: string | null;
  descriptor_json: string | null;
  result_json: string | null;
  summary_json: string | null;
  result_kind: import("../action-results.js").ActionResultKind | null;
}

function envelopeWithoutResults(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const { results: _results, ...envelope } = payload as Record<string, unknown>;
  return envelope;
}

/** Chat-messages concern: append a message + load the recent window. */
export function buildMessageStore(ctx: StoreContext): {
  addMessage(input: NewMessageInput): void;
  getRecentMessages(sessionId: string, limit: number, includePayload?: boolean): ChatMessage[];
} {
  const { db, nowIso } = ctx;
  return {
    addMessage(input) {
      db.transaction(() => {
        const id = randomUUID();
        db.prepare(
          `INSERT INTO chat_messages (id, session_id, workspace_id, admin_user_id, role, content, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          input.sessionId,
          input.workspaceId,
          input.adminUserId,
          input.role,
          input.content,
          input.payload === undefined ? null : JSON.stringify(envelopeWithoutResults(input.payload)),
          nowIso(),
        );
        const insert = db.prepare(
          `INSERT INTO chat_message_result_links (
             message_id, result_index, descriptor_kind, action_result_id, descriptor_json
           ) VALUES (?, ?, ?, ?, ?)`,
        );
        for (const [index, link] of (input.resultLinks ?? []).entries()) {
          insert.run(
            id,
            index,
            link.kind,
            link.kind === "action_result" ? link.ref.id : null,
            link.kind === "action_result" ? null : JSON.stringify(link.descriptor),
          );
        }
      })();
    },

    getRecentMessages(sessionId, limit, includePayload = false) {
      // The model-visible window (the sole request-path consumer) needs only
      // role + content; the stored payload can be a fat list/report receipt
      // (100KB+), so fetching + JSON.parsing it per windowed row is wasted work.
      // It is loaded only when a caller explicitly opts in.
      const columns = includePayload ? "id, role, content, payload_json" : "role, content";
      const rows = db
        .prepare(
          `SELECT ${columns} FROM chat_messages WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        )
        .all(sessionId, limit) as Array<{
        id?: string;
        role: ChatRole;
        content: string;
        payload_json?: string | null;
      }>;
      const loadLinks = db.prepare(
        `SELECT l.descriptor_kind, l.action_result_id, l.descriptor_json,
                a.result_json, a.summary_json, a.kind AS result_kind
           FROM chat_message_result_links l
           LEFT JOIN action_results a ON a.id = l.action_result_id
          WHERE l.message_id = ?
          ORDER BY l.result_index ASC`,
      );
      return rows.reverse().map((r) => {
        if (!includePayload) return { role: r.role, content: r.content };
        const envelope = r.payload_json ? JSON.parse(r.payload_json) as Record<string, unknown> : undefined;
        const links = loadLinks.all(r.id) as ResultLinkRow[];
        const results = links.flatMap((link) => {
          if (link.descriptor_kind === "action_result") {
            return link.result_json ? [JSON.parse(link.result_json) as unknown] : [];
          }
          return link.descriptor_json ? [JSON.parse(link.descriptor_json) as unknown] : [];
        });
        const payload = envelope === undefined && results.length === 0
          ? undefined
          : { ...(envelope ?? {}), ...(results.length > 0 ? { results } : {}) };
        return { ...(r.id ? { id: r.id } : {}), role: r.role, content: r.content, payload };
      });
    },
  };
}
