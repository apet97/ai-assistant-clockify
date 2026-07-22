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

import { batchItemOutcomes, expiryView, humanizeGroup, levelLabel } from "./presentation.js";
import { EN_US_LOCALE, formatLocalDateTime, promptsForPolicy, welcomeCopyForPolicy } from "./product.js";
import {
  cancelOutcome,
  featureGroupRows,
  removeCardReturningFocus,
  reservedPendingFor,
  runConfirmStreamLive,
  settleConfirmOutcome,
  undoFailureMessage,
  type ChatController,
  type ChatResult,
  type ClarifyResult,
  type ConfirmHooks,
  type HistoryResponse,
  type OperationCardData,
  type PolicyShape,
  type PreviewRef,
  type PreviewResult,
  type ReceiptResult,
  type PartialResult,
} from "./shared.js";

const PERMISSION_LEVELS = ["off", "read", "read_write"];

function runEventTask(task: () => Promise<void>, onError: () => void): void {
  void task().catch(onError);
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
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
  onSave: (groups: Record<string, string>) => Promise<boolean>,
): HTMLElement {
  const table = el("table", "permissions");
  table.setAttribute("aria-label", "Assistant permissions by feature group");
  const headRow = el("tr");
  headRow.appendChild(el("th", undefined, "Feature group"));
  headRow.appendChild(el("th", undefined, "Access"));
  table.appendChild(headRow);
  const selections: Record<string, string> = {};
  for (const { group, level } of featureGroupRows(policy)) {
    selections[group] = level;
    const label = humanizeGroup(group);
    const row = el("tr");
    row.appendChild(el("td", "group", label));
    const select = document.createElement("select");
    // Each control names its own group so a screen reader reads them in context.
    select.setAttribute("aria-label", `Permission level for ${label}`);
    for (const option of PERMISSION_LEVELS) {
      const opt = document.createElement("option");
      opt.value = option; // the wire value stays raw — only the display text is humanized
      opt.textContent = levelLabel(option);
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
  const saveButton = el("button", "primary", "Save permissions");
  const saveStatus = el("span", "save-status");
  saveStatus.setAttribute("role", "status"); // "Saved" is announced, not just shown
  saveButton.addEventListener("click", () => {
    runEventTask(async () => {
      saveButton.disabled = true;
      saveStatus.textContent = "Saving…";
      const saved = await onSave({ ...selections });
      saveButton.disabled = false;
      saveStatus.textContent = saved ? "Saved" : ""; // failures speak through the error bar
    }, () => {
      saveButton.disabled = false;
      saveStatus.textContent = "";
    });
  });
  const footer = el("div", "permission-footer");
  footer.appendChild(saveButton);
  footer.appendChild(saveStatus);
  const wrapper = el("div", "permission-panel");
  wrapper.appendChild(table);
  wrapper.appendChild(footer);
  return wrapper;
}

/**
 * One conversation in the chat-history switcher: the route's `SessionSummary`
 * plus the server-set `current` flag (which session the cookie is on — the
 * client can never spoof this; it comes from `claims.sessionId`).
 */
export interface ChatSessionSummary {
  id: string;
  title: string;
  messageCount: number;
  lastMessageAt: string;
  createdAt: string;
  current: boolean;
}

/** Dependencies `renderChatsMenu` needs from the host `mount`. */
export interface ChatsMenuDeps {
  /** Switch to the picked conversation (never called for the CURRENT one). */
  onSelect: (id: string) => void;
}

const TITLE_MAX = 48;

/** Truncate a (untrusted) title for the menu label; whole-string via textContent. */
function truncateTitle(title: string): string {
  const trimmed = title.trim() || "Conversation";
  return trimmed.length > TITLE_MAX ? `${trimmed.slice(0, TITLE_MAX - 1)}…` : trimmed;
}

/** A coarse "5m ago" / "2h ago" / "3d ago" label for the last-activity time. */
export function relativeTime(iso: string, nowMs: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const sec = Math.max(0, Math.round((nowMs - then) / 1000));
  const formatter = new Intl.RelativeTimeFormat(EN_US_LOCALE, { numeric: "auto" });
  if (sec < 60) return formatter.format(0, "second");
  const min = Math.round(sec / 60);
  if (min < 60) return formatter.format(-min, "minute");
  const hr = Math.round(min / 60);
  if (hr < 24) return formatter.format(-hr, "hour");
  return formatter.format(-Math.round(hr / 24), "day");
}

/**
 * The "Chats" history-switcher dropdown: a toggle button plus a `role="menu"`
 * list of the admin's recent conversations (newest-first as supplied). Selecting
 * a NON-current item calls `deps.onSelect(id)`; the current one is marked
 * `aria-current="true"` and is a no-op (it's already open) — clicking it just
 * closes the menu.
 *
 * SAFETY: titles are the first user message = untrusted workspace data, so every
 * label is set via `textContent` (the repo's XSS convention) — markup can never
 * be parsed. The menu is a WCAG menu widget: `aria-haspopup`/`aria-expanded` on
 * the toggle, `role="menuitem"` items, Enter/Space to select, Escape to close,
 * Arrow Up/Down to move focus (wrapping). An empty list shows a non-selectable
 * "No past conversations" item.
 */
export function renderChatsMenu(sessions: ChatSessionSummary[], deps: ChatsMenuDeps): HTMLElement {
  const wrap = el("div", "chats-menu");

  const toggle = el("button", "secondary chats-toggle");
  toggle.type = "button";
  toggle.setAttribute("aria-haspopup", "menu");
  toggle.setAttribute("aria-expanded", "false");
  toggle.appendChild(document.createTextNode("Chats"));
  toggle.appendChild(svgIcon(ICON_CHEVRON));

  const menu = el("div", "chats-list");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Recent conversations");
  menu.hidden = true;

  const items: HTMLButtonElement[] = [];
  // Roving tabindex (WAI-ARIA menu): exactly ONE item sits in the Tab sequence;
  // Arrow keys move focus (and the tab stop) within the menu, so the whole list
  // is a single Tab stop instead of one stop per conversation row.
  const setRoving = (active: number): void => {
    items.forEach((it, i) => {
      it.tabIndex = i === active ? 0 : -1;
    });
  };
  const focusItem = (index: number): void => {
    if (items.length === 0) return;
    const next = (index + items.length) % items.length;
    items[next].focus();
    setRoving(next);
  };
  const moveFocus = (from: number, delta: number): void => {
    focusItem(from + delta);
  };

  // Close the menu on a pointer-down anywhere outside it (the menu-widget
  // behavior mouse users expect). Capture-phase, registered on open, removed on close.
  const onDocPointerDown = (event: Event): void => {
    const target = event.target as Node | null;
    if (target && !wrap.contains(target)) close();
  };
  const close = (): void => {
    menu.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", onDocPointerDown, true);
  };
  // APG menu-button: opening moves focus INTO the menu so Arrow/Escape work at
  // once (a keyboard user shouldn't have to Tab in first); ArrowUp opens onto the
  // last item.
  const open = (focusIndex = 0): void => {
    menu.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", onDocPointerDown, true);
    focusItem(focusIndex);
  };
  toggle.addEventListener("click", () => {
    if (menu.hidden) open();
    else close();
  });
  toggle.addEventListener("keydown", (event) => {
    const e = event as KeyboardEvent;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (menu.hidden) open(0);
      else focusItem(0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (menu.hidden) open(items.length - 1);
      else focusItem(items.length - 1);
    } else if (e.key === "Escape") {
      if (!menu.hidden) close();
    }
  });

  if (sessions.length === 0) {
    const empty = el("div", "chats-empty", "No past conversations");
    menu.appendChild(empty);
  } else {
    const now = Date.now();
    sessions.forEach((s, index) => {
      const item = el("button", `chats-item${s.current ? " current" : ""}`);
      item.type = "button";
      item.setAttribute("role", "menuitem");
      if (s.current) {
        item.setAttribute("aria-current", "true");
        const check = el("span", "chats-check");
        check.appendChild(svgIcon(ICON_CHECK));
        item.appendChild(check);
      }
      // Title and time are untrusted/data — textContent only, never innerHTML.
      item.appendChild(el("span", "chats-title", truncateTitle(s.title)));
      const when = relativeTime(s.lastMessageAt, now);
      if (when) item.appendChild(el("span", "chats-time", when));

      const select = (): void => {
        close();
        if (!s.current) deps.onSelect(s.id);
      };
      item.addEventListener("click", select);
      item.addEventListener("keydown", (event) => {
        const e = event as KeyboardEvent;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          select();
        } else if (e.key === "Escape") {
          close();
          toggle.focus();
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          moveFocus(index, 1);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          moveFocus(index, -1);
        }
      });
      items.push(item);
      menu.appendChild(item);
    });
    // The current session is the initial tab stop (else the first item).
    setRoving(Math.max(0, sessions.findIndex((s) => s.current)));
  }

  wrap.appendChild(toggle);
  wrap.appendChild(menu);
  return wrap;
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
      const chip = el("button", "chip", option.label);
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

/**
 * Example prompts on the empty-chat welcome card — every one maps to a real,
 * live-verified capability, deliberately spanning the breadth (tracking,
 * reports, billing+project links, time off, team) so a new admin discovers
 * more than timers. One screen, no categories — chips stay scannable.
 */
export const EXAMPLE_PROMPTS = promptsForPolicy();

/** The empty-chat welcome card. Lives OUTSIDE the message log (never announced as a turn). */
export function renderWelcome(deps: ClarifyDeps & { policy?: PolicyShape }): HTMLElement {
  const box = el("div", "welcome");
  box.appendChild(el("h2", undefined, "What can I do for you?"));
  box.appendChild(
    el(
      "p",
      undefined,
      welcomeCopyForPolicy(deps.policy),
    ),
  );
  const row = el("div", "chip-row");
  for (const prompt of promptsForPolicy(deps.policy)) {
    const chip = el("button", "chip", prompt);
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
  /**
   * Return focus after a successful Undo (mount points it at the composer input,
   * mirroring the Confirm/Cancel `removeCardReturningFocus` path). Replacing the
   * focused Undo button with the non-focusable "Undone" span would otherwise drop
   * focus to <body> — WCAG 2.4.3 Focus Order.
   */
  returnFocus?: () => void;
}

/** Unique ids for the details disclosure (aria-controls). */
let detailsSeq = 0;

export function renderReceipt(result: ReceiptResult | PartialResult, deps: ReceiptDeps): HTMLElement {
  const { controller, showError } = deps;
  const warnings = result.receipt.warnings ?? [];
  // "Done with caveats" when the action succeeded but something was skipped
  // (e.g. an invoice was created but a line item couldn't be added) — never
  // present a partial result as a clean success.
  const isPartial = result.kind === "partial";
  const status = isPartial ? "Partial — review needed" : result.receipt.ok ? (warnings.length ? "Done — with notes" : "Done") : "Failed";
  const card = el("div", `receipt ${isPartial ? "warn" : result.receipt.ok ? (warnings.length ? "warn" : "ok") : "error"}`);
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", `${status}: ${result.receipt.action}`);
  const head = el("div", "receipt-head");
  const icon = el("span", "receipt-icon");
  icon.appendChild(svgIcon(isPartial ? ICON_ALERT : result.receipt.ok ? (warnings.length ? ICON_ALERT : ICON_CHECK) : ICON_X));
  head.appendChild(icon);
  head.appendChild(el("strong", undefined, status));
  head.appendChild(el("span", "action", result.receipt.action));
  card.appendChild(head);
  if (isPartial) {
    card.appendChild(el("p", "receipt-message", result.message));
    card.appendChild(el("p", "warning", result.recovery.hint));
  }
  // The server's own outcome message (e.g. why an action failed) — verbatim.
  if (!isPartial && result.receipt.message) card.appendChild(el("p", "receipt-message", result.receipt.message));
  // Surface warnings inline (not buried in Details) so the user sees them.
  for (const w of warnings) card.appendChild(el("p", "warning", w.message));
  // Invoice PDF bytes remain behind the scoped, authenticated artifact route.
  // The UI receives only its same-origin path, filename, and expiry; a normal
  // anchor preserves the browser's authenticated cookie and avoids copying a
  // binary into client state.
  if (result.receipt.artifact) {
    const artifact = result.receipt.artifact;
    const download = el("a", "invoice-download", "Download invoice PDF");
    download.setAttribute("href", artifact.downloadUrl);
    download.setAttribute("download", artifact.filename);
    download.setAttribute("aria-label", `Download invoice PDF: ${artifact.filename}`);
    card.appendChild(download);
    const timeZone = document.documentElement?.dataset.timeZone;
    card.appendChild(el("p", "artifact-meta", `${artifact.filename} · Expires ${formatLocalDateTime(artifact.expiresAt, timeZone)}`));
  }
  // One-click undo for a reversible creation (deletes what was just created).
  if (result.receipt.ok && result.undo) {
    const undoId = result.undo.id;
    const undoButton = el("button", "link undo", "Undo");
    undoButton.setAttribute("aria-label", `Undo ${result.receipt.action}`);
    undoButton.addEventListener("click", () => {
      runEventTask(async () => {
        undoButton.disabled = true;
        const res = (await controller.undo(undoId)) as { ok?: boolean; message?: string; receipt?: { message?: string } };
        if (!res?.ok) {
          undoButton.disabled = false;
          showError(undoFailureMessage(res));
          return;
        }
        const done = el("span", "undo-done");
        done.appendChild(svgIcon(ICON_CHECK));
        done.appendChild(document.createTextNode("Undone"));
        undoButton.replaceWith(done);
        // Replacing the focused button with a non-focusable span drops focus to
        // <body>; return it to a stable target (the composer) like Confirm/Cancel.
        deps.returnFocus?.();
        card.appendChild(el("p", "sr-only", "Undo complete"));
      }, () => {
        undoButton.disabled = false;
        showError("Couldn't undo — please try again.");
      });
    });
    card.appendChild(undoButton);
  }
  // Collapsible raw-receipt disclosure (mono, height-capped, scrolls inside).
  detailsSeq += 1;
  const body = el("div", "details-body");
  body.id = `receipt-details-${detailsSeq}`;
  body.appendChild(el("pre", undefined, JSON.stringify(result.receipt, null, 2)));
  const toggle = el("button", "link details-toggle");
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

/** Passive durable-operation card. It deliberately contains no controls. */
export function renderOperationCard(operation: OperationCardData): HTMLElement {
  const card = el("div", "operation-card");
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", `Operation ${operation.status}: ${operation.actionName}`);
  const head = el("div", "receipt-head");
  head.appendChild(el("strong", undefined, operation.status.replaceAll("_", " ")));
  head.appendChild(el("span", "action", operation.actionName));
  card.appendChild(head);
  if (operation.steps?.length) {
    const list = el("ul", "operation-steps");
    for (const step of operation.steps) {
      list.appendChild(el("li", undefined, `${step.name || step.planStepId}: ${step.status.replaceAll("_", " ")}`));
    }
    card.appendChild(list);
  }
  if (operation.stepsTruncated) card.appendChild(el("p", "warning", "Additional operation steps are not shown."));
  if (operation.reconciliation) {
    const state = operation.reconciliation.authoritative === true
      ? "Read-only reconciliation found authoritative evidence."
      : "Read-only reconciliation did not establish the outcome.";
    card.appendChild(el("p", "operation-reconciliation", operation.reconciliation.reason ? `${state} ${operation.reconciliation.reason}` : state));
  }
  return card;
}

/** Dependencies `renderPreview` needs from the host `mount`. */
export interface PreviewDeps {
  controller: ChatController;
  showError: (message: string) => void;
  appendMessage: (role: string, text: string) => void;
  /** Render follow-up results from a resumed agentic turn (receipts, even a CHAINED preview). */
  renderResults: (results: ChatResult[]) => void;
  /**
   * Re-fetch GET /api/chat/history — used by the stale-nonce re-arm path so a tab
   * whose nonce was rotated by another tab can pull the re-served LIVE pending
   * (rotated nonce) and re-render its card. Optional: absent ⇒ a stale confirm
   * just surfaces an honest error (the prior dead-end behavior).
   */
  getHistory?: () => Promise<HistoryResponse>;
  /**
   * Move keyboard focus to a stable location (the composer input) after a
   * Confirm/Cancel click removes this card — otherwise focus collapses to
   * <body> and the next Tab restarts from the page top (WCAG 2.4.3 Focus Order,
   * r1-ux-copy-a11y-04). Mount points it at `input.focus()`, mirroring the
   * post-turn focus return on the chat path. Optional: absent ⇒ removal only.
   */
  returnFocus?: () => void;
  /**
   * Toggle the chat's "working" affordance (the typing bubble + the polite
   * "Assistant is working…" announcement) around a confirmed risky write's
   * durable resume — that resume can run 30-120s and used to run invisibly
   * (r1-ux-copy-a11y-03). Mount points these at the SAME `setWorking` /
   * `setStatusLabel` the chat path uses, so the confirm-resume is symmetric
   * with a normal turn. Optional: absent ⇒ the resume runs without the
   * affordance (the prior behavior; the streamed receipt still renders first).
   */
  setWorking?: (working: boolean) => void;
  /** Show the latest streamed per-step progress label (e.g. "Adding the line item"). */
  setStatusLabel?: (label: string) => void;
}

/** What `buildPreviewHeader` returns: the header element + the advisory-countdown pieces. */
interface PreviewHeader {
  head: HTMLElement;
  /** The ticking pill (absent when nothing has an expiry). */
  countdown: HTMLElement | undefined;
  /** Earliest deadline across the batch (the one honest clock). */
  minExpiry: string | undefined;
  /** The expiry view at render time (drives the initial expired/ticking branch). */
  initialView: ReturnType<typeof expiryView>;
}

/**
 * Header: what's pending, how risky, and how long the one-use preview lasts. A
 * batch shows its earliest deadline — one card, one Confirm all, one honest
 * clock. The countdown is ADVISORY (the server's TTL stays authoritative); a
 * ticking live region would be hostile, so it is aria-hidden.
 */
function buildPreviewHeader(previews: PreviewResult[]): PreviewHeader {
  const batch = previews.length > 1;
  const head = el("div", "preview-head");
  head.appendChild(svgIcon(ICON_CLOCK));
  head.appendChild(
    el("strong", undefined, batch ? `${previews.length} changes awaiting confirmation` : previews[0].preview.actionLabel),
  );
  for (const risk of [...new Set(previews.flatMap((p) => p.preview.riskLabels ?? []))]) {
    head.appendChild(el("span", `badge risk${risk === "destructive" ? " risk-destructive" : ""}`, risk.split("_").join(" ")));
  }
  const expiries = previews.map((p) => p.expiresAt).filter((e): e is string => typeof e === "string");
  const minExpiry = expiries.length > 0 ? expiries.reduce((a, b) => (a < b ? a : b)) : undefined;
  const initialView = expiryView(minExpiry, Date.now());
  let countdown: HTMLElement | undefined;
  if (initialView) {
    countdown = el("span", "countdown", initialView.label);
    countdown.setAttribute("aria-hidden", "true"); // a ticking live region would be hostile
    head.appendChild(countdown);
  }
  return { head, countdown, minExpiry, initialView };
}

/**
 * The expiry lifecycle, ADVISORY only (the server re-checks regardless — a stale
 * click gets its verbatim 400 expired / 409 already-used message). Ticks once a
 * second while the card is connected; at zero the buttons die and the card says
 * why. Returns the `stopTimer` the confirm/cancel paths call so the interval is
 * cleared on every settle/removal path (it also self-cleans once the card leaves
 * the DOM). The shared mutable state — `card`, `head`'s `countdown`, `minExpiry`,
 * and `setButtons` — is threaded in explicitly.
 */
function attachExpiryCountdown(
  card: HTMLElement,
  countdown: HTMLElement | undefined,
  minExpiry: string | undefined,
  initialView: ReturnType<typeof expiryView>,
  setButtons: (disabled: boolean) => void,
): () => void {
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
  return stopTimer;
}

/**
 * The mutable state the confirm wiring threads between the stale-rearm helper and
 * the single-confirm removeCard guard. `rearmed` becomes true once the stale-
 * nonce re-arm has re-rendered a fresh card for this preview — the post-stream
 * cleanup must then leave THIS (now-defunct) card alone instead of double-
 * removing / racing the re-armed replacement.
 */
interface ConfirmWiringState {
  rearmed: boolean;
}

/**
 * r1-concurrency-races-02: this tab's nonce was rotated by another tab's session
 * restore, so the confirm 400'd on a STILL-pending preview. Re-fetch history,
 * re-render the re-served card (its rotated nonce re-arms THIS tab), and retire
 * the stale card — the admin keeps a working Confirm/Cancel right where they're
 * looking, instead of a dead card. The preview was NOT burned (the route rejects
 * pre-commit), so the re-served nonce will validate. With no still-pending match
 * (another tab confirmed/cancelled it, or it expired) or no re-fetch path, the
 * honest reason surfaces and the buttons re-enable — never a loop.
 */
function handleStaleRearm(
  message: string,
  card: HTMLElement,
  refs: PreviewRef[],
  state: ConfirmWiringState,
  stopTimer: () => void,
  setButtons: (disabled: boolean) => void,
  deps: PreviewDeps,
): void {
  const { getHistory, renderResults, appendMessage, showError } = deps;
  void (async () => {
    const previewId = refs[0]?.previewId;
    let reserved: PreviewResult | undefined;
    if (getHistory && previewId) {
      try {
        reserved = reservedPendingFor(await getHistory(), previewId);
      } catch {
        reserved = undefined; // a failed re-fetch falls through to the honest error
      }
    }
    if (reserved) {
      state.rearmed = true;
      stopTimer();
      card.remove();
      renderResults([reserved]);
      appendMessage("assistant", "This card was refreshed in another window — please confirm it again.");
    } else {
      // No longer pending (another tab confirmed/cancelled it, or it expired)
      // or no re-fetch path — surface the honest reason, don't loop.
      showError(message);
      setButtons(false);
    }
  })().catch(() => {
    showError(message);
    setButtons(false);
  });
}

/**
 * Wire the batch "Confirm all" click. Batch is single-turn only (agentic mode
 * interrupts at the first risky write, so it never produces a batch) — plain
 * JSON, settled truthfully: a failed confirm shows its message, never
 * "Confirmed." The card stays as the settled record (one ✓/✗ row per item, the
 * server's message verbatim on failures) so a partial batch shows exactly WHICH
 * item failed and why, not just "1 of 2".
 */
function wireBatchConfirm(
  confirmButton: HTMLButtonElement,
  previews: PreviewResult[],
  refs: PreviewRef[],
  card: HTMLElement,
  actions: HTMLElement,
  countdown: HTMLElement | undefined,
  setButtons: (disabled: boolean) => void,
  stopTimer: () => void,
  confirmHooks: ConfirmHooks,
  deps: PreviewDeps,
): void {
  const { controller, showError } = deps;
  confirmButton.addEventListener("click", () => {
    runEventTask(async () => {
      // One-use: neither button may fire again (or cross-fire) once clicked.
      setButtons(true);
      const responses = await controller.confirmAll(refs);
      stopTimer();
      const list = el("div", "batch-outcomes");
      for (const outcome of batchItemOutcomes(previews.map((p) => p.preview.actionLabel), responses)) {
        const row = el("div", `batch-outcome ${outcome.status === "partial" ? "partial" : outcome.ok ? "ok" : "failed"}`);
        row.appendChild(svgIcon(outcome.status === "partial" ? ICON_ALERT : outcome.ok ? ICON_CHECK : ICON_X));
        row.appendChild(el("span", undefined, outcome.label));
        row.appendChild(el("span", "detail", outcome.detail));
        list.appendChild(row);
      }
      actions.replaceWith(list);
      countdown?.remove(); // the deadline no longer applies to a settled card
      card.classList.add("settled");
      settleConfirmOutcome(responses, confirmHooks);
    }, () => {
      showError("Confirmation failed.");
      setButtons(false);
    });
  });
}

/**
 * Wire the single Confirm click (one preview).
 *
 * Confirm STREAMS: the committed receipt renders immediately (the button never
 * feels dead), then the durable resume streams its continuation — receipts, a
 * chained preview, and the truthful reply — as it runs. The card is removed
 * LAZILY on the first non-stale outcome (not up-front): a stale-nonce 400
 * (another tab rotated this preview's nonce) must NOT lose the card — onStale
 * re-arms it in place. A real receipt/reply/error removes it exactly as before
 * (the button still never feels dead). If the whole stream is a single stale
 * event, `state.rearmed` is set and the card is kept.
 */
function wireSingleConfirm(
  confirmButton: HTMLButtonElement,
  refs: PreviewRef[],
  card: HTMLElement,
  state: ConfirmWiringState,
  setButtons: (disabled: boolean) => void,
  stopTimer: () => void,
  confirmHooks: ConfirmHooks,
  deps: PreviewDeps,
): void {
  const { controller, returnFocus, setWorking, setStatusLabel, showError } = deps;
  confirmButton.addEventListener("click", () => {
    runEventTask(async () => {
      // One-use: neither button may fire again (or cross-fire) once clicked.
      setButtons(true);
      stopTimer();
      const removeCard = (): void => {
        if (!state.rearmed) {
          removeCardReturningFocus(() => card.remove(), () => returnFocus?.());
        }
      };
      await runConfirmStreamLive(controller, refs[0], confirmHooks, {
        onWorking: (working) => setWorking?.(working),
        onStatus: (label) => setStatusLabel?.(label),
        removeCard,
      });
    }, () => {
      showError("Confirmation failed.");
      setButtons(false);
    });
  });
}

/**
 * Wire the Cancel click — shared by the batch ("Cancel all") and single paths,
 * since the cancel logic is identical (it maps over EVERY ref). A 409/403/404
 * comes back as `{ ok:false, message }` (only a 401 throws) — inspect it instead
 * of assuming success, so a concurrent-confirm never reads a false "Cancelled."
 */
function wireCancel(
  cancelButton: HTMLButtonElement,
  refs: PreviewRef[],
  card: HTMLElement,
  setButtons: (disabled: boolean) => void,
  stopTimer: () => void,
  deps: PreviewDeps,
): void {
  const { controller, showError, appendMessage, returnFocus } = deps;
  cancelButton.addEventListener("click", () => {
    runEventTask(async () => {
      setButtons(true);
      // controller.cancel resolves the route's JSON body (only a 401 throws). A
      // 409/403/404 comes back as { ok:false, message } — inspect it instead of
      // assuming success, so a concurrent-confirm never reads a false "Cancelled."
      const outcomes = (await Promise.all(
        refs.map((ref) => controller.cancel(ref.previewId)),
      )) as Array<{ ok?: boolean; message?: string } | null | undefined>;
      const result = cancelOutcome(outcomes);
      if (!result.ok) {
        showError(result.error);
        setButtons(false);
        return;
      }
      stopTimer();
      removeCardReturningFocus(() => card.remove(), () => returnFocus?.());
      appendMessage("assistant", "Cancelled.");
    }, () => {
      showError("Cancel failed.");
      setButtons(false);
    });
  });
}

/**
 * Assemble the preview card: header (buildPreviewHeader), the per-preview detail
 * blocks, the advisory countdown lifecycle (attachExpiryCountdown), and the
 * Confirm/Cancel wiring (batch vs single). Behavior is byte-identical to the
 * former monolith — the extracted builders thread the shared mutable state
 * (card, countdown, minExpiry, setButtons, refs, stopTimer, the rearmed flag)
 * explicitly. SAFETY preserved: button-only confirm, one-use setButtons
 * disabling, lazy card removal via the rearmed guard, the stale-nonce re-arm-in-
 * place, and the advisory-only countdown (server TTL authoritative).
 */
export function renderPreview(previews: PreviewResult[], deps: PreviewDeps): HTMLElement {
  const { appendMessage, renderResults, showError, setStatusLabel } = deps;
  const batch = previews.length > 1;
  const card = el("div", "preview-card");
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", batch ? `${previews.length} changes awaiting confirmation` : "Change awaiting confirmation");

  const { head, countdown, minExpiry, initialView } = buildPreviewHeader(previews);
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
  const confirmButton = el("button", "primary", batch ? "Confirm all" : "Confirm");
  const cancelButton = el("button", "secondary", batch ? "Cancel all" : "Cancel");
  const setButtons = (disabled: boolean): void => {
    confirmButton.disabled = disabled;
    cancelButton.disabled = disabled;
  };

  const stopTimer = attachExpiryCountdown(card, countdown, minExpiry, initialView, setButtons);

  const state: ConfirmWiringState = { rearmed: false };
  const confirmHooks: ConfirmHooks = {
    onAssistant: (text) => appendMessage("assistant", text),
    onResults: renderResults,
    onError: showError,
    // r1-ux-copy-a11y-03: the durable resume streams per-step status labels; drive
    // the SAME typing-bubble label the chat path uses so they're not dropped.
    onStatus: (label) => setStatusLabel?.(label),
    onStale: (message) => handleStaleRearm(message, card, refs, state, stopTimer, setButtons, deps),
  };

  if (batch) {
    wireBatchConfirm(confirmButton, previews, refs, card, actions, countdown, setButtons, stopTimer, confirmHooks, deps);
  } else {
    wireSingleConfirm(confirmButton, refs, card, state, setButtons, stopTimer, confirmHooks, deps);
  }
  // Cancel is wired for BOTH paths (the original handler lived outside the
  // batch/single branch) — "Cancel all" maps over every ref.
  wireCancel(cancelButton, refs, card, setButtons, stopTimer, deps);
  actions.appendChild(confirmButton);
  actions.appendChild(cancelButton);
  card.appendChild(actions);
  return card;
}
