import { randomUUID } from "node:crypto";
import type { ChatMessage, ChatRole, NewMessageInput, StoreContext } from "./context.js";

/** Chat-messages concern: append a message + load the recent window. */
export function buildMessageStore(ctx: StoreContext): {
  addMessage(input: NewMessageInput): void;
  getRecentMessages(sessionId: string, limit: number, includePayload?: boolean): ChatMessage[];
} {
  const { db, nowIso } = ctx;
  return {
    addMessage(input) {
      db.prepare(
        `INSERT INTO chat_messages (id, session_id, workspace_id, admin_user_id, role, content, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        randomUUID(),
        input.sessionId,
        input.workspaceId,
        input.adminUserId,
        input.role,
        input.content,
        input.payload === undefined ? null : JSON.stringify(input.payload),
        nowIso(),
      );
    },

    getRecentMessages(sessionId, limit, includePayload = false) {
      // The model-visible window (the sole request-path consumer) needs only
      // role + content; the stored payload can be a fat list/report receipt
      // (100KB+), so fetching + JSON.parsing it per windowed row is wasted work.
      // It is loaded only when a caller explicitly opts in.
      const columns = includePayload ? "role, content, payload_json" : "role, content";
      const rows = db
        .prepare(
          `SELECT ${columns} FROM chat_messages WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        )
        .all(sessionId, limit) as Array<{
        role: ChatRole;
        content: string;
        payload_json?: string | null;
      }>;
      return rows.reverse().map((r) =>
        includePayload
          ? {
              role: r.role,
              content: r.content,
              payload: r.payload_json ? JSON.parse(r.payload_json) : undefined,
            }
          : { role: r.role, content: r.content },
      );
    },
  };
}
