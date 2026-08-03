import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { ModelClient, ModelMessage, ToolCompletion, ToolDefinition } from "../../src/assistant/model-client.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { verifySessionCookie } from "../../src/auth/sessions.js";
import { createStore, type Store } from "../../src/db/store.js";
import { createApp } from "../../src/server.js";
import { makeTestConfig } from "../helpers/config.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";
import { mintAdminCookie } from "../helpers/session.js";
import { testKeys } from "../helpers/test-keys.js";

const ADDON_KEY = "ai-assistant";
const PROJECT_NAME = "Atlas";
const CREATE_REQUEST = `create a project named ${PROJECT_NAME}`;
const CREATE_WITH_CLIENT_REQUEST = `Create project ${PROJECT_NAME} for client Acme`;
const FOLLOW_UP = "make the project private, add me to it, and make my project member rate to be 15";

let publicKeyPem: string;
let stores: Store[] = [];

beforeAll(async () => {
  publicKeyPem = (await testKeys()).pem;
});

afterEach(() => {
  for (const store of stores) store.close();
  stores = [];
});

function declarationCall(tools: ToolDefinition[]): boolean {
  return tools.length === 1 && tools[0]?.name === "declare_intent_capability";
}

function declarationCompletion(writeActions: unknown[]): ToolCompletion {
  return {
    text: "",
    toolCalls: [{ id: randomUUID(), name: "declare_intent_capability", arguments: { writeActions } }],
    finishReason: "tool_calls",
  };
}

function scriptedTranscriptModel(options: {
  includeGet?: boolean;
  updateCurrentName?: string;
  correctedCurrentName?: string | false;
  selectorName?: string;
  skipCreateTurn?: boolean;
  correctionOutcome?: "update" | "membership" | "text" | "extra";
  initialUpdateMode?: "visibility" | "rename";
  omitVisibilityConstraint?: boolean;
} = {}): ModelClient {
  const updateCurrentName = options.updateCurrentName ?? "project-1";
  const correctedCurrentName = options.correctedCurrentName === undefined && updateCurrentName === "project-1"
    ? PROJECT_NAME
    : options.correctedCurrentName;
  const planner: ToolCompletion[] = [
    {
      text: "",
      toolCalls: [{ id: "create", name: "clockify_projects_create", arguments: { name: PROJECT_NAME } }],
    },
    { text: "Project created.", toolCalls: [] },
    ...(options.includeGet === false ? [] : [{
      text: "",
      toolCalls: [{
        id: "get-created-project",
        name: "clockify_projects_get",
        arguments: { name: PROJECT_NAME },
      }],
    }] satisfies ToolCompletion[]),
    {
      text: "",
      toolCalls: [{
        id: "private",
        name: "clockify_projects_update",
        // Production DeepSeek reused the exact id returned by projects_get in
        // the name-shaped selector slot. The route may canonicalize only this
        // same-loop, authoritative adjacent-project reference.
        arguments: options.initialUpdateMode === "rename"
          ? { currentName: updateCurrentName, name: "Renamed Atlas" }
          : { currentName: updateCurrentName, isPublic: false },
      }],
    },
    ...(options.correctionOutcome === "text"
      ? [{ text: "Done.", toolCalls: [] }] satisfies ToolCompletion[]
      : options.correctionOutcome === "extra"
        ? [{
            text: "",
            toolCalls: [
              {
                id: "private-corrected-extra",
                name: "clockify_projects_update",
                arguments: { currentName: PROJECT_NAME, isPublic: false, name: "Attacker" },
              },
              {
                id: "membership-after-extra",
                name: "clockify_projects_memberships_update",
                arguments: { name: PROJECT_NAME, addUserIds: ["admin-1"] },
              },
            ],
          }] satisfies ToolCompletion[]
      : options.correctionOutcome === "membership"
        ? [{
            text: "",
            toolCalls: [{
              id: "membership-instead-of-correction",
              name: "clockify_projects_memberships_update",
              arguments: { name: PROJECT_NAME, addUserIds: ["admin-1"] },
            }],
          }] satisfies ToolCompletion[]
        : correctedCurrentName === false || correctedCurrentName === undefined ? [] : [{
            text: "",
            toolCalls: [{
              id: "private-corrected",
              name: "clockify_projects_update",
              arguments: { currentName: correctedCurrentName, isPublic: false },
            }],
          }] satisfies ToolCompletion[]),
    {
      text: "",
      toolCalls: [{
        id: "membership",
        name: "clockify_projects_memberships_update",
        arguments: { name: PROJECT_NAME, addUserIds: ["admin-1"] },
      }],
    },
    {
      text: "",
      toolCalls: [{
        id: "rate",
        name: "clockify_projects_rate_update",
        arguments: { projectName: PROJECT_NAME, userName: "me", rateKind: "HOURLY", amount: 15 },
      }],
    },
    { text: "The project is private, you are a member, and your member rate is 15.", toolCalls: [] },
  ];
  let plannerIndex = options.skipCreateTurn ? 2 : 0;

  return {
    complete: vi.fn(async () => "{}"),
    completeWithTools: vi.fn(async (messages: ModelMessage[], tools: ToolDefinition[]) => {
      if (!declarationCall(tools)) return planner[Math.min(plannerIndex++, planner.length - 1)]!;

      const payload = JSON.parse(messages[1]?.content ?? "{}") as {
        segments?: Array<{ source: "unresolved_prior" | "current"; text: string }>;
      };
      const hasPrior = payload.segments?.some((segment) => segment.source === "unresolved_prior") === true;
      if (payload.segments?.at(-1)?.text === CREATE_REQUEST) {
        return declarationCompletion([{
          actionName: "clockify_projects_create",
          sourceRefs: [{ segment: "current", quote: CREATE_REQUEST, occurrence: 0 }],
          literalConstraints: [{
            path: "name",
            value: PROJECT_NAME,
            sourceRef: { segment: "current", quote: PROJECT_NAME, occurrence: 0 },
          }],
          maxExecutions: 1,
        }]);
      }

      return declarationCompletion(hasPrior ? [
        {
          actionName: "clockify_projects_update",
          sourceRefs: [{ segment: "current", quote: "make the project private", occurrence: 0 }],
          literalConstraints: [
            { path: "currentName", value: options.selectorName ?? PROJECT_NAME, sourceRef: { segment: "unresolved_prior", quote: options.selectorName ?? PROJECT_NAME, occurrence: 0 } },
            ...(options.omitVisibilityConstraint ? [] : [
              { path: "isPublic", value: false, sourceRef: { segment: "current" as const, quote: "private", occurrence: 0 } },
            ]),
          ],
          maxExecutions: 1,
        },
        {
          actionName: "clockify_projects_memberships_update",
          sourceRefs: [{ segment: "current", quote: "add me to it", occurrence: 0 }],
          literalConstraints: [
            { path: "name", value: options.selectorName ?? PROJECT_NAME, sourceRef: { segment: "unresolved_prior", quote: options.selectorName ?? PROJECT_NAME, occurrence: 0 } },
            { path: "addUserIds[]", value: ["me"], sourceRef: { segment: "current", quote: "me", occurrence: 0 } },
          ],
          maxExecutions: 1,
        },
        {
          actionName: "clockify_projects_rate_update",
          sourceRefs: [{ segment: "current", quote: "make my project member rate to be 15", occurrence: 0 }],
          literalConstraints: [
            { path: "projectName", value: options.selectorName ?? PROJECT_NAME, sourceRef: { segment: "unresolved_prior", quote: options.selectorName ?? PROJECT_NAME, occurrence: 0 } },
            { path: "rateKind", value: "project member", sourceRef: { segment: "current", quote: "project member", occurrence: 0 } },
            { path: "amount", value: 15, sourceRef: { segment: "current", quote: "15", occurrence: 0 } },
          ],
          maxExecutions: 1,
        },
      ] : []);
    }),
  };
}

