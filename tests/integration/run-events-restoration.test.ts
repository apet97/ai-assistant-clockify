import { describe, expect, it } from "vitest";
import { createStore } from "../../src/db/store.js";
import { computeRequestHash } from "../../src/assistant-v2/state.js";
import { createRunEventViewService } from "../../src/services/run-event-view-service.js";
import { makeTestConfig } from "../helpers/config.js";

describe("run event restoration views", () => {
  it("hydrates assistant text from model.completed chatMessageId", () => {
    const config = makeTestConfig();
    const store = createStore(":memory:", { encryptionKey: "k" });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    const scope = {
      sessionId: session.id,
      runId: "run-1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      installationGeneration: 1,
      authClass: "addon" as const,
    };
    store.startRunWithEvent({
      scope,
      originalRequest: "hello",
      requestHash: computeRequestHash("hello"),
      catalogHash: "a".repeat(64),
      loadedToolNames: [],
      intentHash: "run-1",
    });
    store.addMessage({
      sessionId: session.id,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      role: "assistant",
      content: "Working on it.",
    });
    const [message] = store.getRecentMessages(session.id, 1, true) as Array<{ id?: string; content: string }>;
    const run = store.getRun(scope)!;
    store.completeModelCallWithEvent(scope, run, {
      modelCall: 1,
      providerAttempts: 1,
      chatMessageId: message.id!,
      usage: {},
      latencyMs: 1,
    });
    const views = createRunEventViewService(store, { sessionSecret: config.sessionSecret });
    const page = views.list({
      scope: {
        sessionId: session.id,
        workspaceId: "ws-1",
        adminUserId: "admin-1",
        installationGeneration: 1,
        authClass: "addon",
      },
      runId: "run-1",
      after: 0,
      limit: 200,
    });
    const completed = page.events.find((entry) => entry.event.eventType === "model.completed");
    expect(completed?.attachment).toEqual({
      kind: "assistant_message",
      messageId: message.id,
      text: "Working on it.",
    });
    expect(page.lastSequence).toBe(2);
    store.close();
  });

  it("does not attach terminal prepared confirmations", () => {
    const config = makeTestConfig();
    const store = createStore(":memory:", { encryptionKey: "k" });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    const scope = {
      sessionId: session.id,
      runId: "run-1",
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      installationGeneration: 1,
      authClass: "addon" as const,
    };
    store.startRunWithEvent({
      scope,
      originalRequest: "hello",
      requestHash: computeRequestHash("hello"),
      catalogHash: "a".repeat(64),
      loadedToolNames: [],
      intentHash: "run-1",
    });
    const views = createRunEventViewService(store, { sessionSecret: config.sessionSecret });
    const page = views.list({
      scope: {
        sessionId: session.id,
        workspaceId: "ws-1",
        adminUserId: "admin-1",
        installationGeneration: 1,
        authClass: "addon",
      },
      runId: "run-1",
      after: 0,
      limit: 200,
    });
    expect(page.events.every((entry) => entry.event.eventType !== "operation.prepared" || !entry.attachment)).toBe(true);
    store.close();
  });
});
