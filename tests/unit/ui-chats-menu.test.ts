import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderChatsMenu, type ChatSessionSummary } from "../../src/ui/render.js";

/**
 * Phase 5 — the "Chats" history-switcher dropdown builder.
 *
 * Two safety/a11y contracts this pins:
 *  - Session TITLES are the first USER message = untrusted workspace data. They
 *    MUST render via `textContent` (the repo's XSS convention) — never innerHTML.
 *    A title carrying `<img …>` markup proves it stays inert text, not parsed
 *    into an element node.
 *  - The menu is a WCAG menu widget: a toggle button with
 *    `aria-haspopup="menu"`/`aria-expanded`, a `role="menu"` list whose items are
 *    `role="menuitem"` buttons, the CURRENT session marked `aria-current="true"`,
 *    keyboard nav (Enter/Space select, Escape closes, Arrow Up/Down move focus),
 *    and an empty-state item when there are no past conversations.
 *
 * The vitest env is "node" (no DOM); this file brings a minimal stub `document`/
 * `window` (the same approach as `ui-render-xss.test.ts`) extended to FIRE the
 * registered click/keydown handlers and TRACK focus, so the select + keyboard
 * behavior is exercised without pulling in jsdom/happy-dom. Markup sinks
 * (`innerHTML`/`outerHTML`/`insertAdjacentHTML`) are POISONED (throw on any use).
 */

const XSS = '<img src=x onerror=alert(1)>';

/** A poisoned markup-sink setter: any write means the builder left textContent. */
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

interface StubEvent {
  type: string;
  key?: string;
  defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

function makeEvent(type: string, key?: string): StubEvent {
  return {
    type,
    key,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      /* no-op */
    },
  };
}

let focusedNode: StubNode | undefined;

class StubNode {
  tagName: string;
  className = "";
  textContent = "";
  type = "";
  value = "";
  disabled = false;
  id = "";
  tabIndex = 0;
  isConnected = false;
  hidden = false;
  readonly children: StubNode[] = [];
  readonly classList = { add() {}, remove() {}, toggle: () => false, contains: () => false };
  private readonly attrs: Record<string, string> = {};
  private readonly handlers: Record<string, Array<(e: StubEvent) => void>> = {};

