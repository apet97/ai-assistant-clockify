import { describe, expect, it } from "vitest";
import {
  batchItemOutcomes,
  settleConfirmOutcome,
  submitConfirmStream,
  type ConfirmHooks,
  type ConfirmResponse,
  type ConfirmStreamApi,
  type StreamEvent,
} from "../../src/ui/main.js";

/**
 * Phase 4: settle confirm responses TRUTHFULLY. A failed confirm must never
 * read "Confirmed."; a resumed agentic turn renders its follow-up results
 * (receipts, even a chained preview) and the loop's truthful reply.
 */
function recorder() {
  const events: string[] = [];
  const hooks: ConfirmHooks = {
    onAssistant: (t) => events.push(`assistant:${t}`),
    onResults: (r) => events.push(`results:${r.map((x) => x.kind).join(",")}`),
    onError: (m) => events.push(`error:${m}`),
  };
  return { hooks, events };
}

const okReceipt = { ok: true, receipt: { ok: true, action: "clockify_tags_delete" } } as ConfirmResponse;

describe("settleConfirmOutcome (truthful confirm flow)", () => {
  it("surfaces the server's message on a failed confirm — never 'Confirmed.'", () => {
    const { hooks, events } = recorder();
    const committed = settleConfirmOutcome(
      [{ ok: false, code: "policy_denied", message: "Write access to work_structure is disabled." } as ConfirmResponse],
      hooks,
    );
    expect(committed).toBe(0);
    expect(events).toContain("error:Write access to work_structure is disabled.");
    expect(events.some((e) => e.startsWith("assistant:"))).toBe(false);
  });

  it("confirms a plain (non-resume) preview exactly as before", () => {
    const { hooks, events } = recorder();
    const committed = settleConfirmOutcome([okReceipt], hooks);
    expect(committed).toBe(1);
    expect(events).toEqual(["assistant:Confirmed."]);
  });

  it("renders a resumed turn's results and truthful reply instead of 'Confirmed.'", () => {
    const { hooks, events } = recorder();
    const committed = settleConfirmOutcome(
      [
        {
          ...okReceipt,
          resume: {
            reply: { kind: "answer", text: "The invoice for qwen is created." },
            results: [{ kind: "receipt", receipt: { ok: true, action: "clockify_tags_list" } }],
          },
        } as ConfirmResponse,
      ],
      hooks,
    );
    expect(committed).toBe(1);
    expect(events).toContain("results:receipt");
    expect(events).toContain("assistant:The invoice for qwen is created.");
    expect(events).not.toContain("assistant:Confirmed.");
  });

  it("renders a CHAINED preview from the resumed loop so the next Confirm button appears", () => {
    const { hooks, events } = recorder();
    settleConfirmOutcome(
      [
        {
          ...okReceipt,
          resume: {
            reply: { kind: "actions", text: 'Review the change below and click "Confirm" to apply it. Nothing has been changed yet.' },
            results: [{ kind: "preview", previewId: "p2", nonce: "n2", preview: { actionLabel: "Delete tag" } }],
          },
        } as unknown as ConfirmResponse,
      ],
      hooks,
    );
    expect(events).toContain("results:preview");
    expect(events.some((e) => e.includes("Nothing has been changed yet"))).toBe(true);
  });

  it("reports a partial batch truthfully", () => {
    const { hooks, events } = recorder();
    const committed = settleConfirmOutcome(
      [okReceipt, { ok: false, code: "expired", message: "This preview has expired." } as ConfirmResponse],
      hooks,
    );
    expect(committed).toBe(1);
    expect(events).toContain("error:This preview has expired.");
    expect(events).toContain("assistant:Confirmed 1 of 2 — the rest failed.");
  });

  it("confirms a full batch with the batch message", () => {
    const { hooks, events } = recorder();
    const committed = settleConfirmOutcome([okReceipt, okReceipt], hooks);
    expect(committed).toBe(2);
    expect(events).toEqual(["assistant:Batch confirmed."]);
  });
});

function streamApi(events: StreamEvent[]): ConfirmStreamApi {
  return {
    confirmStream: async (_ref, onEvent) => {
      for (const e of events) onEvent(e);
    },
  };
}

