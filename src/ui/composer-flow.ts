/**
 * The DOM-free send / stream / switch flows for the embedded chat UI, extracted
 * from `main.ts`. Each takes a minimal API surface + hooks (the DOM or a test
 * plugs in), so the responsiveness, truthful-preview batching, and error-
 * surfacing contracts are unit-tested without a browser. `main.ts` re-exports
 * these, so the public/test import surface (`submitMessage`/`submitStreaming`/
 * `switchToSession`/… from `./main.js`) is unchanged.
 *
 * SAFETY: confirmation is button-only. Typed chat text — including "yes" — flows
 * through `submitMessage`/`submitStreaming` to the chat endpoint and NEVER to a
 * confirmation endpoint.
 */

import { ApiError, httpErrorMessage } from "./api-client.js";
import { dispatchStreamEvent, PreviewBuffer, type ChatResult, type StreamEvent } from "./shared.js";

// ---------------------------------------------------------------------------
// Chat response shapes + the responsive send flow (testable core).
// ---------------------------------------------------------------------------

export interface ChatResponse {
  ok: boolean;
  reply: { kind: string; text: string };
  results: ChatResult[];
}

/** Minimal API surface the send flow needs (so it's trivial to test). */
export interface ChatApiLike {
  sendMessage(message: string): Promise<unknown>;
}

/**
 * Hooks the DOM (or a test) plugs into the send flow. `onWorking(true)` fires
 * BEFORE the request so the UI can announce "Assistant is working…" immediately
 * (responsiveness) and is ALWAYS cleared afterward (even on error). The assistant
 * bubble is only appended when the (truthful) reply text is non-empty — in
 * tool-mode the model often returns no text, and the results speak for themselves.
 */
export interface ComposerHooks {
  onWorking(working: boolean): void;
  onAssistant(text: string): void;
  onResults(results: ChatResult[]): void;
  onError(message: string): void;
  /** Latest progress label ("Starting the timer") — purely cosmetic, optional. */
  onStatus?(label: string): void;
}

/**
 * The non-streaming send flow over POST /api/chat/messages. The mounted UI uses
 * `submitStreaming` (+ /chat/stream) instead — this is the maintained, unit-tested
 * fallback/test surface (a simple request/response shape the responsiveness +
 * error-surfacing contracts are pinned against). Kept deliberately so the
 * non-streaming route has a tested client; do not wire it into mount() without
 * a reason.
 *
 * `sendMessage` → `json()` only THROWS on 401 (an expired session); a non-401
 * turn failure (the route's 502 `{ok:false,code,message}`) comes back as the
 * return body, so we must inspect `ok === false` and surface the server's honest
 * copy via onError — otherwise a failed turn would render nothing.
 */
export async function submitMessage(api: ChatApiLike, message: string, hooks: ComposerHooks): Promise<void> {
  hooks.onWorking(true);
  try {
    const response = (await api.sendMessage(message)) as ChatResponse & { code?: string; message?: string };
    if (response.ok === false) {
      hooks.onError(response.message?.trim() ? response.message : "Message failed to send.");
      return;
    }
    if (response.reply?.text) hooks.onAssistant(response.reply.text);
    hooks.onResults(response.results ?? []);
  } catch (error) {
    hooks.onError(error instanceof ApiError ? error.message : "Message failed to send.");
  } finally {
    hooks.onWorking(false);
  }
}

// --- NDJSON streaming (POST /api/chat/stream) ------------------------------

export interface StreamingApi {
  streamMessage(message: string, onEvent: (event: StreamEvent) => void): Promise<void>;
}

/**
 * The streaming send flow. Receipts/clarifies render as they stream in; PREVIEWS
 * are buffered and flushed together (so a batch keeps its single "Confirm all"
 * card) when the truthful reply arrives. Same responsiveness contract as
 * `submitMessage`: working is announced before and always cleared after.
 */
export async function submitStreaming(api: StreamingApi, message: string, hooks: ComposerHooks): Promise<void> {
  hooks.onWorking(true);
  const buffer = new PreviewBuffer((results) => hooks.onResults(results));
  try {
    await api.streamMessage(message, (event) => {
      dispatchStreamEvent(event, hooks, buffer, "Message failed.");
    });
  } catch {
    hooks.onError("Message failed to send.");
  } finally {
    buffer.flush(); // flush any previews if the stream ended without a reply
    hooks.onWorking(false);
  }
}

// --- Chat-history switch (POST /api/chat/sessions/:id/open) -----------------

/** Minimal API surface the switch flow needs (so it's trivial to test). */
export interface SwitchApiLike {
  switchSession(id: string): Promise<unknown>;
}

/**
 * Hooks the switch flow plugs into. `onSwitched(id)` fires ONLY after the cookie
 * was re-bound to the target session (so the host can reset the transcript and
 * replay the switched-to conversation); on ANY failure it fires `onError` and
 * NEVER `onSwitched` — the current chat must stay intact when the switch didn't
 * happen.
 */
export interface SwitchHooks {
  onSwitched(id: string): void | Promise<void>;
  onError(message: string): void;
}

/** Honest fallback copy when opening a past conversation fails (non-401). */
export const SWITCH_FAILED_MESSAGE = "Could not open that conversation. Please try again.";

/**
 * The chat-history switch flow over POST /api/chat/sessions/:id/open. Mirrors the
 * send/new-chat error discipline: `switchSession` → `json()` only THROWS on 401
 * (an expired session → the reload copy); a non-401 failure (the route's 404
 * `{ok:false,code,message}` for a foreign/expired id) comes back as the return
 * body, so we inspect `ok === false` and surface the server's honest copy. ON
 * SUCCESS we hand the id to `onSwitched` (the host re-cookied already on the
 * server) so it can reset + replay; on failure the current chat is LEFT INTACT.
 */
export async function switchToSession(api: SwitchApiLike, id: string, hooks: SwitchHooks): Promise<void> {
  try {
    const response = (await api.switchSession(id)) as { ok?: boolean; message?: string };
    if (response?.ok === false) {
      hooks.onError(response.message?.trim() ? response.message : SWITCH_FAILED_MESSAGE);
      return;
    }
    await hooks.onSwitched(id);
  } catch (error) {
    // A 401 always means "reload" (httpErrorMessage maps it); any other thrown
    // failure shows the friendly switch fallback. The current chat stays intact.
    hooks.onError(error instanceof ApiError ? httpErrorMessage(error.status, error.message, SWITCH_FAILED_MESSAGE) : SWITCH_FAILED_MESSAGE);
  }
}
