import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStore, type Store } from "../../src/db/store.js";
import { createPendingConfirmation } from "../../src/harness/confirmations.js";
import { successReceipt } from "../../src/harness/receipts.js";

const NOW = new Date("2026-07-19T00:00:00.000Z");
const directories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "confirmation-terminal-scrub-"));
  directories.push(directory);
  return join(directory, "store.sqlite");
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function preparedConfirmation(path: string, options: { expired?: boolean } = {}): {
  store: Store;
  confirmationId: string;
  operationId: string;
  sessionId: string;
} {
  const store = createStore(path, { now: () => NOW });
  const session = store.createSession({ workspaceId: "workspace", adminUserId: "admin" });
  const operation = {
    operationId: options.expired ? "operation-expired" : "operation-live",
    actionName: "clockify_tags_update",
    featureGroup: "work_structure" as const,
    risks: ["high_risk_write" as const],
    payload: { id: "tag-1", patch: { name: "Renamed" } },
    mutationPlan: {
      mode: "single" as const,
      maxHostCalls: 2,
      steps: [{ id: "update-tag", kind: "primary" as const }],
    },
  };
  const created = createPendingConfirmation({
    id: options.expired ? "confirmation-expired" : "confirmation-live",
    sessionId: session.id,
    workspaceId: "workspace",
    adminUserId: "admin",
    risk: operation.risks,
    preview: { summary: "Rename tag", target: "tag-1" },
    operation,
    sessionSecret: "secret",
    now: options.expired ? new Date(NOW.getTime() - 10 * 60_000) : NOW,
    agentState: { messages: [{ role: "user", content: "rename it" }] },
  });
  store.prepareOperationRun({
    id: created.record.operationId,
    confirmationId: created.record.id,
    sessionId: session.id,
    workspaceId: "workspace",
    adminUserId: "admin",
    actionName: operation.actionName,
    actionFingerprint: created.record.actionFingerprint,
    catalogHash: created.record.catalogHash,
    operationHash: created.record.operationHash,
    operation,
    mutationPlan: operation.mutationPlan,
  });
  store.savePendingConfirmation(created.record);
  return {
    store,
    confirmationId: created.record.id,
    operationId: created.record.operationId,
    sessionId: session.id,
  };
}

function rawTerminalState(path: string, confirmationId: string, operationId: string): {
  confirmation: Record<string, unknown>;
  operation: Record<string, unknown>;
  result: Record<string, unknown> | undefined;
} {
  const db = new Database(path, { readonly: true });
  const confirmation = db.prepare(
    `SELECT status, nonce_hash, operation_json, agent_state_json, action_result_id
       FROM pending_confirmations WHERE id = ?`,
  ).get(confirmationId) as Record<string, unknown>;
  const operation = db.prepare(
    `SELECT status, operation_json, action_result_id
       FROM operation_runs WHERE id = ?`,
  ).get(operationId) as Record<string, unknown>;
  const result = operation.action_result_id
    ? db.prepare(
        `SELECT kind, result_json, summary_json FROM action_results WHERE id = ?`,
      ).get(operation.action_result_id) as Record<string, unknown> | undefined
    : undefined;
  db.close();
  return { confirmation, operation, result };
}

