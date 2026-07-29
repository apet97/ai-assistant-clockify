import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderPreview, type PreviewDeps } from "../../src/ui/render.js";
import type { ChatController, PreviewResult, StreamEvent } from "../../src/ui/shared.js";

/**
 * T31 — behavioral tests for the DOM-coupled preview-card safety flows that
 * type-check + build alone don't exercise: batch "Confirm all" stays ONE card,
 * Cancel is button-only and truthful, the advisory expiry countdown disables
 * Confirm at TTL, and a single-confirm stale-nonce 400 re-arms the card in place
 * (never a dead end).
 *
 * The vitest env is "node" (no DOM). This file brings a hand-written `StubNode`
 * (the repo's established convention, copied from tests/unit/ui-chats-menu.test.ts
 * and extended: an ASYNC `dispatch` that awaits each handler, a Set-backed
 * `classList`, `disabled`/`isConnected`/`removed`/`replaceWith` tracking, and a
 * `buttons(label)` helper). NO jsdom/happy-dom is added.
 */

function poisonMarkupSink(node: StubNode, prop: string): void {
  Object.defineProperty(node, prop, {
    configurable: true,
    set() {
      throw new Error(`render.ts wrote untrusted markup via ${prop} — must stay textContent-only`);
    },
    get() {
      return "";
    },
  });
}

class StubNode {
  tagName: string;
  className = "";
  textContent = "";
  type = "";
  value = "";
  disabled = false;
  id = "";
  isConnected = true; // the card is treated as "in the DOM" so the expiry tick runs
  removed = false;
  replacedWith: StubNode | undefined;
  readonly children: StubNode[] = [];
  private readonly classes = new Set<string>();
  readonly classList = {
    add: (c: string): void => {
      this.classes.add(c);
      this.syncClassName();
    },
    remove: (c: string): void => {
      this.classes.delete(c);
      this.syncClassName();
    },
    toggle: (c: string): boolean => {
      if (this.classes.has(c)) this.classes.delete(c);
      else this.classes.add(c);
      this.syncClassName();
      return this.classes.has(c);
    },
    contains: (c: string): boolean => this.classes.has(c),
  };
  private readonly attrs: Record<string, string> = {};
  private readonly handlers: Record<string, Array<(e: unknown) => unknown>> = {};

  constructor(tagName: string) {
    this.tagName = tagName.toLowerCase();
    poisonMarkupSink(this, "innerHTML");
    poisonMarkupSink(this, "outerHTML");
  }

  private syncClassName(): void {
    // Keep `className` in sync so the initial `el(tag, className)` class plus any
    // classList mutations both show up under one read.
    const base = this.className.split(/\s+/).filter((c) => c && !this.classes.has(c));
    this.className = [...base, ...this.classes].join(" ").trim();
  }

  set classNameInit(v: string) {
    this.className = v;
    for (const c of v.split(/\s+/).filter(Boolean)) this.classes.add(c);
  }

  setAttribute(name: string, val: string): void {
    this.attrs[name] = val;
  }
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  removeAttribute(name: string): void {
    delete this.attrs[name];
  }
  appendChild(child: StubNode): StubNode {
    this.children.push(child);
    return child;
  }
  addEventListener(type: string, cb: (e: unknown) => unknown): void {
    (this.handlers[type] ??= []).push(cb);
  }
  /** Fire every registered handler for `type`, awaiting async handlers. */
  async dispatch(type: string, event: unknown = {}): Promise<void> {
    for (const cb of this.handlers[type] ?? []) await cb(event);
  }
  focus(): void {
    /* no-op */
  }
  insertAdjacentHTML(): never {
    throw new Error("render.ts called insertAdjacentHTML — must stay textContent-only");
  }
  replaceWith(node: StubNode): void {
    this.replacedWith = node;
    this.removed = true;
  }
  remove(): void {
    this.removed = true;
    this.isConnected = false;
  }
  contains(node: StubNode): boolean {
    if (node === this) return true;
    return this.children.some((c) => c.contains(node));
  }

  /** Every node in this subtree (DFS, self first). */
  all(): StubNode[] {
    const out: StubNode[] = [this];
    for (const c of this.children) out.push(...c.all());
    return out;
  }
  allText(): string[] {
    const out: string[] = [];
    if (this.textContent) out.push(this.textContent);
    for (const c of this.children) out.push(...c.allText());
    return out;
  }
  /** Buttons in this subtree whose textContent equals `label`. */
  buttons(label: string): StubNode[] {
    return this.all().filter((n) => n.tagName === "button" && n.textContent === label);
  }
}