  constructor(tagName: string) {
    this.tagName = tagName.toLowerCase();
    poisonMarkupSink(this, "innerHTML");
    poisonMarkupSink(this, "outerHTML");
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
  addEventListener(type: string, cb: (e: StubEvent) => void): void {
    (this.handlers[type] ??= []).push(cb);
  }
  /** Fire every registered handler for `type` on THIS node (no bubbling needed). */
  dispatch(event: StubEvent): void {
    for (const cb of this.handlers[event.type] ?? []) cb(event);
  }
  focus(): void {
    focusedNode = this;
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
  contains(node: StubNode): boolean {
    if (node === this) return true;
    return this.children.some((c) => c.contains(node));
  }
  querySelectorAll(selector: string): StubNode[] {
    // Only the role-based selectors the builder/test use are honored.
    const roleMatch = /\[role="([^"]+)"\]/.exec(selector);
    const out: StubNode[] = [];
    const walk = (n: StubNode): void => {
      if (roleMatch && n.getAttribute("role") === roleMatch[1]) out.push(n);
      for (const c of n.children) walk(c);
    };
    for (const c of this.children) walk(c);
    return out;
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
  /** Every node in this subtree (DFS, self first). */
  all(): StubNode[] {
    const out: StubNode[] = [this];
    for (const c of this.children) out.push(...c.all());
    return out;
  }
}

const originalDocument = (globalThis as Record<string, unknown>).document;
const originalWindow = (globalThis as Record<string, unknown>).window;

beforeEach(() => {
  focusedNode = undefined;
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
  (globalThis as Record<string, unknown>).window = { setInterval: () => 0, clearInterval: () => {} };
});

afterEach(() => {
  (globalThis as Record<string, unknown>).document = originalDocument;
  (globalThis as Record<string, unknown>).window = originalWindow;
});

function session(over: Partial<ChatSessionSummary> = {}): ChatSessionSummary {
  return {
    id: "s1",
    title: "First conversation",
    messageCount: 4,
    lastMessageAt: new Date(Date.now() - 60_000).toISOString(),
    createdAt: new Date(Date.now() - 120_000).toISOString(),
    current: false,
    ...over,
  };
}

/** Build the menu and return its root + the menuitem buttons. */
function build(sessions: ChatSessionSummary[], onSelect: (id: string) => void) {
  const root = renderChatsMenu(sessions, { onSelect }) as unknown as StubNode;
  const menu = root.all().find((n) => n.getAttribute("role") === "menu");
  const items = menu ? menu.querySelectorAll('[role="menuitem"]') : [];
  return { root, menu, items };
}

describe("renderChatsMenu (chat-history dropdown — accessible, textContent-safe)", () => {
  it("renders one menuitem per session inside a role=menu with a toggle button", () => {
    const sessions = [session({ id: "a", title: "Alpha" }), session({ id: "b", title: "Beta" })];
    const { root, menu, items } = build(sessions, () => {});

    // A toggle button announces a menu popup.
    const toggle = root.all().find((n) => n.getAttribute("aria-haspopup") === "menu");
    expect(toggle).toBeDefined();
    expect(toggle!.getAttribute("aria-expanded")).toBe("false");

    expect(menu).toBeDefined();
    expect(items).toHaveLength(2);
    for (const item of items) expect(item.tagName).toBe("button");
  });

  it("renders untrusted titles via textContent — markup stays inert, never parsed", () => {
    const { root, items } = build([session({ id: "x", title: `Trip ${XSS}` })], () => {});
    // The hostile title is present verbatim as text ...
    expect(items[0].allText().some((t) => t.includes(`Trip ${XSS}`))).toBe(true);
    // ... and was NEVER parsed into an <img>/<script> element node anywhere.
    const tags = root.allTags();
    expect(tags).not.toContain("img");
    expect(tags).not.toContain("script");
  });

  it("marks the current session with aria-current and leaves others unmarked", () => {
    const sessions = [
      session({ id: "a", title: "Alpha", current: false }),
      session({ id: "b", title: "Beta", current: true }),
    ];
    const { items } = build(sessions, () => {});
    expect(items[0].getAttribute("aria-current")).toBeNull();
    expect(items[1].getAttribute("aria-current")).toBe("true");
  });

  it("fires onSelect with the session id when a non-current item is clicked", () => {
    const picked: string[] = [];
    const sessions = [session({ id: "a", current: true }), session({ id: "b", current: false })];
    const { items } = build(sessions, (id) => picked.push(id));

    items[1].dispatch(makeEvent("click"));
    expect(picked).toEqual(["b"]);
  });

  it("does NOT fire onSelect for the current session (already open)", () => {
    const picked: string[] = [];
    const sessions = [session({ id: "a", current: true }), session({ id: "b", current: false })];
    const { items } = build(sessions, (id) => picked.push(id));

    items[0].dispatch(makeEvent("click"));
    expect(picked).toEqual([]);
  });

  it("selects on Enter and Space via keydown", () => {
    const picked: string[] = [];
    const sessions = [session({ id: "a", current: true }), session({ id: "b", current: false })];
    const { items } = build(sessions, (id) => picked.push(id));

    const enter = makeEvent("keydown", "Enter");
    items[1].dispatch(enter);
    expect(picked).toEqual(["b"]);
    expect(enter.defaultPrevented).toBe(true);

    const space = makeEvent("keydown", " ");
    items[1].dispatch(space);
    expect(picked).toEqual(["b", "b"]);
    expect(space.defaultPrevented).toBe(true);
  });

  it("Arrow Down / Arrow Up move focus between menuitems", () => {
    const sessions = [session({ id: "a", title: "A" }), session({ id: "b", title: "B" })];
    const { items } = build(sessions, () => {});

    items[0].dispatch(makeEvent("keydown", "ArrowDown"));
    expect(focusedNode).toBe(items[1]);

    items[1].dispatch(makeEvent("keydown", "ArrowUp"));
    expect(focusedNode).toBe(items[0]);
  });

  it("Escape collapses the menu (toggle returns to aria-expanded=false)", () => {
    const sessions = [session({ id: "a" })];
    const { root, items } = build(sessions, () => {});
    const toggle = root.all().find((n) => n.getAttribute("aria-haspopup") === "menu")!;

    // Open it first (so collapse is observable).
    toggle.dispatch(makeEvent("click"));
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    items[0].dispatch(makeEvent("keydown", "Escape"));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows a 'No past conversations' empty-state item when the list is empty", () => {
    const { menu } = build([], () => {});
    expect(menu).toBeDefined();
    expect(menu!.allText().some((t) => /no past conversations/i.test(t))).toBe(true);
    // The empty state is not a selectable menuitem.
    expect(menu!.querySelectorAll('[role="menuitem"]')).toHaveLength(0);
  });
});
