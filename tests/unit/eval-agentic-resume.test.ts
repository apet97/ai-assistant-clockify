import { describe, expect, it } from "vitest";
import { persistAndResume } from "../../scripts/eval/persist-resume.js";
import type { AgentState } from "../../src/assistant/agent-state.js";
import type { SuccessReceipt } from "../../src/harness/receipts.js";

/**
 * Pins the agentic eval's confirm round-trip to the PRODUCTION suspension
 * boundary (capAgentState → JSON persist → parseAgentState → resumeMessages).
 * The old eval handed the in-memory transcript straight to resumeMessages, so a
 * field that survived in memory but was stripped/rejected by the persisted
 * agent_state_json schema (thoughtSignature, any future contract field) passed
 * the eval and broke only in production. persistAndResume closes that gap.
 */
describe("persistAndResume (eval ↔ production parity)", () => {
  const receipt: SuccessReceipt = {
    ok: true,
    action: "clockify_tags_create",
    entity: "tag",
    ids: { id: "tag-1" },
  };

  function stateWith(call: AgentState["call"]): AgentState {
    return {
      transcript: [
        { role: "user", content: "create a tag" },
        { role: "assistant", content: "", toolCalls: [{ id: call.id || "call_0", name: call.name, arguments: {} }] },
      ],
      call,
    };
  }

  it("preserves a Gemini thought_signature through serialize → validate → resume", () => {
    const state: AgentState = {
      transcript: [
        { role: "user", content: "create a tag" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call_0", name: "clockify_tags_create", arguments: { name: "X" }, thoughtSignature: "sig-abc" },
          ],
        },
      ],
      call: { id: "call_0", name: "clockify_tags_create" },
    };

    const resumed = persistAndResume(state, receipt);
    expect(resumed, "a valid state must survive the persistence round-trip").not.toBeUndefined();
    // The assistant tool call's thought signature must still be present after the
    // round-trip, or every Gemini resume 400s in production while the eval passes.
    const assistant = resumed!.find((m) => m.role === "assistant");
    expect(assistant?.toolCalls?.[0]?.thoughtSignature).toBe("sig-abc");
    // And the committed receipt is appended as the risky call's tool result.
    expect(resumed!.at(-1)).toMatchObject({ role: "tool", toolCallId: "call_0" });
  });

  it("returns undefined when the persisted-state schema rejects the state (drift fails the eval)", () => {
    // A call id the schema requires to be non-empty: a state the production
    // boundary would reject must NOT resume in the eval either — it is a failure,
    // not a silent in-memory resume.
    const broken = stateWith({ id: "", name: "clockify_tags_create" });
    expect(persistAndResume(broken, receipt)).toBeUndefined();
  });
});
