import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  relativeTime,
  renderReceipt,
  renderPermissionTable,
  renderPreview,
  type ReceiptDeps,
  type PreviewDeps,
} from "../../src/ui/render.js";
import type { ChatController, PreviewResult, ReceiptResult } from "../../src/ui/shared.js";

/**
 * T70 — a few cheap UI gaps after T31: the pure `relativeTime` buckets, the
 * receipt Undo button outcomes, the permission-table save lifecycle, and the
 * a11y `aria-hidden` on the advisory countdown pill. DOM-coupled cases reuse the
 * same hand-written StubNode convention (no jsdom).
 */

describe("relativeTime (pure)", () => {
  const now = 1_000_000_000_000;
  it("buckets elapsed time into just-now / m / h / d", () => {
    expect(relativeTime(new Date(now - 30_000).toISOString(), now)).toBe("just now");
    expect(relativeTime(new Date(now - 5 * 60_000).toISOString(), now)).toBe("5m ago");
    expect(relativeTime(new Date(now - 3 * 60 * 60_000).toISOString(), now)).toBe("3h ago");
    expect(relativeTime(new Date(now - 2 * 24 * 60 * 60_000).toISOString(), now)).toBe("2d ago");
  });
  it("returns '' for an unparseable date", () => {
    expect(relativeTime("not-a-date", now)).toBe("");
  });
});

// --- DOM-coupled: a minimal StubNode (same convention as ui-preview-card) ----

class StubNode {
  tagName: string;
  className = "";
  textContent = "";
  type = "";
  value = "";
  disabled = false;
  id = "";
  isConnected = true;
  removed = false;
  replacedWith: StubNode | undefined;
  selected = false;
  readonly children: StubNode[] = [];
  private readonly classes = new Set<string>();
  readonly classList = {
    add: (c: string): void => void this.classes.add(c),
    remove: (c: string): void => void this.classes.delete(c),
    toggle: (c: string): boolean => {
      if (this.classes.has(c)) this.classes.delete(c);
      else this.classes.add(c);
      return this.classes.has(c);
    },
    contains: (c: string): boolean => this.classes.has(c),
  };
  private readonly attrs: Record<string, string> = {};
  private readonly handlers: Record<string, Array<(e: unknown) => unknown>> = {};

  constructor(tagName: string) {
    this.tagName = tagName.toLowerCase();
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
  async dispatch(type: string, event: unknown = {}): Promise<void> {
    for (const cb of this.handlers[type] ?? []) await cb(event);
  }
  focus(): void {
    /* no-op */
  }
  replaceWith(node: StubNode): void {
    this.replacedWith = node;
    this.removed = true;
  }
  remove(): void {
    this.removed = true;
    this.isConnected = false;
  }
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
  buttons(label: string): StubNode[] {
    return this.all().filter((n) => n.tagName === "button" && n.textContent === label);
  }
}

const originalDocument = (globalThis as Record<string, unknown>).document;
const originalWindow = (globalThis as Record<string, unknown>).window;

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  const doc = {
    createElement: (tag: string) => new StubNode(tag),
    createElementNS: (_ns: string, tag: string) => new StubNode(tag),
    createTextNode: (text: string) => {
      const n = new StubNode("#text");
      n.textContent = text;
      return n;
    },
  };
  (globalThis as Record<string, unknown>).document = doc;
  (globalThis as Record<string, unknown>).window = {
    setInterval: () => 1,
    clearInterval: () => {},
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  (globalThis as Record<string, unknown>).document = originalDocument;
  (globalThis as Record<string, unknown>).window = originalWindow;
});

function controller(over: Partial<ChatController> = {}): ChatController {
  return {
    send: vi.fn(async () => ({})),
    confirm: vi.fn(async () => ({})),
    confirmStream: vi.fn(async () => {}),
    confirmAll: vi.fn(async () => []),
    cancel: vi.fn(async () => ({ ok: true })),
    undo: vi.fn(async () => ({ ok: true })),
    savePermissions: vi.fn(async () => ({})),
    getPermissions: vi.fn(async () => ({})),
    ...over,
  };
}

function receipt(undoId = "u1"): ReceiptResult {
  return { kind: "receipt", receipt: { ok: true, action: "clockify_tags_create" }, undo: { id: undoId } };
}

describe("renderReceipt — Undo button", () => {
  it("an ok undo swaps the button for an 'Undone' node", async () => {
    const ctrl = controller({ undo: vi.fn(async () => ({ ok: true })) });
    const deps: ReceiptDeps = { controller: ctrl, showError: vi.fn() };
    const card = renderReceipt(receipt(), deps) as unknown as StubNode;
    const undoBtn = card.buttons("Undo")[0];
    await undoBtn.dispatch("click");
    expect(ctrl.undo).toHaveBeenCalledWith("u1");
    expect(undoBtn.removed).toBe(true);
    expect((undoBtn.replacedWith?.allText() ?? []).join("")).toContain("Undone");
  });

  it("a failed undo re-enables the button and surfaces the honest reason", async () => {
    const ctrl = controller({ undo: vi.fn(async () => ({ ok: false, message: "Policy denies this undo." })) });
    const showError = vi.fn();
    const card = renderReceipt(receipt(), { controller: ctrl, showError }) as unknown as StubNode;
    const undoBtn = card.buttons("Undo")[0];
    await undoBtn.dispatch("click");
    expect(undoBtn.disabled).toBe(false);
    expect(undoBtn.removed).toBe(false);
    expect(showError).toHaveBeenCalledWith("Policy denies this undo.");
  });
});

describe("renderPermissionTable — save button", () => {
  const policy = { version: 1, groups: { time_tracking: "read_write" } };

  it("disables during save and shows Saving… then Saved on success", async () => {
    const onSave = vi.fn(async () => true);
    const panel = renderPermissionTable(policy, onSave) as unknown as StubNode;
    const saveBtn = panel.buttons("Save permissions")[0];
    const status = panel.all().find((n) => n.getAttribute("role") === "status")!;
    await saveBtn.dispatch("click");
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(saveBtn.disabled).toBe(false); // re-enabled after
    expect(status.textContent).toBe("Saved");
  });

  it("clears the status (no 'Saved') when onSave rejects", async () => {
    const onSave = vi.fn(async () => {
      throw new Error("boom");
    });
    const panel = renderPermissionTable(policy, onSave) as unknown as StubNode;
    const saveBtn = panel.buttons("Save permissions")[0];
    const status = panel.all().find((n) => n.getAttribute("role") === "status")!;
    await saveBtn.dispatch("click");
    expect(saveBtn.disabled).toBe(false);
    expect(status.textContent).toBe("");
  });
});

describe("renderPreview — countdown a11y", () => {
  it("marks the advisory countdown pill aria-hidden (a ticking live region would be hostile)", () => {
    const deps: PreviewDeps = {
      controller: controller(),
      showError: vi.fn(),
      appendMessage: vi.fn(),
      renderResults: vi.fn(),
    };
    const preview: PreviewResult = {
      kind: "preview",
      previewId: "p1",
      nonce: "n1",
      expiresAt: new Date(1_000_000 + 5000).toISOString(),
      preview: { actionLabel: "Delete tag", expectedChanges: [], reversibility: "", warnings: [] },
    };
    const card = renderPreview([preview], deps) as unknown as StubNode;
    const countdown = card.all().find((n) => n.className === "countdown");
    expect(countdown).toBeDefined();
    expect(countdown!.getAttribute("aria-hidden")).toBe("true");
  });
});
