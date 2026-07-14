import { randomUUID } from "node:crypto";
import type { ChatSession, NewSessionInput, SessionSummary, StoreContext } from "./context.js";

const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/** Chat-sessions concern: create + fetch a live session + the history switcher list. */
export function buildSessionStore(ctx: StoreContext): {
  createSession(input: NewSessionInput): ChatSession;
  getSession(id: string): ChatSession | undefined;
  invalidateAdminSessions(workspaceId: string, adminUserId: string): number;
  listSessions(workspaceId: string, adminUserId: string, nowIso: string): SessionSummary[];
} {
  const { db, now, nowIso } = ctx;
  return {
    createSession(input) {
      const timestamp = nowIso();
      const expiresAt = new Date(
        now().getTime() + (input.ttlMs ?? DEFAULT_SESSION_TTL_MS),
      ).toISOString();
      const session: ChatSession = {
        id: randomUUID(),
        workspaceId: input.workspaceId,
        adminUserId: input.adminUserId,
        createdAt: timestamp,
        lastSeenAt: timestamp,
        expiresAt,
      };
      db.prepare(
        `INSERT INTO chat_sessions (id, workspace_id, admin_user_id, created_at, last_seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        session.id,
        session.workspaceId,
        session.adminUserId,
        session.createdAt,
        session.lastSeenAt,
        session.expiresAt,
      );
      return session;
    },

    getSession(id) {
      const row = db.prepare("SELECT * FROM chat_sessions WHERE id = ?").get(id) as
        | {
            id: string;
            workspace_id: string;
            admin_user_id: string;
            created_at: string;
            last_seen_at: string;
            expires_at: string;
          }
        | undefined;
      if (!row) return undefined;
      if (new Date(row.expires_at).getTime() <= now().getTime()) return undefined;
      return {
        id: row.id,
        workspaceId: row.workspace_id,
        adminUserId: row.admin_user_id,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        expiresAt: row.expires_at,
      };
    },

    invalidateAdminSessions(workspaceId, adminUserId) {
      return db.prepare(
        `UPDATE chat_sessions
         SET expires_at = ?, last_seen_at = ?
         WHERE workspace_id = ? AND admin_user_id = ? AND expires_at > ?`,
      ).run(nowIso(), nowIso(), workspaceId, adminUserId, nowIso()).changes;
    },

    listSessions(workspaceId, adminUserId, nowIso) {
      const rows = db
        .prepare(
          `SELECT s.id AS id, s.created_at AS created_at,
             (SELECT m.content FROM chat_messages m
                WHERE m.session_id = s.id AND m.role = 'user'
                ORDER BY m.created_at ASC, m.rowid ASC LIMIT 1) AS title,
             (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id) AS message_count,
             (SELECT MAX(m.created_at) FROM chat_messages m WHERE m.session_id = s.id) AS last_message_at
           FROM chat_sessions s
           WHERE s.workspace_id = ? AND s.admin_user_id = ? AND s.expires_at > ?
           ORDER BY last_message_at DESC`,
        )
        .all(workspaceId, adminUserId, nowIso) as Array<{
        id: string;
        created_at: string;
        title: string | null;
        message_count: number;
        last_message_at: string | null;
      }>;
      return rows
        .filter((r) => r.message_count > 0 && r.last_message_at)
        .map((r) => ({
          id: r.id,
          title: r.title ?? "Conversation",
          messageCount: r.message_count,
          lastMessageAt: r.last_message_at as string,
          createdAt: r.created_at,
        }));
    },
  };
}
