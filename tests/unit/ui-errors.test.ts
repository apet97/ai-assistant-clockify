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
    vi.fn(async () => ({
      ok: status < 400,
      status,
      body: null,
      json: async () => body,
    })),
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
