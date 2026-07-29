import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { testing } from "@apet97/clockify-addon-sdk";
import type { Express } from "express";
import { createApp } from "../../src/server.js";
import { createSignatureParser, ClockifyHeaders } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import { makeTestConfig } from "../helpers/config.js";
import type { ModelClient } from "../../src/assistant/model-client.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";
import { testKeys } from "../helpers/test-keys.js";

/**
 * Closure-plan PR 11 (F14): lifecycle log output carries HMAC aliases,
 * generation, state, and bounded counts — NEVER a raw workspace/admin/add-on
 * id, an installation token, or a JWT/header shape. The seeded identifiers are
 * realistic 24-hex ids so the identifier-shape assertion has teeth.
 */
const ADDON_KEY = "ai-assistant";
const LIFECYCLE_HEADER = ClockifyHeaders.LIFECYCLE_TOKEN;
const WORKSPACE_ID = "64ad1305c701cc5be7c26fe4";
const ADDON_ID = "69950af22720c2992bab57f7";
const ADDON_USER_ID = "5f0a1305c701cc5be7c26aa1";
const INSTALL_TOKEN = "raw-install-token-must-never-be-logged";

let keys: { privateKey: unknown; pem: string };
let store: Store;
let app: Express;

const modelClient: ModelClient = {
  async complete() {
    return JSON.stringify({ kind: "answer", text: "unused" });
  },
};

beforeAll(async () => {
  keys = await testKeys();
  const config = makeTestConfig({
    clockifyAddonPublicKeyPem: keys.pem,
    clockifyAddonKey: ADDON_KEY,
  });
  store = createStore(":memory:", { encryptionKey: "test-key" });
  const parser = createSignatureParser(ADDON_KEY, keys.pem);
  const fake = createFakeWorkspace();
  app = createApp({
    config,
    store,
    parser,
    modelClient,
    clockifyForWorkspace: () => fake.client,
  });
});

afterAll(() => store.close());
afterEach(() => vi.restoreAllMocks());

async function lifecycleToken(claims: Record<string, unknown>): Promise<string> {
  return testing.signTestToken(keys.privateKey, ADDON_KEY, {
    iat: Math.floor(Date.now() / 1000),
    ...claims,
  });
}

describe("lifecycle log privacy (F14)", () => {
  it("logs aliases, generation, and state — no raw ids, tokens, or JWT shapes", async () => {
    const logSpy = vi.spyOn(console, "log");
    const nowSeconds = Math.floor(Date.now() / 1000);

    const installed = await request(app)
      .post("/lifecycle/installed")
      .set(LIFECYCLE_HEADER, await lifecycleToken({ workspaceId: WORKSPACE_ID, addonId: ADDON_ID, iat: nowSeconds }))
      .send({
        workspaceId: WORKSPACE_ID,
        addonId: ADDON_ID,
        addonUserId: ADDON_USER_ID,
        authToken: INSTALL_TOKEN,
      });
    expect(installed.status).toBe(200);

    const statusChanged = await request(app)
      .post("/lifecycle/status-changed")
      .set(LIFECYCLE_HEADER, await lifecycleToken({ workspaceId: WORKSPACE_ID, iat: nowSeconds + 1 }))
      .send({ workspaceId: WORKSPACE_ID, status: "INACTIVE" });
    expect(statusChanged.status).toBe(200);

    const deleted = await request(app)
      .post("/lifecycle/deleted")
      .set(LIFECYCLE_HEADER, await lifecycleToken({ workspaceId: WORKSPACE_ID, iat: nowSeconds + 2 }))
      .send({ workspaceId: WORKSPACE_ID });
    expect(deleted.status).toBe(200);

    const lines = logSpy.mock.calls
      .map((call) => call.map(String).join(" "))
      .filter((line) => line.startsWith("[lifecycle]"));
    expect(lines.length).toBeGreaterThanOrEqual(3);

    for (const line of lines) {
      // Seeded raw identifiers must never appear.
      expect(line).not.toContain(WORKSPACE_ID);
      expect(line).not.toContain(ADDON_ID);
      expect(line).not.toContain(ADDON_USER_ID);
      expect(line).not.toContain(INSTALL_TOKEN);
      // Identifier/token SHAPES must never appear either: 24-hex entity ids
      // and JWT prefixes are rejected regardless of which id leaked.
      expect(line).not.toMatch(/[0-9a-f]{24}/);
      expect(line).not.toContain("eyJ");
      expect(line).toMatch(/workspace=ws-[A-Za-z0-9_-]{12}/);
    }

    const installedLine = lines.find((line) => line.includes("event=installed "));
    expect(installedLine).toContain("generation=1");
    expect(installedLine).toContain("status=active");
    expect(installedLine).toMatch(/addon=addon-[A-Za-z0-9_-]{12}/);

    const statusLine = lines.find((line) => line.includes("event=status_changed "));
    expect(statusLine).toContain("status=inactive");

    const deletedLine = lines.find((line) => line.includes("event=deleted "));
    expect(deletedLine).toContain("erased=");
    expect(deletedLine).toContain("generation=");
  });

  it("uses the same stable alias across events so the operator can correlate", async () => {
    const logSpy = vi.spyOn(console, "log");
    const workspaceId = "64ad1305c701cc5be7c26aa2";
    const nowSeconds = Math.floor(Date.now() / 1000);
    for (const [index, authToken] of ["corr-token-one", "corr-token-two"].entries()) {
      const res = await request(app)
        .post("/lifecycle/installed")
        .set(LIFECYCLE_HEADER, await lifecycleToken({ workspaceId, addonId: ADDON_ID, iat: nowSeconds + index }))
        .send({ workspaceId, addonId: ADDON_ID, authToken });
      expect(res.status).toBe(200);
    }
    const aliases = logSpy.mock.calls
      .map((call) => call.map(String).join(" "))
      .filter((line) => line.startsWith("[lifecycle]"))
      .map((line) => /workspace=(ws-[A-Za-z0-9_-]{12})/.exec(line)?.[1]);
    expect(aliases).toHaveLength(2);
    expect(new Set(aliases).size).toBe(1);
  });
});
