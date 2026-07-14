import { createHash, randomUUID } from "node:crypto";
import type { ArtifactRecord, StoreContext } from "./context.js";

const ARTIFACT_TTL_MS = 60 * 60 * 1000;

export function buildArtifactStore(ctx: StoreContext): {
  createArtifact(input: Omit<ArtifactRecord, "id" | "checksum" | "createdAt" | "expiresAt">): { id: string; expiresAt: string };
  getArtifact(id: string, workspaceId: string, adminUserId: string, sessionId: string): ArtifactRecord | undefined;
} {
  const { db, now, nowIso } = ctx;
  return {
    createArtifact(input) {
      if (input.bytes.byteLength > 1_000_000) throw new Error("artifact_too_large");
      const id = randomUUID();
      const createdAt = nowIso();
      const expiresAt = new Date(now().getTime() + ARTIFACT_TTL_MS).toISOString();
      const checksum = createHash("sha256").update(input.bytes).digest("hex");
      db.prepare(
        `INSERT INTO artifacts
          (id, workspace_id, admin_user_id, session_id, content_type, filename, bytes, checksum, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.workspaceId,
        input.adminUserId,
        input.sessionId,
        input.contentType,
        input.filename,
        Buffer.from(input.bytes),
        checksum,
        createdAt,
        expiresAt,
      );
      return { id, expiresAt };
    },

    getArtifact(id, workspaceId, adminUserId, sessionId) {
      const row = db.prepare(
        `SELECT * FROM artifacts
         WHERE id = ? AND workspace_id = ? AND admin_user_id = ? AND session_id = ? AND expires_at > ?`,
      ).get(id, workspaceId, adminUserId, sessionId, nowIso()) as {
        id: string;
        workspace_id: string;
        admin_user_id: string;
        session_id: string;
        content_type: string;
        filename: string;
        bytes: Buffer;
        checksum: string;
        created_at: string;
        expires_at: string;
      } | undefined;
      return row ? {
        id: row.id,
        workspaceId: row.workspace_id,
        adminUserId: row.admin_user_id,
        sessionId: row.session_id,
        contentType: row.content_type,
        filename: row.filename,
        bytes: new Uint8Array(row.bytes),
        checksum: row.checksum,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      } : undefined;
    },
  };
}
