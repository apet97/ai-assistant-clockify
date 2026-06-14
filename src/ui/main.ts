import "./styles.css";
import { isNearBottom } from "./presentation.js";
import {
  el,
  ICON_GEAR,
  renderClarify,
  renderPermissionTable,
  renderPreview,
  renderReceipt,
  renderWelcome,
  svgIcon,
} from "./render.js";
import {
  createRestoreGate,
  historyRestoreItems,
  type ChatController,
  type ChatResult,
  type HistoryResponse,
  type PolicyShape,
  type PreviewResult,
  type RestoreGate,
  type StreamEvent,
} from "./shared.js";

// Re-export the shared UI primitives from the leaf `./shared.js` so the
// public/test import surface (`featureGroupRows` et al. from `./main.js`) is
// unchanged. They live in the leaf so `render.ts` can use them without importing
// from main (which imports render's builders) — that would be a circular dep.
export { featureGroupRows, runConfirmStreamLive, settleConfirmOutcome, submitConfirmStream } from "./shared.js";
export type {
  PolicyShape,
  ChatController,
  PreviewResult,
  ChatResult,
  ConfirmResponse,
  ConfirmHooks,
  ConfirmStreamApi,
  ConfirmStreamLive,
  StreamEvent,
} from "./shared.js";
export {
  batchItemOutcomes,
  expiryView,
  formatCountdown,
  humanizeGroup,
  isNearBottom,
  levelLabel,
  msUntil,
} from "./presentation.js";

/**
 * Vanilla TS chat UI (frontend rules: no framework). The testable core is the
 * controller + pure helpers; DOM bootstrap runs only in a browser.
 *
 * SAFETY: confirmation is button-only. Typed chat text — including "yes" — is
 * sent to the chat endpoint and NEVER to a confirmation endpoint. Only the
 * Confirm / Confirm all buttons call confirmPreview.
 *
 * All DOM text is set via textContent (never innerHTML) so untrusted Clockify
 * data and model output cannot inject markup.
 */

export interface ChatApi {
  getPermissions(): Promise<unknown>;
  savePermissions(groups: Record<string, string>): Promise<unknown>;
  /** Session restore: prior messages + live pending previews (rotated nonces). */
  getHistory(): Promise<unknown>;
  /** Start a fresh conversation (new session); the old chat stays on the server. */
  newChat(): Promise<unknown>;
  sendMessage(message: string): Promise<unknown>;
  /** Streaming send: harness results arrive incrementally, then the truthful reply. */
  streamMessage(message: string, onEvent: (event: StreamEvent) => void): Promise<void>;
  confirmPreview(previewId: string, nonce: string): Promise<unknown>;
  /** Streaming single confirm: the receipt arrives first, then the resume streams. */
  confirmStream(ref: { previewId: string; nonce: string }, onEvent: (event: StreamEvent) => void): Promise<void>;
  cancelPreview(previewId: string): Promise<unknown>;
  undo(id: string): Promise<unknown>;
}

export function createController(api: ChatApi): ChatController {
  return {
    send: (message) => api.sendMessage(message),
    confirm: (ref) => api.confirmPreview(ref.previewId, ref.nonce),
    confirmStream: (ref, onEvent) => api.confirmStream(ref, onEvent),
    confirmAll: (refs) => Promise.all(refs.map((r) => api.confirmPreview(r.previewId, r.nonce))),
    cancel: (previewId) => api.cancelPreview(previewId),
    undo: (id) => api.undo(id),
    savePermissions: (groups) => api.savePermissions(groups),
    getPermissions: () => api.getPermissions(),
  };
}

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
 * The streaming send flow. Receipts/clarifies render as they stream in; PREVIEWS
 * are buffered and flushed together (so a batch keeps its single "Confirm all"
 * card) when the truthful reply arrives. Same responsiveness contract as
 * `submitMessage`: working is announced before and always cleared after.
 */
export async function submitStreaming(api: StreamingApi, message: string, hooks: ComposerHooks): Promise<void> {
  hooks.onWorking(true);
  const pendingPreviews: ChatResult[] = [];
  const flushPreviews = (): void => {
    if (pendingPreviews.length > 0) hooks.onResults(pendingPreviews.splice(0));
  };
  try {
    await api.streamMessage(message, (event) => {
      if (event.type === "result" && event.result) {
        if (event.result.kind === "preview") pendingPreviews.push(event.result);
        else hooks.onResults([event.result]);
      } else if (event.type === "reply") {
        flushPreviews();
        if (event.text) hooks.onAssistant(event.text);
      } else if (event.type === "error") {
        hooks.onError(typeof event.message === "string" ? event.message : "Message failed.");
      } else if (event.type === "status") {
        if (typeof event.label === "string") hooks.onStatus?.(event.label);
      }
    });
  } catch {
    hooks.onError("Message failed to send.");
  } finally {
    flushPreviews(); // flush any previews if the stream ended without a reply
    hooks.onWorking(false);
  }
}

