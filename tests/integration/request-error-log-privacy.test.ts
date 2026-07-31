import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { testing } from "@apet97/clockify-addon-sdk";
import { createApp } from "../../src/server.js";
import { createSignatureParser, ClockifyHeaders } from "../../src/addon/verify.js";
import { createStore, type Store } from "../../src/db/store.js";
import { loadConfig } from "../../src/config.js";
import { classifyLoggableError } from "../../src/log-error-class.js";
import { createModelClient } from "../../src/assistant/model-client.js";
import { makeTestConfig } from "../helpers/config.js";
import { createFakeWorkspace } from "../helpers/fake-clockify.js";
import { testKeys } from "../helpers/test-keys.js";

/**
 * D5. `tests/integration/alert-log-privacy.test.ts` covers the D3 CLASSIFIED
 * alert channel and deliberately silences `console.error` (:130) without
 * asserting anything about it. This file covers exactly that gap: the terminal
 * Express error handler's own line, and the response body beside it.
 *
 * The two are DIFFERENT SINKS, which is what the handler's two comments used to
 * disagree about — one described the log, the other the response. Both are
 * pinned here, because "different sinks" is only a durable claim if both ends
 * are held.
 *
 * NO FAKE is involved in the headline case. `express.json()` and V8's
 * `JSON.parse` are the real production components, and the leak is their real,
 * unmodified behaviour: V8 quotes ~10 bytes on each side of the offending
 * token. The store failure case reuses the same injected-throw technique as
 * alert-log-privacy.test.ts.
 */
const ADDON_KEY = "ai-assistant";
const WORKSPACE_ID = "64ad1305c701cc5be7c26fe4";
const ADMIN_ID = "5f0a1305c701cc5be7c26aa1";
const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJ3b3Jrc3BhY2VJZCI6IngifQ.sig";
const PROMPT = "delete every time entry for Ana Petrovic before Friday";
const HOSTILE_MESSAGE =
  `attempt to write a readonly database: UPDATE installations SET addon_token_ciphertext='${JWT}' `
  + `WHERE workspace_id='${WORKSPACE_ID}' AND admin='${ADMIN_ID}' /* ${PROMPT} */`;

function assertClean(line: string): void {
  expect(line).not.toContain(WORKSPACE_ID);
  expect(line).not.toContain(ADMIN_ID);
  expect(line).not.toContain(JWT);
  expect(line).not.toContain(PROMPT);
  expect(line).not.toContain("eyJ");
  expect(line).not.toMatch(/[0-9a-f]{24}/u);
  expect(line).not.toContain("UPDATE ");
  // Any surviving fragment of the sentence, not just the whole of it.
  expect(line).not.toMatch(/Ana|Petrovic|delete every|readonly database/u);
}

let keys: { privateKey: unknown; pem: string };
beforeAll(async () => {
  keys = await testKeys();
});
afterEach(() => vi.restoreAllMocks());

function errorLines(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((call) => call.map(String).join(" "));
}

function appWith(store: Store) {
  return createApp({
    config: makeTestConfig({ clockifyAddonPublicKeyPem: keys.pem, clockifyAddonKey: ADDON_KEY }),
    store,
    parser: createSignatureParser(ADDON_KEY, keys.pem),
    modelClient: { complete: async () => "{}" },
    clockifyForWorkspace: () => createFakeWorkspace().client,
  });
}

