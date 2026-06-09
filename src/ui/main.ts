import "./styles.css";

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

export interface PreviewRef {
  previewId: string;
  nonce: string;
}

export interface PolicyShape {
  version: number;
  groups: Record<string, string>;
}

export interface ChatApi {
  getPermissions(): Promise<unknown>;
  savePermissions(groups: Record<string, string>): Promise<unknown>;
  sendMessage(message: string): Promise<unknown>;
  /** Streaming send: harness results arrive incrementally, then the truthful reply. */
  streamMessage(message: string, onEvent: (event: StreamEvent) => void): Promise<void>;
  confirmPreview(previewId: string, nonce: string): Promise<unknown>;
  cancelPreview(previewId: string): Promise<unknown>;
  undo(id: string): Promise<unknown>;
}

export interface ChatController {
  send(message: string): Promise<unknown>;
  confirm(ref: PreviewRef): Promise<unknown>;
  confirmAll(refs: PreviewRef[]): Promise<unknown[]>;
  cancel(previewId: string): Promise<unknown>;
  undo(id: string): Promise<unknown>;
  savePermissions(groups: Record<string, string>): Promise<unknown>;
  getPermissions(): Promise<unknown>;
}

export function createController(api: ChatApi): ChatController {
  return {
    send: (message) => api.sendMessage(message),
    confirm: (ref) => api.confirmPreview(ref.previewId, ref.nonce),
    confirmAll: (refs) => Promise.all(refs.map((r) => api.confirmPreview(r.previewId, r.nonce))),
    cancel: (previewId) => api.cancelPreview(previewId),
    undo: (id) => api.undo(id),
    savePermissions: (groups) => api.savePermissions(groups),
    getPermissions: () => api.getPermissions(),
  };
}

export function featureGroupRows(policy: PolicyShape): Array<{ group: string; level: string }> {
  return Object.entries(policy.groups).map(([group, level]) => ({ group, level }));
}

// ---------------------------------------------------------------------------
// Chat response shapes + the responsive send flow (testable core).
// ---------------------------------------------------------------------------

export interface PreviewResult {
  kind: "preview";
  previewId: string;
  nonce: string;
  preview: { actionLabel: string; expectedChanges: string[]; reversibility: string; warnings: string[] };
}
export interface ReceiptResult {
  kind: "receipt";
  receipt: { ok: boolean; action: string; message?: string; changed?: unknown; warnings?: Array<{ code?: string; message: string }> };
  /** Present when the action can be reversed (a one-use undo handle). */
  undo?: { id: string };
}
export interface ClarifyResult {
  kind: "clarify";
  message: string;
  options?: Array<{ id: string; label: string }>;
}
export type ChatResult = PreviewResult | ReceiptResult | ClarifyResult;
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
}

export async function submitMessage(api: ChatApiLike, message: string, hooks: ComposerHooks): Promise<void> {
  hooks.onWorking(true);
  try {
    const response = (await api.sendMessage(message)) as ChatResponse;
    if (response.reply?.text) hooks.onAssistant(response.reply.text);
    hooks.onResults(response.results ?? []);
  } catch {
    hooks.onError("Message failed to send.");
  } finally {
    hooks.onWorking(false);
  }
}

// --- NDJSON streaming (POST /api/chat/stream) ------------------------------