/** Real fetch-backed API client (same-origin; the session cookie authenticates). */
export function createFetchApi(): ChatApi {
  async function json(path: string, init?: RequestInit): Promise<unknown> {
    const res = await fetch(path, {
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      ...init,
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
  return {
    getPermissions: () => json("/api/permissions"),
    savePermissions: (groups) =>
      json("/api/permissions/confirm", { method: "POST", body: JSON.stringify({ groups }) }),
    getHistory: () => json("/api/chat/history"),
    newChat: () => json("/api/chat/new", { method: "POST" }),
    sendMessage: (message) =>
      json("/api/chat/messages", { method: "POST", body: JSON.stringify({ message }) }),
    streamMessage: async (message, onEvent) => {
      const res = await fetch("/api/chat/stream", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message }),
      });
      if (!res.ok || !res.body) {
        // Surface the route's honest JSON copy (rate limit, expired session)
        // instead of a blanket "unavailable".
        let serverMessage: string | undefined;
        try {
          serverMessage = ((await res.json()) as { message?: string })?.message;
        } catch {
          /* keep the fallback */
        }
        onEvent({
          type: "error",
          message: httpErrorMessage(res.status, serverMessage, "The assistant is temporarily unavailable. Please try again."),
        });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const feed = createNdjsonParser(onEvent);
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        feed(decoder.decode(value, { stream: true }));
      }
      feed(decoder.decode()); // flush any trailing bytes
    },
    confirmPreview: (previewId, nonce) =>
      json(`/api/confirmations/${encodeURIComponent(previewId)}/confirm`, {
        method: "POST",
        body: JSON.stringify({ nonce }),
      }),
    confirmStream: async (ref, onEvent) => {
      const res = await fetch(`/api/confirmations/${encodeURIComponent(ref.previewId)}/confirm?stream=1`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce: ref.nonce }),
      });
      if (!res.ok || !res.body) {
        // A non-OK confirm is a JSON error (validation/policy/expired) — surface
        // it; a 401 gets the session-expired copy. Carry the server's `code`
        // through so a stale-nonce 400 (a cross-tab nonce rotation) can re-arm
        // this tab instead of dead-ending — see submitConfirmStream/onStale.
        let serverMessage: string | undefined;
        let serverCode: string | undefined;
        try {
          const body = (await res.json()) as { message?: string; code?: string };
          serverMessage = body?.message;
          serverCode = body?.code;
        } catch {
          /* keep the default */
        }
        onEvent({
          type: "error",
          ...(serverCode ? { code: serverCode } : {}),
          message: httpErrorMessage(res.status, serverMessage, "Confirmation failed."),
        });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const feed = createNdjsonParser(onEvent);
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        feed(decoder.decode(value, { stream: true }));
      }
      feed(decoder.decode());
    },
    cancelPreview: (previewId) =>
      json(`/api/confirmations/${encodeURIComponent(previewId)}/cancel`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    undo: (id) => json(`/api/undo/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify({}) }),
  };
}

// ---------------------------------------------------------------------------
// DOM bootstrap (browser only). Not exercised by unit tests.
// ---------------------------------------------------------------------------

interface PermissionsResponse {
  ok: boolean;
  policy: PolicyShape;
  firstRun: boolean;
}

function mount(root: HTMLElement, api: ChatApi): void {
  const controller = createController(api);
  root.replaceChildren();
  const header = el("header", "app-header");
  header.appendChild(el("h1", undefined, "AI Assistant"));
  // Start a fresh conversation. Hidden until the chat is up (same as settings).
  // The previous chat stays on the server (retention + the audit log keep it);
  // this only resets the visible transcript to an empty session.
  const newChatButton = el("button", "secondary hidden") as HTMLButtonElement;
  newChatButton.type = "button";
  newChatButton.textContent = "New chat";
  newChatButton.setAttribute("aria-label", "Start a new chat");
  header.appendChild(newChatButton);
  // Settings (assistant permissions). Hidden until the chat is up, so the
  // first-run setup flow can't be bypassed mid-way.
  const settingsButton = el("button", "icon-button hidden") as HTMLButtonElement;
  settingsButton.type = "button";
  settingsButton.setAttribute("aria-label", "Assistant permissions");
  settingsButton.setAttribute("aria-expanded", "false");
  settingsButton.setAttribute("aria-controls", "permissions-panel");
  settingsButton.appendChild(svgIcon(ICON_GEAR));
  header.appendChild(settingsButton);
  root.appendChild(header);

  const setup = el("section", "setup hidden");
  setup.id = "permissions-panel";
  setup.setAttribute("aria-label", "Assistant permissions");
  const chat = el("section", "chat hidden");
  chat.setAttribute("aria-label", "Assistant chat");
  // The message log is a live region so a screen reader announces new turns.
  const messages = el("div", "messages");
  messages.setAttribute("role", "log");
  messages.setAttribute("aria-live", "polite");
  messages.setAttribute("aria-relevant", "additions");
  messages.setAttribute("aria-label", "Conversation");
  // Errors are assertive; the working status is polite (announced as it changes).
  const errorBar = el("div", "error hidden");
  errorBar.setAttribute("role", "alert");
  // Visually replaced by the typing indicator (sr-only) but still the live
  // region that ANNOUNCES "Assistant is working…" — keep its semantics exact.
  const statusBar = el("div", "status sr-only hidden");
  statusBar.setAttribute("role", "status");
  statusBar.setAttribute("aria-live", "polite");
  root.appendChild(errorBar);
  root.appendChild(statusBar);
  root.appendChild(setup);
  root.appendChild(chat);

  function showError(message: string): void {
    errorBar.textContent = message;
    errorBar.classList.remove("hidden");
  }
  function clearError(): void {
    errorBar.textContent = "";
    errorBar.classList.add("hidden");
  }
  // The visible "working" affordance: a transient assistant bubble with three
  // dots. aria-hidden — the sr-only status bar above does the announcing, so
  // screen readers hear it once, not twice.
  const typing = el("div", "message assistant typing");
  typing.setAttribute("aria-hidden", "true");
  const typingDots = el("span", "typing-dots");
  for (let i = 0; i < 3; i += 1) typingDots.appendChild(el("span"));
  typing.appendChild(typingDots);
  // The latest streamed progress label ("Starting the timer…") rides next to
  // the dots; the sr-only statusBar announces the same text politely.
  const typingLabel = el("span", "typing-label");
  typing.appendChild(typingLabel);

  function setWorking(working: boolean): void {
    statusBar.textContent = working ? "Assistant is working…" : "";
    statusBar.classList.toggle("hidden", !working);
    if (working) {
      const stick = isNearBottom(messages);
      messages.appendChild(typing);
      if (stick) messages.scrollTop = messages.scrollHeight;
    } else {
      typingLabel.textContent = ""; // reset for the next turn
      typing.remove();
    }
  }

  /** Show the latest per-step progress label in the typing bubble + announce it. */
  function setStatusLabel(label: string): void {
    typingLabel.textContent = `${label}…`;
    statusBar.textContent = `Assistant is working: ${label}…`;
  }

  /** Keep the typing bubble below results that stream in while it shows. */
  function bumpTyping(): void {
    if (typing.isConnected) messages.appendChild(typing);
  }

  // Assigned in renderChat; clarify chips send their label through this SAME
  // path as typed text — never to a confirmation endpoint.
  let sendText: (text: string) => Promise<void> = async () => {};

  // r1-new-session-restore-04: the composer goes live the moment renderChat()
  // runs, but restoreHistory() then awaits a GET before appending the replayed
  // conversation. A message typed in that window must NOT jump ahead of the
  // history. Live sends await this gate; restoreHistory settles it after
  // appending (success AND failure — best-effort restore must never wedge the
  // composer). Default is already-settled so paths with no restore (first-run
  // permissions save) never block.
  let restoreGate: RestoreGate = createRestoreGate();
  restoreGate.settle();

  // Assigned in renderChat (points at the composer input). Confirm/Cancel remove
  // their card with focus on the clicked button INSIDE it, which would drop focus
  // to <body>; this returns focus to the composer so the next Tab continues from
  // a logical place (WCAG 2.4.3 Focus Order, r1-ux-copy-a11y-04). Mirrors the
  // post-turn `input.focus()` on the chat path.
  let focusComposer: () => void = () => {};

  function appendMessage(role: string, text: string): void {
    // Stickiness is decided BEFORE appending: someone reading older history is
    // never yanked back down by streamed results; at the bottom the log follows.
    const stick = isNearBottom(messages);
    messages.appendChild(el("div", `message ${role}`, text));
    bumpTyping();
    if (stick) messages.scrollTop = messages.scrollHeight;
  }

  function renderResults(results: ChatResult[]): void {
    const stick = isNearBottom(messages);
    const previews = results.filter((r): r is PreviewResult => r.kind === "preview");
    if (previews.length > 0)
      messages.appendChild(
        renderPreview(previews, {
          controller,
          showError,
          appendMessage,
          renderResults,
          // The stale-nonce re-arm path (r1-concurrency-races-02): re-fetch the
          // session's live pendings so a tab whose nonce was rotated by another
          // tab can re-render the re-served card.
          getHistory: () => api.getHistory() as Promise<HistoryResponse>,
          // After Confirm/Cancel removes the card, return focus to the composer
          // (not <body>) — WCAG 2.4.3 Focus Order, r1-ux-copy-a11y-04.
          returnFocus: () => focusComposer(),
          // r1-ux-copy-a11y-03: drive the SAME working/typing affordance + status
          // labels the chat path uses, so a confirmed risky write's durable resume
          // (30-120s) shows progress instead of running invisibly.
          setWorking: (working) => setWorking(working),
          setStatusLabel: (label) => setStatusLabel(label),
        }),
      );
    for (const result of results) {
      if (result.kind === "receipt") messages.appendChild(renderReceipt(result, { controller, showError }));
      else if (result.kind === "clarify")
        messages.appendChild(renderClarify(result, { sendText: (text) => void sendText(text) }));
    }
    bumpTyping();
    if (stick) messages.scrollTop = messages.scrollHeight;
  }

  function renderChat(): void {
    chat.replaceChildren();
    chat.appendChild(messages);
    const form = el("form", "composer") as HTMLFormElement;
    form.setAttribute("aria-label", "Send a message to the assistant");
    const input = el("input", "composer-input") as HTMLInputElement;
    input.placeholder = "Ask the assistant…";
    input.setAttribute("aria-label", "Message");
    const send = el("button", "primary", "Send") as HTMLButtonElement;
    send.type = "submit";
    form.appendChild(input);
    form.appendChild(send);
    // Confirm/Cancel returns focus here after removing its card (avoids dropping
    // focus to <body> — WCAG 2.4.3 Focus Order, r1-ux-copy-a11y-04).
    focusComposer = () => input.focus();
    let busy = false;
    // The ONE path into chat for typed text AND clarify chips — never a
    // confirmation endpoint.
    sendText = async (text: string): Promise<void> => {
      if (busy || !text) return; // one-at-a-time guard (Enter/chip while working can't double-submit)
      // Wait for session restore to settle (r1-new-session-restore-04) so a
      // fast first message never renders ABOVE the replayed history. The gate
      // is already-settled outside the restore window, so this is a no-op then.
      await restoreGate.waitUntilSettled();
      chat.querySelector(".welcome")?.remove(); // the conversation has started
      appendMessage("user", text);
      messages.scrollTop = messages.scrollHeight; // sending is intent — always jump to the bottom
      clearError();
      // Streaming: harness results render as they arrive, then the truthful reply.
      await submitStreaming(api, text, {
        onWorking: (working) => {
          busy = working;
          setWorking(working); // announces "Assistant is working…" + shows the typing dots
          send.disabled = working;
          input.disabled = working;
          form.setAttribute("aria-busy", String(working));
          if (!working) input.focus(); // return focus to the composer after the turn
        },
        onAssistant: (assistantText) => appendMessage("assistant", assistantText),
        onResults: (results) => renderResults(results),
        onError: (message) => showError(message),
        onStatus: (label) => setStatusLabel(label),
      });
    };
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (busy) return;
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      await sendText(text);
    });
    chat.appendChild(form);
    // First visit: a welcome card with example prompts, ABOVE the message log
    // (outside the live region, so it is never announced as a turn).
    if (messages.childElementCount === 0) {
      chat.insertBefore(renderWelcome({ sendText: (text) => void sendText(text) }), messages);
    }
    chat.classList.remove("hidden");
    settingsButton.classList.remove("hidden");
    newChatButton.classList.remove("hidden");
    input.focus();
  }

  function closePermissions(): void {
    setup.classList.add("hidden");
    chat.classList.remove("hidden");
    settingsButton.setAttribute("aria-expanded", "false");
    settingsButton.focus();
  }

  /**
   * The permissions panel — the first-run setup and the gear's settings reopen
   * are the SAME panel + the same GET/confirm endpoints; only the copy and the
   * exit path differ. Always re-fetches so the table shows the current policy.
   */
  async function openPermissions(firstRun: boolean): Promise<void> {
    try {
      const perms = (await api.getPermissions()) as PermissionsResponse;
      setup.replaceChildren();
      setup.appendChild(
        el("h2", undefined, firstRun ? "Set up your assistant permissions" : "Assistant permissions"),
      );
      setup.appendChild(
        el(
          "p",
          undefined,
          firstRun
            ? "Defaults grant full read & write for every group. Adjust if you like, then start."
            : "The assistant can only do what these levels allow. Changes apply as soon as you save.",
        ),
      );
      setup.appendChild(
        renderPermissionTable(perms.policy, async (groups) => {
          try {
            await controller.savePermissions(groups);
            if (firstRun) {
              setup.classList.add("hidden");
              renderChat();
            }
            return true; // reopen: stay open so the inline "Saved" is visible
          } catch {
            showError("Could not save permissions.");
            return false;
          }
        }),
      );
      if (!firstRun) {
        const close = el("button", "secondary", "Close") as HTMLButtonElement;
        close.type = "button";
        close.addEventListener("click", closePermissions);
        setup.appendChild(close);
        chat.classList.add("hidden");
        settingsButton.setAttribute("aria-expanded", "true");
      }
      setup.classList.remove("hidden");
    } catch {
      showError("Could not load the assistant.");
    }
  }

  settingsButton.addEventListener("click", () => {
    if (setup.classList.contains("hidden")) void openPermissions(false);
    else closePermissions();
  });

  /**
   * Start a new conversation: mint a fresh session server-side, then reset the
   * visible transcript to an empty welcome. The previous chat is NOT deleted (it
   * stays on the server under retention; the audit log keeps the actions) — only
   * the UI resets. A failed call surfaces honestly and leaves the chat intact.
   */
  async function startNewChat(): Promise<void> {
    try {
      await api.newChat();
    } catch (error) {
      showError(error instanceof ApiError ? error.message : "Could not start a new chat. Please try again.");
      return;
    }
    clearError();
    setWorking(false);
    messages.replaceChildren(); // drop the transcript + any pending preview cards
    chat.querySelector(".welcome")?.remove();
    chat.insertBefore(renderWelcome({ sendText: (text) => void sendText(text) }), messages);
    focusComposer();
  }
  newChatButton.addEventListener("click", () => void startNewChat());

  /**
   * Session restore: replay the stored conversation + the session's still-live
   * pending previews (with freshly rotated nonces) after an iframe reload.
   * Best-effort but honest — a failure leaves the composer fully usable.
   */
  async function restoreHistory(): Promise<void> {
    try {
      const history = (await api.getHistory()) as HistoryResponse;
      const items = historyRestoreItems(history);
      if (items.length === 0) return;
      chat.querySelector(".welcome")?.remove(); // the conversation already started
      for (const item of items) {
        if (item.kind === "bubble") appendMessage(item.role, item.text);
        else renderResults(item.results);
      }
      messages.scrollTop = messages.scrollHeight;
    } catch {
      showError("Couldn't restore the conversation history — you can keep chatting.");
    } finally {
      // Release the composer AFTER the replayed history has appended (success
      // OR failure) so a fast first message can never scramble the transcript
      // (r1-new-session-restore-04). A failure still settles — restore is
      // best-effort and the composer must stay usable.
      restoreGate.settle();
    }
  }

  async function init(): Promise<void> {
    try {
      const perms = (await api.getPermissions()) as PermissionsResponse;
      if (perms.firstRun) await openPermissions(true);
      else {
        // Arm the restore gate BEFORE the composer goes live so a message typed
        // during the history fetch waits for the replay (r1-new-session-restore-04).
        restoreGate = createRestoreGate();
        renderChat();
        await restoreHistory(); // settles the gate when the replay is appended
      }
    } catch {
      showError("Could not load the assistant.");
    }
  }

  void init();
}

if (typeof document !== "undefined") {
  const root = document.getElementById("app");
  if (root) mount(root, createFetchApi());
}
