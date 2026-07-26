import { describe, expect, it } from "vitest";
import { renderClarify } from "../../src/ui/render.js";
import { submitClarificationResolve, type ClarificationResolveApiLike } from "../../src/ui/composer-flow.js";
import { applyRunEventAttachment, PreviewBuffer, type ChatResult, type ClarifyResult, type StreamEvent } from "../../src/ui/shared.js";

/**
 * T14-F: v2 durable clarification UI coverage. Complements the render-XSS pin
 * (`ui-render-xss.test.ts`), which proves label text never reaches a markup
 * sink for BOTH the v1 and v2 clarify path. This file proves the two paths
 * dispatch to the RIGHT callback with the RIGHT payload (id, never label),
 * the disabled/actionable gating, and the `attachmentToResults` mapping that
 * feeds `ClarifyResult.clarificationId`/`status` from a stream event.
 *
 * Uses the same minimal `document`/`window` stub pattern as ui-render-xss so
 * `renderClarify` can build real DOM-shaped nodes without jsdom.
 */

class StubNode {
  tagName: string;
  className = "";
  textContent = "";
  type = "";
  disabled = false;
  readonly children: StubNode[] = [];
  readonly classList = { add() {}, remove() {}, toggle: () => false };
  private readonly attrs: Record<string, string> = {};
  private readonly listeners: Record<string, Array<() => void>> = {};

