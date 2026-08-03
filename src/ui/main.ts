import "./styles.css";
import "./product.css";
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
import { submitClarificationResolve, submitStreaming, switchToSession } from "./composer-flow.js";
import {
  applyUiPreferences,
  firstRunDisclosure,
  formatTimeZoneName,
  loadUiPreferences,
  normalizeUiPreferences,
  saveUiPreferences,
  type UiPreferences,
} from "./product.js";
import {
  createRestoreGate,
  historyRestoreItems,
  RunEventCursor,
  restoreRunEvents,
  type ChatController,
  type ChatResult,
  type HistoryResponse,
  type PolicyShape,
  type PreviewResult,
  type RestoreGate,
} from "./shared.js";
import type { PermissionsResponse, SessionsResponse } from "./protocol.js";

// Re-export barrel: `main.ts` is the bundle entry + the public/test import
// surface, so every symbol the tests pull from `./main.js` is re-exported here.
// They live in the leaf modules (api-client / composer-flow / shared /
// presentation) so `render.ts` and the flows can use them WITHOUT importing from
// main (which imports their builders) — that back-edge would be a circular dep.
export { createFetchApi, ApiError, SESSION_EXPIRED_MESSAGE, httpErrorMessage, createNdjsonParser } from "./api-client.js";
export type { ChatApi } from "./api-client.js";
export { submitMessage, submitStreaming, submitClarificationResolve, switchToSession, SWITCH_FAILED_MESSAGE } from "./composer-flow.js";
export type {
  ChatResponse,
  ChatApiLike,
  ClarificationResolveApiLike,
  ComposerHooks,
  StreamingApi,
  SwitchApiLike,
  SwitchHooks,
} from "./composer-flow.js";
export { featureGroupRows, runConfirmStreamLive, settleConfirmOutcome, submitConfirmStream, RunEventCursor, restoreRunEvents, applyRunEventAttachment } from "./shared.js";
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
export {
  DEFAULT_UI_PREFERENCES,
  firstRunDisclosure,
  formatLocalDateTime,
  formatLocalCurrency,
  formatTimeZoneName,
  normalizeUiPreferences,
  promptsForPolicy,
} from "./product.js";
export type { UiPreferences, UiTheme } from "./product.js";
export {
  ProtocolError,
  decodeApiEnvelope,
  decodeChatResponse,
  decodeConfirmResponse,
  decodeHistoryResponse,
  decodeMeResponse,
  decodeNdjsonEvent,
  decodeOperationResponse,
  decodePermissionsResponse,
  decodeReceipt,
  decodeSessionsResponse,
  decodeUndoResponse,
  protocolErrorMessage,
} from "./protocol.js";

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

/**
 * T14: on a genuine first run the permissions gate (`openPermissions(true, …)`)
 * is the ONLY thing that renders — history replay and the chat-history dropdown
 * never happen (there's no prior chat to restore and no session list to show).
 * Firing `getHistory`/`listSessions` before the permissions gate resolves was
 * pure waste on the critical path: the responses are fetched, then simply
 * discarded because `restoreHistory`/`renderChat(sessionsRequest)` are only
 * reachable from the `!firstRun` branch. This helper fetches permissions
 * FIRST, and only starts the history/session-list requests once the gate has
 * passed — a returning user (`firstRun: false`) still gets both requests
 * started immediately alongside each other, exactly as before.
 */
export async function loadInitialData(
  api: Pick<ChatApi, "getPermissions" | "getHistory" | "listSessions">,
): Promise<{
  perms: PermissionsResponse;
  historyRequest?: Promise<HistoryResponse & { ok: true }>;
  sessionsRequest?: Promise<SessionsResponse>;
}> {
  const perms = await api.getPermissions();
  if (perms.firstRun) return { perms };
  const historyRequest = api.getHistory();
  const sessionsRequest = api.listSessions();
  void historyRequest.catch(() => {});
  void sessionsRequest.catch(() => {});
  return { perms, historyRequest, sessionsRequest };
}