function appHarness(modelClient: ModelClient, options: { seedProject?: boolean } = {}) {
  const store = createStore(":memory:", { encryptionKey: "test-key" });
  stores.push(store);
  store.saveInstallation({
    workspaceId: "ws-1",
    addonId: "addon-1",
    addonUserId: "addon-user-1",
    addonToken: "addon-token",
  });
  const fake = createFakeWorkspace({
    users: [{ id: "admin-1", name: "Ada" }],
    ...(options.seedProject
      ? { projects: [{ id: "project-1", name: PROJECT_NAME }] }
      : {}),
  });
  const config = makeTestConfig({
    clockifyAddonPublicKeyPem: publicKeyPem,
    clockifyAddonKey: ADDON_KEY,
    llmAgentic: true,
    llmMode: "tool",
    llmToolSelect: false,
  });
  const app = createApp({
    config,
    store,
    parser: createSignatureParser(ADDON_KEY, publicKeyPem),
    modelClient,
    clockifyForWorkspace: () => fake.client,
    enforceIntentCapabilitiesInTests: true,
  });
  const cookie = mintAdminCookie(store, config.sessionSecret);
  const sessionId = verifySessionCookie(cookie.split("=")[1]!, config.sessionSecret)!.sessionId;
  return { store, fake, app, cookie, sessionId };
}

async function createProject(app: ReturnType<typeof createApp>, cookie: string) {
  const created = await request(app)
    .post("/api/chat/messages")
    .set("Cookie", cookie)
    .send({ requestId: randomUUID(), message: CREATE_REQUEST });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  expect(created.body.results, JSON.stringify(created.body)).not.toEqual([]);
  return created;
}