// el() sets `className` directly; route that through classNameInit so the
// Set-backed classList sees the initial classes too.
function newNode(tag: string): StubNode {
  const n = new StubNode(tag);
  Object.defineProperty(n, "className", {
    configurable: true,
    get(this: StubNode & { _cn?: string }) {
      return this._cn ?? "";
    },
    set(this: StubNode & { _cn?: string }, v: string) {
      this._cn = v;
    },
  });
  return n;
}

let nowMs = 0;
let intervalCb: (() => void) | undefined;
const originalDocument = (globalThis as Record<string, unknown>).document;
const originalWindow = (globalThis as Record<string, unknown>).window;

beforeEach(() => {
  nowMs = 1_000_000;
  intervalCb = undefined;
  vi.spyOn(Date, "now").mockImplementation(() => nowMs);
  const doc = {
    createElement: (tag: string) => newNode(tag),
    createElementNS: (_ns: string, tag: string) => newNode(tag),
    createTextNode: (text: string) => {
      const n = newNode("#text");
      n.textContent = text;
      return n;
    },
  };
  (globalThis as Record<string, unknown>).document = doc;
  (globalThis as Record<string, unknown>).window = {
    setInterval: (cb: () => void) => {
      intervalCb = cb;
      return 1;
    },
    clearInterval: () => {
      intervalCb = undefined;
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  (globalThis as Record<string, unknown>).document = originalDocument;
  (globalThis as Record<string, unknown>).window = originalWindow;
});

function preview(over: Partial<PreviewResult> = {}): PreviewResult {
  return {
    kind: "preview",
    previewId: over.previewId ?? "p1",
    nonce: over.nonce ?? "n1",
    expiresAt: over.expiresAt,
    preview: {
      actionLabel: "Delete tag urgent",
      expectedChanges: ["Delete tag urgent"],
      reversibility: "Reversible",
      warnings: [],
      ...(over.preview ?? {}),
    },
  };
}

function recordingController(over: Partial<ChatController> = {}): ChatController {
  return {
    send: vi.fn(async () => ({})),
    confirm: vi.fn(async () => ({ ok: true })),
    confirmStream: vi.fn(async () => {}),
    confirmAll: vi.fn(async () => []),
    cancel: vi.fn(async () => ({ ok: true })),
    cancelBatch: vi.fn(async () => ({ ok: true })),
    undo: vi.fn(async () => ({})),
    savePermissions: vi.fn(async () => ({})),
    getPermissions: vi.fn(async () => ({})),
    ...over,
  };
}

function previewDeps(controller: ChatController, over: Partial<PreviewDeps> = {}): PreviewDeps {
  return {
    controller,
    showError: vi.fn(),
    appendMessage: vi.fn(),
    renderResults: vi.fn(),
    ...over,
  };
}

describe("renderPreview — batch 'Confirm all' stays ONE card", () => {
  it("shows one Confirm all + one Cancel all (no single Confirm) and confirms BOTH refs in one card", async () => {
    const confirmAll = vi.fn(async () => [{ ok: true }, { ok: true }]);
    const controller = recordingController({ confirmAll });
    const deps = previewDeps(controller);
    const card = renderPreview([preview({ previewId: "p1", nonce: "n1" }), preview({ previewId: "p2", nonce: "n2" })], deps) as unknown as StubNode;

    expect(card.buttons("Confirm all")).toHaveLength(1);
    expect(card.buttons("Cancel all")).toHaveLength(1);
    expect(card.buttons("Confirm")).toHaveLength(0); // never a per-item Confirm

    await card.buttons("Confirm all")[0].dispatch("click");

    expect(confirmAll).toHaveBeenCalledTimes(1);
    expect(confirmAll).toHaveBeenCalledWith([
      { previewId: "p1", nonce: "n1" },
      { previewId: "p2", nonce: "n2" },
    ]);
    expect(card.removed).toBe(false); // card stays as the settled record
    expect(card.classList.contains("settled")).toBe(true);
    expect(controller.confirmStream).not.toHaveBeenCalled(); // batch is JSON, not the stream path
    expect(controller.send).not.toHaveBeenCalled();
  });
});

describe("renderPreview — Cancel is button-only and truthful", () => {
  it("an ok cancel removes the card and posts 'Cancelled.' (never via send)", async () => {
    const cancel = vi.fn(async () => ({ ok: true }));
    const controller = recordingController({ cancel });
    const appendMessage = vi.fn();
    const card = renderPreview([preview()], previewDeps(controller, { appendMessage })) as unknown as StubNode;

    await card.buttons("Cancel")[0].dispatch("click");

    expect(cancel).toHaveBeenCalledWith("p1");
    expect(controller.send).not.toHaveBeenCalled();
    expect(card.removed).toBe(true);
    expect(appendMessage).toHaveBeenCalledWith("assistant", "Cancelled.");
  });

  it("a {ok:false} cancel KEEPS the card, re-enables buttons, surfaces the reason, no false 'Cancelled.'", async () => {
    const cancel = vi.fn(async () => ({ ok: false, code: "conflict", message: "Already confirmed in another tab." }));
    const controller = recordingController({ cancel });
    const showError = vi.fn();
    const appendMessage = vi.fn();
    const card = renderPreview([preview()], previewDeps(controller, { showError, appendMessage })) as unknown as StubNode;
    const cancelButton = card.buttons("Cancel")[0];

    await cancelButton.dispatch("click");

    expect(card.removed).toBe(false);
    expect(cancelButton.disabled).toBe(false); // re-enabled
    expect(showError).toHaveBeenCalledWith("Already confirmed in another tab.");
    expect(appendMessage).not.toHaveBeenCalledWith("assistant", "Cancelled.");
  });
});

describe("renderPreview — advisory expiry disables Confirm at TTL", () => {
  it("an already-expired preview renders .expired with both buttons disabled", () => {
    const controller = recordingController();
    const card = renderPreview(
      [preview({ expiresAt: new Date(nowMs - 1000).toISOString() })],
      previewDeps(controller),
    ) as unknown as StubNode;

    expect(card.classList.contains("expired")).toBe(true);
    expect(card.buttons("Confirm")[0].disabled).toBe(true);
    expect(card.buttons("Cancel")[0].disabled).toBe(true);
  });

  it("a live preview flips to .expired + Confirm disabled when its tick crosses the deadline", () => {
    const controller = recordingController();
    const card = renderPreview(
      [preview({ expiresAt: new Date(nowMs + 5000).toISOString() })],
      previewDeps(controller),
    ) as unknown as StubNode;

    expect(card.classList.contains("expired")).toBe(false);
    expect(card.buttons("Confirm")[0].disabled).toBe(false);
    expect(intervalCb).toBeDefined();

    nowMs += 6000; // cross the deadline
    intervalCb!();

    expect(card.classList.contains("expired")).toBe(true);
    expect(card.buttons("Confirm")[0].disabled).toBe(true);
  });
});

describe("renderPreview — single Confirm stale-nonce re-arm keeps the card", () => {
  it("re-fetches the re-served pending, re-renders it, posts a refresh note, and shows NO dead-end error", async () => {
    const reserved = preview({ previewId: "p1", nonce: "rotated-nonce" });
    let signalRendered!: () => void;
    const rendered = new Promise<void>((resolve) => {
      signalRendered = resolve;
    });
    const confirmStream = vi.fn(async (_ref: unknown, onEvent: (e: StreamEvent) => void) => {
      onEvent({ type: "error", code: "invalid_confirmation", message: "This preview was refreshed elsewhere." });
    });
    const controller = recordingController({ confirmStream });
    const renderResults = vi.fn((_results: unknown) => signalRendered());
    const appendMessage = vi.fn();
    const showError = vi.fn();
    const getHistory = vi.fn(async () => ({ pendingPreviews: [reserved] }));
    const card = renderPreview(
      [preview({ previewId: "p1", nonce: "n1" })],
      previewDeps(controller, { renderResults, appendMessage, showError, getHistory }),
    ) as unknown as StubNode;

    await card.buttons("Confirm")[0].dispatch("click");
    await rendered; // the non-awaited stale-rearm IIFE reached its observable end state

    expect(getHistory).toHaveBeenCalledTimes(1);
    expect(renderResults).toHaveBeenCalledTimes(1);
    expect(renderResults.mock.calls[0][0]).toEqual([reserved]); // the re-served (rotated-nonce) pending
    expect(appendMessage).toHaveBeenCalledTimes(1);
    expect(String(appendMessage.mock.calls[0][1])).toMatch(/another window/i);
    expect(showError).not.toHaveBeenCalled(); // never a dead end
  });
});
