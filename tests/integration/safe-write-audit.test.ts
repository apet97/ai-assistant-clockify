import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { testKeys } from "../helpers/test-keys.js";
import type { Express } from "express";
import { createApp } from "../../src/server.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import { makeTestConfig } from "../helpers/config.js";
import type { ToolCompletion } from "../../src/assistant/model-client.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import { scriptedToolModel } from "../helpers/scripted-model.js";
import { DefinitiveWriteFailure } from "../../src/clockify/write-outcome.js";
import { mintAdminCookie } from "../helpers/session.js";

/**
 * F3: post-execution bookkeeping on the SAFE-WRITE chat turn is best-effort.
 *
 * A safe write (`clockify_tags_create`) executes IMMEDIATELY on the host —
 * there is no preview/confirm round-trip. Its receipt is then audited and an
 * undo is recorded via `auditAndEmitReceipt` (`addAuditEvent` +
 * `recordUndoIfReversible`). Plan 003 isolated only the CONFIRM-commit tail; this
 * SAFE-WRITE path was still un-isolated, so a transient DB error in the audit
 * write (e.g. a microsecond SQLITE_BUSY) threw the whole turn AFTER the change had
 * already happened — 502 `model_unavailable` (agentic) / 500 (single-turn), the
 * committed receipt dropped on the floor, and a misleading "try again" inviting a
 * DUPLICATE write.
 *
 * Same injection trick as commit-bookkeeping.test.ts: wrap the real store and
 * override the one bookkeeping method (createStore returns an object literal of
 * closures, so spreading keeps every other binding intact).
 */
const ADDON_KEY = "ai-assistant";

let stores: Store[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const s of stores) s.close();
  stores = [];
});

interface TestApp {
  app: Express;
  cookie: string;
  store: Store;
}

async function makeApp(
  script: ToolCompletion[],
  fake: FakeWorkspace,
  wrapStore: (store: Store) => Store = (s) => s,
  agentic = true,
): Promise<TestApp> {
  const keys = await testKeys();
  const config = makeTestConfig({
    clockifyAddonPublicKeyPem: keys.pem,
    clockifyAddonKey: ADDON_KEY,
    llmAgentic: agentic,
  });
  const store = createStore(":memory:", { encryptionKey: "test-key" });
  stores.push(store);
  store.saveInstallation({ workspaceId: "ws-1", addonId: "addon-1", addonUserId: "addon-user-1", addonToken: "addon-token" });
  const parser = createSignatureParser(ADDON_KEY, keys.pem);
  const app = createApp({
    config,
    store: wrapStore(store),
    parser,
    modelClient: scriptedToolModel(script),
    clockifyForWorkspace: () => fake.client,
  });
  const cookie = mintAdminCookie(store, config.sessionSecret);
  return { app, cookie, store };
}

const CREATE_TAG: ToolCompletion = {
  text: "Creating the tag.",
  toolCalls: [{ id: "r1", name: "clockify_tags_create", arguments: { name: "newtag" } }],
};

const LIST_TAGS: ToolCompletion = {
  text: "Here are the tags.",
  toolCalls: [{ id: "r-list", name: "clockify_tags_list", arguments: {} }],
};

// In the agentic loop the LAST scripted completion repeats until the model stops
// proposing tool calls, so a one-step script would re-fire createTag every
// iteration up to maxSteps. A second, tool-free completion terminates the loop
// after the single safe write (the single-turn path runs each action once and
// needs no terminator).
const DONE: ToolCompletion = { text: "Done — created the tag.", toolCalls: [] };

type ResultItem = {
  kind: string;
  persistenceDegraded?: boolean;
  receipt?: { ok: boolean; recovery?: { retryable?: boolean } };
  recovery?: { retryable?: boolean };
};

const CREATE_WORK_PACKAGE: ToolCompletion = {
  text: "Creating the project and task.",
  toolCalls: [{
    id: "r-work-package",
    name: "clockify_create_work_package",
    arguments: { project: { name: "Phoenix" }, task: { name: "Login" } },
  }],
};

function resultsOf(body: unknown): ResultItem[] {
  return (body as { results?: ResultItem[] }).results ?? [];
}

