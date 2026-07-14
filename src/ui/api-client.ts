/**
 * The same-origin fetch client for the embedded chat UI + the NDJSON stream
 * machinery, extracted from `mount()`'s neighbourhood in `main.ts`. A DOM-free
 * leaf (only the `fetch`/`TextDecoder` web APIs + types from `./shared.js`) so it
 * unit-tests without a DOM and adds no module cycle. `main.ts` re-exports these,
 * so the public/test import surface (`createFetchApi`/`ApiError`/… from
 * `./main.js`) is unchanged.
 *
 * SAFETY: the session cookie authenticates (`credentials: "same-origin"`); the
 * client never sees a token. Confirmation is button-only — typed chat text never
 * reaches a confirmation endpoint (that contract lives at the call sites).
 */

import type { ConfirmResponse, StreamEvent } from "./shared.js";

/** The full API surface the chat UI talks to (the real client implements it). */
export interface ChatApi {
  getPermissions(): Promise<unknown>;
  savePermissions(groups: Record<string, string>): Promise<unknown>;
  /** Session restore: prior messages + live pending previews (rotated nonces). */
  getHistory(): Promise<unknown>;
  /** Start a fresh conversation (new session); the old chat stays on the server. */
  newChat(): Promise<unknown>;
  /** List the admin's live, owned, non-empty conversations (the history switcher). */
  listSessions(): Promise<unknown>;
  /** Switch the session cookie to an owned conversation; then restoreHistory replays it. */
  switchSession(id: string): Promise<unknown>;
  sendMessage(message: string): Promise<unknown>;
  /** Streaming send: harness results arrive incrementally, then the truthful reply. */
  streamMessage(message: string, onEvent: (event: StreamEvent) => void): Promise<void>;
  confirmPreview(previewId: string, nonce: string): Promise<ConfirmResponse>;
  /** Streaming single confirm: the receipt arrives first, then the resume streams. */
  confirmStream(ref: { previewId: string; nonce: string }, onEvent: (event: StreamEvent) => void): Promise<void>;
  cancelPreview(previewId: string): Promise<unknown>;
  undo(id: string): Promise<unknown>;
}

/** Honest copy for an auth-expired exchange — the fix is a reload, say so. */
export const SESSION_EXPIRED_MESSAGE = "Your session has expired — reload the page to continue.";

/** An HTTP exchange the UI must surface by STATUS (only 401 throws; see json()). */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Honest user-facing copy for a failed HTTP exchange: 401 = the session
 * expired (reload); anything else shows the server's own message (the routes
 * return honest JSON copy, e.g. the rate limiter's "too quickly") or the
 * caller's fallback.
 */
export function httpErrorMessage(status: number, serverMessage?: string, fallback = "Message failed to send."): string {
  if (status === 401) return SESSION_EXPIRED_MESSAGE;
  return serverMessage && serverMessage.trim() ? serverMessage : fallback;
}

/**
 * A stateful NDJSON line parser: feed it response-body chunks (which can split a
 * line anywhere) and it calls `onEvent` once per COMPLETE line, buffering the
 * partial remainder. Malformed lines are skipped (never throws).
 */
export function createNdjsonParser(onEvent: (event: StreamEvent) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk: string): void => {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) {
        try {
          onEvent(JSON.parse(line) as StreamEvent);
        } catch {
          /* skip a malformed line */
        }
      }
      nl = buffer.indexOf("\n");
    }
  };
}

/**
 * Drain a streaming NDJSON response body into `onEvent`. Reads chunks until the
 * body ends, feeding each through `createNdjsonParser` (lines can split across
 * chunks), then decodes once more with no args to flush any trailing bytes the
 * final chunk left in the decoder. Caller has already verified `res.body` exists.
 */
export async function pumpNdjson(res: Response, onEvent: (event: StreamEvent) => void): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const feed = createNdjsonParser(onEvent);
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    feed(decoder.decode(value, { stream: true }));
  }
  feed(decoder.decode()); // flush any trailing bytes
}

/**
 * Surface a non-OK (or body-less) streaming response as a single `error` event
 * instead of a blanket "unavailable": read the route's honest JSON `{message}`
 * (rate limit, expired session) and map the status via `httpErrorMessage`. With
 * `withCode`, the server's `code` is forwarded too so a stale-nonce 400 (a
 * cross-tab nonce rotation) can re-arm this tab via onStale instead of
 * dead-ending — see submitConfirmStream/onStale.
 */
export async function surfaceStreamHttpError(
  res: Response,
  onEvent: (event: StreamEvent) => void,
  fallback: string,
  opts?: { withCode?: boolean },
): Promise<void> {
  let serverMessage: string | undefined;
  let serverCode: string | undefined;
  try {
    const body = (await res.json()) as { message?: string; code?: string };
    serverMessage = body?.message;
    if (opts?.withCode) serverCode = body?.code;
  } catch {
    /* keep the fallback */
  }
  onEvent({
    type: "error",
    ...(serverCode ? { code: serverCode } : {}),
    message: httpErrorMessage(res.status, serverMessage, fallback),
  });
}

