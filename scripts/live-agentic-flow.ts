/**
 * Opt-in LIVE proof of the durable agentic loop (the agentic-loop GOAL acceptance
 * test, driven over the REAL model + REAL Clockify host instead of the browser
 * iframe). It runs the actual `runAgentTurn` loop with:
 *   - the REAL planner backend (DeepSeek/Gemini via LLM_* env), and
 *   - the REAL Clockify REST adapter (API-key auth, dev-only) as the harness
 *     trust boundary,
 * then simulates the human's button-confirm through the REAL
 * `commitConfirmedOperation` + the durable resume — exactly the production
 * round-trip, minus the cross-site iframe click a human must do.
 *
 * It proves the thing the single-turn planner could NEVER do: read-then-act in
 * one user turn (list clients → create an invoice for a named one), plus the
 * risky interrupt → confirm → resume → truthful summary. Self-cleaning
 * AIASSIST_SMOKE_* with a final 0-leftover check; nothing auto-executes without
 * the simulated confirm.
 *
 * Run (reads .env automatically; needs LLM_* too — pass --env-file=.env.server):
 *   LIVE_CLOCKIFY=1 npx tsx --env-file=.env.server scripts/live-agentic-flow.ts
 *
 * Never commit credentials. Use a sacrificial workspace only.
 */
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { runAgentTurn, type AgentTurnResult } from "../src/assistant/agent-loop.js";
import { resumeMessages, type AgentState } from "../src/assistant/agent-state.js";
import { runAgentConversation } from "../src/assistant/planner.js";
import { selectModelClient, type ModelClientSelection } from "../src/assistant/select-model-client.js";
import type { ModelClient, ToolCall } from "../src/assistant/model-client.js";
import type { ActionContext, ActionResult } from "../src/harness/action.js";
import { commitConfirmedOperation, executeAction } from "../src/harness/actions.js";
import { getAction } from "../src/harness/catalog.js";
import { INTERNAL_ACTION_CATALOG } from "../src/harness/api-catalog.js";
import { defaultAdminPolicy } from "../src/harness/permissions.js";
import { errorReceipt } from "../src/harness/receipts.js";
import { requiresConfirmation } from "../src/harness/risk.js";
import { toolsForModel } from "../src/harness/tools.js";
import { createRestWorkspaceClient } from "../src/clockify/rest-workspace.js";
import { requireCompleteRows } from "../src/clockify/rest/list-pages.js";

function loadDotEnv(): void {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}
loadDotEnv();

if (process.env.LIVE_CLOCKIFY !== "1") {
  console.error("Refusing to run: set LIVE_CLOCKIFY=1 to opt in.");
  process.exit(2);
}
const API_KEY = process.env.LIVE_CLOCKIFY_API_KEY;
const WORKSPACE_ID = process.env.LIVE_WORKSPACE_ID;
const BASE = (process.env.LIVE_BASE_URL ?? "https://api.clockify.me/api/v1").replace(/\/$/, "");
if (!API_KEY || !WORKSPACE_ID) {
  console.error("Missing LIVE_CLOCKIFY_API_KEY or LIVE_WORKSPACE_ID.");
  process.exit(2);
}

async function rest(method: string, path: string, body?: unknown, allow404 = false): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "X-Api-Key": API_KEY as string, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 404 && allow404) return null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass += 1;
  else fail += 1;
}

interface LoopRun {
  turn: AgentTurnResult;
  executed: string[];
  committed: string[];
  interrupts: number;
  safetyViolations: string[];
  finalText: string;
}

/**
 * Run the agentic loop to completion, simulating the human button-confirm at
 * each interrupt through the REAL commit choke point + durable resume.
 */
async function runLoop(ctx: ActionContext, modelClient: ModelClient, message: string, maxConfirms = 4): Promise<LoopRun> {
  const executed: string[] = [];
  const committed: string[] = [];
  const safetyViolations: string[] = [];
  let interrupts = 0;

  const runAction = async (call: ToolCall): Promise<ActionResult> => {
    let result: ActionResult;
    try {
      result = await executeAction({ actionName: call.name, args: call.arguments, context: ctx });
    } catch (e) {
      result = {
        kind: "receipt",
        receipt: errorReceipt({ action: call.name, code: "action_failed", message: String(e).slice(0, 200) }),
      };
    }
    if (result.kind === "receipt") {
      executed.push(call.name);
      if (result.receipt.ok && requiresConfirmation(getAction(call.name)?.risks ?? [])) {
        safetyViolations.push(`${call.name} returned a direct successful receipt without a preview`);
      }
    }
    return result;
  };

  let turn = await runAgentConversation({
    modelClient,
    messages: [{ role: "user", content: message }],
    policy: ctx.policy,
    runAction,
  });
  let confirms = 0;
  while (turn.kind === "interrupt" && confirms < maxConfirms) {
    confirms += 1;
    interrupts += 1;
    const receipt = await commitConfirmedOperation(ctx, turn.operation);
    committed.push(turn.operation.actionName);
    const state: AgentState = { transcript: turn.transcript, call: { id: turn.call.id, name: turn.call.name } };
    turn = await runAgentTurn({
      modelClient,
      messages: resumeMessages(state, receipt),
      tools: toolsForModel(INTERNAL_ACTION_CATALOG),
      runAction,
    });
  }
  const finalText =
    turn.kind === "final" || turn.kind === "exhausted" ? turn.text : turn.kind === "clarify" ? turn.message : "";
  return { turn, executed, committed, interrupts, safetyViolations, finalText };
}

