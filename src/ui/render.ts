/**
 * Leaf DOM render builders for the embedded chat UI, extracted from `mount()`.
 *
 * These are pure structural builders: each takes its dependencies (controller,
 * status callbacks, message appender) as explicit params instead of closing over
 * `mount`'s scope. Behavior is identical to the original in-mount closures.
 *
 * All DOM text is set via textContent (never innerHTML) so untrusted Clockify
 * data and model output cannot inject markup. This module is untested DOM glue
 * (type-check + the vite build are the safety nets); keep these builders exact.
 */

import {
  featureGroupRows,
  settleConfirmOutcome,
  submitConfirmStream,
  type ChatController,
  type ChatResult,
  type ClarifyResult,
  type ConfirmHooks,
  type ConfirmResponse,
  type PolicyShape,
  type PreviewRef,
  type PreviewResult,
  type ReceiptResult,
} from "./shared.js";

const PERMISSION_LEVELS = ["off", "read", "read_write"];

export function el(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function renderPermissionTable(
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

/** Dependencies `renderClarify` needs from the host `mount`. */
export interface ClarifyDeps {
  /** Send text through the NORMAL chat path (same function the composer uses). */
  sendText: (text: string) => void;
}

/**
 * A clarify turn: the question bubble plus the grounded "did you mean?" options
 * as one-use chips. A chip click sends the option LABEL as an ordinary chat
 * message — it goes through the same send path as typed text, so nothing here
 * can reach a confirmation endpoint (the option id is never sent).
 */
export function renderClarify(result: ClarifyResult, deps: ClarifyDeps): HTMLElement {
  const wrap = el("div", "clarify");
  wrap.appendChild(el("div", "message assistant", result.message));
  const options = result.options ?? [];
  if (options.length > 0) {
    const row = el("div", "chip-row");
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", "Suggested replies");
    for (const option of options) {
      const chip = el("button", "chip", option.label) as HTMLButtonElement;
      chip.type = "button";
      chip.addEventListener("click", () => {
        // One-use: the whole row disables; the chosen chip stays highlighted
        // as a record of what was picked.
        for (const button of Array.from(row.querySelectorAll("button"))) {
          (button as HTMLButtonElement).disabled = true;
        }
        chip.classList.add("chip-selected");
        deps.sendText(option.label);
      });
      row.appendChild(chip);
    }
    wrap.appendChild(row);
  }
  return wrap;
}

/** Dependencies `renderReceipt` needs from the host `mount`. */
export interface ReceiptDeps {
  controller: ChatController;
  showError: (message: string) => void;
}

export function renderReceipt(result: ReceiptResult, deps: ReceiptDeps): HTMLElement {
  const { controller, showError } = deps;
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

/** Dependencies `renderPreview` needs from the host `mount`. */
export interface PreviewDeps {
  controller: ChatController;
  showError: (message: string) => void;
  appendMessage: (role: string, text: string) => void;
  /** Render follow-up results from a resumed agentic turn (receipts, even a CHAINED preview). */
  renderResults: (results: ChatResult[]) => void;
}

export function renderPreview(previews: PreviewResult[], deps: PreviewDeps): HTMLElement {
  const { controller, showError, appendMessage, renderResults } = deps;
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
  const confirmHooks: ConfirmHooks = {
    onAssistant: (text) => appendMessage("assistant", text),
    onResults: renderResults,
    onError: showError,
  };
  confirmButton.addEventListener("click", async () => {
    confirmButton.disabled = true;
    if (batch) {
      // Batch ("Confirm all") is single-turn only (agentic mode interrupts at the
      // first risky write, so it never produces a batch) — plain JSON, settled
      // truthfully: a failed confirm shows its message, never "Confirmed."
      try {
        const responses = (await controller.confirmAll(refs)) as ConfirmResponse[];
        card.remove();
        settleConfirmOutcome(responses, confirmHooks);
      } catch {
        showError("Confirmation failed.");
        confirmButton.disabled = false;
      }
      return;
    }
    // Single confirm STREAMS: the committed receipt renders immediately (the
    // button never feels dead), then the durable resume streams its continuation
    // — receipts, a chained preview, and the truthful reply — as it runs.
    card.remove();
    await submitConfirmStream(controller, refs[0], confirmHooks);
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
