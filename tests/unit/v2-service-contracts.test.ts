import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as contracts from "../../src/shared/contracts.js";
import { runScopeSchema } from "../../src/assistant-v2/protocol.js";
import {
  chatBodySchema,
  confirmBatchBodySchema,
  confirmBodySchema,
  resolveClarificationBodySchema,
  uuidIdSchema,
} from "../../src/routes/request-schemas.js";
import { createRunEventService } from "../../src/services/run-event-service.js";
import { createStore } from "../../src/db/store.js";
import { computeRequestHash } from "../../src/assistant-v2/state.js";
import {
  createPermissionService,
  PERMISSION_PREVIEW_TTL_MS,
} from "../../src/services/permission-service.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";

/**
 * T16-A/T16-B: the frozen v2 service contracts.
 *
 * - Request DTOs validate the exact ID class (server-minted UUIDs) and reject
 *   unknown fields.
 * - A run scope can never silently drop a security field.
 * - Service and contract modules carry no HTTP objects, no service locator
 *   (`AppDeps`), and no `any` escape hatches.
 * - `src/shared/contracts.ts` is type-only: nothing from it can ever reach the
 *   UI bundle as runtime code (the 21 KiB gzip budget depends on this).
 * - `RunEventService` exposes ONLY named composite transition methods — no
 *   generic append, no caller-selected event type — and each method validates
 *   its closed payload before touching the store.
 * - Provider attempt 2 belongs to the same logical model call and must not
 *   increment the model-call denominator (T16-B).
 */

const ROOT = join(__dirname, "..", "..");

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

const VALID_UUID = "3f2f9c9a-9b1a-4c6e-8a2e-1d2c3b4a5f60";