describe("project follow-up transcript", () => {
  it("executes the exact two-message flow through all three button confirmations", async () => {
    const { app, cookie, fake } = appHarness(scriptedTranscriptModel());
    const created = await createProject(app, cookie);
    expect(fake.counts.createProjectAtomic, JSON.stringify(created.body)).toBe(1);

    const followUp = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ requestId: randomUUID(), message: FOLLOW_UP });
    expect(followUp.status, JSON.stringify(followUp.body)).toBe(200);
    expect(followUp.body.results).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "receipt",
        receipt: expect.objectContaining({ code: "internal_argument_correction" }),
      }),
    ]));

    let preview = followUp.body.results.find((result: { kind?: string }) => result.kind === "preview");
    expect(preview, JSON.stringify(followUp.body)).toBeDefined();
    expect(preview?.preview?.expectedChanges.join(" ")).toContain("isPublic");

    const confirmPrivate = await request(app)
      .post(`/api/confirmations/${preview.previewId as string}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: preview.nonce });
    expect(confirmPrivate.status, JSON.stringify(confirmPrivate.body)).toBe(200);
    preview = confirmPrivate.body.resume.results.find((result: { kind?: string }) => result.kind === "preview");
    expect(preview?.preview?.expectedChanges.join(" ")).toContain("Add 1 member");

    const confirmMembership = await request(app)
      .post(`/api/confirmations/${preview.previewId as string}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: preview.nonce });
    expect(confirmMembership.status, JSON.stringify(confirmMembership.body)).toBe(200);
    preview = confirmMembership.body.resume.results.find((result: { kind?: string }) => result.kind === "preview");
    expect(preview, JSON.stringify(confirmMembership.body)).toBeDefined();
    expect(preview?.preview?.expectedChanges.join(" ")).toContain("15.00");

    const confirmRate = await request(app)
      .post(`/api/confirmations/${preview.previewId as string}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: preview.nonce });
    expect(confirmRate.status, JSON.stringify(confirmRate.body)).toBe(200);
    expect(confirmRate.body.receipt).toMatchObject({ ok: true, action: "clockify_projects_rate_update" });

    const project = fake.state.projects.find((item) => item.name === PROJECT_NAME) as
      | { id: string; isPublic?: boolean }
      | undefined;
    expect(project?.isPublic).toBe(false);
    expect(fake.state.projectMemberships[project!.id]).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: "admin-1", hourlyRate: { amount: 1500 } }),
    ]));
  });

  it("uses the exact authored project name directly without a lookup", async () => {
    const { app, cookie } = appHarness(scriptedTranscriptModel({
      includeGet: false,
      updateCurrentName: PROJECT_NAME,
    }));
    await createProject(app, cookie);

    const followUp = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ requestId: randomUUID(), message: FOLLOW_UP });

    expect(followUp.status, JSON.stringify(followUp.body)).toBe(200);
    expect(followUp.body.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "preview" }),
    ]));
  });

  it("denies an arbitrary id even after the exact project lookup", async () => {
    const { app, cookie } = appHarness(scriptedTranscriptModel({ updateCurrentName: "project-attacker" }));
    await createProject(app, cookie);

    const followUp = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ requestId: randomUUID(), message: FOLLOW_UP });

    expect(followUp.status, JSON.stringify(followUp.body)).toBe(200);
    expect(followUp.body.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "receipt",
        receipt: expect.objectContaining({ ok: false, code: "intent_capability_argument_mismatch" }),
      }),
    ]));
  });

  it("allows only one internal correction before a repeated id reaches raw authority and is denied", async () => {
    const { app, cookie } = appHarness(scriptedTranscriptModel({ correctedCurrentName: "project-1" }));
    await createProject(app, cookie);

    const followUp = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ requestId: randomUUID(), message: FOLLOW_UP });

    expect(followUp.status, JSON.stringify(followUp.body)).toBe(200);
    expect(followUp.body.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "receipt",
        receipt: expect.objectContaining({ ok: false, code: "intent_capability_argument_mismatch" }),
      }),
    ]));
    expect(followUp.body.results).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "receipt",
        receipt: expect.objectContaining({ code: "internal_argument_correction" }),
      }),
    ]));
  });

  it("does not enter correction for an id-shaped rename request", async () => {
    const { app, cookie } = appHarness(scriptedTranscriptModel({ initialUpdateMode: "rename" }));
    await createProject(app, cookie);

    const followUp = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ requestId: randomUUID(), message: FOLLOW_UP });

    expect(followUp.status, JSON.stringify(followUp.body)).toBe(200);
    expect(followUp.body.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "receipt",
        receipt: expect.objectContaining({ ok: false, code: "intent_capability_argument_mismatch" }),
      }),
    ]));
    expect(followUp.body.results).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "preview" }),
    ]));
  });

  it("does not enter correction without the exact capability-bound visibility literal", async () => {
    const { app, cookie } = appHarness(scriptedTranscriptModel({ omitVisibilityConstraint: true }));
    await createProject(app, cookie);

    const followUp = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ requestId: randomUUID(), message: FOLLOW_UP });

    expect(followUp.status, JSON.stringify(followUp.body)).toBe(200);
    expect(followUp.body.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "receipt",
        receipt: expect.objectContaining({ ok: false, code: "intent_capability_argument_mismatch" }),
      }),
    ]));
    expect(followUp.body.results).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "preview" }),
    ]));
  });

  it("terminates when the model skips the pending correction for a membership action", async () => {
    const { app, cookie, fake } = appHarness(scriptedTranscriptModel({ correctionOutcome: "membership" }));
    await createProject(app, cookie);

    const followUp = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ requestId: randomUUID(), message: FOLLOW_UP });

    expect(followUp.status, JSON.stringify(followUp.body)).toBe(200);
    expect(followUp.body.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "receipt",
        receipt: expect.objectContaining({ ok: false, code: "intent_capability_argument_mismatch" }),
      }),
    ]));
    expect(followUp.body.results).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "preview" }),
    ]));
    expect(fake.state.projectMemberships["project-1"] ?? []).toEqual([]);
  });

  it("replaces text-only completion while a correction is pending with a truthful no-change reply", async () => {
    const { app, cookie } = appHarness(scriptedTranscriptModel({ correctionOutcome: "text" }));
    await createProject(app, cookie);

    const followUp = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ requestId: randomUUID(), message: FOLLOW_UP });

    expect(followUp.status, JSON.stringify(followUp.body)).toBe(200);
    expect(followUp.body.reply.text).toContain("No change has been prepared");
    expect(followUp.body.reply.text).toContain("fresh message");
    expect(followUp.body.reply.text).not.toContain("Done");
    expect(followUp.body.results).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "preview" }),
    ]));
  });

  it("does not clear a pending correction for an exact selector carrying any extra argument", async () => {
    const { app, cookie, fake } = appHarness(scriptedTranscriptModel({ correctionOutcome: "extra" }));
    await createProject(app, cookie);

    const followUp = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ requestId: randomUUID(), message: FOLLOW_UP });

    expect(followUp.status, JSON.stringify(followUp.body)).toBe(200);
    expect(followUp.body.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "receipt",
        receipt: expect.objectContaining({ ok: false, code: "intent_capability_argument_mismatch" }),
      }),
    ]));
    expect(followUp.body.results).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "preview" }),
    ]));
    expect(fake.state.projectMemberships["project-1"] ?? []).toEqual([]);
  });

  it("denies all follow-up writes when another prior literal is misbound as the project selector", async () => {
    const { app, cookie, fake, store, sessionId } = appHarness(scriptedTranscriptModel({
      selectorName: "Acme",
      skipCreateTurn: true,
    }), { seedProject: true });
    store.addMessage({
      sessionId,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      role: "user",
      content: CREATE_WITH_CLIENT_REQUEST,
    });
    const resultRef = store.recordActionResult({
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      sessionId,
      actionName: "clockify_projects_create",
      status: "succeeded",
      result: {
        kind: "receipt",
        receipt: {
          ok: true,
          action: "clockify_projects_create",
          changed: { created: [{ type: "project", id: "project-1", name: PROJECT_NAME }] },
        },
      },
    });
    store.addMessage({
      sessionId,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      role: "assistant",
      content: "Project created.",
      payload: { kind: "final" },
      resultLinks: [{ kind: "action_result", ref: resultRef }],
    });

    const followUp = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ requestId: randomUUID(), message: FOLLOW_UP });

    expect(followUp.status, JSON.stringify(followUp.body)).toBe(200);
    expect(followUp.body.results).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "preview" }),
    ]));
    expect(fake.counts.updateProject ?? 0).toBe(0);
  });

  it("does not carry a created-project referent across an intervening turn", async () => {
    const { app, cookie, store, sessionId, fake } = appHarness(scriptedTranscriptModel());
    await createProject(app, cookie);
    store.addMessage({
      sessionId,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      role: "user",
      content: "What else can you do?",
    });
    store.addMessage({
      sessionId,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      role: "assistant",
      content: "I can help with Clockify administration.",
      payload: { kind: "final", results: [] },
    });

    const followUp = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ requestId: randomUUID(), message: FOLLOW_UP });

    expect(followUp.status, JSON.stringify(followUp.body)).toBe(200);
    expect(followUp.body.results).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "preview" }),
    ]));
    expect(fake.counts.updateProject ?? 0).toBe(0);
  });
});
