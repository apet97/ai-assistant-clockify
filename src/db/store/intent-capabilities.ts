import { randomUUID } from "node:crypto";
import {
  hashIntentCapability,
  parseIntentCapabilityV1,
  type IntentCapabilityV1,
} from "../../harness/intent-capability.js";
import type { StoreContext } from "./context.js";

export interface IntentCapabilityScope {
  workspaceId: string;
  adminUserId: string;
  sessionId: string;
  requestId: string;
  requestHash: string;
  catalogHash: string;
}

export interface CreateIntentCapabilityInput extends Omit<IntentCapabilityScope, "requestHash" | "catalogHash"> {
  id?: string;
  authoredSource: string;
  capability: IntentCapabilityV1;
}

export interface IntentCapabilityRecord extends IntentCapabilityScope {
  id: string;
  capabilityHash: string;
  capability: IntentCapabilityV1;
  createdAt: string;
}

export interface BindIntentCapabilityOperationInput extends IntentCapabilityScope {
  capabilityId: string;
  capabilityHash: string;
  operationId: string;
  confirmationId?: string;
  actionName: string;
}

/** Confirm/resume lookup surface. Request identity is derived from the durable
 * operation→capability binding rather than trusted from a client/AgentState. */
export interface IntentCapabilityOperationScope {
  operationId: string;
  workspaceId: string;
  adminUserId: string;
  sessionId: string;
  capabilityId: string;
  capabilityHash: string;
  expectedCatalogHash?: string;
  expectedActionName?: string;
}

export type BindIntentCapabilityOperationResult = { state: "bound" | "replay" };

export type ConsumeIntentCapabilityExecutionResult =
  | { state: "consumed" | "replay"; execution: number }
  | { state: "denied"; reason: "deny_all_writes" | "action_not_declared" | "execution_limit" };

export class IntentCapabilityStoreError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "IntentCapabilityStoreError";
  }
}

interface CapabilityRow {
  id: string;
  workspace_id: string;
  admin_user_id: string;
  session_id: string;
  request_id: string;
  request_hash: string;
  catalog_hash: string;
  capability_hash: string;
  capability_json: string;
  created_at: string;
}

interface OperationBindingRow {
  id: string;
  request_id: string | null;
  confirmation_id: string | null;
  session_id: string;
  workspace_id: string;
  admin_user_id: string;
  action_name: string;
  catalog_hash: string;
  capability_id: string | null;
  capability_hash: string | null;
}

function fail(code: string): never {
  throw new IntentCapabilityStoreError(code);
}

function toRecord(row: CapabilityRow): IntentCapabilityRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    adminUserId: row.admin_user_id,
    sessionId: row.session_id,
    requestId: row.request_id,
    requestHash: row.request_hash,
    catalogHash: row.catalog_hash,
    capabilityHash: row.capability_hash,
    capability: parseIntentCapabilityV1(JSON.parse(row.capability_json) as unknown),
    createdAt: row.created_at,
  };
}

function assertScope(row: CapabilityRow, scope: IntentCapabilityScope, capabilityHash?: string): void {
  if (row.workspace_id !== scope.workspaceId) fail("intent_capability_workspace_drift");
  if (row.admin_user_id !== scope.adminUserId) fail("intent_capability_admin_drift");
  if (row.session_id !== scope.sessionId) fail("intent_capability_session_drift");
  if (row.request_id !== scope.requestId || row.request_hash !== scope.requestHash) {
    fail("intent_capability_request_drift");
  }
  if (row.catalog_hash !== scope.catalogHash) fail("intent_capability_catalog_drift");
  if (capabilityHash !== undefined && row.capability_hash !== capabilityHash) {
    fail("intent_capability_hash_drift");
  }
}

