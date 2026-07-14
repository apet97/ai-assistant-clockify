import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/server.js";
import { createStore, type Store } from "../../src/db/store.js";
import { makeTestConfig } from "../helpers/config.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";
import { signSessionCookie } from "../../src/auth/sessions.js";
import { buildSessionCookie } from "../../src/routes/deps.js";

const stores: Store[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

function setup() {
  const store = createStore(":memory:", { encryptionKey: "test-key" });
  stores.push(store);
  const config = makeTestConfig();
  const fake = createFakeWorkspace();
  const app = createApp({
    config,
    store,
    parser: {} as never,
    modelClient: { complete: async () => "ok" },
    clockifyForWorkspace: () => fake.client,
  });
  return { store, config, app };
}

function ownedSession(store: Store, secret: string, workspaceId = "ws-1", adminUserId = "admin-1") {
  const session = store.createSession({ workspaceId, adminUserId });
  const cookie = buildSessionCookie(signSessionCookie({
    sessionId: session.id,
    workspaceId,
    adminUserId,
    workspaceRole: "ADMIN",
    expiresAt: session.expiresAt,
  }, secret), false).split(";")[0];
  return { session, cookie };
}

describe("GET /api/operation-runs/:operationId", () => {
  it("returns only bounded allowlisted scoped status, reconciliation, summary, plan, steps, and timestamps", async () => {
    const { store, app, config } = setup();
    const { session, cookie } = ownedSession(store, config.sessionSecret);
    const planSteps = Array.from({ length: 80 }, (_, index) => ({ id: `step-${index}`, kind: "primary" as const }));
    store.prepareOperationRun({
      id: "operation-owned",
      sessionId: session.id,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      actionName: "clockify_<script>alert(1)</script>",
      actionFingerprint: "af",
      catalogHash: "ch",
      operationHash: "oh",
      operation: {
        huge: "x".repeat(200_000),
      },
      mutationPlan: { mode: "batch", steps: planSteps },
    });
    store.markOperationExecuting("operation-owned");
    let reconciledStep = "";
    for (let index = 0; index < planSteps.length; index += 1) {
      const stepId = store.prepareOperationStep({
        operationId: "operation-owned",
        planStepId: `step-${index}`,
        index,
        name: `Write <script>${index}</script>`,
        kind: "primary",
      });
      store.markOperationStepExecuting(stepId);
      if (index === 0) {
        store.settleOperationStep(stepId, "outcome_unknown", { detail: { token: "STEP_SECRET" } });
        store.recordOperationReconciliation("operation-owned", stepId, {
          token: "RECONCILIATION_SECRET",
          headers: { Authorization: "secret" },
          huge: "z".repeat(200_000),
          reason: "authoritative_match",
        }, true);
        store.settleReconciledStep(stepId, "succeeded", { detail: { token: "STEP_SECRET" } });
        reconciledStep = stepId;
      } else {
        store.settleOperationStep(stepId, "succeeded", {
          effect: { token: "STEP_SECRET", bytes: new Uint8Array([1, 2]) },
          detail: { headers: "SECRET" },
        });
      }
    }
    store.settleOperationResult("operation-owned", "succeeded", {
      kind: "receipt",
      receipt: {
        ok: true,
        action: "clockify_<script>alert(1)</script>",
        token: "SUMMARY_SECRET",
        headers: { Authorization: "secret" },
        attachment: { type: "Buffer", data: [1, 2, 3, 4] },
        pixels: { 0: 255, 1: 0, 2: 128 },
        message: "<img src=x onerror=alert(2)>",
      },
    });

    const response = await request(app).get("/api/operation-runs/operation-owned").set("Cookie", cookie);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      operation: {
        id: "operation-owned",
        actionName: "clockify_<script>alert(1)</script>",
        status: "succeeded",
        plan: { mode: "batch" },
        result: { kind: "succeeded" },
        reconciliation: { authoritative: true, stepId: reconciledStep },
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        reconciledAt: expect.any(String),
      },
    });
    expect(response.body.operation.steps[0]).toMatchObject({ planStepId: "step-0", status: "succeeded" });
    expect(response.body.operation.plan.steps.length).toBeLessThan(planSteps.length);
    expect(response.body.operation.steps.length).toBeLessThan(planSteps.length);
    expect(response.body.operation).not.toHaveProperty("operation");
    const encoded = JSON.stringify(response.body);
    expect(encoded).not.toContain("SECRET");
    expect(encoded).not.toContain("Authorization");
    expect(encoded).not.toContain("effect");
    expect(encoded).not.toContain("detail");
    expect(Buffer.byteLength(encoded, "utf8")).toBeLessThan(80_000);
  });

  it("returns the same scoped 404 for another workspace, admin, or session", async () => {
    const { store, app, config } = setup();
    const owner = ownedSession(store, config.sessionSecret);
    store.prepareOperationRun({
      id: "private-operation",
      sessionId: owner.session.id,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      actionName: "a",
      actionFingerprint: "af",
      catalogHash: "ch",
      operationHash: "oh",
    });
    for (const outsider of [
      ownedSession(store, config.sessionSecret, "ws-2", "admin-1"),
      ownedSession(store, config.sessionSecret, "ws-1", "admin-2"),
      ownedSession(store, config.sessionSecret, "ws-1", "admin-1"),
    ]) {
      const response = await request(app).get("/api/operation-runs/private-operation").set("Cookie", outsider.cookie);
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ ok: false, code: "not_found", message: "Operation not found." });
    }
  });

  it("does not expose a foreign-scope canonical result through a corrupted operation link", async () => {
    const { store, app, config } = setup();
    const owner = ownedSession(store, config.sessionSecret);
    const foreign = ownedSession(store, config.sessionSecret, "ws-foreign", "admin-foreign");
    store.prepareOperationRun({
      id: "cross-linked-operation", sessionId: owner.session.id, workspaceId: "ws-1", adminUserId: "admin-1",
      actionName: "owned-action", actionFingerprint: "af", catalogHash: "ch", operationHash: "oh",
    });
    const foreignResult = store.recordActionResult({
      workspaceId: "ws-foreign", adminUserId: "admin-foreign", sessionId: foreign.session.id,
      actionName: "foreign-action", status: "succeeded",
      result: { kind: "receipt", receipt: { ok: true, action: "foreign-action", message: "FOREIGN_RESULT_SECRET" } },
    });
    // Model a corrupt/legacy cross-scope foreign key. The scoped view's SQL join
    // must re-check every tenant dimension instead of trusting action_result_id.
    store.settleOperationRun("cross-linked-operation", "succeeded", foreignResult.id);

    const response = await request(app).get("/api/operation-runs/cross-linked-operation").set("Cookie", owner.cookie);
    expect(response.status).toBe(200);
    expect(response.body.operation).not.toHaveProperty("result");
    expect(JSON.stringify(response.body)).not.toContain("FOREIGN_RESULT_SECRET");
  });

  it("fails closed over malformed persisted plan entries without exposing their payload", async () => {
    const { store, app, config } = setup();
    const owner = ownedSession(store, config.sessionSecret);
    store.prepareOperationRun({
      id: "malformed-plan", sessionId: owner.session.id, workspaceId: "ws-1", adminUserId: "admin-1",
      actionName: "owned-action", actionFingerprint: "af", catalogHash: "ch", operationHash: "oh",
      mutationPlan: {
        mode: "single",
        steps: [
          { id: 7, kind: "primary", payload: { note: "MALFORMED_PLAN_MARKER" } },
          { id: "valid", kind: "not-a-kind", detail: "MALFORMED_PLAN_MARKER" },
        ],
      } as never,
    });

    const response = await request(app).get("/api/operation-runs/malformed-plan").set("Cookie", owner.cookie);
    expect(response.status).toBe(200);
    expect(response.body.operation.plan).toMatchObject({ mode: "single", steps: [], truncated: true });
    expect(JSON.stringify(response.body)).not.toContain("MALFORMED_PLAN_MARKER");
  });
});
