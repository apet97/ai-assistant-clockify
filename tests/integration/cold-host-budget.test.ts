import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { ModelClient, ModelMessage } from "../../src/assistant/model-client.js";
import { createSignatureParser } from "../../src/addon/verify.js";
import type { WorkspaceClient } from "../../src/clockify/client.js";
import { chargeHostCallBudget, HOST_CALL_BUDGET_MAXIMUM } from "../../src/clockify/request-governor.js";
import { createStore, type Store } from "../../src/db/store.js";
import { GROUP_MEMBER_BATCH_MAX } from "../../src/harness/safety-limits.js";
import { createApp } from "../../src/server.js";
import { makeTestConfig } from "../helpers/config.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";
import { mintAdminCookie } from "../helpers/session.js";
import { testKeys } from "../helpers/test-keys.js";

const ADDON_KEY = "ai-assistant";
const SESSION_SECRET = "test-session-secret";
let publicKeyPem: string;
const stores: Store[] = [];

beforeAll(async () => {
  publicKeyPem = (await testKeys()).pem;
});

afterEach(() => {
  while (stores.length) stores.pop()!.close();
});

function byteSpan(source: string, literal: string) {
  const index = source.indexOf(literal);
  if (index < 0) throw new Error(`missing fixture literal: ${literal}`);
  const startByte = Buffer.byteLength(source.slice(0, index), "utf8");
  return { startByte, endByte: startByte + Buffer.byteLength(literal, "utf8"), text: literal };
}

function isDeclarationCall(messages: ModelMessage[]): boolean {
  return messages[0]?.role === "system" && messages[0].content.includes("constrained intent declaration pass");
}

describe("cold authenticated host-call boundary", () => {
  it("confirms the advertised 14-member batch without exceeding 60 physical calls or stopping halfway", async () => {
    expect(GROUP_MEMBER_BATCH_MAX).toBe(14);
    const memberIds = Array.from({ length: GROUP_MEMBER_BATCH_MAX }, (_, index) => `user-${index + 1}`);
    const membersLiteral = JSON.stringify(memberIds);
    const authored = `add members ${membersLiteral} to group g1`;
    const actionSpan = byteSpan(authored, "add members");
    const membersSpan = byteSpan(authored, membersLiteral);
    const groupSpan = byteSpan(authored, "g1");
    const modelClient: ModelClient = {
      complete: vi.fn(async (messages) => {
        if (isDeclarationCall(messages)) {
          return JSON.stringify({
            writeActions: [{
              actionName: "clockify_groups_add_user",
              sourceSpans: [actionSpan, membersSpan, groupSpan],
              literalConstraints: [
                { path: "members", value: memberIds, sourceSpan: membersSpan },
                { path: "groupId", value: "g1", sourceSpan: groupSpan },
              ],
              maxExecutions: 1,
            }],
          });
        }
        return JSON.stringify({
          kind: "actions",
          text: "Membership preview prepared.",
          actions: [{
            name: "clockify_groups_add_user",
            arguments: { groupId: "g1", members: memberIds },
          }],
        });
      }),
    };
    const store = createStore(":memory:", { encryptionKey: "test-key" });
    stores.push(store);
    store.saveInstallation({
      workspaceId: "ws-1",
      addonId: "addon-1",
      addonUserId: "addon-user-1",
      addonToken: "addon-token",
    });
    const fake = createFakeWorkspace({
      users: memberIds.map((id) => ({ id, name: id, email: `${id}@example.com` })),
      groups: [{ id: "g1", name: "Boundary group", userIds: [] }],
      memberRoles: { "admin-1": "ADMIN" },
    });
    let physicalCalls = 0;
    const charged = new Proxy(fake.client, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          chargeHostCallBudget();
          physicalCalls += 1;
          return (value as (...methodArgs: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as WorkspaceClient;
    const config = makeTestConfig({
      clockifyAddonPublicKeyPem: publicKeyPem,
      clockifyAddonKey: ADDON_KEY,
      sessionSecret: SESSION_SECRET,
      llmMode: "json",
      llmAgentic: false,
    });
    let nowMs = Date.now();
    const app = createApp({
      config,
      store,
      parser: createSignatureParser(ADDON_KEY, publicKeyPem),
      modelClient,
      clockifyForWorkspace: () => charged,
      now: () => new Date(nowMs),
    });
    const cookie = mintAdminCookie(store, SESSION_SECRET, { adminUserId: "admin-1" });

    const chat = await request(app)
      .post("/api/chat/messages")
      .set("Cookie", cookie)
      .send({ requestId: randomUUID(), message: authored });
    expect(chat.status).toBe(200);
    const preview = (chat.body.results as Array<{ kind?: string; previewId?: string; nonce?: string }>)
      .find((result) => result.kind === "preview");
    expect(preview).toMatchObject({ previewId: expect.any(String), nonce: expect.any(String) });

    // Expire the positive read cache so the confirmation starts from the true
    // worst-case cold authenticated boundary.
    nowMs += 60_001;
    physicalCalls = 0;
    const confirmed = await request(app)
      .post(`/api/confirmations/${preview!.previewId}/confirm`)
      .set("Cookie", cookie)
      .send({ nonce: preview!.nonce });

    expect(confirmed.status).toBe(200);
    expect(confirmed.body.receipt).toMatchObject({ ok: true, action: "clockify_groups_add_user" });
    expect(physicalCalls).toBe(59);
    expect(physicalCalls).toBeLessThanOrEqual(HOST_CALL_BUDGET_MAXIMUM);
    expect(fake.counts.addUserToGroupAtomic).toBe(GROUP_MEMBER_BATCH_MAX);
    expect(fake.state.groups[0]?.userIds).toHaveLength(GROUP_MEMBER_BATCH_MAX);
  });
});
