import { randomUUID } from "node:crypto";
import type { StoreContext } from "./context.js";

export interface EntityReferenceScope {
  sessionId: string;
  workspaceId: string;
  adminUserId: string;
}

/**
 * A captured scope VALUE for this specific reference instance (e.g. the
 * parent project id a task reference was verified under) — not an action's
 * argument-path metadata. `externalId` needs no entry here; it already has
 * its own column. Extensible only to the reviewed non-`externalId` reference
 * fields an action's `ReferenceSelectorMetadata` may bind
 * (`src/harness/api-operation.ts`).
 */
export interface EntityReferenceScopeBinding {
  field: "scope.projectId";
  value: string;
}

export type EntityReferenceStatus = "active" | "stale" | "deleted";

export interface UpsertEntityReferenceInput extends EntityReferenceScope {
  id?: string;
  entityType: string;
  externalId: string;
  displayName: string;
  bindings: readonly EntityReferenceScopeBinding[];
  bindingFingerprint: string;
  sourceRunId: string;
}

export interface EntityReferenceRecord extends EntityReferenceScope {
  id: string;
  entityType: string;
  externalId: string;
  displayName: string;
  bindings: EntityReferenceScopeBinding[];
  bindingFingerprint: string;
  sourceRunId: string;
  status: EntityReferenceStatus;
  verifiedAt: string;
  createdAt: string;
  updatedAt: string;
}

export class EntityReferenceStoreError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "EntityReferenceStoreError";
  }
}

function fail(code: string): never {
  throw new EntityReferenceStoreError(code);
}

interface EntityReferenceRow {
  id: string;
  session_id: string;
  workspace_id: string;
  admin_user_id: string;
  entity_type: string;
  external_id: string;
  display_name: string;
  bindings_json: string;
  binding_fingerprint: string;
  source_run_id: string;
  status: EntityReferenceStatus;
  verified_at: string;
  created_at: string;
  updated_at: string;
}

function toRecord(row: EntityReferenceRow): EntityReferenceRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    workspaceId: row.workspace_id,
    adminUserId: row.admin_user_id,
    entityType: row.entity_type,
    externalId: row.external_id,
    displayName: row.display_name,
    bindings: JSON.parse(row.bindings_json) as EntityReferenceScopeBinding[],
    bindingFingerprint: row.binding_fingerprint,
    sourceRunId: row.source_run_id,
    status: row.status,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertScope(row: EntityReferenceRow, scope: EntityReferenceScope): void {
  if (row.session_id !== scope.sessionId) fail("entity_reference_session_drift");
  if (row.workspace_id !== scope.workspaceId) fail("entity_reference_workspace_drift");
  if (row.admin_user_id !== scope.adminUserId) fail("entity_reference_admin_drift");
}

/**
 * Grounded entity references the assistant may cite in a later turn (e.g. "the
 * project I just made"). One row per (session, workspace, admin, entityType,
 * externalId); a later sighting of the same entity refreshes it in place rather
 * than accumulating duplicates. Extraction/consumption (T14-B onward) owns
 * deciding when a reference is worth recording and when it has gone stale.
 */
export function buildEntityReferenceStore(ctx: StoreContext): {
  upsertEntityReference(input: UpsertEntityReferenceInput): EntityReferenceRecord;
  getEntityReference(id: string, scope: EntityReferenceScope): EntityReferenceRecord | undefined;
  listRecentActiveEntityReferences(scope: EntityReferenceScope, limit?: number): EntityReferenceRecord[];
  markEntityReferenceStatus(
    id: string,
    scope: EntityReferenceScope,
    status: EntityReferenceStatus,
  ): EntityReferenceRecord;
} {
  const { db, nowIso } = ctx;

  const byId = (id: string): EntityReferenceRow | undefined => db.prepare(
    "SELECT * FROM entity_references WHERE id = ?",
  ).get(id) as EntityReferenceRow | undefined;

  return {
    upsertEntityReference(input) {
      return db.transaction((): EntityReferenceRecord => {
        const timestamp = nowIso();
        const bindingsJson = JSON.stringify(input.bindings);
        const existing = db.prepare(
          `SELECT * FROM entity_references
            WHERE session_id = ? AND workspace_id = ? AND admin_user_id = ?
              AND entity_type = ? AND external_id = ?`,
        ).get(
          input.sessionId,
          input.workspaceId,
          input.adminUserId,
          input.entityType,
          input.externalId,
        ) as EntityReferenceRow | undefined;
        if (existing) {
          db.prepare(
            `UPDATE entity_references SET
               display_name = ?, bindings_json = ?, binding_fingerprint = ?,
               source_run_id = ?, status = 'active', verified_at = ?, updated_at = ?
             WHERE id = ?`,
          ).run(
            input.displayName,
            bindingsJson,
            input.bindingFingerprint,
            input.sourceRunId,
            timestamp,
            timestamp,
            existing.id,
          );
          return toRecord(byId(existing.id)!);
        }
        const id = input.id ?? randomUUID();
        db.prepare(
          `INSERT INTO entity_references (
             id, session_id, workspace_id, admin_user_id, entity_type, external_id,
             display_name, bindings_json, binding_fingerprint, source_run_id, status,
             verified_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        ).run(
          id,
          input.sessionId,
          input.workspaceId,
          input.adminUserId,
          input.entityType,
          input.externalId,
          input.displayName,
          bindingsJson,
          input.bindingFingerprint,
          input.sourceRunId,
          timestamp,
          timestamp,
          timestamp,
        );
        return toRecord(byId(id)!);
      })();
    },

    getEntityReference(id, scope) {
      const row = byId(id);
      if (!row) return undefined;
      assertScope(row, scope);
      return toRecord(row);
    },

    listRecentActiveEntityReferences(scope, limit = 20) {
      const rows = db.prepare(
        `SELECT * FROM entity_references
          WHERE workspace_id = ? AND admin_user_id = ? AND session_id = ? AND status = 'active'
          ORDER BY verified_at DESC
          LIMIT ?`,
      ).all(scope.workspaceId, scope.adminUserId, scope.sessionId, limit) as EntityReferenceRow[];
      return rows.map(toRecord);
    },

    markEntityReferenceStatus(id, scope, status) {
      return db.transaction((): EntityReferenceRecord => {
        const row = byId(id);
        if (!row) fail("entity_reference_not_found");
        assertScope(row, scope);
        const timestamp = nowIso();
        db.prepare(
          "UPDATE entity_references SET status = ?, updated_at = ? WHERE id = ?",
        ).run(status, timestamp, id);
        return toRecord(byId(id)!);
      })();
    },
  };
}

export type EntityReferenceStore = ReturnType<typeof buildEntityReferenceStore>;