describe("request DTO ID classes (T16-A)", () => {
  it("uuidIdSchema accepts a v4 UUID and rejects other shapes", () => {
    expect(uuidIdSchema.safeParse(VALID_UUID).success).toBe(true);
    for (const bad of ["", "abc", "123", `${VALID_UUID} `, "674ad1305c701cc5be7c26fe"]) {
      expect(uuidIdSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("chatBodySchema requires UUID requestId/continuationRunId and rejects unknown fields", () => {
    expect(chatBodySchema.safeParse({ message: "hi", requestId: VALID_UUID }).success).toBe(true);
    expect(chatBodySchema.safeParse({ message: "hi", requestId: "not-a-uuid" }).success).toBe(false);
    expect(chatBodySchema.safeParse({ message: "hi", continuationRunId: "run-1" }).success).toBe(false);
    expect(chatBodySchema.safeParse({ message: "hi", extra: true }).success).toBe(false);
  });

  it("confirm bodies are strict and batch items require UUID confirmation ids", () => {
    expect(confirmBodySchema.safeParse({ nonce: "n" }).success).toBe(true);
    expect(confirmBodySchema.safeParse({ nonce: "n", groups: {} }).success).toBe(false);
    expect(confirmBatchBodySchema.safeParse({
      items: [{ confirmationId: VALID_UUID, nonce: "n" }],
    }).success).toBe(true);
    expect(confirmBatchBodySchema.safeParse({
      items: [{ confirmationId: "confirmation-1", nonce: "n" }],
    }).success).toBe(false);
    expect(resolveClarificationBodySchema.safeParse({ optionId: "a" }).success).toBe(true);
    expect(resolveClarificationBodySchema.safeParse({ optionId: "a", label: "x" }).success).toBe(false);
  });
});

describe("run scope security fields (T16-A)", () => {
  const scope = {
    sessionId: "s-1",
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    installationGeneration: 1,
    authClass: "addon",
  };

  it("accepts a complete scope and rejects any missing security field", () => {
    expect(runScopeSchema.safeParse(scope).success).toBe(true);
    for (const key of Object.keys(scope)) {
      const partial: Record<string, unknown> = { ...scope };
      delete partial[key];
      expect(runScopeSchema.safeParse(partial).success).toBe(false);
    }
  });

  it("rejects unknown keys and unknown auth classes", () => {
    expect(runScopeSchema.safeParse({ ...scope, extra: 1 }).success).toBe(false);
    expect(runScopeSchema.safeParse({ ...scope, authClass: "anonymous" }).success).toBe(false);
  });
});

describe("service/contract module hygiene (T16-A)", () => {
  const serviceFiles = readdirSync(join(ROOT, "src", "services"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `src/services/${f}`);
  const contractFiles = ["src/assistant-v2/protocol.ts", "src/shared/contracts.ts"];

  it("services and contracts never import express or carry HTTP request/response objects", () => {
    for (const file of [...serviceFiles, ...contractFiles]) {
      const source = read(file);
      expect(source, `${file} must not import express`).not.toMatch(/from "express"/);
      expect(source, `${file} must not type HTTP objects`).not.toMatch(/\b(?:Request|Response)\b\s*(?:,|\})?\s*from "express"/);
    }
  });

  it("services never take the whole AppDeps bag (no service locator)", () => {
    for (const file of serviceFiles) {
      expect(read(file), `${file} must depend on narrow ports, not AppDeps`).not.toMatch(/\bAppDeps\b/);
    }
  });

  it("services and contracts contain no `any` escape hatches", () => {
    for (const file of [...serviceFiles, ...contractFiles]) {
      const source = read(file);
      expect(source, `${file} must not use : any`).not.toMatch(/:\s*any\b/);
      expect(source, `${file} must not use as any`).not.toMatch(/\bas any\b/);
    }
  });

  it("shared/contracts.ts is type-only: its runtime module namespace is empty", () => {
    // Type-only exports are erased by tsc; any runtime binding here would be
    // bundled into the UI and squeeze the 21 KiB gzip budget.
    expect(Object.keys(contracts)).toEqual([]);
  });
});

describe("RunEventService is closed to named transitions (T16-B)", () => {
  const NAMED_TRANSITIONS = [
    "startRun",
    "reserveModelCall",
    "completeModelCall",
    "reserveDiscoveryCall",
    "loadOperations",
    "requestTool",
    "denyTool",
    "startTool",
    "completeTool",
    "requireClarification",
    // F23: the atomic question+suspension composite — still a NAMED
    // transition, not a generic append.
    "requireClarificationAndSuspend",
    "suspendRun",
    "completeRun",
    "failRun",
  ].sort();

  function fakeStore() {
    const call = vi.fn(() => ({ sequence: 1, eventType: "model.started", payload: {}, createdAt: "" }));
    return {
      startRunWithEvent: call,
      reserveModelCallWithEvent: call,
      completeModelCallWithEvent: call,
      reserveDiscoveryCallWithEvent: call,
      loadOperationsWithEvent: call,
      requestToolWithEvent: call,
      denyToolWithEvent: call,
      startToolWithEvent: call,
      completeToolWithEvent: call,
      requireClarificationWithEvent: call,
      suspendRunWithEvent: call,
      completeRunWithEvent: call,
      failRunWithEvent: call,
      call,
    };
  }

  it("exposes exactly the named composite transitions — no generic append", () => {
    const store = fakeStore();
    const service = createRunEventService(store as never);
    expect(Object.keys(service).sort()).toEqual(NAMED_TRANSITIONS);
    expect(service).not.toHaveProperty("append");
    expect(service).not.toHaveProperty("emit");
    expect(service).not.toHaveProperty("record");
  });

  it("rejects a malformed payload BEFORE any store write (caller cannot pick the event type)", () => {
    const store = fakeStore();
    const service = createRunEventService(store as never);
    const scope = {
      sessionId: "s-1",
      runId: "run-1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      installationGeneration: 1,
      authClass: "addon" as const,
    };
    expect(() =>
      service.reserveModelCall({
        scope,
        state: {} as never,
        // A run.failed-shaped payload smuggled into the model.started slot.
        payload: { code: "boom" } as never,
      }),
    ).toThrow();
    expect(store.call).not.toHaveBeenCalled();
  });
});

describe("permission preview token binding (T16-E)", () => {
  function service(nowRef: { value: Date }) {
    const saved: unknown[] = [];
    const svc = createPermissionService({
      store: {
        getAdminPolicy: () => undefined,
        upsertAdminPolicy: (_w: string, _a: string, policy: unknown) => { saved.push(policy); },
        recordActionResult: () => ({ id: "result-1" }),
        addAuditEvent: () => undefined,
        getInstallation: () => ({ status: "active", generation: 1 }),
      } as never,
      loadPolicy: () => defaultAdminPolicy(),
      sessionSecret: "secret-1",
      now: () => nowRef.value,
    });
    return { svc, saved };
  }

  const claims = {
    sessionId: "s-1",
    workspaceId: "ws-1",
    adminUserId: "admin-1",
    workspaceRole: "ADMIN",
    expiresAt: "2027-01-01T00:00:00.000Z",
  };

  it("confirm applies exactly the previewed patch and rejects the token after the 5-minute TTL", () => {
    const nowRef = { value: new Date("2026-07-26T12:00:00.000Z") };
    const { svc, saved } = service(nowRef);
    const preview = svc.preview(claims, { invoices: "off" });
    if (!preview.ok) throw new Error("preview failed");

    // One second before expiry: applies.
    nowRef.value = new Date(nowRef.value.getTime() + PERMISSION_PREVIEW_TTL_MS - 1000);
    const confirmed = svc.confirm(claims, preview.view.previewToken, 1);
    expect(confirmed.ok).toBe(true);
    expect(saved).toHaveLength(1);

    // A second, fresh token left to expire: rejected with no write.
    const late = svc.preview(claims, { invoices: "off" });
    if (!late.ok) throw new Error("preview failed");
    nowRef.value = new Date(nowRef.value.getTime() + PERMISSION_PREVIEW_TTL_MS + 1000);
    const expired = svc.confirm(claims, late.view.previewToken, 1);
    expect(expired.ok).toBe(false);
    if (!expired.ok) expect(expired.code).toBe("invalid_preview_token");
    expect(saved).toHaveLength(1);
  });

  it("rejects a token minted for a different session/admin scope", () => {
    const nowRef = { value: new Date("2026-07-26T12:00:00.000Z") };
    const { svc, saved } = service(nowRef);
    const preview = svc.preview(claims, { invoices: "off" });
    if (!preview.ok) throw new Error("preview failed");
    const foreign = svc.confirm({ ...claims, sessionId: "s-2" }, preview.view.previewToken, 1);
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.code).toBe("invalid_preview_token");
    expect(saved).toHaveLength(0);
  });
});

describe("stored clarify results hydrate truthfully (review-gate Finding 2 coupling)", () => {
  it("presents a clarify action result as NOT performed — never as succeeded", async () => {
    const { hydrateRunEventAttachments } = await import("../../src/services/run-event-hydration.js");
    const store = createStore(":memory:", { encryptionKey: "k" });
    try {
      const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
      const ref = store.recordActionResult({
        workspaceId: "ws-1",
        adminUserId: "admin-1",
        sessionId: session.id,
        actionName: "clockify_tags_delete",
        status: "definitive_failed",
        result: { kind: "clarify", message: "Which tag did you mean?" },
      });
      const hydrated = hydrateRunEventAttachments(
        {
          store,
          scope: {
            sessionId: session.id,
            runId: "run-1",
            workspaceId: "ws-1",
            adminUserId: "admin-1",
            installationGeneration: 1,
            authClass: "addon",
          },
          sessionSecret: "secret",
          now: new Date(),
        },
        [{
          runId: "run-1",
          sequence: 1,
          event: {
            eventType: "tool.completed",
            payload: { toolCallId: "t1", actionName: "clockify_tags_delete", actionResultId: ref.id },
            createdAt: new Date().toISOString(),
          },
        }],
      );
      const attachment = hydrated[0]?.attachment;
      if (attachment?.kind !== "presented_result") throw new Error("expected presented_result attachment");
      expect(attachment.envelope.presentation.status).toBe("failed");
      expect(attachment.envelope.presentation.warnings.map((w) => w.code)).toContain("clarification_required");
      expect(attachment.envelope.presentation.summary).toBe("Which tag did you mean?");
    } finally {
      store.close();
    }
  });
});

describe("provider attempt 2 shares the logical model call (T16-B)", () => {
  it("appends a second model.started event without incrementing modelCallsUsed", () => {
    const store = createStore(":memory:", { encryptionKey: "k" });
    try {
      const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
      const scope = {
        sessionId: session.id,
        runId: "run-1",
        workspaceId: "ws-1",
        adminUserId: "admin-1",
        installationGeneration: 1,
        authClass: "addon" as const,
      };
      const service = createRunEventService(store);
      service.startRun({
        scope,
        input: {
          originalRequest: "list projects",
          requestHash: computeRequestHash("list projects"),
          catalogHash: "a".repeat(64),
          loadedToolNames: [],
          intentHash: "intent-1",
        },
      });
      const state = store.getRun(scope);
      if (!state) throw new Error("run state missing");

      const attempt1 = service.reserveModelCall({
        scope,
        state,
        payload: { modelCall: 1, providerAttempt: 1, loadedOperationIds: [], cacheSeeded: false },
      });
      const afterFirst = store.getRun(scope);
      expect(afterFirst?.budget.modelCallsUsed).toBe(1);

      const attempt2 = service.reserveModelCall({
        scope,
        state: afterFirst ?? state,
        payload: { modelCall: 1, providerAttempt: 2, loadedOperationIds: [], cacheSeeded: false },
      });
      const afterSecond = store.getRun(scope);
      // The retry is the SAME logical model call: the denominator is unchanged
      // while the event journal still records both provider attempts in order.
      expect(afterSecond?.budget.modelCallsUsed).toBe(1);
      expect(attempt2.sequence).toBeGreaterThan(attempt1.sequence);

      const completed = service.completeModelCall({
        scope,
        state: afterSecond ?? state,
        payload: { modelCall: 1, providerAttempts: 2, usage: {}, latencyMs: 12 },
      });
      expect(completed.sequence).toBeGreaterThan(attempt2.sequence);
      expect(store.getLastRunEventSequence(scope)).toBe(completed.sequence);
    } finally {
      store.close();
    }
  });
});
