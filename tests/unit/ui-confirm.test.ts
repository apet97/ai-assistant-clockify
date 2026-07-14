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
import { cancelOutcome, runConfirmStreamLive, undoFailureMessage } from "../../src/ui/shared.js";

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
    onStale: (m) => events.push(`stale:${m}`),
  };
  return { hooks, events };
}

const okReceipt = { ok: true, receipt: { ok: true, action: "clockify_tags_delete" } } as ConfirmResponse;

describe("undoFailureMessage (undo failures surface the route's real reason)", () => {
  it("prefers the top-level message (policy denial / not-found)", () => {
    expect(undoFailureMessage({ ok: false, message: "Undo needs write access to work_structure." })).toBe(
      "Undo needs write access to work_structure.",
    );
  });
  it("falls back to the receipt message (a failed reversal — fix #4's honest error)", () => {
    expect(undoFailureMessage({ ok: false, receipt: { message: "Couldn't undo — none of the items could be removed." } })).toBe(
      "Couldn't undo — none of the items could be removed.",
    );
  });
  it("uses a safe fallback when the response carries no reason", () => {
    expect(undoFailureMessage({ ok: false })).toBe("Couldn't undo — please try again.");
    expect(undoFailureMessage(undefined)).toBe("Couldn't undo — please try again.");
  });
});

