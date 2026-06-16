import { describe, expect, it } from "vitest";
import type { ToolCall, ToolCompletion } from "../../src/assistant/model-client.js";
import { runAgentConversation } from "../../src/assistant/planner.js";
import { runAgentTurn, type AgentTurnResult } from "../../src/assistant/agent-loop.js";
import type { AgentState } from "../../src/assistant/agent-state.js";
import type { ActionContext, ActionResult } from "../../src/harness/action.js";
import { commitConfirmedOperation, executeAction } from "../../src/harness/actions.js";
import { getAction } from "../../src/harness/catalog.js";
import { defaultAdminPolicy } from "../../src/harness/permissions.js";
import { errorReceipt } from "../../src/harness/receipts.js";
import { requiresConfirmation } from "../../src/harness/risk.js";
import { toolsForModel } from "../../src/harness/tools.js";
import { createFakeWorkspace, type FakeWorkspace } from "../helpers/fake-clockify.js";
import { scriptedToolModel } from "../helpers/scripted-model.js";
import { persistAndResume } from "../../scripts/eval/persist-resume.js";

/**
 * Offline smoke eval: drives the REAL agentic loop + REAL harness against the fake
 * workspace with a SCRIPTED (deterministic, no-network) model — so CI gates that
 * the eval machinery + the risky-write confirm choke point work end-to-end and
 * that a confirmation-required action NEVER returns a direct successful receipt
 * inside a loop turn (0 safety violations). Deterministic floor under the opt-in
 * live evals (scripts/eval-planner.ts, eval-agentic.ts).
 */
function makeContext(fake: FakeWorkspace): ActionContext {
  return {
    workspaceId: "eval-ws",
    adminUserId: "eval-admin",
    policy: defaultAdminPolicy(),
    clockify: fake.client,
    now: () => new Date(),
  };
}
function call(name: string, args: Record<string, unknown>): ToolCompletion {
  return { text: "", toolCalls: [{ id: `c-${name}`, name, arguments: args }] };
}
const done = (text: string): ToolCompletion => ({ text, toolCalls: [] });

async function runScripted(
  script: ToolCompletion[],
  fake: FakeWorkspace,
): Promise<{
  executed: string[];
  committed: string[];
  safety: string[];
  kind: AgentTurnResult["kind"];
}> {
  const ctx = makeContext(fake);
  const executed: string[] = [];
  const committed: string[] = [];
  const safety: string[] = [];
  const model = scriptedToolModel(script);
  const runAction = async (c: ToolCall): Promise<ActionResult> => {
    let result: ActionResult;
    try {
      result = await executeAction({ actionName: c.name, args: c.arguments, context: ctx });
    } catch (err) {
      result = {
        kind: "receipt",
        receipt: errorReceipt({
          action: c.name,
          code: "action_failed",
          message: (err instanceof Error ? err.message : "failed").slice(0, 200),
        }),
      };
    }
    if (result.kind === "receipt") {
      executed.push(c.name);
      if (result.receipt.ok && requiresConfirmation(getAction(c.name)?.risks ?? [])) {
        safety.push(`${c.name} returned a direct successful receipt without a preview`);
      }
    }
    return result;
  };
  let turn: AgentTurnResult = await runAgentConversation({
    modelClient: model,
    messages: [{ role: "user", content: "scripted" }],
    policy: ctx.policy,
    runAction,
  });
  let guard = 0;
  while (turn.kind === "interrupt" && guard < 5) {
    guard += 1;
    const receipt = await commitConfirmedOperation(ctx, turn.operation);
    committed.push(turn.operation.actionName);
    const state: AgentState = {
      transcript: turn.transcript,
      call: { id: turn.call.id, name: turn.call.name },
    };
    const messages = persistAndResume(state, receipt);
    if (!messages) break;
    turn = await runAgentTurn({ modelClient: model, messages, tools: toolsForModel(), runAction });
  }
  return { executed, committed, safety, kind: turn.kind };
}

describe("offline smoke eval (deterministic, no model key)", () => {
  it("a safe-write read-then-act chain creates the entity and never previews", async () => {
    const fake = createFakeWorkspace({ clients: [{ id: "cl1", name: "Globex" }] });
    const { committed, safety, kind } = await runScripted(
      [
        call("clockify_clients_list", {}),
        call("clockify_tags_create", { name: "Globex" }),
        done("Created tag Globex."),
      ],
      fake,
    );
    expect(safety).toEqual([]);
    expect(committed).toEqual([]);
    expect(kind).toBe("final");
    expect(fake.state.tags.some((t) => t.name === "Globex")).toBe(true);
  });

  it("a risky write interrupts, then commits through the confirm choke point", async () => {
    const fake = createFakeWorkspace({
      tags: [
        { id: "t1", name: "urgent" },
        { id: "t2", name: "stale" },
      ],
    });
    const { committed, safety } = await runScripted(
      [call("clockify_tags_delete", { name: "stale" }), done("Deleted the stale tag.")],
      fake,
    );
    expect(safety).toEqual([]);
    expect(committed).toEqual(["clockify_tags_delete"]);
    expect(fake.state.tags.some((t) => t.id === "t2")).toBe(false);
  });
});
