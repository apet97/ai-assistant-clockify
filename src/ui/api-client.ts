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

import type { ConfirmResponse, HistoryResponse, StreamEvent } from "./shared.js";
import {
  decodeChatResponse,
  decodeConfirmResponse,
  decodeHistoryResponse,
  decodeMeResponse,
  decodeNdjsonEvent,
  decodeOperationResponse,
  decodePermissionsResponse,
  decodePermissionSaveResponse,
  decodeSessionsResponse,
  decodeSimpleMutationResponse,
  decodeUndoResponse,
  decodeRunEventsResponse,
  protocolErrorMessage,
  type ApiFailure,
  type ChatResponse,
  type MeResponse,
  type PermissionsResponse,
  type PermissionSaveResponse,
  type SessionsResponse,
  type SimpleMutationResponse,
  type UndoResponse,
} from "./protocol.js";

/** The full API surface the chat UI talks to (the real client implements it). */
export interface ChatApi {
  /** Verified Clockify display preferences + public product links and CSRF token. */
  getMe?(): Promise<MeResponse>;
  getPermissions(): Promise<PermissionsResponse>;
  savePermissions(groups: Record<string, string>): Promise<PermissionSaveResponse>;
  /** Session restore: prior messages + live pending previews (rotated nonces). */
  getHistory(): Promise<HistoryResponse & { ok: true }>;
  /** Start a fresh conversation (new session); the old chat stays on the server. */
  newChat(): Promise<SimpleMutationResponse>;
  /** List the admin's live, owned, non-empty conversations (the history switcher). */
  listSessions(): Promise<SessionsResponse>;
  /** Switch the session cookie to an owned conversation; then restoreHistory replays it. */
  switchSession(id: string): Promise<SimpleMutationResponse>;
  /** Passive, scoped durable-operation status; never a control endpoint. */
  getOperation?(id: string): Promise<Awaited<ReturnType<typeof decodeOperationResponse>>>;
  /** Scoped durable v2 run-event pages for reload/second-tab restoration. */
  getRunEvents?(runId: string, after: number): Promise<import("./shared.js").RunEventPageResponse>;
  sendMessage(message: string): Promise<ChatResponse | ApiFailure>;
  /** Streaming send: harness results arrive incrementally, then the truthful reply.
   * `continuationRunId` (T14-F): resumes that exact v2 run's pending clarification
   * with this free text instead of starting a new run. */
  streamMessage(message: string, onEvent: (event: StreamEvent) => void, continuationRunId?: string): Promise<void>;
  confirmPreview(previewId: string, nonce: string): Promise<ConfirmResponse>;
  /** Streaming single confirm: the receipt arrives first, then the resume streams. */
  confirmStream(ref: { previewId: string; nonce: string }, onEvent: (event: StreamEvent) => void): Promise<void>;
  /** v2 exact clarification resolve (T14-F): streams the resumed run's events. */
  resolveClarificationOption(clarificationId: string, optionId: string, onEvent: (event: StreamEvent) => void): Promise<void>;
  cancelPreview(previewId: string): Promise<SimpleMutationResponse>;
  undo(id: string): Promise<UndoResponse>;
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
 * partial remainder. Any malformed JSON or event contract becomes a visible
 * `error` event; silently dropping a partial-deploy payload can otherwise leave
 * a confirmation card stranded with no explanation. Pass `final=true` when the
 * stream closes so an unterminated last line is decoded rather than discarded.
 */
export function createNdjsonParser(
  onEvent: (event: StreamEvent) => void,
): (chunk: string, final?: boolean) => void {
  let buffer = "";
  const processLine = (line: string): void => {
    if (!line) return;
    try {
      onEvent(decodeNdjsonEvent(JSON.parse(line)));
    } catch {
      onEvent({ type: "error", message: protocolErrorMessage(undefined) });
    }
  };
  return (chunk: string, final = false): void => {
    buffer += chunk;
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      processLine(line);
      nl = buffer.indexOf("\n");
    }
    if (final) {
      processLine(buffer.trim());
      buffer = "";
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
  let terminalDoneSeen = false;
  const protocolFailure = (): void => {
    onEvent({ type: "error", message: protocolErrorMessage(undefined) });
  };
  const feed = createNdjsonParser((event) => {
    // `done` is the stream commit marker. EOF alone is not success: a proxy can
    // cleanly truncate an HTTP 200 after any complete status/reply line. Once
    // committed, every additional event (including a second done) is a protocol
    // violation rather than a second turn fragment.
    if (terminalDoneSeen) {
      protocolFailure();
      return;
    }
    onEvent(event);
    if (event.type === "done") terminalDoneSeen = true;
  });
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    feed(decoder.decode(value, { stream: true }));
  }
  feed(decoder.decode(), true); // flush trailing UTF-8 bytes and an unterminated final event
  if (!terminalDoneSeen) protocolFailure();
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
    const body = await res.json() as unknown;
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const fields = body as Record<string, unknown>;
      if (typeof fields.message === "string") serverMessage = fields.message;
      if (opts?.withCode && typeof fields.code === "string") serverCode = fields.code;
    }
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
  let mePromise: Promise<MeResponse> | undefined;

