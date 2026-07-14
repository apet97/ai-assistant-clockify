import { describe, expect, it } from "vitest";
import { settleAgentTurn, truthfulReplyText, type TurnMachinery } from "../../src/routes/chat-results.js";
import type { AgentState } from "../../src/assistant/agent-state.js";
import type { AgentTurnResult } from "../../src/assistant/agent-loop.js";

// truthfulReplyText is the single-turn truthfulness override: the model narrates
// the batch outcome BEFORE the actions run, so an optimistic "Done!" must be
// replaced when the receipts disagree with it.
const okReceipt = (n = "a") => ({ kind: "receipt", receipt: { ok: true, changed: { created: [{ type: "tag", id: n, name: n }] } } });
const failReceipt = () => ({ kind: "receipt", receipt: { ok: false, code: "x", message: "nope" } });

describe("truthfulReplyText — single-turn actions outcome", () => {
  it("PARTIAL failure: replaces the optimistic narration with a count-accurate line", () => {
    const results = [okReceipt("a"), failReceipt()];
    const out = truthfulReplyText(results, "Done! Created both tags.", "actions");
    expect(out).not.toMatch(/Done!/);
    expect(out).toMatch(/1 of 2/);
    expect(out).toMatch(/failed/i);
  });

  it("ALL-failed still reports nothing was changed", () => {
    const results = [failReceipt(), failReceipt()];
    const out = truthfulReplyText(results, "Done! Created both tags.", "actions");
    expect(out).toMatch(/nothing was changed/i);
  });

  it("ALL-success leaves the model's truthful narration untouched", () => {
    const results = [okReceipt("a")];
    const out = truthfulReplyText(results, "Done! Created the tag.", "actions");
    expect(out).toBe("Done! Created the tag.");
  });
});

describe("settleAgentTurn — durable state byte cap", () => {
  it("caps the fully assembled state after adding maximum selection context", () => {
    const maxBytes = 256 * 1024;
    // Maximum valid character count, deliberately multibyte so the assertion
    // guards UTF-8 JSON bytes rather than JavaScript string length.
    const selectionContext = "č".repeat(8_000);
    const stateFor = (contentBytes: number): AgentState => ({
      transcript: [{ role: "user", content: "t".repeat(contentBytes) }],
      call: { id: "call-1", name: "clockify_tags_delete" },
    });
    let low = 0;
    let high = maxBytes;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (Buffer.byteLength(JSON.stringify(stateFor(mid)), "utf8") <= maxBytes) low = mid;
      else high = mid - 1;
    }
    const baseState = stateFor(low);
    expect(Buffer.byteLength(JSON.stringify(baseState), "utf8")).toBeLessThanOrEqual(maxBytes);
    expect(Buffer.byteLength(JSON.stringify({ ...baseState, selectionContext }), "utf8")).toBeGreaterThan(maxBytes);

    let emitted = false;
    let persistedState: AgentState | undefined;
    const machinery = {
      ctx: {},
      results: [],
      resultLinks: [],
      emit: () => undefined,
      auditAndEmitReceipt: () => undefined,
      auditAndEmitPartial: () => undefined,
      emitPreviewFor: (_preview: unknown, _operation: unknown, state?: AgentState) => {
        emitted = true;
        persistedState = state;
      },
      runAction: async () => { throw new Error("not used"); },
      onStep: () => undefined,
      selectionContext,
    } as unknown as TurnMachinery;
    const turn: AgentTurnResult = {
      kind: "interrupt",
      call: { id: baseState.call.id, name: baseState.call.name, arguments: {} },
      preview: {
        actionLabel: "Delete tag",
        featureGroup: "work_structure",
        riskLabels: ["destructive"],
        targets: [],
        expectedChanges: [],
        reversibility: "Not reversible",
        warnings: [],
      },
      operation: {
        operationId: "operation-1",
        actionName: "clockify_tags_delete",
        featureGroup: "work_structure",
        risks: ["destructive"],
        payload: {},
      },
      transcript: baseState.transcript,
    };

    settleAgentTurn(machinery, turn);

    expect(emitted).toBe(true);
    expect(persistedState === undefined).toBe(true);
  });
});