function streamEvents(body: string): Array<Record<string, unknown>> {
  return body.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

const throwingAudit = (store: Store): Store => ({
  ...store,
  addAuditEvent: () => {
    throw new Error("sensitive SQL payload must not escape");
  },
});

// F7: the assistant-reply persistence (`persistAssistantReply` -> `addMessage`)
// runs AFTER the turn's action(s) executed. Make ONLY the assistant-role write
// throw — the user-message write (start of the turn) and the safe write itself
// still succeed, so the change has already happened on the host by the time the
// reply persistence throws. The wrapper delegates every other addMessage call to
// the real store so the user message + history are intact.
const throwingAssistantReplyPersist = (store: Store): Store => ({
  ...store,
  addMessage: (input) => {
    if (input.role === "assistant") {
      throw new Error("sensitive assistant SQL payload must not escape");
    }
    return store.addMessage(input);
  },
});

describe("safe-write post-execution bookkeeping is best-effort (a DB hiccup can't drop a committed receipt)", () => {
  it("a throwing addAuditEvent on a SAFE-write turn (agentic default) still returns the receipt 200 and does not 502", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fake = createFakeWorkspace({ tags: [] });
    const { app, cookie } = await makeApp([CREATE_TAG, DONE], fake, throwingAudit, true);

    const chat = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "create a tag called newtag" });

    // The safe write ALREADY ran on the host; the audit threw AFTER it. The turn
    // must be a 200 carrying the committed receipt — not a 502 model_unavailable.
    expect(chat.status).toBe(200);
    expect(fake.counts.createTag).toBe(1);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("sensitive SQL payload");
    const receipts = (chat.body.results as ResultItem[]).filter((r) => r.kind === "receipt");
    expect(receipts.length).toBeGreaterThan(0);
  });

  it("a throwing addAuditEvent on a SAFE-write turn (single-turn) still returns the receipt 200 and does not 500", async () => {
    const fake = createFakeWorkspace({ tags: [] });
    const { app, cookie } = await makeApp([CREATE_TAG], fake, throwingAudit, false);

    const chat = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "create a tag called newtag" });

    expect(chat.status).toBe(200);
    expect(fake.counts.createTag).toBe(1);
    const receipts = (chat.body.results as ResultItem[]).filter((r) => r.kind === "receipt");
    expect(receipts.length).toBeGreaterThan(0);
  });

  it.each([
    { mode: "agentic", agentic: true, script: [CREATE_TAG, DONE], requestId: "c537678e-f86e-4b31-b087-0713a62ef434" },
    { mode: "single-turn", agentic: false, script: [CREATE_TAG], requestId: "2827f89a-a067-440d-bf6c-c9822695a18e" },
  ])("preserves a successful $mode write when canonical settlement stays unavailable", async ({ agentic, script, requestId }) => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fake = createFakeWorkspace({ tags: [] });
    let settlementAttempts = 0;
    let operationId: string | undefined;
    const { app, cookie, store } = await makeApp(script, fake, (underlying) => ({
      ...underlying,
      settleOperationResult: (id) => {
        operationId = id;
        settlementAttempts += 1;
        throw new Error("sensitive sqlite detail must not escape");
      },
    }), agentic);

    const send = () => request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "create a tag called newtag", requestId });
    const chat = await send();

    expect(chat.status).toBe(200);
    expect(fake.counts.createTag).toBe(1);
    expect(settlementAttempts).toBe(2);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("sensitive sqlite detail");
    expect(resultsOf(chat.body)).toContainEqual(expect.objectContaining({
      kind: "receipt",
      persistenceDegraded: true,
      receipt: expect.objectContaining({ ok: true }),
    }));
    const operation = store.getOperationRun(operationId!);
    expect(operation?.status).toBe("executing");
    expect(operation).not.toHaveProperty("actionResultId");

    const replay = await send();
    expect(replay.status).toBe(200);
    expect(resultsOf(replay.body)).toContainEqual(expect.objectContaining({
      kind: "receipt",
      persistenceDegraded: true,
      receipt: expect.objectContaining({ ok: true }),
    }));
    expect(fake.counts.createTag).toBe(1);
    expect(settlementAttempts).toBe(2);
  });

  it.each([
    { mode: "agentic", agentic: true, script: [CREATE_WORK_PACKAGE, DONE], requestId: "71237d49-615b-41d9-af30-403e46979580" },
    { mode: "single-turn", agentic: false, script: [CREATE_WORK_PACKAGE], requestId: "74c753f8-9041-49e2-b6a3-90b8a42a230d" },
  ])("preserves a truthful $mode partial when canonical settlement stays unavailable", async ({ agentic, script, requestId }) => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fake = createFakeWorkspace();
    let taskDispatches = 0;
    fake.client.createTaskAtomic = async () => {
      taskDispatches += 1;
      throw new DefinitiveWriteFailure("POST", "/tasks", "task rejected", 400);
    };
    let settlementAttempts = 0;
    let operationId: string | undefined;
    const { app, cookie, store } = await makeApp(script, fake, (underlying) => ({
      ...underlying,
      settleOperationResult: (id) => {
        operationId = id;
        settlementAttempts += 1;
        throw new Error("sensitive sqlite detail must not escape");
      },
    }), agentic);

    const chat = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "create project Phoenix and task Login", requestId });

    expect(chat.status).toBe(200);
    expect(fake.counts.createProjectAtomic).toBe(1);
    expect(taskDispatches).toBe(1);
    expect(settlementAttempts).toBe(2);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("sensitive sqlite detail");
    expect(resultsOf(chat.body)).toContainEqual(expect.objectContaining({
      kind: "partial",
      persistenceDegraded: true,
      receipt: expect.objectContaining({ ok: true }),
      recovery: expect.objectContaining({ retryable: false }),
    }));
    const operation = store.getOperationRun(operationId!);
    expect(operation?.status).toBe("executing");
    expect(operation).not.toHaveProperty("actionResultId");
  });

  it("uses the same bounded inline fallback when an unbound result row cannot be recorded", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fake = createFakeWorkspace({ tags: [{ id: "t1", name: "urgent" }] });
    let persistenceAttempts = 0;
    const requestId = "a45dc05c-bb39-4f01-881f-0f5b6f8bb5cc";
    const { app, cookie } = await makeApp([LIST_TAGS], fake, (underlying) => ({
      ...underlying,
      recordActionResult: () => {
        persistenceAttempts += 1;
        throw new Error("sensitive sqlite detail must not escape");
      },
    }), false);

    const send = () => request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "list my tags", requestId });
    const chat = await send();

    expect(chat.status).toBe(200);
    expect(persistenceAttempts).toBe(2);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("sensitive sqlite detail");
    expect(resultsOf(chat.body)).toContainEqual(expect.objectContaining({
      kind: "receipt",
      persistenceDegraded: true,
      receipt: expect.objectContaining({ ok: true }),
    }));

    const replay = await send();
    expect(replay.status).toBe(200);
    expect(resultsOf(replay.body)).toEqual(resultsOf(chat.body));
    expect(persistenceAttempts).toBe(2);
  });

  it.each([
    { route: "json", endpoint: "/api/chat/messages", mode: "agentic", agentic: true, script: [CREATE_TAG, DONE], requestId: "130fc9b6-355b-4dd6-8925-844bd781d209" },
    { route: "json", endpoint: "/api/chat/messages", mode: "single-turn", agentic: false, script: [CREATE_TAG], requestId: "9383cd02-1459-428a-b119-d9589b67aa13" },
    { route: "stream", endpoint: "/api/chat/stream", mode: "agentic", agentic: true, script: [CREATE_TAG, DONE], requestId: "9349c4e9-f218-4ba9-a031-38c847b34511" },
    { route: "stream", endpoint: "/api/chat/stream", mode: "single-turn", agentic: false, script: [CREATE_TAG], requestId: "899e840a-b545-42b8-9063-cbf6786d30d4" },
  ])("preserves a degraded $mode write through $route when turn finalization also fails", async ({ endpoint, route, agentic, script, requestId }) => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fake = createFakeWorkspace({ tags: [] });
    let settlementAttempts = 0;
    let finalizationAttempts = 0;
    const { app, cookie } = await makeApp(script, fake, (underlying) => ({
      ...underlying,
      settleOperationResult: () => {
        settlementAttempts += 1;
        throw new Error("sensitive canonical failure");
      },
      finishTurnRun: () => {
        finalizationAttempts += 1;
        throw new Error("sensitive finalization failure");
      },
    }), agentic);

    const send = () => request(app)
      .post(endpoint)
      .set("Cookie", cookie)
      .send({ message: "create a tag called newtag", requestId });
    const chat = await send();

    expect(chat.status).toBe(200);
    if (route === "stream") {
      const events = streamEvents(chat.text);
      const result = events.find((event) => event.type === "result")?.result as ResultItem | undefined;
      expect(result).toMatchObject({ kind: "receipt", persistenceDegraded: true, receipt: { ok: true } });
      expect(events.some((event) => event.type === "reply")).toBe(true);
      expect(events.some((event) => event.type === "error")).toBe(false);
      expect(events.at(-1)?.type).toBe("done");
    } else {
      expect(resultsOf(chat.body)).toContainEqual(expect.objectContaining({
        kind: "receipt",
        persistenceDegraded: true,
        receipt: expect.objectContaining({ ok: true }),
      }));
    }
    expect(fake.counts.createTag).toBe(1);
    expect(settlementAttempts).toBe(2);
    expect(finalizationAttempts).toBe(1);
    expect(JSON.stringify(errorLog.mock.calls)).not.toMatch(/sensitive (?:canonical|finalization) failure/);

    const duplicate = await send();
    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toMatchObject({ code: "operation_in_progress" });
    expect(fake.counts.createTag).toBe(1);
    expect(settlementAttempts).toBe(2);
    expect(finalizationAttempts).toBe(1);
  });

  it("bounds a large degraded inline replay descriptor to the canonical 65,536-byte ceiling", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tags = Array.from({ length: 600 }, (_, index) => ({
      id: `tag-${String(index).padStart(4, "0")}`,
      name: `large-${index}-${"x".repeat(200)}`,
    }));
    const fake = createFakeWorkspace({ tags });
    const requestId = "484d8cee-15ed-47b4-841f-0ca8655e91a4";
    const { app, cookie } = await makeApp([LIST_TAGS], fake, (underlying) => ({
      ...underlying,
      recordActionResult: () => {
        throw new Error("db unavailable");
      },
    }), false);
    const send = () => request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "list my tags", requestId });

    const chat = await send();
    const liveResult = resultsOf(chat.body)[0]!;
    expect(Buffer.byteLength(JSON.stringify(liveResult), "utf8")).toBeGreaterThan(65_536);
    expect(liveResult).toMatchObject({ kind: "receipt", persistenceDegraded: true });

    const replay = await send();
    const durableDescriptor = resultsOf(replay.body)[0]!;
    expect(durableDescriptor).toMatchObject({ kind: "receipt", persistenceDegraded: true });
    expect(Buffer.byteLength(JSON.stringify(durableDescriptor), "utf8")).toBeLessThanOrEqual(65_536);
  });

  it("never logs a raw model-supplied action name when degraded result persistence fails", async () => {
    const rawActionName = "unknown\n\u001b[31mcontrol-action";
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fake = createFakeWorkspace();
    const { app, cookie } = await makeApp([{
      text: "Trying the action.",
      toolCalls: [{ id: "malicious-name", name: rawActionName, arguments: {} }],
    }], fake, (underlying) => ({
      ...underlying,
      recordActionResult: () => {
        throw new Error("db unavailable");
      },
    }), false);

    const chat = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "try that action", requestId: "17fa188a-f471-40b7-8d80-c49402f77690" });

    expect(chat.status).toBe(200);
    expect(resultsOf(chat.body)).toContainEqual(expect.objectContaining({
      kind: "receipt",
      persistenceDegraded: true,
      receipt: expect.objectContaining({ ok: false }),
    }));
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(rawActionName);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("control-action");
  });
});

