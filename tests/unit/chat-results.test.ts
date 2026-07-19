import { describe, expect, it } from "vitest";
import { settleAgentTurn, truthfulReplyText, type TurnMachinery } from "../../src/routes/chat-results.js";
import type { AgentState } from "../../src/assistant/agent-state.js";
import type { AgentTurnResult } from "../../src/assistant/agent-loop.js";
import {
  NO_VERIFIED_TOOL_RESULT_REPLY,
  requestsTextApproval,
} from "../../src/assistant/text-safety.js";

// truthfulReplyText is the single-turn truthfulness override: the model narrates
// the batch outcome BEFORE the actions run, so an optimistic "Done!" must be
// replaced when the receipts disagree with it.
const okReceipt = (n = "a") => ({ kind: "receipt", receipt: { ok: true, changed: { created: [{ type: "tag", id: n, name: n }] } } });
const failReceipt = () => ({ kind: "receipt", receipt: { ok: false, code: "x", message: "nope" } });
const capabilityDeniedReceipt = () => ({
  kind: "receipt",
  receipt: { ok: false, code: "intent_capability_denied", message: "denied" },
});
const capabilityMismatchReceipt = () => ({
  kind: "receipt",
  receipt: { ok: false, code: "intent_capability_argument_mismatch", message: "mismatch" },
});