describe("terminal request-error handler privacy", () => {
  it("proves the raw JSON.parse message really does quote the request body", () => {
    // The premise of this whole task, established against the real runtime
    // rather than assumed: if this ever stops holding, the fix below is
    // over-strict and should be revisited rather than silently kept.
    const hostileBody = `{"message":"${PROMPT}","workspaceId":"${WORKSPACE_ID}"}x`;
    let message = "";
    try {
      JSON.parse(hostileBody);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe("");

    // Two shapes, both real. A body that is not JSON at all quotes its opening
    // bytes; a body whose first invalid token is deep inside quotes both sides.
    let quotedPrompt = "";
    try {
      JSON.parse(PROMPT);
    } catch (error) {
      quotedPrompt = (error as Error).message;
    }
    expect(quotedPrompt).toContain("delete eve");

    let quotedSecret = "";
    try {
      JSON.parse(`["${WORKSPACE_ID}", ${JWT}]`);
    } catch (error) {
      quotedSecret = (error as Error).message;
    }
    expect(quotedSecret).toContain("7c26fe4");
    expect(quotedSecret).toContain("eyJhbGciOi");
  });

  it("logs a classification, not the parser's quotation of the admin's own text", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = createStore(":memory:", { encryptionKey: "test-key" });
    const res = await request(appWith(store))
      .post("/lifecycle/installed")
      .set("content-type", "application/json")
      // Valid JSON followed by one stray byte: body-parser raises
      // `entity.parse.failed` (status 400) and the terminal handler is the only
      // thing that sees it.
      .send(`{"message":"${PROMPT}","workspaceId":"${WORKSPACE_ID}","token":"${JWT}"}x`);
    store.close();

    expect(res.status).toBe(400);
    const lines = errorLines(error).filter((line) => line.startsWith("request error:"));
    expect(lines).toEqual(["request error: name=SyntaxError type=entity.parse.failed status=400"]);
    assertClean(lines[0]!);

    // The other sink: a fixed sentence and nothing derived from the error.
    expect(res.body).toEqual({
      ok: false,
      code: "invalid_request",
      message: "The request was rejected (too large or malformed).",
    });
    assertClean(JSON.stringify(res.body));
  });

  it("still distinguishes an oversized body from a malformed one", async () => {
    // The classification has to stay operationally useful: 413 and 400 are the
    // two cases a runbook separates, and both used to be legible only from the
    // raw message.
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store = createStore(":memory:", { encryptionKey: "test-key" });
    const res = await request(appWith(store))
      .post("/lifecycle/installed")
      .set("content-type", "application/json")
      .send(JSON.stringify({ message: PROMPT.repeat(2_000) }));
    store.close();

    expect(res.status).toBe(413);
    const lines = errorLines(error).filter((line) => line.startsWith("request error:"));
    expect(lines).toEqual(["request error: name=PayloadTooLargeError type=entity.too.large status=413"]);
    assertClean(lines[0]!);
    expect(res.body.code).toBe("invalid_request");
  });

  it("logs a mid-turn store failure by driver code, never by driver text", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = createStore(":memory:", { encryptionKey: "test-key" });
    const failing: Store = {
      ...store,
      saveInstallation: () => {
        throw Object.assign(new Error(HOSTILE_MESSAGE), { name: "SqliteError", code: "SQLITE_BUSY" });
      },
    };
    const token = await testing.signTestToken(keys.privateKey, ADDON_KEY, {
      iat: Math.floor(Date.now() / 1000),
      workspaceId: WORKSPACE_ID,
      addonId: "69950af22720c2992bab57f7",
    });
    const res = await request(appWith(failing))
      .post("/lifecycle/installed")
      .set(ClockifyHeaders.LIFECYCLE_TOKEN, token)
      .send({ workspaceId: WORKSPACE_ID, authToken: "install-token" });
    store.close();

    expect(res.status).toBe(500);
    const lines = errorLines(error).filter((line) => line.startsWith("request error:"));
    expect(lines).toEqual(["request error: name=SqliteError code=SQLITE_BUSY status=none"]);
    assertClean(lines[0]!);
    expect(res.body).toEqual({
      ok: false,
      code: "server_error",
      message: "Something went wrong on our side. Please try again.",
    });
  });

  it("names the offending env variable at boot without quoting its value", () => {
    // Driven through the REAL `loadConfig`, not a hand-built ZodError, because
    // the whole point is what the production schema actually reports.
    const base = {
      PORT: "3001",
      BASE_URL: "https://example.com/addon",
      CLOCKIFY_ADDON_PUBLIC_KEY_PEM: "public-key",
      CLOCKIFY_ADDON_KEY: "ai-assistant",
      SESSION_SECRET: "session-secret-with-32-chars-of-entropy",
      DATABASE_PATH: ":memory:",
      LLM_BASE_URL: "https://api.deepseek.com",
      LLM_API_KEY: "llm-key",
      LLM_MODEL: "deepseek-v4-pro",
      NODE_ENV: "test",
    };
    const startupLine = (env: Record<string, string | undefined>): string => {
      try {
        loadConfig(env);
      } catch (error) {
        return `startup failed: ${classifyLoggableError(error)}`;
      }
      throw new Error("expected loadConfig to reject");
    };

    // A missing/short secret: only a length bound is in the issue, so naming
    // the path costs nothing and the value never appears.
    const missingSecret = startupLine({ ...base, SESSION_SECRET: undefined });
    expect(missingSecret).toBe("startup failed: name=ZodError issues=SESSION_SECRET");

    // The one issue kind that DOES echo a value (`invalid_enum_value`): the
    // path is reported, the rejected value is not.
    const badProvider = startupLine({ ...base, LLM_PROVIDER: "SECRET-PROVIDER-xyz" });
    expect(badProvider).toBe("startup failed: name=ZodError issues=LLM_PROVIDER");
    expect(badProvider).not.toContain("SECRET-PROVIDER-xyz");

    // The non-schema check names its own key on the same channel.
    expect(startupLine({ ...base, NODE_ENV: "production", DATA_ENCRYPTION_KEY: undefined }))
      .toContain("issues=DATA_ENCRYPTION_KEY");

    // The thrown message is deliberately UNCHANGED — an operator debugging
    // interactively, and every assertion in tests/unit/config.test.ts, still
    // sees the validator's full text. Only the LOG refuses it.
    expect(() => loadConfig({ ...base, LLM_TIMEOUT_MS: "not-a-number" })).toThrow(/LLM_TIMEOUT_MS/u);
  });

  it("bounds the provider request id, the one alert value the provider controls", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = createModelClient({
      baseUrl: "https://provider.invalid/v1/chat/completions",
      apiKey: "test-key",
      model: "test-model",
      sleepImpl: async () => undefined,
      fetchImpl: async () => new Response("{}", {
        status: 503,
        // A provider echoing admin text back in the correlation header.
        headers: { "x-request-id": `${PROMPT} ${JWT}` },
      }),
    });
    await expect(client.complete([{ role: "user", content: PROMPT }])).rejects.toThrow();
    const lines = warn.mock.calls.map((call) => call.map(String).join(" "))
      .filter((line) => line.includes("provider_http_error"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toContain("request_id=unclassified");
      assertClean(line);
    }
  });

  it("reports a non-Error throw by shape, never by value", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = createStore(":memory:", { encryptionKey: "test-key" });
    const failing: Store = {
      ...store,
      // `String(err)` on this used to be the widest hole in the handler: an
      // arbitrary thrown value is less bounded than a message.
      saveInstallation: () => {
        throw `${PROMPT} ${JWT} ${WORKSPACE_ID}`;
      },
    };
    const token = await testing.signTestToken(keys.privateKey, ADDON_KEY, {
      iat: Math.floor(Date.now() / 1000),
      workspaceId: WORKSPACE_ID,
      addonId: "69950af22720c2992bab57f7",
    });
    const res = await request(appWith(failing))
      .post("/lifecycle/installed")
      .set(ClockifyHeaders.LIFECYCLE_TOKEN, token)
      .send({ workspaceId: WORKSPACE_ID, authToken: "install-token" });
    store.close();

    expect(res.status).toBe(500);
    const lines = errorLines(error).filter((line) => line.startsWith("request error:"));
    expect(lines).toEqual(["request error: thrown=string status=none"]);
    assertClean(lines[0]!);
  });
});