export function createController(api: ChatApi): ChatController {
  return {
    send: (message) => api.sendMessage(message),
    confirm: (ref) => api.confirmPreview(ref.previewId, ref.nonce),
    confirmStream: (ref, onEvent) => api.confirmStream(ref, onEvent),
    confirmAll: async (refs) => {
      // A batch-owned card (every ref carries the same batchId) confirms
      // through the ONE aggregate settlement (PR 12): per-item confirm of a
      // batch member is bound to the batch's capability/settlement and is
      // rejected server-side. v1-shaped multi-previews keep the per-item loop.
      const batchId = refs[0]?.batchId;
      if (batchId !== undefined && refs.every((r) => r.batchId === batchId)) {
        const committed = await api.confirmBatch(
          batchId,
          refs.map((r) => ({ confirmationId: r.previewId, nonce: r.nonce })),
        );
        if (!committed.ok) {
          return refs.map(() => ({ ok: false, ...(committed.message ? { message: committed.message } : {}) }));
        }
        const byId = new Map(committed.items.map((item) => [item.confirmationId, item]));
        return refs.map((r) => {
          const item = byId.get(r.previewId);
          if (!item) return { ok: false, message: "No response." };
          if (item.status === "succeeded") return { ok: true };
          if (item.status === "partial") {
            return {
              ok: true,
              result: {
                kind: "partial" as const,
                receipt: { ok: true, action: "" },
                message: "Partial — review needed. Verify in Clockify.",
                recovery: { hint: "Check the operation status card." },
              },
            };
          }
          return { ok: false, message: `Confirmation ${item.status.split("_").join(" ")}.` };
        });
      }
      return Promise.all(refs.map((r) => api.confirmPreview(r.previewId, r.nonce)));
    },
    cancel: (previewId) => api.cancelPreview(previewId),
    cancelBatch: (batchId) => api.cancelBatch(batchId),
    undo: (id) => api.undo(id),
    savePermissions: (groups) => api.savePermissions(groups),
    getPermissions: () => api.getPermissions(),
  };
}

// ---------------------------------------------------------------------------
// DOM bootstrap (browser only). Not exercised by unit tests.
// ---------------------------------------------------------------------------