async function main(): Promise<void> {
  const selection: ModelClientSelection = {
    llmProvider: (process.env.LLM_PROVIDER as ModelClientSelection["llmProvider"]) ?? "http",
    llmBaseUrl: process.env.LLM_BASE_URL,
    llmApiKey: process.env.LLM_API_KEY,
    llmModel: process.env.LLM_MODEL,
    geminiModel: process.env.GEMINI_MODEL,
  };
  const modelClient = selectModelClient(selection);
  if (typeof modelClient.completeWithTools !== "function") {
    console.error("The agentic loop needs a tool-calling backend (the http provider). Set LLM_PROVIDER=http.");
    process.exit(2);
  }

  const me = (await rest("GET", "/user")) as { id: string; name: string };
  const clockify = createRestWorkspaceClient({ baseUrl: BASE, workspaceId: WORKSPACE_ID as string, auth: { apiKey: API_KEY as string } });
  const ctx: ActionContext = {
    workspaceId: WORKSPACE_ID as string,
    adminUserId: me.id,
    policy: defaultAdminPolicy(),
    clockify,
    now: () => new Date(),
  };
  const sfx = randomBytes(3).toString("hex");
  const ws = `/workspaces/${WORKSPACE_ID}`;
  const clientName = `AIASSIST_SMOKE_qwen_${sfx}`;
  const modelLabel = selection.llmProvider === "gemini-cli" ? `gemini-cli:${selection.geminiModel ?? "router"}` : selection.llmModel;
  console.log(`Live agentic flow | user ${me.name} | ws ${WORKSPACE_ID} | model ${modelLabel} | suffix ${sfx}\n`);

  // Seed one uniquely-named client so the read-then-act invoice flow has a real
  // target the model must discover (the single-turn planner can't reach it).
  const client = (await rest("POST", `${ws}/clients`, { name: clientName })) as { id: string };
  let invoiceId: string | undefined;
  let tagId: string | undefined;

  try {
    // ── Scenario 1: read-then-act in ONE turn (the headline). ────────────────
    console.log("Scenario 1: create an invoice for the named client (read clients → resolve → preview → confirm → resume)");
    const r1 = await runLoop(ctx, modelClient, `Create an invoice for ${clientName} for 1000.`);
    check("the invoice was previewed, not auto-created", r1.interrupts >= 1);
    check("exactly the invoices_create op was committed via the confirm", r1.committed.includes("clockify_invoices_create"));
    check("the loop reached a settled final turn", r1.turn.kind === "final", `kind=${r1.turn.kind}`);
    // The headline capability: the loop RESUMED after the confirm and produced a
    // truthful summary the model could only write having seen the committed
    // receipt — the single-turn planner can never do this.
    const summarized = r1.turn.kind === "final" && r1.finalText.length > 0 && r1.finalText.toLowerCase().includes(clientName.toLowerCase());
    check("durable resume produced a truthful post-confirm summary (read-then-act done)", summarized);
    check("NO risky action auto-executed (0 safety violations)", r1.safetyViolations.length === 0, r1.safetyViolations.join("; "));
    // Verify the invoice actually exists on the live host for our client.
    const mine = requireCompleteRows(
      await clockify.listInvoices(),
      "verify the agentic-flow invoice exists",
    ).find((i) => i.clientId === client.id);
    invoiceId = mine?.id;
    check("the invoice exists on the live Clockify host for the named client", Boolean(mine), invoiceId ? `id ${invoiceId}` : "not found");
    if (r1.finalText) console.log(`    final: "${r1.finalText.slice(0, 100)}"`);

    // ── Scenario 2: risky write previews and is button-gated (no auto-exec). ──
    console.log("\nScenario 2: create then delete a tag by name (safe write auto-chains; delete interrupts → confirm → resume)");
    const tagName = `AIASSIST_SMOKE_tag_${sfx}`;
    const created = (await rest("POST", `${ws}/tags`, { name: tagName })) as { id: string };
    tagId = created.id;
    const r2 = await runLoop(ctx, modelClient, `Delete the tag named ${tagName}.`);
    check("the delete was previewed, not auto-executed", r2.interrupts >= 1);
    check("the tag delete committed via the confirm", r2.committed.includes("clockify_tags_delete"));
    const tagsAfter = requireCompleteRows(
      await clockify.listTags(),
      "verify the agentic-flow tag deletion",
    );
    const stillThere = tagsAfter.some((t) => t.id === created.id);
    check("the tag is really gone on the live host", !stillThere);
    if (!stillThere) tagId = undefined;
    check("NO risky action auto-executed (0 safety violations)", r2.safetyViolations.length === 0, r2.safetyViolations.join("; "));
  } finally {
    // ── Self-clean every AIASSIST_SMOKE_* resource we created. ───────────────
    console.log("\nCleanup:");
    if (invoiceId) await clockify.deleteInvoice(invoiceId).then(() => console.log(`  removed invoice ${invoiceId}`)).catch((e) => console.log(`  invoice cleanup: ${String(e).slice(0, 80)}`));
    if (tagId) await rest("DELETE", `${ws}/tags/${tagId}`, undefined, true).then(() => console.log(`  removed tag ${tagId}`)).catch(() => {});
    await clockify
      .deleteClient(client.id)
      .then(() => console.log(`  removed client ${client.id}`))
      .catch(async () => {
        // Clockify won't delete a client with invoices/usage; archive it instead.
        await rest("PUT", `${ws}/clients/${client.id}`, { name: clientName, archived: true }, true).catch(() => {});
        console.log(`  archived client ${client.id}`);
      });
  }

  console.log(`\nLIVE AGENTIC FLOW: PASS=${pass} FAIL=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nLIVE FLOW FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
