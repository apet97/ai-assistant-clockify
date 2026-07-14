import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  createFetchApi,
  httpErrorMessage,
  SESSION_EXPIRED_MESSAGE,
  submitMessage,
  type StreamEvent,
} from "../../src/ui/main.js";

/**
 * The UI must surface real HTTP failures honestly: a 401 means "reload"
 * (sessions expire after 8h), and the routes' own JSON copy (e.g. the rate
 * limiter's 429 message) must reach the chat error bar verbatim — never a
 * blanket "Message failed to send.".
 */
function stubFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) => {
      const isMeBootstrap = path === "/api/me" && status !== 401;
      const responseStatus = isMeBootstrap ? 200 : status;
      return {
        ok: responseStatus < 400,
        status: responseStatus,
        body: null,
        json: async () => isMeBootstrap ? { ok: true, csrfToken: "csrf-token" } : body,
      };
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("httpErrorMessage", () => {
  it("maps 401 to the session-expired copy regardless of any body", () => {
    expect(httpErrorMessage(401, "whatever")).toBe(SESSION_EXPIRED_MESSAGE);
  });

  it("prefers the server's own message, then the fallback", () => {
    expect(httpErrorMessage(429, "You're sending messages too quickly — please wait a moment and try again.")).toMatch(
      /too quickly/,
    );
    expect(httpErrorMessage(502, "", "fallback copy")).toBe("fallback copy");
  });
});

describe("createFetchApi error surfacing", () => {
  it("sendMessage on a 401 rejects with ApiError and submitMessage shows the session copy", async () => {
    stubFetch(401, { ok: false, code: "unauthorized", message: "No valid session." });
    const api = createFetchApi();
    await expect(api.sendMessage("hi")).rejects.toBeInstanceOf(ApiError);

    const errors: string[] = [];
    let working = false;
    await submitMessage(api as never, "hi", {
      onWorking: (w) => {
        working = w;
      },
      onAssistant: () => {},
      onResults: () => {},
      onError: (m) => errors.push(m),
    });
    expect(errors).toEqual([SESSION_EXPIRED_MESSAGE]);
    expect(working).toBe(false); // always cleared
  });

  it("submitMessage surfaces a non-401 turn failure ({ok:false}) instead of rendering nothing", async () => {
    // The POST /chat/messages route returns 502 {ok:false,code,message} on a
    // failed turn; json() only THROWS on 401, so a non-401 error body comes
    // back as a return value. submitMessage must detect ok===false and route
    // the server's honest copy to onError — never silently render nothing.
    stubFetch(502, { ok: false, code: "model_error", message: "The assistant is temporarily unavailable." });
    const api = createFetchApi();
    const errors: string[] = [];
    const assistant: string[] = [];
    let working = false;
    await submitMessage(api as never, "hi", {
      onWorking: (w) => {
        working = w;
      },
      onAssistant: (t) => assistant.push(t),
      onResults: () => {},
      onError: (m) => errors.push(m),
    });
    expect(errors).toEqual(["The assistant is temporarily unavailable."]);
    expect(assistant).toEqual([]); // never rendered an (empty) assistant bubble
    expect(working).toBe(false); // always cleared
  });

  it("streamMessage surfaces the route's 429 copy verbatim (and the session copy on 401)", async () => {
    stubFetch(429, { ok: false, code: "rate_limited", message: "You're sending messages too quickly — please wait a moment and try again." });
    const api = createFetchApi();
    const events: StreamEvent[] = [];
    await api.streamMessage("hi", (e) => events.push(e));
    expect(events).toEqual([{ type: "error", message: expect.stringMatching(/too quickly/) }]);

    stubFetch(401, { ok: false, code: "unauthorized", message: "No valid session." });
    const expired: StreamEvent[] = [];
    await createFetchApi().streamMessage("hi", (e) => expired.push(e));
    expect(expired).toEqual([{ type: "error", message: SESSION_EXPIRED_MESSAGE }]);
  });

  it("a non-401 confirm error still RESOLVES with the JSON body (the confirm flow renders it)", async () => {
    stubFetch(409, { ok: false, code: "expired", message: "This confirmation has expired." });
    const result = (await createFetchApi().confirmPreview("p1", "n1")) as { ok: boolean; message?: string };
    expect(result.ok).toBe(false);
    expect(result.message).toContain("expired");
  });

  it("confirmStream maps a 401 to the session copy (and carries the server code through)", async () => {
    stubFetch(401, { ok: false, code: "unauthorized", message: "No valid session." });
    const events: StreamEvent[] = [];
    await createFetchApi().confirmStream({ previewId: "p1", nonce: "n1" }, (e) => events.push(e));
    // The error event now CARRIES the server `code` (r1-concurrency-races-02 needs
    // `code:'invalid_confirmation'` to drive the stale-nonce re-arm); a 401 still
    // shows the session copy and a non-stale code routes to onError, not re-arm.
    expect(events).toEqual([{ type: "error", code: "unauthorized", message: SESSION_EXPIRED_MESSAGE }]);
  });

  it("confirmStream carries code:'invalid_confirmation' on a stale-nonce 400 (the re-arm signal)", async () => {
    stubFetch(400, { ok: false, code: "invalid_confirmation", message: "Confirmation does not match this preview." });
    const events: StreamEvent[] = [];
    await createFetchApi().confirmStream({ previewId: "p1", nonce: "n1" }, (e) => events.push(e));
    expect(events).toEqual([
      { type: "error", code: "invalid_confirmation", message: "Confirmation does not match this preview." },
    ]);
  });
});

/**
 * The chat-history switcher's client methods: `listSessions()` GETs the list and
 * `switchSession(id)` POSTs the open route with the id URL-encoded (the id comes
 * from the authenticated list endpoint, but encodeURIComponent keeps the path
 * safe and mirrors the confirm/undo callers). We pin the exact path + method via
 * a recording fetch mock so a wrong verb or unencoded id can't slip through.
 */
describe("createFetchApi chat-history switcher methods", () => {
  function recordFetch(): { calls: Array<{ path: string; init?: RequestInit }> } {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (path: string, init?: RequestInit) => {
        calls.push({ path, init });
        return {
          ok: true,
          status: 200,
          body: null,
          json: async () => path === "/api/me" ? { ok: true, csrfToken: "csrf-token" } : { ok: true },
        };
      }),
    );
    return { calls };
  }

  it("listSessions GETs /api/chat/sessions", async () => {
    const { calls } = recordFetch();
    const body = (await createFetchApi().listSessions()) as { ok: boolean };
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/api/chat/sessions");
    // json() defaults to GET — no explicit method override.
    expect(calls[0].init?.method).toBeUndefined();
    expect(body.ok).toBe(true);
  });

  it("switchSession POSTs /api/chat/sessions/<encoded id>/open with an encoded id", async () => {
    const { calls } = recordFetch();
    await createFetchApi().switchSession("a b/../c?d");
    expect(calls).toHaveLength(2);
    expect(calls[0].path).toBe("/api/me");
    expect(calls[1].path).toBe(`/api/chat/sessions/${encodeURIComponent("a b/../c?d")}/open`);
    expect(calls[1].init?.method).toBe("POST");
  });
});

describe("createFetchApi CSRF fallback", () => {
  it("loads the session token once from /api/me and sends it on every mutation", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      const body = path === "/api/me" ? { ok: true, csrfToken: "csrf-token" } : { ok: true };
      return { ok: true, status: 200, body: null, json: async () => body };
    }));
    const api = createFetchApi();
    await api.sendMessage("hello");
    await api.cancelPreview("p1");

    expect(calls.map((call) => call.path)).toEqual([
      "/api/me",
      "/api/chat/messages",
      "/api/confirmations/p1/cancel",
    ]);
    for (const call of calls.slice(1)) {
      expect(new Headers(call.init?.headers).get("x-csrf-token")).toBe("csrf-token");
    }
  });
});
