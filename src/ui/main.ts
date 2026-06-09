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
interface PreviewResult {
  kind: "preview";
  previewId: string;
  nonce: string;
  preview: {
    actionLabel: string;
    expectedChanges: string[];
    reversibility: string;
    warnings: string[];
  };
}
interface ReceiptResult {
  kind: "receipt";
  receipt: {
    ok: boolean;
    action: string;
    message?: string;
    changed?: unknown;
    warnings?: Array<{ code?: string; message: string }>;
  };
  /** Present when the action can be reversed (a one-use undo handle). */
  undo?: { id: string };
}
interface ClarifyResult {
  kind: "clarify";
  message: string;
  options?: Array<{ id: string; label: string }>;
}
type ChatResult = PreviewResult | ReceiptResult | ClarifyResult;
interface ChatResponse {
  ok: boolean;
  reply: { kind: string; text: string };
  results: ChatResult[];
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
  root.appendChild(el("header", "app-header", "AI Assistant"));

  const setup = el("section", "setup hidden");
  const chat = el("section", "chat hidden");
  const messages = el("div", "messages");
  const errorBar = el("div", "error hidden");
  root.appendChild(errorBar);
  root.appendChild(setup);
  root.appendChild(chat);

  function showError(message: string): void {
    errorBar.textContent = message;
    errorBar.classList.remove("hidden");
  }
  function clearError(): void {
    errorBar.classList.add("hidden");
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
    const selections: Record<string, string> = {};
    for (const { group, level } of featureGroupRows(policy)) {
      selections[group] = level;
      const row = el("tr");
      row.appendChild(el("td", "group", group));
      const select = document.createElement("select");
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
    card.appendChild(el("strong", undefined, status));
    card.appendChild(el("span", "action", result.receipt.action));
    // Surface warnings inline (not buried in Details) so the user sees them.
    for (const w of warnings) card.appendChild(el("p", "warning", w.message));
    // One-click undo for a reversible creation (deletes what was just created).
    if (result.receipt.ok && result.undo) {
      const undoId = result.undo.id;
      const undoButton = el("button", "link undo", "Undo") as HTMLButtonElement;
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
    toggle.addEventListener("click", () => details.classList.toggle("hidden"));
    card.appendChild(toggle);
    card.appendChild(details);
    return card;
  }

  function renderPreview(previews: PreviewResult[]): HTMLElement {
    const batch = previews.length > 1;
    const card = el("div", "preview-card");
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
    const input = el("input", "composer-input") as HTMLInputElement;
    input.placeholder = "Ask the assistant…";
    const send = el("button", "primary", "Send") as HTMLButtonElement;
    form.appendChild(input);
    form.appendChild(send);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      // Typed text always goes to chat — never to a confirmation endpoint.
      appendMessage("user", text);
      input.value = "";
      clearError();
      try {
        const response = (await controller.send(text)) as ChatResponse;
        if (response.reply?.text) appendMessage("assistant", response.reply.text);
        renderResults(response.results ?? []);
      } catch {
        showError("Message failed to send.");
      }
    });
    chat.appendChild(form);
    chat.classList.remove("hidden");
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