function mount(root: HTMLElement, api: ChatApi): void {
  // Apply a locally stored display preference before the first interactive
  // frame. This is deliberately browser-local and never enters the chat/API.
  let preferences: UiPreferences = loadUiPreferences(window.localStorage);
  applyUiPreferences(document.documentElement, preferences);
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
  let cachedSessions: ChatSessionSummary[] | undefined;
  header.appendChild(chatsSlot);
  const displayButton = el("button", "secondary display-button", "Display");
  displayButton.type = "button";
  displayButton.setAttribute("aria-expanded", "false");
  displayButton.setAttribute("aria-controls", "display-panel");
  header.appendChild(displayButton);
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

  const displayPanel = el("section", "display-panel hidden");
  displayPanel.id = "display-panel";
  displayPanel.setAttribute("aria-label", "Display preferences");
  const themeLabel = el("label", undefined, "Theme");
  const theme = document.createElement("select");
  theme.setAttribute("aria-label", "Theme");
  for (const value of ["system", "light", "dark"]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value[0].toUpperCase() + value.slice(1);
    option.selected = preferences.theme === value;
    theme.appendChild(option);
  }
  themeLabel.appendChild(theme);
  const timeZoneSummary = el("p", "display-time-zone");
  const refreshTimeZoneSummary = (): void => {
    timeZoneSummary.textContent = preferences.timeZone
      ? `Clockify time zone: ${formatTimeZoneName(preferences.timeZone)}`
      : "Clockify time zone is unavailable.";
  };
  refreshTimeZoneSummary();
  const saveDisplay = el("button", "primary", "Save display");
  saveDisplay.type = "button";
  saveDisplay.addEventListener("click", () => {
    preferences = {
      ...preferences,
      theme: theme.value as UiPreferences["theme"],
    };
    saveUiPreferences(window.localStorage, preferences);
    applyUiPreferences(document.documentElement, preferences);
    refreshTimeZoneSummary();
    refreshDisplayUi();
    displayPanel.classList.add("hidden");
    displayButton.setAttribute("aria-expanded", "false");
    displayButton.focus();
  });
  displayPanel.append(themeLabel, timeZoneSummary, saveDisplay);
  root.appendChild(displayPanel);
  displayButton.addEventListener("click", () => {
    const open = displayPanel.classList.toggle("hidden");
    displayButton.setAttribute("aria-expanded", String(!open));
    if (!open) theme.focus();
  });

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
  const footer = el("footer", "app-footer");
  const footerLinks = new Map<string, HTMLAnchorElement>();
  for (const [label, href] of [
    ["Privacy", "/privacy"],
    ["Security", "/security"],
    ["Support", "/support"],
  ]) {
    const link = el("a", undefined, label);
    link.href = href;
    link.target = "_blank";
    link.rel = "noreferrer";
    footerLinks.set(label.toLowerCase(), link);
    footer.appendChild(link);
  }
  root.appendChild(footer);

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
    // This local state happens synchronously before fetch/model work; it gives
    // the admin a truthful <100ms acknowledgement without pretending a tool ran.
    statusBar.textContent = working ? "Understanding your request…" : "";
    statusBar.classList.toggle("hidden", !working);
    if (working) {
      typingLabel.textContent = "Understanding your request…";
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

  // Assigned in renderChat; SUGGESTION chips send their label through this SAME
  // path as typed text — never to a confirmation endpoint. v2 clarification
  // chips use `resolveOption` instead (never the label).
  let sendText: (text: string) => Promise<void> = async () => {};

  // T14-F: the current chat's active v2 run while it awaits a clarification,
  // hydrated from `HistoryResponse.activeRun` on restore/switch. Forwarded as
  // `continuationRunId` on the NEXT free-text send so a typed follow-up resumes
  // the SAME run instead of starting a new one. Cleared on durable evidence
  // only: a resolved/superseded clarification, a chat switch, or starting a
  // new chat — never on a local guess.
  let activeClarificationRunId: string | undefined;

  // Assigned in renderChat (needs the local `busy`/`applyComposerWorking`
  // guard); v2 exact clarification resolve (T14-F) — a chip click, never the
  // label.
  let resolveOption: (clarificationId: string, optionId: string) => Promise<void> = async () => {};

  // The empty-chat welcome card lives OUTSIDE the message log (insertBefore the
  // `messages` live region) so it is never announced as a turn, and is bound to
  // the SAME `sendText` path the composer uses (a chip is typed text, never a
  // confirmation endpoint). Both helpers are main-local because they capture the
  // live `chat`/`messages`/`sendText` bindings.
  function dropWelcome(): void {
    chat.querySelector(".welcome")?.remove();
  }
  let activePolicy: PolicyShape | undefined;
  function showWelcome(): void {
    dropWelcome();
    chat.insertBefore(
      renderWelcome({
        policy: activePolicy,
        sendText: (text) => runUiTask(sendText(text), "Message failed to send."),
      }),
      messages,
    );
  }

  function renderSessionMenu(sessions: ChatSessionSummary[]): void {
    cachedSessions = sessions;
    chatsSlot.replaceChildren(
      renderChatsMenu(sessions, {
        onSelect: (id) => runUiTask(selectSession(id), "Could not open that conversation. Please try again."),
      }),
    );
  }

  /** Re-render only display/policy-derived empty-state chrome; never touch turns. */
  function refreshDisplayUi(): void {
    refreshTimeZoneSummary();
    if (chat.querySelector(".composer") && messages.childElementCount === 0) showWelcome();
    if (cachedSessions) renderSessionMenu(cachedSessions);
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
          getHistory: () => api.getHistory(),
          // v2 previews live ONLY on the run-event page (one control source) —
          // the stale-nonce re-arm reads it for the freshly rotated pending.
          ...(api.getRunEvents ? { getRunEvents: (runId: string, after: number) => api.getRunEvents!(runId, after) } : {}),
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
          renderClarify(result, {
            sendText: (text) => runUiTask(sendText(text), "Message failed to send."),
            resolveOption: (clarificationId, optionId) =>
              runUiTask(resolveOption(clarificationId, optionId), "That option could not be resolved."),
          }),
        );
    }
    bumpTyping();
    if (stick) messages.scrollTop = messages.scrollHeight;
  }

  function renderChat(initialSessionsRequest?: Promise<SessionsResponse>): void {
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
    const applyComposerWorking = (working: boolean): void => {
      busy = working;
      setWorking(working);
      send.disabled = working;
      input.disabled = working;
      form.setAttribute("aria-busy", String(working));
      if (!working) {
        input.focus();
        runUiTask(refreshChatsMenu(), "Could not load your conversations.");
      }
    };
    // The ONE path into chat for typed text AND clarify chips — never a
    // confirmation endpoint.
    sendText = async (text: string): Promise<void> => {
      if (busy || !text) return; // one-at-a-time guard (Enter/chip while working can't double-submit)
      // Acknowledge locally before the ordered history gate or any model work.
      // The user bubble still waits, preserving replay order, but the iframe
      // responds within the current event turn instead of appearing frozen.
      applyComposerWorking(true);
      // Wait for session restore to settle (r1-new-session-restore-04) so a
      // fast first message never renders ABOVE the replayed history. The gate
      // is already-settled outside the restore window, so this is a no-op then.
      await restoreGate.waitUntilSettled();
      dropWelcome(); // the conversation has started
      appendMessage("user", text);
      messages.scrollTop = messages.scrollHeight; // sending is intent — always jump to the bottom
      clearError();
      // Streaming: harness results render as they arrive, then the truthful reply.
      // T14-F: a typed free-text answer to a still-`pending` v2 clarification
      // resumes that SAME run when one is tracked; settlement (success or
      // error) is durable evidence the run either advanced or the stale id no
      // longer applies, so it is cleared unconditionally either way.
      const continuationRunId = activeClarificationRunId;
      try {
        await submitStreaming(api, text, {
          onWorking: applyComposerWorking,
          onAssistant: (assistantText) => appendMessage("assistant", assistantText),
          onResults: (results) => renderResults(results),
          onError: (message) => showError(message),
          onStatus: (label) => setStatusLabel(label),
        }, continuationRunId);
      } finally {
        if (continuationRunId) activeClarificationRunId = undefined;
      }
    };
    resolveOption = async (clarificationId: string, optionId: string): Promise<void> => {
      if (busy) return;
      clearError();
      try {
        await submitClarificationResolve(api, clarificationId, optionId, {
          onWorking: applyComposerWorking,
          onAssistant: (text) => appendMessage("assistant", text),
          onResults: (results) => renderResults(results),
          onError: (message) => showError(message),
          onStatus: (label) => setStatusLabel(label),
        });
      } finally {
        // Durable evidence the clarification is no longer live either way:
        // resolved (success), or already-settled/expired/foreign (error) — a
        // rejected resolve never re-arms this tab's stale tracked run id.
        activeClarificationRunId = undefined;
      }
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
    runUiTask(refreshChatsMenu(initialSessionsRequest), "Could not load your conversations.");
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
   * exit path differ. A manual reopen re-fetches the current policy; first-run
   * setup reuses the policy already fetched by the parallel initialization.
   */
  async function openPermissions(firstRun: boolean, prefetched?: PermissionsResponse): Promise<void> {
    try {
      const perms = prefetched ?? await api.getPermissions();
      activePolicy = perms.policy;
      setup.replaceChildren();
      setup.appendChild(
        el("h2", undefined, firstRun ? "Set up your assistant permissions" : "Assistant permissions"),
      );
      if (firstRun) setup.appendChild(el("p", "first-run-disclosure", firstRunDisclosure()));
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
            const saved = await controller.savePermissions(groups) as {
              ok?: boolean;
              message?: string;
              policy?: PolicyShape;
            };
            if (saved?.ok !== true || !saved.policy) {
              showError(saved?.message ?? "Could not save permissions.");
              return false;
            }
            activePolicy = saved.policy;
            if (firstRun) {
              setup.classList.add("hidden");
              renderChat();
            } else refreshDisplayUi();
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
      const result = await api.newChat();
      if (!result.ok) {
        showError(result.message ?? "Could not start a new chat. Please try again.");
        return;
      }
    } catch (error) {
      showError(error instanceof ApiError ? error.message : "Could not start a new chat. Please try again.");
      return;
    }
    clearError();
    setWorking(false);
    messages.replaceChildren(); // drop the transcript + any pending preview cards
    activeClarificationRunId = undefined; // new chat: no run/clarification carries over
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
  async function restoreHistory(historyRequest?: Promise<HistoryResponse & { ok: true }>): Promise<void> {
    try {
      const history = await (historyRequest ?? api.getHistory());
      // T14-F: only an `awaiting_clarification` active run is a valid free-text
      // continuation target — restoring mid-loop/awaiting-confirmation phases
      // never sets it (an ordinary message there is new-run supersession, not
      // a continuation).
      activeClarificationRunId = history.activeRun?.phase === "awaiting_clarification"
        ? history.activeRun.runId
        : undefined;
      const items = historyRestoreItems(history);
      if (items.length === 0 && !history.activeRun) return;
      dropWelcome(); // the conversation already started
      for (const item of items) {
        if (item.kind === "bubble") appendMessage(item.role, item.text);
        else if (item.kind === "results") renderResults(item.results);
        else messages.appendChild(renderOperationCard(item.operation));
      }
      if (history.activeRun && api.getRunEvents) {
        const cursor = new RunEventCursor(history.activeRun.runId);
        await restoreRunEvents(
          (runId, after) => api.getRunEvents!(runId, after),
          history.activeRun.runId,
          cursor,
          {
            onAssistant: (text) => appendMessage("assistant", text),
            onResults: (results) => renderResults(results),
            onError: (message) => showError(message),
          },
        );
      }
      messages.scrollTop = messages.scrollHeight;
    } catch (error) {
      // A failed/empty restore is non-blocking — the composer works and a fresh
      // session has nothing to replay. Only a genuine session expiry (401) is
      // worth surfacing (its fix is a reload); anything else degrades quietly so
      // we never throw an alarming red bar over a benign first-load restore
      // (plan 006).
      if (error instanceof ApiError) {
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
  async function refreshChatsMenu(sessionsRequest?: Promise<SessionsResponse>): Promise<void> {
    try {
      const body = await (sessionsRequest ?? api.listSessions());
      const sessions: ChatSessionSummary[] = body.sessions;
      renderSessionMenu(sessions);
    } catch (error) {
      showError(error instanceof ApiError ? error.message : "Could not load your conversations.");
    }
  }

  async function init(): Promise<void> {
    try {
      // `getMe` is independent of the permissions gate (display preferences
      // apply either way), so it still starts immediately. History and the
      // chat-menu request are NOT independent of first-run: on a genuine first
      // run neither is ever consumed (see `loadInitialData`), so they wait for
      // the permissions gate before starting — no waste on the critical path.
      // Once started (returning-user path), keep the restore gate closed until
      // the ordered history replay completes so a fast typed message never
      // jumps ahead.
      const meRequest = api.getMe?.();
      void meRequest?.then((value) => {
        preferences = normalizeUiPreferences(value.preferences);
        saveUiPreferences(window.localStorage, preferences);
        applyUiPreferences(document.documentElement, preferences);
        theme.value = preferences.theme;
        refreshTimeZoneSummary();
        for (const key of ["privacy", "support", "security"] as const) {
          footerLinks.get(key)!.href = value.links[key];
        }
        refreshDisplayUi();
      }).catch((error: unknown) => {
        showError(error instanceof ApiError ? error.message : "Could not load this session.");
      });
      const { perms, historyRequest, sessionsRequest } = await loadInitialData(api);
      activePolicy = perms.policy;
      if (perms.firstRun) await openPermissions(true, perms);
      else {
        // Arm the restore gate BEFORE the composer goes live so a message typed
        // during the history fetch waits for the replay (r1-new-session-restore-04).
        restoreGate = createRestoreGate();
        renderChat(sessionsRequest);
        await restoreHistory(historyRequest); // settles after ordered replay
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