describe("submitConfirmStream (streaming single confirm)", () => {
  it("renders the committed receipt FIRST (instant), then resume results, then the reply", async () => {
    const { hooks, events } = recorder();
    await submitConfirmStream(
      streamApi([
        { type: "receipt", receipt: { ok: true, action: "clockify_invoices_create" }, undo: { id: "u1" } },
        { type: "result", result: { kind: "receipt", receipt: { ok: true, action: "clockify_clients_list" } } },
        { type: "reply", kind: "answer", text: "The invoice for qwen is created." },
        { type: "done" },
      ]),
      { previewId: "p1", nonce: "n1" },
      hooks,
    );
    // The receipt is the first thing rendered — the button never feels dead.
    expect(events[0]).toBe("results:receipt");
    expect(events).toContain("results:receipt");
    expect(events).toContain("assistant:The invoice for qwen is created.");
    // It must NOT fall back to the generic "Confirmed." text.
    expect(events).not.toContain("assistant:Confirmed.");
  });

  it("buffers a chained preview and flushes it at the reply (its Confirm button appears)", async () => {
    const { hooks, events } = recorder();
    await submitConfirmStream(
      streamApi([
        { type: "receipt", receipt: { ok: true, action: "clockify_tags_delete" } },
        { type: "result", result: { kind: "preview", previewId: "p2", nonce: "n2", preview: { actionLabel: "Delete tag", expectedChanges: [], reversibility: "", warnings: [] } } },
        { type: "reply", kind: "actions", text: 'Review the change below and click "Confirm" to apply it. Nothing has been changed yet.' },
        { type: "done" },
      ]),
      { previewId: "p1", nonce: "n1" },
      hooks,
    );
    expect(events[0]).toBe("results:receipt");
    expect(events).toContain("results:preview");
    expect(events.some((e) => e.includes("Nothing has been changed yet"))).toBe(true);
  });

  it("surfaces a resume error but keeps the already-rendered receipt (the change still applied)", async () => {
    const { hooks, events } = recorder();
    await submitConfirmStream(
      streamApi([
        { type: "receipt", receipt: { ok: true, action: "clockify_tags_delete" } },
        { type: "error", code: "resume_error", message: "The follow-up couldn't complete, but your change was applied." },
        { type: "done" },
      ]),
      { previewId: "p1", nonce: "n1" },
      hooks,
    );
    expect(events[0]).toBe("results:receipt");
    expect(events).toContain("error:The follow-up couldn't complete, but your change was applied.");
  });

  it("surfaces a transport failure (never silently drops the click)", async () => {
    const { hooks, events } = recorder();
    const failing: ConfirmStreamApi = { confirmStream: async () => { throw new Error("network"); } };
    await submitConfirmStream(failing, { previewId: "p1", nonce: "n1" }, hooks);
    expect(events.some((e) => e.startsWith("error:"))).toBe(true);
  });
});

describe("batchItemOutcomes (per-item truth on the settled batch card)", () => {
  it("maps each label to its response: ok → Confirmed, failure → the server's message verbatim", () => {
    const out = batchItemOutcomes(
      ["Delete tag Old", "Archive project Apollo"],
      [okReceipt, { ok: false, code: "policy_denied", message: "Write access to projects is disabled." } as ConfirmResponse],
    );
    expect(out).toEqual([
      { label: "Delete tag Old", ok: true, detail: "Confirmed" },
      { label: "Archive project Apollo", ok: false, detail: "Write access to projects is disabled." },
    ]);
  });

  it("a failure without a message falls back honestly", () => {
    const out = batchItemOutcomes(["Delete tag Old"], [{ ok: false } as ConfirmResponse]);
    expect(out).toEqual([{ label: "Delete tag Old", ok: false, detail: "Confirmation failed." }]);
  });

  it("a missing response never invents success", () => {
    const out = batchItemOutcomes(["A", "B"], [okReceipt]);
    expect(out[1]).toEqual({ label: "B", ok: false, detail: "No response." });
  });
});
