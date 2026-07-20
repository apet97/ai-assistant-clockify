import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { ModelClient, ModelMessage, ToolCompletion, ToolDefinition } from "../../src/assistant/model-client.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import { createApp } from "../../src/server.js";
import { makeTestConfig } from "../helpers/config.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";
import { mintAdminCookie } from "../helpers/session.js";
import { testKeys } from "../helpers/test-keys.js";

const ADDON_KEY = "ai-assistant";
const PROJECT_NAME = "sdasdasdas";
const CREATE_REQUEST = `create a project named ${PROJECT_NAME}`;
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

function scriptedTranscriptModel(): ModelClient {
  const planner: ToolCompletion[] = [
    {
      text: "",
      toolCalls: [{ id: "create", name: "clockify_projects_create", arguments: { name: PROJECT_NAME } }],
    },
    { text: "Project created.", toolCalls: [] },
    {
      text: "",
      toolCalls: [{
        id: "private",
        name: "clockify_projects_update",
        arguments: { currentName: PROJECT_NAME, isPublic: false },
      }],
    },
    {
      text: "",
      toolCalls: [{
        id: "membership",
        name: "clockify_projects_memberships_update",
        arguments: { name: PROJECT_NAME, addUserIds: ["me"] },
      }],
    },
    {
      text: "",
      toolCalls: [{
        id: "rate",
        name: "clockify_projects_rate_update",
        arguments: { projectName: PROJECT_NAME, userId: "me", rateKind: "HOURLY", amount: 15 },
      }],
    },
    { text: "The project is private, you are a member, and your member rate is 15.", toolCalls: [] },
  ];
  let plannerIndex = 0;

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
            { path: "currentName", value: PROJECT_NAME, sourceRef: { segment: "unresolved_prior", quote: PROJECT_NAME, occurrence: 0 } },
            { path: "isPublic", value: false, sourceRef: { segment: "current", quote: "private", occurrence: 0 } },
          ],
          maxExecutions: 1,
        },
        {
          actionName: "clockify_projects_memberships_update",
          sourceRefs: [{ segment: "current", quote: "add me to it", occurrence: 0 }],
          literalConstraints: [
            { path: "name", value: PROJECT_NAME, sourceRef: { segment: "unresolved_prior", quote: PROJECT_NAME, occurrence: 0 } },
            { path: "addUserIds[]", value: "me", sourceRef: { segment: "current", quote: "me", occurrence: 0 } },
          ],
          maxExecutions: 1,
        },
        {
          actionName: "clockify_projects_rate_update",
          sourceRefs: [{ segment: "current", quote: "make my project member rate to be 15", occurrence: 0 }],
          literalConstraints: [
            { path: "projectName", value: PROJECT_NAME, sourceRef: { segment: "unresolved_prior", quote: PROJECT_NAME, occurrence: 0 } },
            { path: "userId", value: "me", sourceRef: { segment: "current", quote: "my", occurrence: 0 } },
            { path: "rateKind", value: "HOURLY", sourceRef: { segment: "current", quote: "project member rate", occurrence: 0 } },
            { path: "amount", value: 15, sourceRef: { segment: "current", quote: "15", occurrence: 0 } },
          ],
          maxExecutions: 1,
        },
      ] : []);
    }),
  };
}

describe("project follow-up transcript", () => {
  it("executes the exact two-message flow through all three button confirmations", async () => {
    const store = createStore(":memory:", { encryptionKey: "test-key" });
    stores.push(store);
    store.saveInstallation({
      workspaceId: "ws-1",
      addonId: "addon-1",
      addonUserId: "addon-user-1",
      addonToken: "addon-token",
    });
    const fake = createFakeWorkspace({ users: [{ id: "admin-1", name: "Ada" }] });
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
      modelClient: scriptedTranscriptModel(),
      clockifyForWorkspace: () => fake.client,
      enforceIntentCapabilitiesInTests: true,
    });
    const cookie = mintAdminCookie(store, config.sessionSecret);

    const created = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ requestId: randomUUID(), message: CREATE_REQUEST });
    expect(created.status).toBe(200);
    expect(fake.counts.createProjectAtomic).toBe(1);

    const followUp = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ requestId: randomUUID(), message: FOLLOW_UP });
    expect(followUp.status).toBe(200);

    let preview = followUp.body.results.find((result: { kind?: string }) => result.kind === "preview");
    expect(preview, JSON.stringify(followUp.body)).toBeDefined();
    expect(preview?.preview?.expectedChanges.join(" ")).toContain("isPublic");

    const confirmPrivate = await request(app)
      .post(`/api/confirmations/${preview.previewId as string}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: preview.nonce });
    expect(confirmPrivate.status).toBe(200);
    preview = confirmPrivate.body.resume.results.find((result: { kind?: string }) => result.kind === "preview");
    expect(preview?.preview?.expectedChanges.join(" ")).toContain("Add 1 member");

    const confirmMembership = await request(app)
      .post(`/api/confirmations/${preview.previewId as string}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: preview.nonce });
    expect(confirmMembership.status).toBe(200);
    preview = confirmMembership.body.resume.results.find((result: { kind?: string }) => result.kind === "preview");
    expect(preview, JSON.stringify(confirmMembership.body)).toBeDefined();
    expect(preview?.preview?.expectedChanges.join(" ")).toContain("15.00");

    const confirmRate = await request(app)
      .post(`/api/confirmations/${preview.previewId as string}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: preview.nonce });
    expect(confirmRate.status).toBe(200);
    expect(confirmRate.body.receipt).toMatchObject({ ok: true, action: "clockify_projects_rate_update" });

    const project = fake.state.projects.find((item) => item.name === PROJECT_NAME) as
      | { id: string; isPublic?: boolean }
      | undefined;
    expect(project?.isPublic).toBe(false);
    expect(fake.state.projectMemberships[project!.id]).toEqual(expect.arrayContaining([
      expect.objectContaining({ userId: "admin-1", hourlyRate: { amount: 1500 } }),
    ]));
  });
});
