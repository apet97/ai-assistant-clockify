/**
 * Opt-in live model (planner) smoke. Drives the REAL planner (planConversation +
 * its Zod validation and single repair retry) against a configured
 * OpenAI-compatible chat endpoint. The model is given ONLY the action catalog +
 * admin policy — never a token, session secret, or any raw header.
 *
 * The model is proposal-only: this smoke just proves the planner returns a valid
 * ModelPlan (answer | actions | clarify) and never crashes on bad model JSON (it
 * falls back to a safe clarify). The harness still re-validates and gates every
 * proposed action elsewhere; this script does NOT execute any action.
 *
 * Run (put the vars in a gitignored .env, or pass inline):
 *   LLM_BASE_URL=... LLM_API_KEY=... LLM_MODEL=... npx tsx scripts/chat-smoke.ts
 *   npx tsx scripts/chat-smoke.ts "review my time entries for today"
 *
 * The API key is sent only in the LLM Authorization header and is never printed.
 */
import { existsSync, readFileSync } from "node:fs";
import { createModelClient } from "../src/assistant/model-client.js";
import { planConversation } from "../src/assistant/planner.js";
import { catalogForModel } from "../src/harness/catalog.js";
import { INTERNAL_ACTION_CATALOG } from "../src/harness/api-catalog.js";
import { defaultAdminPolicy } from "../src/harness/permissions.js";

// Load a gitignored .env (KEY=VALUE lines). Existing process.env always wins.
// Key values (incl. LLM_API_KEY) are never echoed.
function loadDotEnv(): void {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}
loadDotEnv();

const BASE_URL = process.env.LLM_BASE_URL;
const API_KEY = process.env.LLM_API_KEY;
const MODEL = process.env.LLM_MODEL;
if (!BASE_URL || !API_KEY || !MODEL) {
  console.error(
    "Refusing to run: set LLM_BASE_URL, LLM_API_KEY, and LLM_MODEL (e.g. in a gitignored .env) to run the live chat smoke.",
  );
  process.exit(2);
}

const PROMPT = process.argv.slice(2).join(" ") || "create a tag called Deep Work";

async function main(): Promise<void> {
  const modelClient = createModelClient({
    baseUrl: BASE_URL as string,
    apiKey: API_KEY as string,
    model: MODEL as string,
  });
  console.log(`Model: ${MODEL} | prompt: ${JSON.stringify(PROMPT)}\n`);

  const plan = await planConversation({
    modelClient,
    messages: [{ role: "user", content: PROMPT }],
    actionCatalog: catalogForModel(INTERNAL_ACTION_CATALOG),
    policy: defaultAdminPolicy(),
  });

  // The planner already validates + repairs; reaching here means a valid ModelPlan.
  const validKinds = ["answer", "actions", "clarify"];
  if (!validKinds.includes(plan.kind)) {
    throw new Error(`planner returned an invalid kind: ${String(plan.kind)}`);
  }
  console.log("plan.kind: ", plan.kind);
  console.log("plan.text: ", plan.text);
  if (plan.actions?.length) {
    console.log("proposed actions:", plan.actions.map((a) => a.name).join(", "));
  }
  console.log(
    "\nCHAT SMOKE PASSED: planner produced a valid plan; only the catalog + policy were sent to the model (no token), and nothing was printed that could leak a secret.",
  );
}

main().catch((err) => {
  console.error("CHAT SMOKE FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