  constructor(tagName: string) {
    this.tagName = tagName.toLowerCase();
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
  addEventListener(type: string, handler: () => void): void {
    (this.listeners[type] ??= []).push(handler);
  }
  click(): void {
    for (const handler of this.listeners.click ?? []) handler();
  }
  querySelectorAll(selector: string): StubNode[] {
    // renderClarify only ever queries "button" within a chip row.
    if (selector !== "button") return [];
    return this.children.filter((c) => c.tagName === "button");
  }
  replaceWith(): void {}
  remove(): void {}
}

function withDomStub<T>(fn: () => T): T {
  const originalDocument = (globalThis as Record<string, unknown>).document;
  const originalWindow = (globalThis as Record<string, unknown>).window;
  (globalThis as Record<string, unknown>).document = {
    createElement: (tag: string) => new StubNode(tag),
    createElementNS: (_ns: string, tag: string) => new StubNode(tag),
    createTextNode: (text: string) => {
      const n = new StubNode("#text");
      n.textContent = text;
      return n;
    },
  };
  (globalThis as Record<string, unknown>).window = { setInterval: () => 0, clearInterval: () => {} };
  try {
    return fn();
  } finally {
    (globalThis as Record<string, unknown>).document = originalDocument;
    (globalThis as Record<string, unknown>).window = originalWindow;
  }
}

const XSS = '<img src=x onerror=alert(1)><script>alert(2)</script>';

describe("T14-F: v2 clarification chip dispatch (id, never label)", () => {
  it("a v2 clarify (clarificationId set) sends the option ID to resolveOption, never sendText", () => {
    withDomStub(() => {
      const sendTextCalls: string[] = [];
      const resolveCalls: Array<[string, string]> = [];
      const clarify: ClarifyResult = {
        kind: "clarify",
        message: "Which project?",
        options: [{ id: "opt-1", label: "Marketing Site" }],
        clarificationId: "clarification-1",
        status: "pending",
      };
      const card = renderClarify(clarify, {
        sendText: (t) => sendTextCalls.push(t),
        resolveOption: (id, optionId) => resolveCalls.push([id, optionId]),
      }) as unknown as StubNode;

      const chip = card.children[1].children[0];
      chip.click();

      expect(resolveCalls).toEqual([["clarification-1", "opt-1"]]);
      expect(sendTextCalls).toEqual([]);
    });
  });

  it("a v1 clarify (no clarificationId) sends the option LABEL via sendText, never resolveOption", () => {
    withDomStub(() => {
      const sendTextCalls: string[] = [];
      const resolveCalls: Array<[string, string]> = [];
      const clarify: ClarifyResult = {
        kind: "clarify",
        message: "Which project?",
        options: [{ id: "opt-1", label: "Marketing Site" }],
      };
      const card = renderClarify(clarify, {
        sendText: (t) => sendTextCalls.push(t),
        resolveOption: (id, optionId) => resolveCalls.push([id, optionId]),
      }) as unknown as StubNode;

      const chip = card.children[1].children[0];
      chip.click();

      expect(sendTextCalls).toEqual(["Marketing Site"]);
      expect(resolveCalls).toEqual([]);
    });
  });

  it("a resolving clarification renders every chip disabled up front", () => {
    withDomStub(() => {
      const clarify: ClarifyResult = {
        kind: "clarify",
        message: "Which project?",
        options: [
          { id: "opt-1", label: "Marketing Site" },
          { id: "opt-2", label: "Internal Tools" },
        ],
        clarificationId: "clarification-1",
        status: "resolving",
      };
      const card = renderClarify(clarify, { sendText: () => {}, resolveOption: () => {} }) as unknown as StubNode;
      const chips = card.children[1].children;
      expect(chips).toHaveLength(2);
      expect(chips.every((c) => c.disabled)).toBe(true);
    });
  });

  it("a pending v2 clarification renders chips enabled", () => {
    withDomStub(() => {
      const clarify: ClarifyResult = {
        kind: "clarify",
        message: "Which project?",
        options: [{ id: "opt-1", label: "Marketing Site" }],
        clarificationId: "clarification-1",
        status: "pending",
      };
      const card = renderClarify(clarify, { sendText: () => {}, resolveOption: () => {} }) as unknown as StubNode;
      expect(card.children[1].children[0].disabled).toBe(false);
    });
  });

  it("clicking a chip disables the entire row, including chips not clicked", () => {
    withDomStub(() => {
      const clarify: ClarifyResult = {
        kind: "clarify",
        message: "Which project?",
        options: [
          { id: "opt-1", label: "Marketing Site" },
          { id: "opt-2", label: "Internal Tools" },
        ],
        clarificationId: "clarification-1",
        status: "pending",
      };
      const card = renderClarify(clarify, { sendText: () => {}, resolveOption: () => {} }) as unknown as StubNode;
      const chips = card.children[1].children;
      chips[0].click();
      expect(chips.every((c) => c.disabled)).toBe(true);
    });
  });

  it("a hostile label with clarificationId set still stays textContent-only (never id/dispatch leaks the label)", () => {
    withDomStub(() => {
      const resolveCalls: Array<[string, string]> = [];
      const clarify: ClarifyResult = {
        kind: "clarify",
        message: `Did you mean ${XSS}?`,
        options: [{ id: "opt-1", label: `Project ${XSS}` }],
        clarificationId: "clarification-1",
        status: "pending",
      };
      const card = renderClarify(clarify, {
        sendText: () => {
          throw new Error("v1 path must not fire for a v2 clarification");
        },
        resolveOption: (id, optionId) => resolveCalls.push([id, optionId]),
      }) as unknown as StubNode;

      const chip = card.children[1].children[0];
      expect(chip.textContent).toBe(`Project ${XSS}`);
      chip.click();
      // The dispatched payload is the exact option id, never the hostile label.
      expect(resolveCalls).toEqual([["clarification-1", "opt-1"]]);
    });
  });
});

function runEventFor(status: "pending" | "resolving"): Extract<StreamEvent, { type: "run_event" }> {
  return {
    type: "run_event",
    runId: "run-1",
    sequence: 1,
    event: { eventType: "tool.suspended", payload: {}, createdAt: "2026-07-26T00:00:00.000Z" } as never,
    attachment: {
      kind: "pending_clarification",
      clarificationId: "clarification-9",
      status,
      question: "Which project did you mean?",
      missingField: "projectId",
      candidates: [{ optionId: "opt-1", label: "Marketing Site" }],
      expiresAt: "2026-07-26T00:00:00.000Z",
    },
  };
}

describe("T14-F: applyRunEventAttachment maps pending_clarification through clarificationId/status", () => {
  it("carries clarificationId and status from the run-event attachment into the ClarifyResult", () => {
    const received: ChatResult[] = [];
    const buffer = new PreviewBuffer((results) => received.push(...results));
    applyRunEventAttachment(runEventFor("pending"), {
      onAssistant: () => {},
      onResults: (results) => received.push(...results),
      onError: () => {},
    }, buffer);
    buffer.flush();
    expect(received).toEqual([{
      kind: "clarify",
      message: "Which project did you mean?",
      options: [{ id: "opt-1", label: "Marketing Site" }],
      clarificationId: "clarification-9",
      status: "pending",
    }]);
  });

  it("carries a resolving status through unchanged", () => {
    const received: ChatResult[] = [];
    const buffer = new PreviewBuffer((results) => received.push(...results));
    applyRunEventAttachment(runEventFor("resolving"), {
      onAssistant: () => {},
      onResults: (results) => received.push(...results),
      onError: () => {},
    }, buffer);
    expect((received[0] as ClarifyResult).status).toBe("resolving");
  });
});

describe("T14-F: submitClarificationResolve responsiveness + error contract", () => {
  it("announces working before the call and always clears it after, on success", async () => {
    const events: string[] = [];
    const api: ClarificationResolveApiLike = {
      async resolveClarificationOption(_id, _optionId, onEvent) {
        events.push("call-start");
        onEvent({ type: "done" });
      },
    };
    const workingStates: boolean[] = [];
    await submitClarificationResolve(api, "clarification-1", "opt-1", {
      onWorking: (w) => workingStates.push(w),
      onAssistant: () => {},
      onResults: () => {},
      onError: () => {
        throw new Error("should not error");
      },
    });
    expect(workingStates).toEqual([true, false]);
    expect(events).toEqual(["call-start"]);
  });

  it("surfaces a thrown API error via onError and still clears working", async () => {
    const api: ClarificationResolveApiLike = {
      async resolveClarificationOption() {
        throw new Error("network down");
      },
    };
    const workingStates: boolean[] = [];
    let errorMessage: string | undefined;
    await submitClarificationResolve(api, "clarification-1", "opt-1", {
      onWorking: (w) => workingStates.push(w),
      onAssistant: () => {},
      onResults: () => {},
      onError: (message) => {
        errorMessage = message;
      },
    });
    expect(workingStates).toEqual([true, false]);
    expect(errorMessage).toBe("That option could not be resolved.");
  });

  it("never calls resolveClarificationOption with the option label — only the id it was given", async () => {
    let receivedOptionId: string | undefined;
    const api: ClarificationResolveApiLike = {
      async resolveClarificationOption(_id, optionId, onEvent) {
        receivedOptionId = optionId;
        onEvent({ type: "done" });
      },
    };
    await submitClarificationResolve(api, "clarification-1", "opt-1", {
      onWorking: () => {},
      onAssistant: () => {},
      onResults: () => {},
      onError: () => {},
    });
    expect(receivedOptionId).toBe("opt-1");
  });
});