describe("truthfulReplyText — single-turn actions outcome", () => {
  it.each([
    "Proceed?",
    "Should I proceed?",
    "Is it okay if I delete it?",
    "Please give me the go-ahead.",
    "Once you approve, I will delete it.",
    "Awaiting your confirmation.",
  ])("classifies text authorization directly: %s", (text) => {
    expect(requestsTextApproval(text)).toBe(true);
  });

  it.each([
    "Would you confirm the invoice number?",
    "Could you confirm the amount is 100?",
    "Could you confirm which project you mean?",
  ])("does not misclassify target information clarification: %s", (text) => {
    expect(requestsTextApproval(text)).toBe(false);
  });

  it("PARTIAL failure: replaces the optimistic narration with a count-accurate line", () => {
    const results = [okReceipt("a"), failReceipt()];
    const out = truthfulReplyText(results, "Done! Created both tags.", "actions");
    expect(out).not.toMatch(/Done!/);
    expect(out).toMatch(/1 of 2/);
    expect(out).toMatch(/failed/i);
  });

  it("never lets a later failure erase an earlier recorded success", () => {
    const out = truthfulReplyText(
      [okReceipt("a"), failReceipt()],
      "The second action failed, so nothing was changed.",
      "answer",
    );
    expect(out).toMatch(/completed change.*recorded/i);
    expect(out).not.toMatch(/nothing was changed/i);
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

  it("never repeats provider advice to type a confirmation after authority denial", () => {
    const out = truthfulReplyText(
      [capabilityDeniedReceipt()],
      "Please type yes to confirm the project creation.",
      "answer",
    );
    expect(out).toMatch(/could not validate|couldn't validate/i);
    expect(out).not.toMatch(/type yes|confirm/i);
  });

  it("never repeats typed-confirmation advice when deny-all filtering leaves no write result", () => {
    const out = truthfulReplyText([], "Please type yes to confirm the project creation.", "answer");
    expect(out).toMatch(/button|no change|not.*awaiting/i);
    expect(out).not.toMatch(/type yes/i);
  });

  it.each([
    "Would you like me to go ahead and approve them?",
    "I need your explicit confirmation before I can create it.",
    "Shall I proceed with the approvals?",
    "Do I have your permission to apply this?",
    "Could you give me the go-ahead?",
    "Do you want me to create it now?",
    "Let me know if you want me to proceed.",
    "If you confirm, I can create it.",
    "Is it okay if I approve them?",
    "I can approve these once you give me the green light.",
    "Your authorization is required before this can run.",
    "Okay to proceed?",
    "Authorize this action to continue.",
  ])("removes no-preview text-approval wording: %s", (providerText) => {
    const out = truthfulReplyText([], providerText, "answer");
    expect(out).toBe("No change has been prepared. State the change you want in one fresh message.");
  });

  it("keeps a real clarification that asks which target the admin means", () => {
    const text = "Could you confirm which project you mean?";
    expect(truthfulReplyText([], text, "answer")).toBe(text);
  });

  it.each([
    "All pending timesheets are approved.",
    "The approvals are complete.",
    "Nothing is left; this was handled already.",
    "Any text at all, including a novel approval euphemism.",
  ])("uses only deterministic harness copy after a declared write with no result: %s", (providerText) => {
    expect(truthfulReplyText([], providerText, "answer", { writeIntentDeclared: true }))
      .toBe("No change has been prepared. State the change you want in one fresh message.");
  });

  it("preserves a known successful mutation while discarding later denial or text-approval prose", () => {
    const deniedAfterSuccess = truthfulReplyText(
      [okReceipt("project-1"), capabilityDeniedReceipt()],
      "No project tool is available, so no change was made.",
      "answer",
    );
    expect(deniedAfterSuccess).toMatch(/completed change.*recorded/i);
    expect(deniedAfterSuccess).not.toMatch(/no change was made/i);

    const approvalAfterSuccess = truthfulReplyText(
      [okReceipt("project-1")],
      "The project was created. Type yes to approve the next change.",
      "answer",
    );
    expect(approvalAfterSuccess).toMatch(/completed change.*recorded/i);
    expect(approvalAfterSuccess).not.toMatch(/type yes|no change has been prepared/i);
  });

  it("uses declared-write structure instead of matching provider tool-absence wording", () => {
    const out = truthfulReplyText(
      [okReceipt("timer-1")],
      "The timer was started, but the relevant operation surface was omitted from this environment.",
      "answer",
      { writeIntentDeclared: true },
    );
    expect(out).toMatch(/completed change.*recorded/i);
    expect(out).not.toMatch(/operation surface|omitted/i);
  });

  it("suppresses an unsupported-tool claim without relying on the request grammar", () => {
    expect(truthfulReplyText(
      [],
      "The project bootstrap operation is absent from my interface.",
      "answer",
    )).toBe(NO_VERIFIED_TOOL_RESULT_REPLY);
  });

  it("preserves an ordinary factual read answer about absent data", () => {
    const text = "There are no projects matching Atlas.";
    expect(truthfulReplyText([], text, "answer")).toBe(text);
  });

  it("does not let an unrelated unknown-action receipt exempt provider absence prose", () => {
    const text = "That action is unavailable because the requested tool name is unknown.";
    expect(truthfulReplyText([{
      kind: "receipt",
      receipt: { ok: false, code: "unknown_action", message: "unknown" },
    }], text, "answer")).toBe(NO_VERIFIED_TOOL_RESULT_REPLY);
  });

  it.each([
    "I do not have the ability to create projects.",
    "I am unable to create projects.",
  ])("suppresses unsupported-ability wording: %s", (text) => {
    expect(truthfulReplyText([], text, "answer")).toBe(NO_VERIFIED_TOOL_RESULT_REPLY);
  });

  it.each([
    "Project creation is not supported by the available actions.",
    "Creating projects is outside my capabilities.",
    "There is no project-creation capability in this chat.",
  ])("uses the recorded receipt instead of a post-success capability claim: %s", (providerText) => {
    const out = truthfulReplyText(
      [okReceipt("timer-1")],
      providerText,
      "answer",
      { writeIntentDeclared: true },
    );
    expect(out).toMatch(/completed change.*recorded/i);
    expect(out).not.toBe(providerText);
  });

  it("overrides an uncorrected capability mismatch but preserves a later successful correction", () => {
    const denied = truthfulReplyText(
      [capabilityMismatchReceipt()],
      "Reply yes and I will apply it.",
      "answer",
    );
    expect(denied).toMatch(/could not validate|couldn't validate/i);
    expect(denied).not.toMatch(/reply yes/i);

    const corrected = truthfulReplyText(
      [capabilityMismatchReceipt(), okReceipt("project-1")],
      "The corrected request was applied.",
      "answer",
    );
    expect(corrected).toBe("The completed change is recorded above. No other change was made.");
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