  async function json<T extends { ok: boolean; message?: string }>(
    path: string,
    init: RequestInit | undefined,
    decode: (value: unknown) => T,
    requireSuccess = false,
  ): Promise<T> {
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
    try {
      const decoded = decode(body);
      if (requireSuccess && !decoded.ok) {
        throw new ApiError(res.status || 500, decoded.message?.trim() || "The request could not be completed.");
      }
      return decoded;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(res.status || 502, protocolErrorMessage(error));
    }
  }

  function getMe(): Promise<MeResponse> {
    mePromise ??= json("/api/me", undefined, decodeMeResponse, true).then((body) => {
      if (!body.ok) throw new ApiError(500, body.message ?? "Could not load this session.");
      return body;
    }).catch((error: unknown) => {
      mePromise = undefined;
      throw error;
    });
    return mePromise;
  }

  function csrfToken(): Promise<string> {
    return getMe().then((body) => body.csrfToken);
  }

  async function mutation<T extends { ok: boolean; message?: string }>(
    path: string,
    init: RequestInit,
    decode: (value: unknown) => T,
  ): Promise<T> {
    const token = await csrfToken();
    const headers = new Headers(init.headers);
    headers.set("x-csrf-token", token);
    return json(path, { ...init, headers }, decode);
  }

  async function mutationFetch(path: string, init: RequestInit): Promise<Response> {
    const token = await csrfToken();
    const headers = new Headers(init.headers);
    headers.set("x-csrf-token", token);
    return fetch(path, { credentials: "same-origin", ...init, headers });
  }
  const newRequestId = (): string => crypto.randomUUID();
  return {
    getMe,
    getPermissions: async () => {
      const body = await json("/api/permissions", undefined, decodePermissionsResponse, true);
      if (!body.ok) throw new ApiError(500, body.message ?? "Could not load permissions.");
      return body;
    },
    savePermissions: (groups) =>
      mutation(
        "/api/permissions/confirm",
        { method: "POST", body: JSON.stringify({ groups }) },
        decodePermissionSaveResponse,
      ),
    getHistory: async () => {
      const body = await json("/api/chat/history", undefined, decodeHistoryResponse, true);
      if (!body.ok) throw new ApiError(500, body.message ?? "Could not load history.");
      return body;
    },
    getRunEvents: async (runId, after) => {
      const body = await json(
        `/api/runs/${encodeURIComponent(runId)}/events?after=${encodeURIComponent(String(after))}`,
        undefined,
        decodeRunEventsResponse,
        true,
      );
      if (!body.ok) throw new ApiError(500, body.message ?? "Could not load run events.");
      return body;
    },
    newChat: () => mutation("/api/chat/new", { method: "POST" }, decodeSimpleMutationResponse),
    listSessions: async () => {
      const body = await json("/api/chat/sessions", undefined, decodeSessionsResponse, true);
      if (!body.ok) throw new ApiError(500, body.message ?? "Could not load conversations.");
      return body;
    },
    switchSession: (id) =>
      mutation(
        `/api/chat/sessions/${encodeURIComponent(id)}/open`,
        { method: "POST", body: JSON.stringify({}) },
        decodeSimpleMutationResponse,
      ),
    getOperation: (id) => json(`/api/operation-runs/${encodeURIComponent(id)}`, undefined, decodeOperationResponse),
    sendMessage: (message) => {
      const requestId = newRequestId();
      const send = () => mutation(
        "/api/chat/messages",
        { method: "POST", body: JSON.stringify({ message, requestId }) },
        decodeChatResponse,
      );
      return send().catch(() => send());
    },
    streamMessage: async (message, onEvent, continuationRunId) => {
      let res: Response;
      const requestId = newRequestId();
      try {
        const send = () => mutationFetch("/api/chat/stream", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message, requestId, ...(continuationRunId ? { continuationRunId } : {}) }),
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
      await mutation(
        `/api/confirmations/${encodeURIComponent(previewId)}/confirm`,
        { method: "POST", body: JSON.stringify({ nonce }) },
        decodeConfirmResponse,
      ),
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
    resolveClarificationOption: async (clarificationId, optionId, onEvent) => {
      let res: Response;
      try {
        res = await mutationFetch(`/api/clarifications/${encodeURIComponent(clarificationId)}/resolve`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ optionId }),
        });
      } catch (error) {
        onEvent({
          type: "error",
          ...(error instanceof ApiError && error.status === 401 ? { code: "unauthorized" } : {}),
          message: error instanceof ApiError ? error.message : "That option could not be resolved.",
        });
        return;
      }
      if (!res.ok || !res.body) {
        await surfaceStreamHttpError(res, onEvent, "That option could not be resolved.", { withCode: true });
        return;
      }
      await pumpNdjson(res, onEvent);
    },
    cancelPreview: (previewId) =>
      mutation(
        `/api/confirmations/${encodeURIComponent(previewId)}/cancel`,
        { method: "POST", body: JSON.stringify({}) },
        (value) => decodeSimpleMutationResponse(value, "cancelled"),
      ),
    undo: (id) => mutation(
      `/api/undo/${encodeURIComponent(id)}`,
      { method: "POST", body: JSON.stringify({}) },
      decodeUndoResponse,
    ),
  };
}
