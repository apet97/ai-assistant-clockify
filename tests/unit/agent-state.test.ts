import { describe, expect, it } from "vitest";
import { capAgentState, parseAgentState, resumeMessages, type AgentState } from "../../src/assistant/agent-state.js";
import { TOOL_RESULT_MAX_BYTES } from "../../src/assistant/agent-loop.js";
import { createPendingConfirmation } from "../../src/harness/confirmations.js";
import { successReceipt } from "../../src/harness/receipts.js";
import { createStore } from "../../src/db/store.js";

/**
 * Phase 3: the durable suspension of an agentic turn across the risky-write
 * confirm round-trip — shape validation, the resume transcript, and the
 * pending_confirmations persistence round-trip (backward compatible).
 */
const state: AgentState = {
  transcript: [
    { role: "system", content: "sys" },
    { role: "user", content: "delete the urgent tag" },
    {
      role: "assistant",
      content: "",
      // Thinking-mode reasoning must survive the persistence round-trip — the
      // provider requires it back verbatim on resume.
      reasoningContent: "the user wants the urgent tag gone",
      toolCalls: [{ id: "r1", name: "clockify_tags_delete", arguments: { name: "urgent" } }],
    },
  ],
  call: { id: "r1", name: "clockify_tags_delete" },
};

describe("agent-state (durable agentic suspension)", () => {
  it("parseAgentState accepts a stored state and rejects malformed values", () => {
    expect(parseAgentState(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(parseAgentState(undefined)).toBeUndefined();
    expect(parseAgentState(null)).toBeUndefined();
    expect(parseAgentState({ transcript: "nope", call: { id: "x", name: "y" } })).toBeUndefined();
    expect(parseAgentState({ transcript: [], call: { id: "x", name: "y" } })).toBeUndefined();
    expect(parseAgentState({ transcript: state.transcript, call: { id: "", name: "y" } })).toBeUndefined();
  });

  it("preserves a Gemini per-tool-call thoughtSignature through parseAgentState (continuation needs it back, or 400)", () => {
    // Gemini 3.x rejects a tool-call continuation that drops
    // extra_content.google.thought_signature, exactly like DeepSeek's
    // reasoning_content. The persisted state must keep it through the confirm
    // round-trip — the zod schema was silently stripping it, so every Gemini
    // risky-write resume 400'd.
    const geminiState: AgentState = {
      transcript: [
        { role: "user", content: "delete the urgent tag" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "r1", name: "clockify_tags_delete", arguments: { name: "urgent" }, thoughtSignature: "sig-abc123" },
          ],
        },
      ],
      call: { id: "r1", name: "clockify_tags_delete" },
    };
    const restored = parseAgentState(JSON.parse(JSON.stringify(geminiState)));
    expect(restored?.transcript[1]?.toolCalls?.[0]?.thoughtSignature).toBe("sig-abc123");
  });

  it("resumeMessages appends the committed receipt as the risky call's tool result", () => {
    const receipt = successReceipt({ action: "clockify_tags_delete", entity: "tag" });
    const messages = resumeMessages(state, receipt);
    expect(messages).toHaveLength(state.transcript.length + 1);
    const last = messages[messages.length - 1];
    expect(last.role).toBe("tool");
    expect(last.toolCallId).toBe("r1");
    expect(last.content).toContain("clockify_tags_delete");
    expect(last.content).toContain('"ok":true');
  });

  it("resumeMessages byte-caps a fat committed receipt like every other tool result (TOOL_RESULT_MAX_BYTES)", () => {
    // A fat commit receipt (bulk ops / compose / a many-item invoice doc) must
    // obey the same per-tool-result cap as in-loop receipts; otherwise the
    // resume transcript can blow the provider request budget and runResume
    // silently drops the follow-up narration.
    const receipt = successReceipt({
      action: "clockify_invoices_create",
      entity: "invoice",
      data: { items: Array.from({ length: 5000 }, (_, i) => ({ description: `line ${i}`, quantity: 1, unitPrice: 1234 })) },
    });
    expect(Buffer.byteLength(JSON.stringify(receipt), "utf8")).toBeGreaterThan(TOOL_RESULT_MAX_BYTES);

    const messages = resumeMessages(state, receipt);
    const last = messages[messages.length - 1];
    expect(last.role).toBe("tool");
    expect(last.toolCallId).toBe("r1");
    expect(Buffer.byteLength(last.content, "utf8")).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES);
    // The honest truncation marker is present, while the identifying fields survive.
    expect(last.content).toContain("truncatedForModel");
    expect(last.content).toContain('"ok":true');
    expect(last.content).toContain("clockify_invoices_create");
  });

  it("resumeMessages leaves a small committed receipt byte-identical", () => {
    const receipt = successReceipt({ action: "clockify_tags_delete", entity: "tag" });
    const messages = resumeMessages(state, receipt);
    const last = messages[messages.length - 1];
    expect(last.content).toBe(JSON.stringify(receipt));
  });

  it("capAgentState passes a normal state through and drops an oversized one (no-resume is the safe fallback; truncating would corrupt tool-call pairing)", () => {
    expect(capAgentState(state)).toEqual(state);
    const huge: AgentState = {
      transcript: [
        ...state.transcript,
        { role: "tool", toolCallId: "r1", content: "x".repeat(300_000) },
      ],
      call: state.call,
    };
    expect(capAgentState(huge)).toBeUndefined();
  });

  it("round-trips agentState through the pending_confirmations store; rows without it stay undefined", () => {
    const store = createStore(":memory:", { encryptionKey: "test-key" });
    const session = store.createSession({ workspaceId: "ws-1", adminUserId: "admin-1" });
    const base = {
      sessionId: session.id,
      workspaceId: "ws-1",
      adminUserId: "admin-1",
      risk: ["destructive" as const],
      preview: { actionLabel: "Delete tag" },
      operation: { actionName: "clockify_tags_delete", featureGroup: "work_structure", risks: ["destructive"], payload: { id: "t1" } },
      sessionSecret: "secret",
    };

    const withState = createPendingConfirmation({ ...base, agentState: state });
    store.savePendingConfirmation(withState.record);
    const loaded = store.getPendingConfirmation(withState.previewId);
    expect(parseAgentState(loaded?.agentState)).toEqual(state);

    const withoutState = createPendingConfirmation(base);
    store.savePendingConfirmation(withoutState.record);
    const legacy = store.getPendingConfirmation(withoutState.previewId);
    expect(legacy?.agentState).toBeUndefined();
    store.close();
  });
});
