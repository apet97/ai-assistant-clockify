import { describe, expect, it } from "vitest";
import { parseAgentState, resumeMessages, type AgentState } from "../../src/assistant/agent-state.js";
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