describe("F7: assistant-reply persistence is best-effort (a throwing addMessage can't 500 a turn whose write already ran)", () => {
  it("a throwing assistant-reply addMessage on a SAFE-write turn (agentic default) still returns the receipt 200 and does not 502", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fake = createFakeWorkspace({ tags: [] });
    const { app, cookie } = await makeApp([CREATE_TAG, DONE], fake, throwingAssistantReplyPersist, true);

    const chat = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "create a tag called newtag" });

    // The safe write ALREADY ran on the host; persisting the assistant reply threw
    // AFTER it. The turn must be a 200 carrying the committed receipt — not a 502.
    expect(chat.status).toBe(200);
    expect(fake.counts.createTag).toBe(1);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("sensitive assistant SQL payload");
    const receipts = (chat.body.results as ResultItem[]).filter((r) => r.kind === "receipt");
    expect(receipts.length).toBeGreaterThan(0);
  });

  it("a throwing assistant-reply addMessage on a SAFE-write turn (single-turn) still returns the receipt 200 and does not 500", async () => {
    const fake = createFakeWorkspace({ tags: [] });
    const { app, cookie } = await makeApp([CREATE_TAG], fake, throwingAssistantReplyPersist, false);

    const chat = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ message: "create a tag called newtag" });

    expect(chat.status).toBe(200);
    expect(fake.counts.createTag).toBe(1);
    const receipts = (chat.body.results as ResultItem[]).filter((r) => r.kind === "receipt");
    expect(receipts.length).toBeGreaterThan(0);
  });
});
