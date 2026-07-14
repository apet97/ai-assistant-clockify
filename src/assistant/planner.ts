import { z } from "zod";
import type { ActionCatalogEntry } from "../harness/action.js";
import type { AdminPolicy } from "../harness/permissions.js";
import { toolsForModel } from "../harness/tools.js";
import { runAgentTurn, type AgentTurnResult, type RunAgentTurnInput } from "./agent-loop.js";
import type { ModelClient, ModelMessage, ToolDefinition } from "./model-client.js";
import { buildRepairMessage, buildSystemPrompt, buildToolSystemPrompt, type AuthClass } from "./prompts.js";

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

/**
 * The fields that shape the tool-calling system prompt + tool catalog, shared by
 * the single-turn ({@link PlanConversationInput}) and agentic
 * ({@link AgentConversationInput}) paths. {@link buildToolMessages} consumes
 * exactly these — so both paths build a byte-identical prompt and resolve the
 * same tool list.
 */
export interface ToolPromptInput {
  policy: AdminPolicy;
  /** Tool catalog (defaults to `toolsForModel()`); injectable for tests. */
  tools?: ToolDefinition[];
  /** Clockify auth class so the prompt can surface add-on platform restrictions. */
  authClass?: AuthClass;
  /** Server clock date (YYYY-MM-DD) so the model narrates the real date, not its cutoff. */
  currentDate?: string;
}

export interface PlanConversationInput extends ToolPromptInput {
  modelClient: ModelClient;
  messages: ModelMessage[];
  actionCatalog: ActionCatalogEntry[];
  /** Prefer native tool-calling when the client supports it (default true). */
  useTools?: boolean;
  /** Cooperative cancellation for provider work; never threaded into actions. */
  signal?: AbortSignal;
}

/**
 * Build the tool-calling request: the system prompt (prepended to the caller's
 * messages) plus the resolved tool catalog. Shared by single-turn
 * {@link planWithTools} and the agentic {@link runAgentConversation} so the model
 * always sees the same prompt + tools on a chat turn and its confirm resume — a
 * prerequisite for the prompt-cache-stable prefix.
 */
function buildToolMessages(input: ToolPromptInput & { messages: ModelMessage[] }): {
  messages: ModelMessage[];
  tools: ToolDefinition[];
} {
  const system = buildToolSystemPrompt({
    policy: input.policy,
    authClass: input.authClass,
    currentDate: input.currentDate,
  });
  return {
    messages: [{ role: "system", content: system }, ...input.messages],
    tools: input.tools ?? toolsForModel(),
  };
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
  extends Pick<RunAgentTurnInput, "modelClient" | "messages" | "runAction" | "onStep" | "maxSteps" | "signal">,
    ToolPromptInput {}

/**
 * Agentic planning entry (Phase 2b): the durable tool-loop with the SAME tool
 * system prompt as single-turn tool planning — the model is still sent only the
 * security framing, safety rules, and the admin's permissions, never secrets.
 * The caller supplies `runAction` (the harness trust boundary) and persists/
 * resumes the returned transcript on an interrupt.
 */
export async function runAgentConversation(input: AgentConversationInput): Promise<AgentTurnResult> {
  const { messages, tools } = buildToolMessages(input);
  return runAgentTurn({
    modelClient: input.modelClient,
    messages,
    tools,
    runAction: input.runAction,
    onStep: input.onStep,
    maxSteps: input.maxSteps,
    signal: input.signal,
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
  const { messages, tools } = buildToolMessages(input);
  const completion = await input.modelClient.completeWithTools!(messages, tools, input.signal);

  if (completion.toolCalls.length > 0) {
    return {
      kind: "actions",
      text: completion.text ?? "",
      actions: completion.toolCalls.map((call) => ({ name: call.name, arguments: call.arguments })),
    };
  }
  return { kind: "answer", text: completion.text ?? "" };
}

/**
 * Validated JSON-mode path (the original flow; one repair retry). NOT dead:
 * reached whenever the model client lacks `completeWithTools` — i.e. the
 * `gemini-cli` backend (LLM_PROVIDER=gemini-cli) or useTools:false/LLM_MODE=json.
 * Also imported directly by scripts/eval-planner.ts (via buildSystemPrompt).
 * Pinned by tests/unit/planner.test.ts + planner-tools.test.ts:61-80 — keep green.
 */
async function planWithJson(input: PlanConversationInput): Promise<ModelPlan> {
  const system = buildSystemPrompt({
    actionCatalog: input.actionCatalog,
    policy: input.policy,
    authClass: input.authClass,
  });
  const baseMessages: ModelMessage[] = [{ role: "system", content: system }, ...input.messages];

  const first = await input.modelClient.complete(baseMessages, undefined, input.signal);
  let parsed = parsePlan(first);

  if (!parsed.ok) {
    const repaired = await input.modelClient.complete(
      [
        ...baseMessages,
        { role: "assistant", content: first },
        { role: "user", content: buildRepairMessage(parsed.error) },
      ],
      undefined,
      input.signal,
    );
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
