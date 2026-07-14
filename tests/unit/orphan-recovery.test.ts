import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStore } from "../../src/db/store.js";
import { createPendingConfirmation } from "../../src/harness/confirmations.js";

const directories: string[] = [];

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "assistant-orphan-"));
  directories.push(directory);
  return join(directory, "db.sqlite");
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("orphaned execution recovery", () => {
  it("records one canonical unknown result and scrubs an executing confirmation", () => {
    const path = databasePath();
    const store = createStore(path, { encryptionKey: "k" });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    const created = createPendingConfirmation({
      sessionId: session.id,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      risk: ["high_risk_write"],
      preview: { summary: "Update a client" },
      operation: {
        operationId: "op-confirmation",
        actionName: "clockify_clients_update",
        featureGroup: "work_structure",
        risks: ["high_risk_write"],
        payload: { clientId: "client-1", name: "new name" },
      },
      sessionSecret: "secret",
      agentState: { messages: [{ role: "user", content: "change it" }] },
    });
    store.savePendingConfirmation(created.record);
    store.prepareOperationRun({
      id: created.record.operationId,
      confirmationId: created.record.id,
      sessionId: session.id,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      actionName: "clockify_clients_update",
      actionFingerprint: created.record.actionFingerprint,
      catalogHash: created.record.catalogHash,
      operationHash: created.record.operationHash,
    });
    expect(store.markConfirmationExecuting(created.record.id)).toBe(true);
    store.close();

    const recovered = createStore(path, { encryptionKey: "k" });
    const confirmation = recovered.getPendingConfirmation(created.record.id);
    expect(confirmation).toMatchObject({
      status: "outcome_unknown",
      nonceHash: "",
      operation: {},
      agentState: undefined,
    });
    expect(confirmation?.actionResultId).toBeDefined();
    expect(recovered.getOperationRun(created.record.operationId)).toMatchObject({
      status: "outcome_unknown",
      actionResultId: confirmation?.actionResultId,
    });
    expect(recovered.getActionResult(confirmation!.actionResultId!)).toMatchObject({
      kind: "receipt",
      receipt: { ok: false, action: "clockify_clients_update", code: "commit_outcome_unknown" },
    });
    recovered.close();

    const db = new Database(path, { readonly: true });
    const raw = db.prepare(
      "SELECT nonce_hash, operation_json, agent_state_json, action_result_id FROM pending_confirmations WHERE id = ?",
    ).get(created.record.id) as Record<string, unknown>;
    expect(raw).toMatchObject({
      nonce_hash: "",
      operation_json: null,
      agent_state_json: null,
      action_result_id: confirmation?.actionResultId,
    });
    expect((db.prepare("SELECT COUNT(*) AS count FROM action_results").get() as { count: number }).count).toBe(1);
    db.close();
  });

  it("records one canonical unknown result for an orphaned safe-write operation", () => {
    const path = databasePath();
    const store = createStore(path, { encryptionKey: "k" });
    const operationId = store.prepareOperationRun({
      id: "op-safe-write",
      requestId: "request-1",
      sessionId: "session-1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      actionName: "clockify_tags_create",
      actionFingerprint: "fingerprint",
      catalogHash: "catalog",
      operationHash: "operation",
    });
    expect(store.markOperationExecuting(operationId)).toBe(true);
    store.close();

    const recovered = createStore(path, { encryptionKey: "k" });
    const operation = recovered.getOperationRun(operationId);
    expect(operation).toMatchObject({ status: "outcome_unknown" });
    expect(operation?.actionResultId).toBeDefined();
    expect(recovered.getActionResult(operation!.actionResultId!)).toMatchObject({
      kind: "receipt",
      receipt: { ok: false, action: "clockify_tags_create", code: "commit_outcome_unknown" },
    });
    recovered.close();

    const db = new Database(path, { readonly: true });
    expect((db.prepare("SELECT COUNT(*) AS count FROM action_results").get() as { count: number }).count).toBe(1);
    db.close();
  });
});
