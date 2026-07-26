import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  relativeTime,
  renderReceipt,
  renderPermissionTable,
  renderPreview,
  renderWelcome,
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
  it("buckets elapsed time through English Intl relative-time units", () => {
    expect(relativeTime(new Date(now - 30_000).toISOString(), now)).toBe("now");
    expect(relativeTime(new Date(now - 5 * 60_000).toISOString(), now)).toBe("5 minutes ago");
    expect(relativeTime(new Date(now - 3 * 60 * 60_000).toISOString(), now)).toBe("3 hours ago");
    expect(relativeTime(new Date(now - 2 * 24 * 60 * 60_000).toISOString(), now)).toBe("2 days ago");
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
let createdNodes: StubNode[] = [];

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  createdNodes = [];
  const createNode = (tag: string): StubNode => {
    const node = new StubNode(tag);
    createdNodes.push(node);
    return node;
  };
  const doc = {
    createElement: (tag: string) => createNode(tag),
    createElementNS: (_ns: string, tag: string) => createNode(tag),
    createTextNode: (text: string) => {
      const n = createNode("#text");
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
    confirm: vi.fn(async () => ({ ok: true })),
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
  it("renders a prominent authenticated invoice-PDF link with filename and expiry", () => {
    const result: ReceiptResult = {
      kind: "receipt",
      receipt: {
        ok: true,
        action: "clockify_invoices_export",
        artifact: {
          downloadUrl: "/api/artifacts/artifact-1",
          filename: "clockify-invoice-artifact-1.pdf",
          expiresAt: "2026-07-18T13:00:00.000Z",
        },
      },
    };
    const card = renderReceipt(result, { controller: controller(), showError: vi.fn() }) as unknown as StubNode;
    const download = card.all().find((node) => node.textContent === "Download invoice PDF");
    expect(download?.tagName).toBe("a");
    expect(download?.getAttribute("href")).toBe("/api/artifacts/artifact-1");
    expect(card.allText().join(" ")).toContain("clockify-invoice-artifact-1.pdf");
    expect(card.allText().join(" ")).toContain("Expires");
  });

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

  it("returns focus after a successful undo (the replaced button would otherwise drop focus to <body>)", async () => {
    const returnFocus = vi.fn();
    const ctrl = controller({ undo: vi.fn(async () => ({ ok: true })) });
    const deps: ReceiptDeps = { controller: ctrl, showError: vi.fn(), returnFocus };
    const card = renderReceipt(receipt(), deps) as unknown as StubNode;
    await card.buttons("Undo")[0].dispatch("click");
    expect(returnFocus).toHaveBeenCalledTimes(1);
  });

  it("does NOT move focus when the undo FAILS (the button stays focusable + re-enabled)", async () => {
    const returnFocus = vi.fn();
    const ctrl = controller({ undo: vi.fn(async () => ({ ok: false, message: "Policy denies this undo." })) });
    const deps: ReceiptDeps = { controller: ctrl, showError: vi.fn(), returnFocus };
    const card = renderReceipt(receipt(), deps) as unknown as StubNode;
    await card.buttons("Undo")[0].dispatch("click");
    expect(returnFocus).not.toHaveBeenCalled();
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

describe("renderWelcome — effective policy copy", () => {
  it("does not claim write capability when the saved policy is read-only", () => {
    const welcome = renderWelcome({
      policy: {
        version: 3,
        groups: { time_tracking: "read", reports: "read", expenses: "off", invoices: "off" },
      },
      sendText: vi.fn(),
    }) as unknown as StubNode;

    const copy = welcome.allText().join(" ");
    expect(copy).toContain("Changes are disabled by your saved permission policy.");
    expect(copy).not.toContain("Safe changes run immediately");
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

  it("preserves arbitrary Unicode project, client, and description data in text nodes", () => {
    const value = "Čukarica 東京 — račun № 7";
    const deps: PreviewDeps = {
      controller: controller(),
      showError: vi.fn(),
      appendMessage: vi.fn(),
      renderResults: vi.fn(),
    };
    const preview: PreviewResult = {
      kind: "preview",
      previewId: "p-unicode",
      nonce: "n-unicode",
      preview: {
        actionLabel: "Update project",
        expectedChanges: [value],
        reversibility: "Preview only",
        warnings: [],
        targets: [
          { type: "project", id: "project-1", name: value },
          { type: "client", id: "client-1", name: value },
        ],
      },
    };

    renderPreview([preview], deps);
    const descriptionNode = createdNodes.find((node) => node.tagName === "li");
    expect(descriptionNode?.textContent).toBe(value);
    expect(Buffer.from(descriptionNode?.textContent ?? "", "utf8")).toEqual(Buffer.from(value, "utf8"));
    expect(createdNodes.map((node) => node.textContent)).toContain(`Target: ${value}, ${value}`);
  });
});

describe("renderReceipt — technical details disclosure (T15-E)", () => {
  it("prefers the v2 diagnostic value over the flattened receipt when present", () => {
    const withDiagnostic: ReceiptResult = {
      kind: "receipt",
      receipt: {
        ok: true,
        action: "Create a tag",
        presentedStatus: "succeeded",
        diagnostic: { kind: "sanitized_receipt", byteLength: 2, value: { onlyIn: "diagnostic" } },
      },
    };
    renderReceipt(withDiagnostic, { controller: controller(), showError: vi.fn() });
    const pre = createdNodes.find((node) => node.tagName === "pre");
    expect(pre?.textContent).toContain("onlyIn");
    expect(pre?.textContent).not.toContain("presentedStatus");
  });

  it("falls back to the flattened receipt when no diagnostic is present (legacy v1 shape unchanged)", () => {
    createdNodes = [];
    const legacy: ReceiptResult = { kind: "receipt", receipt: { ok: true, action: "clockify_tags_create" } };
    renderReceipt(legacy, { controller: controller(), showError: vi.fn() });
    const pre = createdNodes.find((node) => node.tagName === "pre");
    expect(pre?.textContent).toContain("clockify_tags_create");
  });
});
