import { z } from "zod";
import type { ActionCatalogEntry } from "../harness/action.js";
import type { AdminPolicy } from "../harness/permissions.js";
import { toolsForModel } from "../harness/tools.js";
import { runAgentTurn, type AgentTurnResult, type RunAgentTurnInput } from "./agent-loop.js";
import type { ModelClient, ModelMessage, ToolDefinition } from "./model-client.js";
import { buildRepairMessage, buildSystemPrompt, buildToolSystemPrompt } from "./prompts.js";

/**
 * Validated planning flow (SPEC "Chat Flow" steps 5–7). The model output must be
 * JSON; the planner validates it with Zod and retries exactly once with the
 * validation error. If still invalid, it returns a safe clarify result rather
 * than passing unstructured output downstream. The harness still re-validates
 * every proposed action (unknown names, policy, schema) before execution.
 */
export interface PlannedAction {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ModelPlan {
  kind: "answer" | "actions" | "clarify";
  text: string;
  actions?: PlannedAction[];
}

const modelPlanSchema = z
  .object({
    kind: z.enum(["answer", "actions", "clarify"]),
    text: z.string(),
    actions: z
      .array(
        z.object({
          name: z.string().min(1),
          arguments: z.record(z.string(), z.unknown()).default({}),
        }),
      )
      .optional(),
  })
  .refine((plan) => plan.kind !== "actions" || (plan.actions?.length ?? 0) > 0, {
    message: "kind 'actions' requires a non-empty actions array",
  });

export interface PlanConversationInput {
  modelClient: ModelClient;
  messages: ModelMessage[];
  actionCatalog: ActionCatalogEntry[];
  policy: AdminPolicy;
  /** Prefer native tool-calling when the client supports it (default true). */
  useTools?: boolean;
  /** Tool catalog (defaults to `toolsForModel()`); injectable for tests. */
  tools?: ToolDefinition[];
}

type ParseResult =
  | { ok: true; plan: ModelPlan }
  | { ok: false; error: string };

function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return (fenced ? fenced[1] : raw).trim();
}

function parsePlan(raw: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(extractJson(raw));
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "invalid JSON" };
  }
  const result = modelPlanSchema.safeParse(json);
  if (!result.success) {
    return { ok: false, error: result.error.issues.map((i) => i.message).join("; ") };
  }
  return { ok: true, plan: result.data };
}

export interface AgentConversationInput
  extends Pick<RunAgentTurnInput, "modelClient" | "messages" | "runAction" | "onStep" | "maxSteps"> {
  policy: AdminPolicy;
  /** Tool catalog (defaults to `toolsForModel()`); injectable for tests. */
  tools?: ToolDefinition[];
}

/**
 * Agentic planning entry (Phase 2b): the durable tool-loop with the SAME tool
 * system prompt as single-turn tool planning — the model is still sent only the
 * security framing, safety rules, and the admin's permissions, never secrets.
 * The caller supplies `runAction` (the harness trust boundary) and persists/
 * resumes the returned transcript on an interrupt.
 */
export async function runAgentConversation(input: AgentConversationInput): Promise<AgentTurnResult> {
  const system = buildToolSystemPrompt({ policy: input.policy });
  return runAgentTurn({
    modelClient: input.modelClient,
    messages: [{ role: "system", content: system }, ...input.messages],
    tools: input.tools ?? toolsForModel(),
    runAction: input.runAction,
    onStep: input.onStep,
    maxSteps: input.maxSteps,
  });
}

export async function planConversation(input: PlanConversationInput): Promise<ModelPlan> {
  const canUseTools = typeof input.modelClient.completeWithTools === "function";
  if ((input.useTools ?? true) && canUseTools) {
    return planWithTools(input);
  }
  return planWithJson(input);
}

/**
 * Native tool-calling path: the provider validates the model's arguments against
 * each tool's JSON schema before they reach us. Tool calls map straight to
 * proposed actions; a text-only reply is an answer/clarification. The harness
 * still re-validates and gates every proposed action (Zod + risk/policy).
 */
async function planWithTools(input: PlanConversationInput): Promise<ModelPlan> {
  const system = buildToolSystemPrompt({ policy: input.policy });
  const messages: ModelMessage[] = [{ role: "system", content: system }, ...input.messages];
  const tools = input.tools ?? toolsForModel();
  const completion = await input.modelClient.completeWithTools!(messages, tools);

  if (completion.toolCalls.length > 0) {
    return {
      kind: "actions",
      text: completion.text ?? "",
      actions: completion.toolCalls.map((call) => ({ name: call.name, arguments: call.arguments })),
    };
  }
  return { kind: "answer", text: completion.text ?? "" };
}

/** Validated JSON-mode path (the original flow; one repair retry). */
async function planWithJson(input: PlanConversationInput): Promise<ModelPlan> {
  const system = buildSystemPrompt({
    actionCatalog: input.actionCatalog,
    policy: input.policy,
  });
  const baseMessages: ModelMessage[] = [{ role: "system", content: system }, ...input.messages];

  const first = await input.modelClient.complete(baseMessages);
  let parsed = parsePlan(first);

  if (!parsed.ok) {
    const repaired = await input.modelClient.complete([
      ...baseMessages,
      { role: "assistant", content: first },
      { role: "user", content: buildRepairMessage(parsed.error) },
    ]);
    parsed = parsePlan(repaired);
  }

  if (!parsed.ok) {
    return {
      kind: "clarify",
      text: "I couldn't turn that into a valid plan. Could you rephrase your request?",
    };
  }

  return parsed.plan;
}
