import { describe, expect, it } from "vitest";
import { settleConfirmOutcome, type ConfirmHooks, type ConfirmResponse } from "../../src/ui/main.js";

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