/** One event from the streaming chat endpoint. */
export interface StreamEvent {
  type: "result" | "reply" | "error" | "done" | string;
  result?: ChatResult;
  kind?: string;
  text?: string;
  code?: string;
  message?: string;
}

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
    return res.json();
  }
  return {
    getPermissions: () => json("/api/permissions"),
    savePermissions: (groups) =>
      json("/api/permissions/confirm", { method: "POST", body: JSON.stringify({ groups }) }),
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
        onEvent({ type: "error", message: "The assistant is temporarily unavailable. Please try again." });
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

const PERMISSION_LEVELS = ["off", "read", "read_write"];

interface PermissionsResponse {
  ok: boolean;
  policy: PolicyShape;
  firstRun: boolean;
}

function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function mount(root: HTMLElement, api: ChatApi): void {
  const controller = createController(api);
  root.replaceChildren();
  const header = el("header", "app-header");
  header.appendChild(el("h1", undefined, "AI Assistant"));
  root.appendChild(header);

  const setup = el("section", "setup hidden");
  setup.setAttribute("aria-label", "Set up assistant permissions");
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
  const statusBar = el("div", "status hidden");
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
  function setWorking(working: boolean): void {
    statusBar.textContent = working ? "Assistant is working…" : "";
    statusBar.classList.toggle("hidden", !working);
  }

  function appendMessage(role: string, text: string): void {
    messages.appendChild(el("div", `message ${role}`, text));
    messages.scrollTop = messages.scrollHeight;
  }

  function renderPermissionTable(
    policy: PolicyShape,
    onSave: (groups: Record<string, string>) => void,
  ): HTMLElement {
    const table = el("table", "permissions");
    table.setAttribute("aria-label", "Assistant permissions by feature group");
    const selections: Record<string, string> = {};
    for (const { group, level } of featureGroupRows(policy)) {
      selections[group] = level;
      const row = el("tr");
      row.appendChild(el("td", "group", group));
      const select = document.createElement("select");
      // Each control names its own group so a screen reader reads them in context.
      select.setAttribute("aria-label", `Permission level for ${group}`);
      for (const option of PERMISSION_LEVELS) {
        const opt = document.createElement("option");
        opt.value = option;
        opt.textContent = option;
        if (option === level) opt.selected = true;
        select.appendChild(opt);
      }
      select.addEventListener("change", () => {
        selections[group] = select.value;
      });
      const cell = el("td");
      cell.appendChild(select);
      row.appendChild(cell);
      table.appendChild(row);
    }
    const saveButton = el("button", "primary", "Save permissions") as HTMLButtonElement;
    saveButton.addEventListener("click", () => onSave({ ...selections }));
    const wrapper = el("div", "permission-panel");
    wrapper.appendChild(table);
    wrapper.appendChild(saveButton);
    return wrapper;
  }

  function renderReceipt(result: ReceiptResult): HTMLElement {
    const warnings = result.receipt.warnings ?? [];
    // "Done with caveats" when the action succeeded but something was skipped
    // (e.g. an invoice was created but a line item couldn't be added) — never
    // present a partial result as a clean success.
    const status = result.receipt.ok ? (warnings.length ? "Done — with notes" : "Done") : "Failed";
    const card = el("div", `receipt ${result.receipt.ok ? (warnings.length ? "warn" : "ok") : "error"}`);
    card.setAttribute("role", "group");
    card.setAttribute("aria-label", `${status}: ${result.receipt.action}`);
    card.appendChild(el("strong", undefined, status));
    card.appendChild(el("span", "action", result.receipt.action));
    // Surface warnings inline (not buried in Details) so the user sees them.
    for (const w of warnings) card.appendChild(el("p", "warning", w.message));
    // One-click undo for a reversible creation (deletes what was just created).
    if (result.receipt.ok && result.undo) {
      const undoId = result.undo.id;
      const undoButton = el("button", "link undo", "Undo") as HTMLButtonElement;
      undoButton.setAttribute("aria-label", `Undo ${result.receipt.action}`);
      undoButton.addEventListener("click", async () => {
        undoButton.disabled = true;
        try {
          const res = (await controller.undo(undoId)) as { ok?: boolean };
          if (res?.ok) {
            undoButton.textContent = "Undone";
          } else {
            undoButton.textContent = "Undo";
            undoButton.disabled = false;
            showError("Undo failed.");
          }
        } catch {
          undoButton.textContent = "Undo";
          undoButton.disabled = false;
          showError("Undo failed.");
        }
      });
      card.appendChild(undoButton);
    }
    const details = el("pre", "details hidden", JSON.stringify(result.receipt, null, 2));
    const toggle = el("button", "link", "Details") as HTMLButtonElement;
    toggle.setAttribute("aria-expanded", "false");
    toggle.addEventListener("click", () => {
      const open = details.classList.toggle("hidden") === false;
      toggle.setAttribute("aria-expanded", String(open));
    });
    card.appendChild(toggle);
    card.appendChild(details);
    return card;
  }

  function renderPreview(previews: PreviewResult[]): HTMLElement {
    const batch = previews.length > 1;
    const card = el("div", "preview-card");
    card.setAttribute("role", "group");
    card.setAttribute("aria-label", batch ? `${previews.length} changes awaiting confirmation` : "Change awaiting confirmation");
    for (const preview of previews) {
      const block = el("div", "preview");
      block.appendChild(el("strong", undefined, preview.preview.actionLabel));
      const changes = el("ul");
      for (const change of preview.preview.expectedChanges) {
        changes.appendChild(el("li", undefined, change));
      }
      block.appendChild(changes);
      block.appendChild(el("em", "reversibility", preview.preview.reversibility));
      card.appendChild(block);
    }
    const actions = el("div", "buttons");
    const refs: PreviewRef[] = previews.map((p) => ({ previewId: p.previewId, nonce: p.nonce }));
    const confirmButton = el("button", "primary", batch ? "Confirm all" : "Confirm") as HTMLButtonElement;
    confirmButton.addEventListener("click", async () => {
      confirmButton.disabled = true;
      try {
        if (batch) await controller.confirmAll(refs);
        else await controller.confirm(refs[0]);
        card.remove();
        appendMessage("assistant", batch ? "Batch confirmed." : "Confirmed.");
      } catch {
        showError("Confirmation failed.");
        confirmButton.disabled = false;
      }
    });
    const cancelButton = el("button", "secondary", batch ? "Cancel all" : "Cancel") as HTMLButtonElement;
    cancelButton.addEventListener("click", async () => {
      for (const ref of refs) await controller.cancel(ref.previewId);
      card.remove();
      appendMessage("assistant", "Cancelled.");
    });
    actions.appendChild(confirmButton);
    actions.appendChild(cancelButton);
    card.appendChild(actions);
    return card;
  }

  function renderResults(results: ChatResult[]): void {
    const previews = results.filter((r): r is PreviewResult => r.kind === "preview");
    if (previews.length > 0) messages.appendChild(renderPreview(previews));
    for (const result of results) {
      if (result.kind === "receipt") messages.appendChild(renderReceipt(result));
      else if (result.kind === "clarify") appendMessage("assistant", result.message);
    }
    messages.scrollTop = messages.scrollHeight;
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
    let busy = false;
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (busy) return; // a one-at-a-time guard (Enter while working can't double-submit)
      const text = input.value.trim();
      if (!text) return;
      // Typed text always goes to chat — never to a confirmation endpoint.
      appendMessage("user", text);
      input.value = "";
      clearError();
      // Streaming: harness results render as they arrive, then the truthful reply.
      await submitStreaming(api, text, {
        onWorking: (working) => {
          busy = working;
          setWorking(working); // announces "Assistant is working…" to screen readers
          send.disabled = working;
          form.setAttribute("aria-busy", String(working));
          if (!working) input.focus(); // return focus to the composer after the turn
        },
        onAssistant: (assistantText) => appendMessage("assistant", assistantText),
        onResults: (results) => renderResults(results),
        onError: (message) => showError(message),
      });
    });
    chat.appendChild(form);
    chat.classList.remove("hidden");
    input.focus();
  }

  async function init(): Promise<void> {
    try {
      const perms = (await api.getPermissions()) as PermissionsResponse;
      if (perms.firstRun) {
        setup.replaceChildren();
        setup.appendChild(el("h2", undefined, "Set up your assistant permissions"));
        setup.appendChild(
          el(
            "p",
            undefined,
            "Defaults grant full read & write for every group. Adjust if you like, then start.",
          ),
        );
        setup.appendChild(
          renderPermissionTable(perms.policy, async (groups) => {
            try {
              await controller.savePermissions(groups);
              setup.classList.add("hidden");
              renderChat();
            } catch {
              showError("Could not save permissions.");
            }
          }),
        );
        setup.classList.remove("hidden");
      } else {
        renderChat();
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
