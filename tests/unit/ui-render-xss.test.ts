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

  it("renderReceipt facts/references/recovery stay textContent-only (T15-E)", () => {
    const receipt: ReceiptResult = {
      kind: "receipt",
      receipt: {
        ok: true,
        action: `Create tag ${XSS}`,
        message: `Created ${XSS}`,
        presentedStatus: "succeeded",
        facts: [{ label: `Name ${XSS}`, value: `Value ${XSS}` }],
        references: [{
          id: "ref-1",
          conversationId: "conv-1",
          entityType: "tag",
          externalId: "ext-1",
          displayName: `Reference ${XSS}`,
          sourceRunId: "run-1",
          bindings: {},
          status: "active",
          verifiedAt: "2026-01-01T00:00:00.000Z",
        }],
        recovery: { kind: "start_new_chat", label: `Start over ${XSS}` },
      },
    };
    const card = renderReceipt(receipt, { controller: {} as never, showError: () => {} }) as unknown as StubNode;
    const text = card.allText();
    expect(text.some((t) => t.includes(`Name ${XSS}`))).toBe(true);
    expect(text.some((t) => t.includes(`Value ${XSS}`))).toBe(true);
    expect(text.some((t) => t.includes(`Reference ${XSS}`))).toBe(true);
    expect(text.some((t) => t.includes(`Start over ${XSS}`))).toBe(true);
    const tags = card.allTags();
    expect(tags).not.toContain("img");
    expect(tags).not.toContain("script");
  });

  it("renderPreview facts/references stay textContent-only (T15-E)", () => {
    const preview: PreviewResult = {
      kind: "preview",
      previewId: "p1",
      nonce: "n1",
      preview: {
        actionLabel: "Create tag",
        expectedChanges: ["Add a tag"],
        reversibility: "Reversible",
        warnings: [],
        facts: [{ label: `Name ${XSS}`, value: `Value ${XSS}` }],
      },
      references: [{
        id: "ref-1",
        conversationId: "conv-1",
        entityType: "tag",
        externalId: "ext-1",
        displayName: `Reference ${XSS}`,
        sourceRunId: "run-1",
        bindings: {},
        status: "stale",
        verifiedAt: "2026-01-01T00:00:00.000Z",
      }],
    };
    const card = renderPreview([preview], {
      controller: {} as never,
      showError: () => {},
      appendMessage: () => {},
      renderResults: () => {},
    }) as unknown as StubNode;
    const text = card.allText();
    expect(text.some((t) => t.includes(`Name ${XSS}`))).toBe(true);
    expect(text.some((t) => t.includes(`Value ${XSS}`))).toBe(true);
    expect(text.some((t) => t.includes(`Reference ${XSS}`))).toBe(true);
    const tags = card.allTags();
    expect(tags).not.toContain("img");
    expect(tags).not.toContain("script");
  });
});

/**
 * T15-E: structured v2 status rendering. Production doesn't yet emit every
 * status (`run-event-hydration.ts`'s `chatResultToPresentation` currently
 * produces only succeeded/failed/pending_confirmation — flagged for the
 * T14-T16 review gate), so this drives the render layer directly with
 * fixture data covering all seven `PresentedResult` statuses, proving the MECHANISM
 * renders each distinctly and never derives an accessible name from a raw
 * `clockify_*` action id.
 */
describe("T15-E: structured result statuses render distinctly, never exposing a raw action id", () => {
  const CLOCKIFY_ID_PATTERN = /clockify_[a-z_]+/;
  const HUMAN_TITLE = "Create a tag";

  function receiptFor(presentedStatus: NonNullable<ReceiptResult["receipt"]["presentedStatus"]>): ReceiptResult {
    return {
      kind: "receipt",
      receipt: {
        // Mirrors the server's `chatReceiptFromEnvelope` / the client's
        // `attachmentToResults` ok-bit classification exactly.
        ok: presentedStatus === "succeeded" || presentedStatus === "partial" || presentedStatus === "no_change_needed",
        action: HUMAN_TITLE,
        message: "A human-readable summary.",
        presentedStatus,
      },
    };
  }

  const statuses = ["succeeded", "no_change_needed", "failed", "partial", "cancelled", "outcome_unknown"] as const;
  const labels: Record<(typeof statuses)[number], string> = {
    succeeded: "Done",
    no_change_needed: "No change needed",
    failed: "Failed",
    partial: "Partial — review needed",
    cancelled: "Cancelled",
    outcome_unknown: "Outcome unknown — verify in Clockify",
  };

  for (const status of statuses) {
    it(`renders a distinct label for "${status}" with no raw action id in any text`, () => {
      const card = renderReceipt(receiptFor(status), {
        controller: {} as never,
        showError: () => {},
      }) as unknown as StubNode;
      const text = card.allText();
      expect(text).toContain(labels[status]);
      for (const rendered of text) expect(rendered).not.toMatch(CLOCKIFY_ID_PATTERN);
      const ariaLabel = card.getAttribute("aria-label") ?? "";
      expect(ariaLabel).not.toMatch(CLOCKIFY_ID_PATTERN);
    });
  }

  it('a no-op WITH warnings renders "No change needed" — never "Done — with notes" (D-3)', () => {
    // The ok+warnings "Done — with notes" override must be reserved for the
    // "ok" cls; the neutral no-op card keeps its own truthful header.
    const receipt = receiptFor("no_change_needed");
    receipt.receipt.warnings = [{ message: "No running timer to stop." }];
    const card = renderReceipt(receipt, {
      controller: {} as never,
      showError: () => {},
    }) as unknown as StubNode;
    const text = card.allText();
    expect(text).toContain("No change needed");
    expect(text).toContain("No running timer to stop.");
    expect(text).not.toContain("Done — with notes");
    expect(text).not.toContain("Done");
    expect(text).not.toContain("Failed");
    expect(card.getAttribute("aria-label")).toBe(`No change needed: ${HUMAN_TITLE}`);
  });

  it("renders pending_confirmation via renderPreview with no raw action id in any text", () => {
    const preview: PreviewResult = {
      kind: "preview",
      previewId: "p1",
      nonce: "n1",
      preview: {
        actionLabel: HUMAN_TITLE,
        expectedChanges: ["A human-readable summary."],
        reversibility: "",
        warnings: [],
      },
    };
    const card = renderPreview([preview], {
      controller: {} as never,
      showError: () => {},
      appendMessage: () => {},
      renderResults: () => {},
    }) as unknown as StubNode;
    const text = card.allText();
    for (const rendered of text) expect(rendered).not.toMatch(CLOCKIFY_ID_PATTERN);
    const ariaLabel = card.getAttribute("aria-label") ?? "";
    expect(ariaLabel).not.toMatch(CLOCKIFY_ID_PATTERN);
  });
});
