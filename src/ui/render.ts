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

import { batchItemOutcomes, expiryView } from "./presentation.js";
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

// Inline stroke icons, built via createElementNS (NEVER innerHTML).
export const ICON_CHECK = "M5 13l4 4L19 7";
export const ICON_X = "M6 6l12 12M18 6L6 18";
export const ICON_ALERT = "M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z";
export const ICON_CLOCK = "M12 8v4l2.5 2.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0";
export const ICON_CHEVRON = "M9 6l6 6-6 6";
export const ICON_GEAR = "M4 7h10M18 7h2M4 17h2M10 17h10M14 5v4M8 15v4";
export const ICON_UNDO = "M3 7v6h6M3 13a9 9 0 1 0 3-7.7";

export function svgIcon(pathD: string): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", pathD);
  svg.appendChild(path);
  return svg;
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

/** Example prompts on the empty-chat welcome card — every one maps to a real capability. */
export const EXAMPLE_PROMPTS = [
  "What did I track today?",
  "Show this week's summary report",
  "Start a timer for deep work",
  "What did you change recently?",
];

/** The empty-chat welcome card. Lives OUTSIDE the message log (never announced as a turn). */
export function renderWelcome(deps: ClarifyDeps): HTMLElement {
  const box = el("div", "welcome");
  box.appendChild(el("h2", undefined, "What can I do for you?"));
  box.appendChild(
    el(
      "p",
      undefined,
      "I can read and change this Clockify workspace. Safe changes run immediately with receipts; anything risky shows a preview you confirm with a button.",
    ),
  );
  const row = el("div", "chip-row");
  for (const prompt of EXAMPLE_PROMPTS) {
    const chip = el("button", "chip", prompt) as HTMLButtonElement;
    chip.type = "button";
    chip.addEventListener("click", () => deps.sendText(prompt));
    row.appendChild(chip);
  }
  box.appendChild(row);
  return box;
}

/** Dependencies `renderReceipt` needs from the host `mount`. */
export interface ReceiptDeps {
  controller: ChatController;
  showError: (message: string) => void;
}