export function buildIntentCapabilityStore(ctx: StoreContext): {
  createIntentCapability(input: CreateIntentCapabilityInput): IntentCapabilityRecord;
  getIntentCapability(id: string, scope: IntentCapabilityScope): IntentCapabilityRecord | undefined;
  getIntentCapabilityForOperation(input: IntentCapabilityOperationScope): IntentCapabilityRecord;
  bindIntentCapabilityOperation(input: BindIntentCapabilityOperationInput): BindIntentCapabilityOperationResult;
  consumeIntentCapabilityExecution(input: BindIntentCapabilityOperationInput): ConsumeIntentCapabilityExecutionResult;
  consumeIntentCapabilityForOperation(input: IntentCapabilityOperationScope): ConsumeIntentCapabilityExecutionResult;
} {
  const { db, nowIso } = ctx;

  const capabilityById = (id: string): CapabilityRow | undefined => db.prepare(
    "SELECT * FROM intent_capabilities WHERE id = ?",
  ).get(id) as CapabilityRow | undefined;

  const scopedCapability = (
    id: string,
    scope: IntentCapabilityScope,
    capabilityHash?: string,
  ): CapabilityRow => {
    const row = capabilityById(id);
    if (!row) return fail("intent_capability_not_found");
    assertScope(row, scope, capabilityHash);
    return row;
  };

  const operationBinding = (input: BindIntentCapabilityOperationInput): OperationBindingRow => {
    const operation = db.prepare(
      `SELECT id, request_id, confirmation_id, session_id, workspace_id, admin_user_id,
              action_name, catalog_hash, capability_id, capability_hash
         FROM operation_runs WHERE id = ?`,
    ).get(input.operationId) as OperationBindingRow | undefined;
    if (!operation) return fail("intent_capability_operation_not_found");
    if (operation.workspace_id !== input.workspaceId) fail("intent_capability_workspace_drift");
    if (operation.admin_user_id !== input.adminUserId) fail("intent_capability_admin_drift");
    if (operation.session_id !== input.sessionId) fail("intent_capability_session_drift");
    if (operation.request_id !== input.requestId) fail("intent_capability_request_drift");
    if (operation.catalog_hash !== input.catalogHash) fail("intent_capability_catalog_drift");
    if (operation.action_name !== input.actionName) fail("intent_capability_action_drift");
    return operation;
  };

  const capabilityForOperation = (
    input: IntentCapabilityOperationScope,
  ): { record: IntentCapabilityRecord; operation: OperationBindingRow } => {
    const operation = db.prepare(
      `SELECT id, request_id, confirmation_id, session_id, workspace_id, admin_user_id,
              action_name, catalog_hash, capability_id, capability_hash
         FROM operation_runs WHERE id = ?`,
    ).get(input.operationId) as OperationBindingRow | undefined;
    if (!operation) return fail("intent_capability_operation_not_found");
    if (operation.workspace_id !== input.workspaceId) fail("intent_capability_workspace_drift");
    if (operation.admin_user_id !== input.adminUserId) fail("intent_capability_admin_drift");
    if (operation.session_id !== input.sessionId) fail("intent_capability_session_drift");
    if (operation.capability_id === null || operation.capability_hash === null) {
      fail("intent_capability_binding_missing");
    }
    if (operation.capability_id !== input.capabilityId) fail("intent_capability_binding_drift");
    if (operation.capability_hash !== input.capabilityHash) fail("intent_capability_hash_drift");

    const capabilityRow = capabilityById(operation.capability_id);
    if (!capabilityRow) return fail("intent_capability_not_found");
    if (capabilityRow.workspace_id !== operation.workspace_id) fail("intent_capability_workspace_drift");
    if (capabilityRow.admin_user_id !== operation.admin_user_id) fail("intent_capability_admin_drift");
    if (capabilityRow.session_id !== operation.session_id) fail("intent_capability_session_drift");
    if (capabilityRow.request_id !== operation.request_id) fail("intent_capability_request_drift");
    if (capabilityRow.catalog_hash !== operation.catalog_hash ||
      (input.expectedCatalogHash !== undefined && operation.catalog_hash !== input.expectedCatalogHash)) {
      fail("intent_capability_catalog_drift");
    }
    if (input.expectedActionName !== undefined && operation.action_name !== input.expectedActionName) {
      fail("intent_capability_action_drift");
    }
    const record = toRecord(capabilityRow);
    if (record.capability.requestHash !== capabilityRow.request_hash) fail("intent_capability_request_drift");
    if (record.capability.catalogHash !== capabilityRow.catalog_hash) fail("intent_capability_catalog_drift");
    if (record.capabilityHash !== operation.capability_hash ||
      hashIntentCapability(record.capability) !== record.capabilityHash) {
      fail("intent_capability_hash_drift");
    }
    if (!record.capability.writeActions.some((action) => action.actionName === operation.action_name)) {
      fail("intent_capability_action_drift");
    }
    return { record, operation };
  };

  const consumeBoundOperation = (
    record: IntentCapabilityRecord,
    operationId: string,
    actionName: string,
  ): ConsumeIntentCapabilityExecutionResult => {
    if (record.capability.mode === "deny_all_writes") return { state: "denied", reason: "deny_all_writes" };
    const grant = record.capability.writeActions.find((action) => action.actionName === actionName);
    if (!grant) return { state: "denied", reason: "action_not_declared" };
    const existing = db.prepare(
      `SELECT capability_id, action_name, execution_index
         FROM intent_capability_usage WHERE operation_id = ?`,
    ).get(operationId) as {
      capability_id: string;
      action_name: string;
      execution_index: number;
    } | undefined;
    if (existing) {
      if (existing.capability_id !== record.id || existing.action_name !== actionName) {
        fail("intent_capability_usage_drift");
      }
      return { state: "replay", execution: existing.execution_index };
    }
    const count = (db.prepare(
      `SELECT COUNT(*) AS count FROM intent_capability_usage
        WHERE capability_id = ? AND action_name = ?`,
    ).get(record.id, actionName) as { count: number }).count;
    if (count >= grant.maxExecutions) return { state: "denied", reason: "execution_limit" };
    const execution = count + 1;
    db.prepare(
      `INSERT INTO intent_capability_usage (
         id, capability_id, operation_id, action_name, execution_index, created_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), record.id, operationId, actionName, execution, nowIso());
    return { state: "consumed", execution };
  };

  return {
    createIntentCapability(input) {
      const capability = parseIntentCapabilityV1(input.capability, input.authoredSource);
      const capabilityHash = hashIntentCapability(capability);
      const id = input.id ?? randomUUID();
      return db.transaction((): IntentCapabilityRecord => {
        const existing = db.prepare(
          `SELECT * FROM intent_capabilities
            WHERE workspace_id = ? AND admin_user_id = ? AND session_id = ? AND request_id = ?`,
        ).get(input.workspaceId, input.adminUserId, input.sessionId, input.requestId) as CapabilityRow | undefined;
        if (existing) {
          assertScope(existing, {
            workspaceId: input.workspaceId,
            adminUserId: input.adminUserId,
            sessionId: input.sessionId,
            requestId: input.requestId,
            requestHash: capability.requestHash,
            catalogHash: capability.catalogHash,
          }, capabilityHash);
          return toRecord(existing);
        }
        const createdAt = nowIso();
        db.prepare(
          `INSERT INTO intent_capabilities (
             id, workspace_id, admin_user_id, session_id, request_id, request_hash,
             catalog_hash, capability_hash, mode, capability_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          input.workspaceId,
          input.adminUserId,
          input.sessionId,
          input.requestId,
          capability.requestHash,
          capability.catalogHash,
          capabilityHash,
          capability.mode,
          JSON.stringify(capability),
          createdAt,
        );
        return {
          id,
          workspaceId: input.workspaceId,
          adminUserId: input.adminUserId,
          sessionId: input.sessionId,
          requestId: input.requestId,
          requestHash: capability.requestHash,
          catalogHash: capability.catalogHash,
          capabilityHash,
          capability,
          createdAt,
        };
      })();
    },

    getIntentCapability(id, scope) {
      const row = capabilityById(id);
      if (!row) return undefined;
      assertScope(row, scope);
      return toRecord(row);
    },

    getIntentCapabilityForOperation(input) {
      return capabilityForOperation(input).record;
    },

    bindIntentCapabilityOperation(input) {
      return db.transaction((): BindIntentCapabilityOperationResult => {
        const capabilityRow = scopedCapability(input.capabilityId, input, input.capabilityHash);
        const capability = toRecord(capabilityRow).capability;
        const operation = operationBinding(input);
        const grant = capability.writeActions.find((action) => action.actionName === input.actionName);
        if (!grant) fail("intent_capability_action_denied");
        if ((operation.capability_id === null) !== (operation.capability_hash === null)) {
          fail("intent_capability_binding_drift");
        }
        if (operation.capability_id !== null &&
          (operation.capability_id !== input.capabilityId || operation.capability_hash !== input.capabilityHash)) {
          fail("intent_capability_binding_drift");
        }

        const confirmationId = input.confirmationId ?? operation.confirmation_id;
        let confirmation: {
          operation_id: string;
          session_id: string;
          workspace_id: string;
          admin_user_id: string;
          catalog_hash: string;
          capability_id: string | null;
          capability_hash: string | null;
        } | undefined;
        if (confirmationId) {
          confirmation = db.prepare(
            `SELECT operation_id, session_id, workspace_id, admin_user_id, catalog_hash,
                    capability_id, capability_hash
               FROM pending_confirmations WHERE id = ?`,
          ).get(confirmationId) as typeof confirmation;
          if (!confirmation || confirmation.operation_id !== input.operationId) {
            fail("intent_capability_confirmation_drift");
          }
          if (confirmation.workspace_id !== input.workspaceId) fail("intent_capability_workspace_drift");
          if (confirmation.admin_user_id !== input.adminUserId) fail("intent_capability_admin_drift");
          if (confirmation.session_id !== input.sessionId) fail("intent_capability_session_drift");
          if (confirmation.catalog_hash !== input.catalogHash) fail("intent_capability_catalog_drift");
          if ((confirmation.capability_id === null) !== (confirmation.capability_hash === null)) {
            fail("intent_capability_binding_drift");
          }
          if (confirmation.capability_id !== null &&
            (confirmation.capability_id !== input.capabilityId || confirmation.capability_hash !== input.capabilityHash)) {
            fail("intent_capability_binding_drift");
          }
        }

        const replay = operation.capability_id !== null &&
          (!confirmation || confirmation.capability_id !== null) &&
          (confirmationId === undefined || operation.confirmation_id === confirmationId);
        if (replay) return { state: "replay" };

        const operationUpdate = db.prepare(
          `UPDATE operation_runs
              SET capability_id = ?, capability_hash = ?, confirmation_id = COALESCE(confirmation_id, ?)
            WHERE id = ? AND capability_id IS NULL AND capability_hash IS NULL
              AND (confirmation_id IS NULL OR confirmation_id = ?)`,
        ).run(input.capabilityId, input.capabilityHash, confirmationId ?? null, input.operationId, confirmationId ?? null);
        if (operation.capability_id === null && operationUpdate.changes !== 1) {
          fail("intent_capability_binding_drift");
        }
        if (confirmationId && confirmation?.capability_id === null) {
          const confirmationUpdate = db.prepare(
            `UPDATE pending_confirmations SET capability_id = ?, capability_hash = ?
              WHERE id = ? AND operation_id = ? AND capability_id IS NULL AND capability_hash IS NULL`,
          ).run(input.capabilityId, input.capabilityHash, confirmationId, input.operationId);
          if (confirmationUpdate.changes !== 1) fail("intent_capability_binding_drift");
        }
        return { state: "bound" };
      })();
    },

    consumeIntentCapabilityExecution(input) {
      return db.transaction((): ConsumeIntentCapabilityExecutionResult => {
        const capabilityRow = scopedCapability(input.capabilityId, input, input.capabilityHash);
        const operation = operationBinding(input);
        if (operation.capability_id !== input.capabilityId || operation.capability_hash !== input.capabilityHash) {
          fail("intent_capability_binding_missing");
        }
        return consumeBoundOperation(toRecord(capabilityRow), input.operationId, input.actionName);
      }).immediate();
    },

    consumeIntentCapabilityForOperation(input) {
      return db.transaction((): ConsumeIntentCapabilityExecutionResult => {
        const { record, operation } = capabilityForOperation(input);
        return consumeBoundOperation(record, operation.id, operation.action_name);
      }).immediate();
    },
  };
}