/** Real fetch-backed API client (same-origin; the session cookie authenticates). */
export function createFetchApi(): ChatApi {
  let csrfTokenPromise: Promise<string> | undefined;

  async function json(path: string, init?: RequestInit): Promise<unknown> {
    const headers = new Headers(init?.headers);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    const res = await fetch(path, {
      credentials: "same-origin",
      ...init,
      headers,
    });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    // ONLY 401 throws: an expired session has one fix (reload) and must say so.
    // Other non-ok statuses RETURN their JSON body — the confirm/cancel/undo
    // flows render those `{ok:false, code, message}` payloads as return values.
    if (res.status === 401) throw new ApiError(401, SESSION_EXPIRED_MESSAGE);
    return body;
  }

  function csrfToken(): Promise<string> {
    csrfTokenPromise ??= json("/api/me").then((body) => {
      const token = (body as { csrfToken?: unknown } | undefined)?.csrfToken;
      if (typeof token !== "string" || !token) {
        throw new ApiError(403, "Could not verify this browser session. Reload the page and try again.");
      }
      return token;
    }).catch((error: unknown) => {
      csrfTokenPromise = undefined;
      throw error;
    });
    return csrfTokenPromise;
  }

  async function mutation(path: string, init: RequestInit): Promise<unknown> {
    const token = await csrfToken();
    const headers = new Headers(init.headers);
    headers.set("x-csrf-token", token);
    return json(path, { ...init, headers });
  }

  async function mutationFetch(path: string, init: RequestInit): Promise<Response> {
    const token = await csrfToken();
    const headers = new Headers(init.headers);
    headers.set("x-csrf-token", token);
    return fetch(path, { credentials: "same-origin", ...init, headers });
  }
  const newRequestId = (): string => crypto.randomUUID();
  return {
    getPermissions: () => json("/api/permissions"),
    savePermissions: (groups) =>
      mutation("/api/permissions/confirm", { method: "POST", body: JSON.stringify({ groups }) }),
    getHistory: () => json("/api/chat/history"),
    newChat: () => mutation("/api/chat/new", { method: "POST" }),
    listSessions: () => json("/api/chat/sessions"),
    switchSession: (id) =>
      mutation(`/api/chat/sessions/${encodeURIComponent(id)}/open`, { method: "POST", body: JSON.stringify({}) }),
    sendMessage: (message) => {
      const requestId = newRequestId();
      const send = () => mutation("/api/chat/messages", { method: "POST", body: JSON.stringify({ message, requestId }) });
      return send().catch(() => send());
    },
    streamMessage: async (message, onEvent) => {
      let res: Response;
      const requestId = newRequestId();
      try {
        const send = () => mutationFetch("/api/chat/stream", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message, requestId }),
        });
        try {
          res = await send();
        } catch {
          res = await send();
        }
      } catch (error) {
        onEvent({ type: "error", message: error instanceof ApiError ? error.message : "The assistant is temporarily unavailable. Please try again." });
        return;
      }
      if (!res.ok || !res.body) {
        // Surface the route's honest JSON copy (rate limit, expired session)
        // instead of a blanket "unavailable".
        await surfaceStreamHttpError(res, onEvent, "The assistant is temporarily unavailable. Please try again.");
        return;
      }
      await pumpNdjson(res, onEvent);
    },
    confirmPreview: async (previewId, nonce) =>
      await mutation(`/api/confirmations/${encodeURIComponent(previewId)}/confirm`, {
        method: "POST",
        body: JSON.stringify({ nonce }),
      }) as ConfirmResponse,
    confirmStream: async (ref, onEvent) => {
      let res: Response;
      try {
        res = await mutationFetch(`/api/confirmations/${encodeURIComponent(ref.previewId)}/confirm?stream=1`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ nonce: ref.nonce }),
        });
      } catch (error) {
        onEvent({
          type: "error",
          ...(error instanceof ApiError && error.status === 401 ? { code: "unauthorized" } : {}),
          message: error instanceof ApiError ? error.message : "Confirmation failed.",
        });
        return;
      }
      if (!res.ok || !res.body) {
        // A non-OK confirm is a JSON error (validation/policy/expired) — surface
        // it; a 401 gets the session-expired copy. Carry the server's `code`
        // through (withCode) so a stale-nonce 400 (a cross-tab nonce rotation)
        // can re-arm this tab instead of dead-ending — see submitConfirmStream/onStale.
        await surfaceStreamHttpError(res, onEvent, "Confirmation failed.", { withCode: true });
        return;
      }
      await pumpNdjson(res, onEvent);
    },
    cancelPreview: (previewId) =>
      mutation(`/api/confirmations/${encodeURIComponent(previewId)}/cancel`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    undo: (id) => mutation(`/api/undo/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify({}) }),
  };
}
