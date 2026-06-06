import { z } from "zod";
import type { ActionCatalogEntry } from "../harness/action.js";
import type { AdminPolicy } from "../harness/permissions.js";
import type { ModelClient, ModelMessage } from "./model-client.js";
import { buildRepairMessage, buildSystemPrompt } from "./prompts.js";

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

export async function planConversation(input: PlanConversationInput): Promise<ModelPlan> {
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