describe("terminal confirmation executable-payload scrubbing", () => {
  it("atomically cancels a preview, terminalizes its operation, and preserves a truthful passive result", () => {
    const path = databasePath();
    const { store, confirmationId, operationId, sessionId } = preparedConfirmation(path);

    expect(store.cancelConfirmation(confirmationId)).toBe(true);

    expect(store.getPendingConfirmation(confirmationId)).toMatchObject({
      status: "cancelled",
      operation: {},
      nonceHash: "",
      agentState: undefined,
      actionResultId: expect.any(String),
    });
    expect(store.getOperationRun(operationId)).toMatchObject({
      status: "definitive_failed",
      actionResultId: expect.any(String),
    });
    expect(store.getOperationRun(operationId)).not.toHaveProperty("operation");
    expect(store.getOperationRun(operationId)).not.toHaveProperty("mutationPlan");
    const raw = rawTerminalState(path, confirmationId, operationId);
    expect(raw.confirmation).toMatchObject({
      status: "cancelled",
      nonce_hash: "",
      operation_json: null,
      agent_state_json: null,
      action_result_id: raw.operation.action_result_id,
    });
    expect(raw.operation).toMatchObject({
      status: "definitive_failed",
      operation_json: "{}",
      action_result_id: expect.any(String),
    });
    expect(JSON.parse(String(raw.result?.result_json))).toMatchObject({
      kind: "receipt",
      receipt: { ok: false, action: "clockify_tags_update", code: "confirmation_cancelled" },
    });
    expect(store.getScopedOperationRun(operationId, "workspace", "admin", sessionId)).toMatchObject({
      id: operationId,
      actionName: "clockify_tags_update",
      status: "definitive_failed",
      steps: [],
      result: {
        id: raw.operation.action_result_id,
        kind: "definitive_failed",
        summary: {
          kind: "receipt",
          receipt: { ok: false, code: "confirmation_cancelled" },
        },
      },
    });
    store.close();
  });

  it("rolls cancellation back if the linked operation cannot terminalize", () => {
    const path = databasePath();
    const { store, confirmationId, operationId } = preparedConfirmation(path);
    const raw = new Database(path);
    raw.exec(`
      CREATE TRIGGER reject_confirmation_operation_cancel
      BEFORE UPDATE OF status ON operation_runs
      WHEN NEW.id = '${operationId}' AND NEW.status = 'definitive_failed'
      BEGIN
        SELECT RAISE(ABORT, 'forced operation cancellation failure');
      END;
    `);
    raw.close();

    expect(() => store.cancelConfirmation(confirmationId)).toThrow(/forced operation cancellation failure/);
    expect(store.getPendingConfirmation(confirmationId)).toMatchObject({ status: "pending" });
    expect(store.getOperationRun(operationId)).toMatchObject({ status: "prepared" });
    const verify = new Database(path, { readonly: true });
    expect(verify.prepare("SELECT COUNT(*) AS count FROM action_results").get()).toEqual({ count: 0 });
    verify.close();
    store.close();
  });

  it("repairs an older cancelled confirmation whose linked operation was left prepared", () => {
    const path = databasePath();
    const { store, confirmationId, operationId } = preparedConfirmation(path);
    store.close();

    const legacy = new Database(path);
    legacy.exec(`
      DROP TRIGGER pending_confirmation_nonpending_payload_guard;
      DROP TRIGGER pending_confirmation_pre_dispatch_operation_guard;
      DROP TRIGGER pending_confirmation_pre_dispatch_terminal;
    `);
    legacy.prepare(
      `UPDATE pending_confirmations
          SET status = 'cancelled', used_at = ?, nonce_hash = '',
              operation_json = NULL, agent_state_json = NULL
        WHERE id = ?`,
    ).run(NOW.toISOString(), confirmationId);
    expect(legacy.prepare(
      "SELECT status, action_result_id, operation_json FROM operation_runs WHERE id = ?",
    ).get(operationId)).toMatchObject({
      status: "prepared",
      action_result_id: null,
      operation_json: expect.not.stringMatching(/^\{\}$/),
    });
    legacy.close();

    const repaired = createStore(path, { now: () => NOW });
    const state = rawTerminalState(path, confirmationId, operationId);
    expect(state.confirmation).toMatchObject({
      status: "cancelled",
      operation_json: null,
      nonce_hash: "",
      agent_state_json: null,
      action_result_id: state.operation.action_result_id,
    });
    expect(state.operation).toMatchObject({
      status: "definitive_failed",
      operation_json: "{}",
      action_result_id: expect.any(String),
    });
    expect(JSON.parse(String(state.result?.result_json))).toMatchObject({
      kind: "receipt",
      receipt: { code: "confirmation_cancelled" },
    });
    repaired.close();

    const reopened = createStore(path, { now: () => NOW });
    const verify = new Database(path, { readonly: true });
    expect(verify.prepare("SELECT COUNT(*) AS count FROM action_results WHERE operation_id = ?")
      .get(operationId)).toEqual({ count: 1 });
    verify.close();
    reopened.close();
  });

  it.each(["load", "list", "count"] as const)(
    "expires and scrubs the linked prepared operation through the %s path",
    (pathKind) => {
      const path = databasePath();
      const { store, confirmationId, operationId, sessionId } = preparedConfirmation(path, { expired: true });

      if (pathKind === "load") {
        expect(store.getPendingConfirmation(confirmationId)?.status).toBe("expired");
      } else if (pathKind === "list") {
        expect(store.listPendingConfirmations(sessionId, NOW.toISOString())).toEqual([]);
      } else {
        expect(store.countPendingConfirmations(sessionId, NOW.toISOString())).toBe(0);
      }

      const raw = rawTerminalState(path, confirmationId, operationId);
      expect(raw.confirmation).toMatchObject({
        status: "expired",
        nonce_hash: "",
        operation_json: null,
        agent_state_json: null,
        action_result_id: raw.operation.action_result_id,
      });
      expect(raw.operation).toMatchObject({
        status: "definitive_failed",
        operation_json: "{}",
        action_result_id: expect.any(String),
      });
      expect(JSON.parse(String(raw.result?.result_json))).toMatchObject({
        kind: "receipt",
        receipt: { ok: false, action: "clockify_tags_update", code: "confirmation_expired" },
      });
      store.close();
    },
  );

  it("expires a linked operation atomically inside the bounded retention update", async () => {
    const path = databasePath();
    const { store, confirmationId, operationId } = preparedConfirmation(path, { expired: true });

    const counts = await store.pruneExpired(NOW.toISOString());

    expect(counts.expiredConfirmations).toBe(1);
    const raw = rawTerminalState(path, confirmationId, operationId);
    expect(raw.confirmation).toMatchObject({
      status: "expired",
      operation_json: null,
      nonce_hash: "",
      agent_state_json: null,
      action_result_id: raw.operation.action_result_id,
    });
    expect(raw.operation).toMatchObject({
      status: "definitive_failed",
      operation_json: "{}",
      action_result_id: expect.any(String),
    });
    store.close();
  });

  it("scrubs the executable operation and plan on successful settlement but keeps steps and canonical receipt", () => {
    const path = databasePath();
    const { store, confirmationId, operationId } = preparedConfirmation(path);
    expect(store.markConfirmationExecuting(confirmationId)).toBe(true);
    const stepId = store.prepareOperationStep({
      operationId,
      planStepId: "update-tag",
      index: 0,
      name: "Update tag",
      kind: "primary",
      preparedDetail: { method: "PUT", body: { name: "Renamed" } },
    });
    expect(store.markOperationStepExecuting(stepId, operationId)).toBe(true);
    expect(store.markOperationStepDispatched(stepId, operationId)).toBe(true);
    store.settleOperationStep(stepId, "succeeded", { externalId: "tag-1" }, operationId);

    const ref = store.settleConfirmedOperation(
      confirmationId,
      "succeeded",
      "clockify_tags_update",
      successReceipt({ action: "clockify_tags_update", changed: { updated: [{ type: "tag", id: "tag-1" }] } }),
    );

    const raw = rawTerminalState(path, confirmationId, operationId);
    expect(raw.operation).toMatchObject({
      status: "succeeded",
      operation_json: "{}",
      action_result_id: ref.id,
    });
    expect(store.getOperationRun(operationId)).not.toHaveProperty("operation");
    expect(store.getOperationRun(operationId)).not.toHaveProperty("mutationPlan");
    expect(store.listOperationSteps(operationId)).toMatchObject([{
      id: stepId,
      status: "succeeded",
      externalId: "tag-1",
    }]);
    expect(store.getActionResult(ref.id)).toMatchObject({
      kind: "receipt",
      receipt: { ok: true, action: "clockify_tags_update" },
    });
    store.close();
  });
});