/** Unique ids for the details disclosure (aria-controls). */
let detailsSeq = 0;

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
  const head = el("div", "receipt-head");
  const icon = el("span", "receipt-icon");
  icon.appendChild(svgIcon(result.receipt.ok ? (warnings.length ? ICON_ALERT : ICON_CHECK) : ICON_X));
  head.appendChild(icon);
  head.appendChild(el("strong", undefined, status));
  head.appendChild(el("span", "action", result.receipt.action));
  card.appendChild(head);
  // The server's own outcome message (e.g. why an action failed) — verbatim.
  if (result.receipt.message) card.appendChild(el("p", "receipt-message", result.receipt.message));
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
          const done = el("span", "undo-done");
          done.appendChild(svgIcon(ICON_CHECK));
          done.appendChild(document.createTextNode("Undone"));
          undoButton.replaceWith(done);
          // The log region announces additions — give non-visual users the outcome.
          card.appendChild(el("p", "sr-only", "Undo complete"));
        } else {
          undoButton.disabled = false;
          showError("Undo failed.");
        }
      } catch {
        undoButton.disabled = false;
        showError("Undo failed.");
      }
    });
    card.appendChild(undoButton);
  }
  // Collapsible raw-receipt disclosure (mono, height-capped, scrolls inside).
  detailsSeq += 1;
  const body = el("div", "details-body");
  body.id = `receipt-details-${detailsSeq}`;
  body.appendChild(el("pre", undefined, JSON.stringify(result.receipt, null, 2)));
  const toggle = el("button", "link details-toggle") as HTMLButtonElement;
  toggle.appendChild(svgIcon(ICON_CHEVRON));
  toggle.appendChild(document.createTextNode("Details"));
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", body.id);
  toggle.addEventListener("click", () => {
    const open = body.classList.toggle("open");
    toggle.setAttribute("aria-expanded", String(open));
  });
  card.appendChild(toggle);
  card.appendChild(body);
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

  // Header: what's pending, how risky, and how long the one-use preview lasts.
  const head = el("div", "preview-head");
  head.appendChild(svgIcon(ICON_CLOCK));
  head.appendChild(
    el("strong", undefined, batch ? `${previews.length} changes awaiting confirmation` : previews[0].preview.actionLabel),
  );
  for (const risk of [...new Set(previews.flatMap((p) => p.preview.riskLabels ?? []))]) {
    head.appendChild(el("span", `badge risk${risk === "destructive" ? " risk-destructive" : ""}`, risk.split("_").join(" ")));
  }
  // The countdown is ADVISORY (the server's TTL stays authoritative). A batch
  // shows its earliest deadline — one card, one Confirm all, one honest clock.
  const expiries = previews.map((p) => p.expiresAt).filter((e): e is string => typeof e === "string");
  const minExpiry = expiries.length > 0 ? expiries.reduce((a, b) => (a < b ? a : b)) : undefined;
  const initialView = expiryView(minExpiry, Date.now());
  let countdown: HTMLElement | undefined;
  if (initialView) {
    countdown = el("span", "countdown", initialView.label);
    countdown.setAttribute("aria-hidden", "true"); // a ticking live region would be hostile
    head.appendChild(countdown);
  }
  card.appendChild(head);

  for (const preview of previews) {
    const block = el("div", "preview");
    if (batch) block.appendChild(el("strong", undefined, preview.preview.actionLabel));
    const targets = (preview.preview.targets ?? []).map((t) => t.name ?? t.id);
    if (targets.length > 0) block.appendChild(el("div", "targets", `Target: ${targets.join(", ")}`));
    const changes = el("ul");
    for (const change of preview.preview.expectedChanges) {
      changes.appendChild(el("li", undefined, change));
    }
    block.appendChild(changes);
    block.appendChild(el("em", "reversibility", preview.preview.reversibility));
    // Surface the harness's preview warnings (the "$0 caveat" class) — they
    // exist precisely so the admin sees them BEFORE confirming.
    for (const warning of preview.preview.warnings ?? []) {
      block.appendChild(el("p", "warning", warning));
    }
    card.appendChild(block);
  }

  const actions = el("div", "buttons");
  const refs: PreviewRef[] = previews.map((p) => ({ previewId: p.previewId, nonce: p.nonce }));
  const confirmButton = el("button", "primary", batch ? "Confirm all" : "Confirm") as HTMLButtonElement;
  const cancelButton = el("button", "secondary", batch ? "Cancel all" : "Cancel") as HTMLButtonElement;
  const setButtons = (disabled: boolean): void => {
    confirmButton.disabled = disabled;
    cancelButton.disabled = disabled;
  };

  // Expiry lifecycle: tick once a second while the card is connected; at zero
  // the buttons die and the card says why. The server re-checks regardless —
  // a stale click gets its verbatim 400 expired / 409 already-used message.
  let timer: number | undefined;
  const stopTimer = (): void => {
    if (timer !== undefined) window.clearInterval(timer);
    timer = undefined;
  };
  const expire = (): void => {
    stopTimer();
    setButtons(true);
    card.classList.add("expired");
    if (countdown) {
      countdown.textContent = "Expired";
      countdown.classList.add("expired-pill");
    }
    card.appendChild(el("p", "expired-note", "This preview expired — ask the assistant to prepare it again."));
    card.appendChild(el("p", "sr-only", "Preview expired")); // one polite announcement via the log region
  };
  if (initialView && countdown) {
    if (initialView.expired) {
      expire();
    } else {
      timer = window.setInterval(() => {
        if (!card.isConnected) {
          stopTimer(); // self-cleanup on any removal path
          return;
        }
        const view = expiryView(minExpiry, Date.now());
        if (!view) return;
        countdown!.textContent = view.label;
        if (view.expired) expire();
      }, 1000);
    }
  }

  const confirmHooks: ConfirmHooks = {
    onAssistant: (text) => appendMessage("assistant", text),
    onResults: renderResults,
    onError: showError,
  };
  confirmButton.addEventListener("click", async () => {
    // One-use: neither button may fire again (or cross-fire) once clicked.
    setButtons(true);
    if (batch) {
      // Batch ("Confirm all") is single-turn only (agentic mode interrupts at the
      // first risky write, so it never produces a batch) — plain JSON, settled
      // truthfully: a failed confirm shows its message, never "Confirmed."
      try {
        const responses = (await controller.confirmAll(refs)) as ConfirmResponse[];
        stopTimer();
        // The card stays as the settled record: one ✓/✗ row per item, with the
        // server's message verbatim on failures — so a partial batch shows
        // exactly WHICH item failed and why, not just "1 of 2".
        const list = el("div", "batch-outcomes");
        for (const outcome of batchItemOutcomes(previews.map((p) => p.preview.actionLabel), responses)) {
          const row = el("div", `batch-outcome ${outcome.ok ? "ok" : "failed"}`);
          row.appendChild(svgIcon(outcome.ok ? ICON_CHECK : ICON_X));
          row.appendChild(el("span", undefined, outcome.label));
          row.appendChild(el("span", "detail", outcome.detail));
          list.appendChild(row);
        }
        actions.replaceWith(list);
        countdown?.remove(); // the deadline no longer applies to a settled card
        card.classList.add("settled");
        settleConfirmOutcome(responses, confirmHooks);
      } catch {
        showError("Confirmation failed.");
        setButtons(false);
      }
      return;
    }
    // Single confirm STREAMS: the committed receipt renders immediately (the
    // button never feels dead), then the durable resume streams its continuation
    // — receipts, a chained preview, and the truthful reply — as it runs.
    stopTimer();
    card.remove();
    await submitConfirmStream(controller, refs[0], confirmHooks);
  });
  cancelButton.addEventListener("click", async () => {
    setButtons(true);
    try {
      for (const ref of refs) await controller.cancel(ref.previewId);
    } catch {
      showError("Cancel failed.");
      setButtons(false);
      return;
    }
    stopTimer();
    card.remove();
    appendMessage("assistant", "Cancelled.");
  });
  actions.appendChild(confirmButton);
  actions.appendChild(cancelButton);
  card.appendChild(actions);
  return card;
}