describe("cancelOutcome (cancel surfaces the route's truth — never a false 'Cancelled.')", () => {
  it("reports ok when every cancel returned ok:true", () => {
    expect(cancelOutcome([{ ok: true }])).toEqual({ ok: true });
    expect(cancelOutcome([{ ok: true }, { ok: true }])).toEqual({ ok: true });
  });

  it("surfaces the server's verbatim message on a concurrent-confirm 409 — does NOT claim 'Cancelled.'", () => {
    // r1-ux-copy-a11y-01: the cancel route returns { ok:false } (not a throw)
    // when the preview was already confirmed/cancelled in another tab. The card
    // must NOT be removed and the admin must NOT be told it was cancelled — the
    // risky change may already have COMMITTED.
    expect(cancelOutcome([{ ok: false, code: "not_pending", message: "This preview is no longer pending." }])).toEqual({
      ok: false,
      error: "This preview is no longer pending.",
    });
  });

  it("surfaces a 403 wrong-session message verbatim", () => {
    expect(cancelOutcome([{ ok: false, code: "forbidden", message: "This preview belongs to a different session." }])).toEqual({
      ok: false,
      error: "This preview belongs to a different session.",
    });
  });

  it("falls back honestly when a failure carries no message", () => {
    expect(cancelOutcome([{ ok: false }])).toEqual({
      ok: false,
      error: "Couldn't cancel — it may have already been confirmed.",
    });
  });

  it("a single failure in a batch fails the whole cancel (no half-truth)", () => {
    expect(cancelOutcome([{ ok: true }, { ok: false, message: "This preview is no longer pending." }])).toEqual({
      ok: false,
      error: "This preview is no longer pending.",
    });
  });

  it("a missing/undefined response never invents a successful cancel", () => {
    expect(cancelOutcome([undefined])).toEqual({
      ok: false,
      error: "Couldn't cancel — it may have already been confirmed.",
    });
  });
});

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

  it("surfaces the failed COMMIT's receipt reason (no top-level message) — never the generic fallback", () => {
    // A failed commit comes back as { ok:false, receipt:{ message } } with no
    // top-level message; the real reason must reach onError, not be swallowed.
    const { hooks, events } = recorder();
    const committed = settleConfirmOutcome(
      [
        {
          ok: false,
          receipt: { ok: false, action: "clockify_tags_delete", message: "Clockify DELETE /tags/t1 -> 400: tag in use" },
        } as ConfirmResponse,
      ],
      hooks,
    );
    expect(committed).toBe(0);
    expect(events).toContain("error:Clockify DELETE /tags/t1 -> 400: tag in use");
    expect(events).not.toContain("error:Confirmation failed.");
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

  it("renders a JSON partial result with recovery and undo instead of claiming clean confirmation", () => {
    const results: unknown[] = [];
    const assistant: string[] = [];
    const partial = {
      kind: "partial" as const,
      receipt: { ok: true, action: "clockify_invoices_create" },
      message: "The invoice exists, but enrichment failed.",
      recovery: { hint: "Review the invoice before retrying.", retryable: false },
    };
    const committed = settleConfirmOutcome(
      [{
        ok: true,
        receipt: partial.receipt,
        result: partial,
        undo: { id: "undo-partial" },
      } as unknown as ConfirmResponse],
      {
        onAssistant: (text) => assistant.push(text),
        onResults: (items) => results.push(...items),
        onError: () => undefined,
      },
    );

    expect(committed).toBe(1);
    expect(results).toEqual([{ ...partial, undo: { id: "undo-partial" } }]);
    expect(assistant).toEqual([]);
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

  it("routes a stale-nonce 400 (another tab rotated the nonce) to onStale, NOT onError", async () => {
    // r1-concurrency-races-02: when two restored tabs each hold a pending card,
    // the later GET /api/chat/history rotates the nonce, so the earlier tab's
    // Confirm 400s with code 'invalid_confirmation'. That tab must be RE-ARMED
    // (re-fetch history + re-render the live card), not dead-ended on onError —
    // so the admin can retry from the tab they're looking at.
    const { hooks, events } = recorder();
    await submitConfirmStream(
      streamApi([
        { type: "error", code: "invalid_confirmation", message: "Confirmation does not match this preview." },
      ]),
      { previewId: "p1", nonce: "n1" },
      hooks,
    );
    expect(events.some((e) => e.startsWith("stale:"))).toBe(true);
    expect(events.some((e) => e.startsWith("error:"))).toBe(false);
  });

  it("still routes a generic (non-stale) confirm error to onError", async () => {
    const { hooks, events } = recorder();
    await submitConfirmStream(
      streamApi([{ type: "error", code: "expired", message: "This preview has expired." }]),
      { previewId: "p1", nonce: "n1" },
      hooks,
    );
    expect(events).toContain("error:This preview has expired.");
    expect(events.some((e) => e.startsWith("stale:"))).toBe(false);
  });
});

describe("runConfirmStreamLive (confirm-resume shows the working affordance + streams status)", () => {
  // r1-ux-copy-a11y-03: a confirmed risky write's durable resume can run 30-120s.
  // The chat path shows the typing/working affordance + per-step status labels;
  // the confirm-resume path used to run INVISIBLY (no working toggle, status
  // labels dropped). This orchestrator makes the two symmetric.
  function liveRecorder() {
    const events: string[] = [];
    const hooks: ConfirmHooks = {
      onAssistant: (t) => events.push(`assistant:${t}`),
      onResults: (r) => events.push(`results:${r.map((x) => x.kind).join(",")}`),
      onError: (m) => events.push(`error:${m}`),
      onStale: (m) => events.push(`stale:${m}`),
    };
    return {
      hooks,
      events,
      onWorking: (w: boolean) => events.push(`working:${w}`),
      onStatus: (label: string) => events.push(`status:${label}`),
      removeCard: () => events.push("removeCard"),
    };
  }

  it("toggles working before/after and forwards each streamed status label", async () => {
    const rec = liveRecorder();
    await runConfirmStreamLive(
      streamApi([
        { type: "receipt", receipt: { ok: true, action: "clockify_invoices_create" } },
        { type: "status", action: "clockify_clients_list", label: "Listing clients" },
        { type: "status", action: "clockify_invoices_items_add", label: "Adding the line item" },
        { type: "reply", kind: "answer", text: "Invoice created." },
        { type: "done" },
      ]),
      { previewId: "p1", nonce: "n1" },
      rec.hooks,
      { onWorking: rec.onWorking, onStatus: rec.onStatus, removeCard: rec.removeCard },
    );
    // working is announced BEFORE the stream and ALWAYS cleared after (mirrors
    // the chat path's submitStreaming contract).
    expect(rec.events[0]).toBe("working:true");
    expect(rec.events[rec.events.length - 1]).toBe("working:false");
    // per-step status labels are no longer dropped
    expect(rec.events).toContain("status:Listing clients");
    expect(rec.events).toContain("status:Adding the line item");
    // the card is removed exactly once, on the first real outcome (the receipt)
    expect(rec.events.filter((e) => e === "removeCard")).toEqual(["removeCard"]);
    expect(rec.events).toContain("results:receipt");
    expect(rec.events).toContain("assistant:Invoice created.");
  });

  it("clears working even when the stream errors", async () => {
    const rec = liveRecorder();
    await runConfirmStreamLive(
      streamApi([
        { type: "receipt", receipt: { ok: true, action: "clockify_tags_delete" } },
        { type: "error", code: "resume_error", message: "The follow-up couldn't complete." },
        { type: "done" },
      ]),
      { previewId: "p1", nonce: "n1" },
      rec.hooks,
      { onWorking: rec.onWorking, onStatus: rec.onStatus, removeCard: rec.removeCard },
    );
    expect(rec.events[0]).toBe("working:true");
    expect(rec.events[rec.events.length - 1]).toBe("working:false");
    expect(rec.events).toContain("error:The follow-up couldn't complete.");
  });

  it("a stale-nonce 400 re-arms in place and does NOT remove the card", async () => {
    const rec = liveRecorder();
    await runConfirmStreamLive(
      streamApi([{ type: "error", code: "invalid_confirmation", message: "Confirmation does not match this preview." }]),
      { previewId: "p1", nonce: "n1" },
      rec.hooks,
      { onWorking: rec.onWorking, onStatus: rec.onStatus, removeCard: rec.removeCard },
    );
    expect(rec.events).toContain("stale:Confirmation does not match this preview.");
    expect(rec.events).not.toContain("removeCard"); // the card stays for the re-arm
    expect(rec.events[rec.events.length - 1]).toBe("working:false");
  });
});

describe("batchItemOutcomes (per-item truth on the settled batch card)", () => {
  it("marks an ok:true partial response as partial, never cleanly confirmed", () => {
    const partial = {
      kind: "partial" as const,
      receipt: { ok: true, action: "clockify_invoices_create" },
      message: "The invoice exists, but enrichment failed.",
      recovery: { hint: "Review it.", retryable: false },
    };
    expect(batchItemOutcomes(
      ["Create invoice"],
      [{ ok: true, receipt: partial.receipt, result: partial } as unknown as ConfirmResponse],
    )).toEqual([{
      label: "Create invoice",
      ok: true,
      status: "partial",
      detail: "The invoice exists, but enrichment failed.",
    }]);
  });

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

  it("a failed COMMIT (no top-level message) surfaces the receipt's reason verbatim", () => {
    // The confirm route returns a failed commit as { ok:false, receipt:{ message } }
    // with NO top-level message — the real reason lives on receipt.message.
    const out = batchItemOutcomes(
      ["Delete tag Old"],
      [
        {
          ok: false,
          receipt: { ok: false, action: "clockify_tags_delete", message: "Clockify DELETE /tags/t1 -> 400: tag in use" },
        } as ConfirmResponse,
      ],
    );
    expect(out).toEqual([
      { label: "Delete tag Old", ok: false, detail: "Clockify DELETE /tags/t1 -> 400: tag in use" },
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
