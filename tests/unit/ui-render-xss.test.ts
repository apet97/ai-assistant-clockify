import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderClarify, renderOperationCard, renderPreview, renderReceipt } from "../../src/ui/render.js";
import type { ClarifyResult, PreviewResult, ReceiptResult } from "../../src/ui/shared.js";

/**
 * r2-injection-rendering-02 — render-XSS regression pin for the attacker-named
 * entity sinks in the preview / receipt / clarify cards.
 *
 * Threat model (CLAUDE.md): "Project names, client names ... are untrusted
 * input" — any member can name a project `<img src=x onerror=...>`. render.ts
 * documents that every card text is set via `textContent` (NEVER innerHTML), so
 * hostile names render as inert text inside the embedded admin iframe. There was
 * NO test exercising those DOM builders: a switch from textContent to innerHTML
 * anywhere in render.ts would ship silently (type-check + the vite build both
 * still pass). This pin closes that gap WITHOUT a new dependency: it installs a
 * tiny stub `document`/`window` whose nodes record `textContent` and whose
 * markup sinks (`innerHTML` / `outerHTML` / `insertAdjacentHTML`) are POISONED
 * (throw on any use). Rendering a hostile name then proves it never reaches a
 * markup-parsing sink and stays inert text.
 *
 * The vitest env is "node" (no DOM) on purpose; this file brings its own minimal
 * stub for the few APIs these three builders touch, rather than pulling in
 * jsdom/happy-dom.
 */

const XSS = '<img src=x onerror=alert(1)><script>alert(2)</script>';

/** A poisoned markup-sink setter: any write means the builder stopped using textContent. */
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
  isConnected = false;
  readonly children: StubNode[] = [];
  readonly classList = { add() {}, remove() {}, toggle: () => false };
  private readonly attrs: Record<string, string> = {};

  constructor(tagName: string) {
    this.tagName = tagName.toLowerCase();
    // If any builder ever switches a text sink to markup, these throw.
    poisonMarkupSink(this, "innerHTML");
    poisonMarkupSink(this, "outerHTML");
  }

  setAttribute(name: string, val: string): void {
    this.attrs[name] = val;
  }
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  appendChild(child: StubNode): StubNode {
    this.children.push(child);
    return child;
  }
  addEventListener(): void {
    /* no-op: builders register click handlers we never fire */
  }
  insertAdjacentHTML(): never {
    throw new Error("render.ts called insertAdjacentHTML — must stay textContent-only");
  }
  replaceWith(): void {
    /* no-op */
  }
  remove(): void {
    /* no-op */
  }
  querySelectorAll(): StubNode[] {
    return [];
  }

  /** Every text node in this subtree (DFS). */
  allText(): string[] {
    const out: string[] = [];
    if (this.textContent) out.push(this.textContent);
    for (const c of this.children) out.push(...c.allText());
    return out;
  }
  /** Tag names of every element node created in this subtree. */
  allTags(): string[] {
    const out: string[] = [this.tagName];
    for (const c of this.children) out.push(...c.allTags());
    return out;
  }
}

const originalDocument = (globalThis as Record<string, unknown>).document;
const originalWindow = (globalThis as Record<string, unknown>).window;

beforeEach(() => {
  const doc = {
    createElement: (tag: string) => new StubNode(tag),
    // SVG icons go through createElementNS; a hostile string never reaches here.
    createElementNS: (_ns: string, tag: string) => new StubNode(tag),
    // The undo/details builders append literal text nodes — model them as inert text.
    createTextNode: (text: string) => {
      const n = new StubNode("#text");
      n.textContent = text;
      return n;
    },
  };
  (globalThis as Record<string, unknown>).document = doc;
  (globalThis as Record<string, unknown>).window = { setInterval: () => 0, clearInterval: () => {} };
});

afterEach(() => {
  (globalThis as Record<string, unknown>).document = originalDocument;
  (globalThis as Record<string, unknown>).window = originalWindow;
});

describe("render-XSS: attacker-named entities render as inert text (r2-injection-rendering-02)", () => {
  it("renderPreview target / expectedChanges / warnings stay textContent-only", () => {
    const preview: PreviewResult = {
      kind: "preview",
      previewId: "p1",
      nonce: "n1",
      preview: {
        actionLabel: `Create project ${XSS}`,
        expectedChanges: [`Set name to ${XSS}`],
        reversibility: "Reversible",
        warnings: [`Heads up ${XSS}`],
        targets: [{ type: "project", id: "abc", name: XSS }],
      },
    };
    // Building must NOT throw — a throw means a markup sink (innerHTML/...) was hit.
    const card = renderPreview([preview], {
      controller: {} as never,
      showError: () => {},
      appendMessage: () => {},
      renderResults: () => {},
    }) as unknown as StubNode;

    const text = card.allText();
    // The hostile name is present verbatim as inert text (the Target line, the
    // change, the warning, and the action label all flow through el()).
    expect(text.some((t) => t.includes(`Target: ${XSS}`))).toBe(true);
    expect(text.some((t) => t.includes(`Set name to ${XSS}`))).toBe(true);
    expect(text.some((t) => t.includes(`Heads up ${XSS}`))).toBe(true);
    // ... and it was NEVER parsed into <img>/<script> element nodes.
    const tags = card.allTags();
    expect(tags).not.toContain("img");
    expect(tags).not.toContain("script");
  });

  it("renderReceipt message + warnings stay textContent-only", () => {
    const receipt: ReceiptResult = {
      kind: "receipt",
      receipt: {
        ok: true,
        action: `delete ${XSS}`,
        message: `Deleted ${XSS}`,
        warnings: [{ message: `Skipped ${XSS}` }],
      },
    };
    const card = renderReceipt(receipt, {
      controller: {} as never,
      showError: () => {},
    }) as unknown as StubNode;

    const text = card.allText();
    expect(text.some((t) => t.includes(`Deleted ${XSS}`))).toBe(true);
    expect(text.some((t) => t.includes(`Skipped ${XSS}`))).toBe(true);
    const tags = card.allTags();
    expect(tags).not.toContain("img");
    expect(tags).not.toContain("script");
  });

  it("renderClarify message + option labels stay textContent-only", () => {
    const clarify: ClarifyResult = {
      kind: "clarify",
      message: `Did you mean ${XSS}?`,
      options: [{ id: "o1", label: `Project ${XSS}` }],
    };
    const card = renderClarify(clarify, { sendText: () => {} }) as unknown as StubNode;

    const text = card.allText();
    expect(text.some((t) => t.includes(`Did you mean ${XSS}?`))).toBe(true);
    expect(text.some((t) => t.includes(`Project ${XSS}`))).toBe(true);
    const tags = card.allTags();
    expect(tags).not.toContain("img");
    expect(tags).not.toContain("script");
  });

  it("renders passive operation cards with hostile action/step/reconciliation text via textContent", () => {
    const card = renderOperationCard({
      id: "operation-1",
      actionName: XSS,
      status: "outcome_unknown",
      steps: [{ planStepId: "step-1", name: XSS, status: "outcome_unknown" }],
      reconciliation: { authoritative: false, reason: XSS },
    }) as unknown as StubNode;
    expect(card.allText()).toContain(XSS);
    expect(card.allTags()).not.toContain("script");
    expect(card.allTags()).not.toContain("img");
    expect(card.allTags()).not.toContain("button");
  });
});
