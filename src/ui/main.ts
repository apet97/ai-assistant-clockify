import "./styles.css";
import { isNearBottom } from "./presentation.js";
import {
  el,
  ICON_GEAR,
  renderChatsMenu,
  renderClarify,
  renderPermissionTable,
  renderOperationCard,
  renderPreview,
  renderReceipt,
  renderWelcome,
  svgIcon,
  type ChatSessionSummary,
} from "./render.js";
import {
  ApiError,
  createFetchApi,
  type ChatApi,
} from "./api-client.js";
import { submitStreaming, switchToSession } from "./composer-flow.js";
import {
  createRestoreGate,
  historyRestoreItems,
  type ChatController,
  type ChatResult,
  type HistoryResponse,
  type PolicyShape,
  type PreviewResult,
  type RestoreGate,
} from "./shared.js";

// Re-export barrel: `main.ts` is the bundle entry + the public/test import
// surface, so every symbol the tests pull from `./main.js` is re-exported here.
// They live in the leaf modules (api-client / composer-flow / shared /
// presentation) so `render.ts` and the flows can use them WITHOUT importing from
// main (which imports their builders) — that back-edge would be a circular dep.
export { createFetchApi, ApiError, SESSION_EXPIRED_MESSAGE, httpErrorMessage, createNdjsonParser } from "./api-client.js";
export type { ChatApi } from "./api-client.js";
export { submitMessage, submitStreaming, switchToSession, SWITCH_FAILED_MESSAGE } from "./composer-flow.js";
export type {
  ChatResponse,
  ChatApiLike,
  ComposerHooks,
  StreamingApi,
  SwitchApiLike,
  SwitchHooks,
} from "./composer-flow.js";
export { featureGroupRows, runConfirmStreamLive, settleConfirmOutcome, submitConfirmStream } from "./shared.js";
export type {
  PolicyShape,
  ChatController,
  PreviewResult,
  ChatResult,
  ConfirmResponse,
  ConfirmHooks,
  ConfirmStreamApi,
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
  // The chat-history switcher: a "Chats ▾" dropdown (the renderChatsMenu widget,
  // which owns its own toggle/open/close + a11y) listing the admin's recent
  // conversations. Hidden until the chat is up (same as the other header
  // controls). refreshChatsMenu() rebuilds it with the current list whenever
  // that list can change (chat-up, New chat, after a turn) so it stays fresh.
  const chatsSlot = el("div", "chats-slot hidden");
  header.appendChild(chatsSlot);
  // Start a fresh conversation. Hidden until the chat is up (same as settings).
  // The previous chat stays on the server (retention + the audit log keep it);
  // this only resets the visible transcript to an empty session.
  const newChatButton = el("button", "secondary hidden");
  newChatButton.type = "button";
  newChatButton.textContent = "New chat";
  newChatButton.setAttribute("aria-label", "Start a new chat");
  header.appendChild(newChatButton);
  // Settings (assistant permissions). Hidden until the chat is up, so the
  // first-run setup flow can't be bypassed mid-way.
  const settingsButton = el("button", "icon-button hidden");
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
  function runUiTask(task: Promise<void>, fallback: string): void {
    void task.catch((error: unknown) => {
      showError(error instanceof ApiError ? error.message : fallback);
    });
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

  // The empty-chat welcome card lives OUTSIDE the message log (insertBefore the
  // `messages` live region) so it is never announced as a turn, and is bound to
  // the SAME `sendText` path the composer uses (a chip is typed text, never a
  // confirmation endpoint). Both helpers are main-local because they capture the
  // live `chat`/`messages`/`sendText` bindings.
  function dropWelcome(): void {
    chat.querySelector(".welcome")?.remove();
  }
  function showWelcome(): void {
    chat.insertBefore(
      renderWelcome({ sendText: (text) => runUiTask(sendText(text), "Message failed to send.") }),
      messages,
    );
  }

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
      if (result.kind === "receipt" || result.kind === "partial")
        messages.appendChild(renderReceipt(result, { controller, showError, returnFocus: () => focusComposer() }));
      else if (result.kind === "clarify")
        messages.appendChild(
          renderClarify(result, { sendText: (text) => runUiTask(sendText(text), "Message failed to send.") }),
        );
    }
    bumpTyping();
    if (stick) messages.scrollTop = messages.scrollHeight;
  }

  function renderChat(): void {
    chat.replaceChildren();
    chat.appendChild(messages);
    const form = el("form", "composer");
    form.setAttribute("aria-label", "Send a message to the assistant");
    const input = el("input", "composer-input");
    input.placeholder = "Ask the assistant…";
    input.setAttribute("aria-label", "Message");
    const send = el("button", "primary", "Send");
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
      dropWelcome(); // the conversation has started
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
          if (!working) {
            input.focus(); // return focus to the composer after the turn
            runUiTask(refreshChatsMenu(), "Could not load your conversations.");
          }
        },
        onAssistant: (assistantText) => appendMessage("assistant", assistantText),
        onResults: (results) => renderResults(results),
        onError: (message) => showError(message),
        onStatus: (label) => setStatusLabel(label),
      });
    };
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (busy) return;
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      runUiTask(sendText(text), "Message failed to send.");
    });
    chat.appendChild(form);
    // First visit: a welcome card with example prompts, ABOVE the message log
    // (outside the live region, so it is never announced as a turn).
    if (messages.childElementCount === 0) {
      showWelcome();
    }
    chat.classList.remove("hidden");
    settingsButton.classList.remove("hidden");
    newChatButton.classList.remove("hidden");
    chatsSlot.classList.remove("hidden");
    runUiTask(refreshChatsMenu(), "Could not load your conversations.");
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
        const close = el("button", "secondary", "Close");
        close.type = "button";
        close.addEventListener("click", closePermissions);
        setup.appendChild(close);
        chat.classList.add("hidden");
        settingsButton.setAttribute("aria-expanded", "true");
        // Symmetric with closePermissions()'s settingsButton.focus(): on open move
        // focus INTO the now-visible panel (its heading) so a keyboard/AT user
        // isn't stranded on the gear with the chat hidden behind an unfocused panel.
        const heading = setup.querySelector("h2");
        if (heading) {
          heading.setAttribute("tabindex", "-1");
          (heading as HTMLElement).focus();
        }
      }
      setup.classList.remove("hidden");
    } catch {
      showError("Could not load the assistant.");
    }
  }

  settingsButton.addEventListener("click", () => {
    if (setup.classList.contains("hidden")) runUiTask(openPermissions(false), "Could not load the assistant.");
    else closePermissions();
  });
  // Escape closes the panel on the gear/reopen path only (aria-expanded="true");
  // first-run setup leaves aria-expanded false, so Escape can't skip it. Registered
  // once on `setup` (which persists across reopens) — closePermissions is idempotent.
  setup.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key === "Escape" && settingsButton.getAttribute("aria-expanded") === "true") {
      closePermissions();
    }
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
    dropWelcome();
    showWelcome();
    runUiTask(refreshChatsMenu(), "Could not load your conversations.");
    focusComposer();
  }
  newChatButton.addEventListener("click", () => {
    runUiTask(startNewChat(), "Could not start a new chat. Please try again.");
  });

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
      dropWelcome(); // the conversation already started
      for (const item of items) {
        if (item.kind === "bubble") appendMessage(item.role, item.text);
        else if (item.kind === "results") renderResults(item.results);
        else messages.appendChild(renderOperationCard(item.operation));
      }
      messages.scrollTop = messages.scrollHeight;
    } catch (error) {
      // A failed/empty restore is non-blocking — the composer works and a fresh
      // session has nothing to replay. Only a genuine session expiry (401) is
      // worth surfacing (its fix is a reload); anything else degrades quietly so
      // we never throw an alarming red bar over a benign first-load restore
      // (plan 006).
      if (error instanceof ApiError && error.status === 401) {
        showError(error.message);
      } else {
        console.warn("history restore skipped:", error instanceof Error ? error.message : String(error));
      }
    } finally {
      // Release the composer AFTER the replayed history has appended (success
      // OR failure) so a fast first message can never scramble the transcript
      // (r1-new-session-restore-04). A failure still settles — restore is
      // best-effort and the composer must stay usable.
      restoreGate.settle();
    }
  }

  /**
   * Switch to a past conversation. The server re-cookies to the target session
   * (an owned, live id only — the route 404s a foreign/expired one); ON SUCCESS
   * we mirror startNewChat's reset (drop the transcript + any pending cards),
   * then re-arm the restore gate and replay the switched-to session via
   * restoreHistory(). ON FAILURE the current chat is LEFT INTACT and the error
   * is surfaced honestly. Focus returns to the Chats toggle either way (WCAG
   * 2.4.3 Focus Order — like Confirm/Cancel's focus return).
   */
  async function selectSession(id: string): Promise<void> {
    await switchToSession(api, id, {
      onSwitched: async () => {
        clearError();
        setWorking(false);
        messages.replaceChildren(); // drop the previous transcript + any preview cards
        dropWelcome();
        // Arm the gate so a message typed during the replay can't jump ahead
        // (r1-new-session-restore-04); restoreHistory settles it when done.
        restoreGate = createRestoreGate();
        await restoreHistory();
        if (messages.childElementCount === 0) {
          // The switched-to session replayed nothing visible — show the welcome.
          showWelcome();
        }
      },
      onError: (message) => showError(message),
    });
    // Return focus to the toggle (the widget was rebuilt on open).
    (chatsSlot.querySelector(".chats-toggle") as HTMLElement | null)?.focus();
  }

  /**
   * (Re)build the chat-history dropdown with a FRESH list. The `renderChatsMenu`
   * widget owns its own toggle/open/close + a11y; we just feed it the current
   * sessions and wire `onSelect` to the switch flow. We rebuild whenever the
   * list can change (chat-up, New chat, after the first message of a fresh
   * session) so the menu stays current. A failed list is non-fatal — show an
   * honest error and leave the slot's prior widget usable.
   */
  async function refreshChatsMenu(): Promise<void> {
    try {
      const body = (await api.listSessions()) as { ok?: boolean; sessions?: ChatSessionSummary[] };
      const sessions: ChatSessionSummary[] = body?.sessions ?? [];
      chatsSlot.replaceChildren(
        renderChatsMenu(sessions, {
          onSelect: (id) => runUiTask(selectSession(id), "Could not open that conversation. Please try again."),
        }),
      );
    } catch (error) {
      showError(error instanceof ApiError ? error.message : "Could not load your conversations.");
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

  runUiTask(init(), "Could not load the assistant.");
}

if (typeof document !== "undefined") {
  const root = document.getElementById("app");
  if (root) mount(root, createFetchApi());
}
