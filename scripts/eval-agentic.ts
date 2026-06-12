/**
 * Multi-step task-completion eval (Phase 5 of the agentic roadmap). Drives the
 * REAL model + the REAL harness (executeAction / commitConfirmedOperation)
 * against the in-memory fake workspace — NO Clockify calls — and scores each
 * case's TERMINAL outcome (end state + safety), not the first tool call.
 *
 * Two modes, so the lift over the old architecture is a measured number:
 *   - agentic (default): runAgentConversation; every interrupt is "confirmed"
 *     through the real commit choke point, then the loop RESUMES — exactly the
 *     production round-trip.
 *   - single-turn baseline (--single-turn): ONE planConversation, its actions
 *     executed once (previews generously auto-confirmed), no feedback, no
 *     resume — the pre-loop architecture.
 *
 * Safety meter: a confirmation-required action that ever returns a direct
 * successful receipt inside a loop turn is counted as a SAFETY VIOLATION and
 * fails the whole run. Expected: 0, always.
 *
 * Run (creds come from the env file, never echoed):
 *   npx tsx --env-file=.env.server scripts/eval-agentic.ts --repeat=3
 *   npx tsx --env-file=.env.server scripts/eval-agentic.ts --repeat=3 --single-turn
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { runAgentTurn, type AgentTurnResult } from "../src/assistant/agent-loop.js";
import { resumeMessages, type AgentState } from "../src/assistant/agent-state.js";
import type { ModelClient, ToolCall } from "../src/assistant/model-client.js";
import { planConversation, runAgentConversation } from "../src/assistant/planner.js";
import { selectModelClient, type ModelClientSelection } from "../src/assistant/select-model-client.js";
import type { ActionContext, ActionResult } from "../src/harness/action.js";
import { commitConfirmedOperation, executeAction } from "../src/harness/actions.js";
import { catalogForModel, getAction } from "../src/harness/catalog.js";
import { defaultAdminPolicy } from "../src/harness/permissions.js";
import { errorReceipt } from "../src/harness/receipts.js";
import { requiresConfirmation } from "../src/harness/risk.js";
import { toolsForModel } from "../src/harness/tools.js";
import { createFakeWorkspace } from "../tests/helpers/fake-clockify.js";
import { AGENTIC_CASES, type AgenticCase, type AgenticOutcome } from "./eval/agentic-cases.js";

interface Flags {
  repeat: number;
  only?: string;
  concurrency: number;
  singleTurn: boolean;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { repeat: 1, concurrency: 4, singleTurn: false };
  for (const arg of argv) {
    const repeat = arg.match(/^--repeat=(\d+)$/);
    const only = arg.match(/^--only=(.+)$/);
    const conc = arg.match(/^--concurrency=(\d+)$/);
    if (repeat) flags.repeat = Math.max(1, Number(repeat[1]));
    else if (only) flags.only = only[1];
    else if (conc) flags.concurrency = Math.max(1, Number(conc[1]));
    else if (arg === "--single-turn") flags.singleTurn = true;
  }
  return flags;
}

function makeContext(fake: ReturnType<typeof createFakeWorkspace>): ActionContext {
  return {
    workspaceId: "eval-ws",
    adminUserId: "eval-admin",
    policy: defaultAdminPolicy(),
    clockify: fake.client,
    now: () => new Date(),
  };
}

interface CaseRun {
  outcome: AgenticOutcome;
  safetyViolations: string[];
}

async function runAgenticCase(modelClient: ModelClient, c: AgenticCase): Promise<CaseRun> {
  const fake = createFakeWorkspace(c.seed);
  const ctx = makeContext(fake);
  const executed: string[] = [];
  const committed: string[] = [];
  const safetyViolations: string[] = [];
  let interrupts = 0;

  const runAction = async (call: ToolCall): Promise<ActionResult> => {
    let result: ActionResult;
    try {
      result = await executeAction({ actionName: call.name, args: call.arguments, context: ctx });
    } catch (err) {
      result = {
        kind: "receipt",
        receipt: errorReceipt({
          action: call.name,
          code: "action_failed",
          message: (err instanceof Error ? err.message : "failed").slice(0, 200),
        }),
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

  try {
    let turn: AgentTurnResult = await runAgentConversation({
      modelClient,
      messages: [{ role: "user", content: c.message }],
      policy: ctx.policy,
      runAction,
    });
    const maxConfirms = c.maxConfirms ?? 3;
    let confirms = 0;
    while (turn.kind === "interrupt" && confirms < maxConfirms) {
      confirms += 1;
      interrupts += 1;
      // The human clicks Confirm: the REAL commit choke point, then resume.
      const receipt = await commitConfirmedOperation(ctx, turn.operation);
      committed.push(turn.operation.actionName);
      const state: AgentState = { transcript: turn.transcript, call: { id: turn.call.id, name: turn.call.name } };
      turn = await runAgentTurn({
        modelClient,
        messages: resumeMessages(state, receipt),
        tools: toolsForModel(),
        runAction,
      });
    }
    const kind: AgenticOutcome["kind"] =
      turn.kind === "interrupt" ? "interrupted" : turn.kind === "final" ? "final" : turn.kind;
    if (turn.kind === "interrupt") interrupts += 1;
    const finalText =
      turn.kind === "final" || turn.kind === "exhausted" ? turn.text : turn.kind === "clarify" ? turn.message : "";
    return { outcome: { kind, finalText, executed, committed, interrupts, fake }, safetyViolations };
  } catch (err) {
    return {
      outcome: {
        kind: "error",
        finalText: err instanceof Error ? err.message : String(err),
        executed,
        committed,
        interrupts,
        fake,
      },
      safetyViolations,
    };
  }
}

/** The pre-loop architecture: one plan, executed once, previews auto-confirmed, no feedback. */
async function runSingleTurnCase(modelClient: ModelClient, c: AgenticCase): Promise<CaseRun> {
  const fake = createFakeWorkspace(c.seed);
  const ctx = makeContext(fake);
  const executed: string[] = [];
  const committed: string[] = [];
  const safetyViolations: string[] = [];
  let interrupts = 0;
  let clarified = false;
  let text = "";

  try {
    const plan = await planConversation({
      modelClient,
      messages: [{ role: "user", content: c.message }],
      actionCatalog: catalogForModel(),
      policy: ctx.policy,
      useTools: true,
    });
    text = plan.text ?? "";
    clarified = plan.kind === "clarify";
    if (plan.kind === "actions" && plan.actions) {
      for (const a of plan.actions) {
        let outcome: ActionResult;
        try {
          outcome = await executeAction({ actionName: a.name, args: a.arguments, context: ctx });
        } catch {
          continue;
        }
        if (outcome.kind === "receipt") {
          executed.push(a.name);
          if (outcome.receipt.ok && requiresConfirmation(getAction(a.name)?.risks ?? [])) {
            safetyViolations.push(`${a.name} returned a direct successful receipt without a preview`);
          }
        } else if (outcome.kind === "clarify") {
          clarified = true;
        } else {
          interrupts += 1;
          // Generous to the baseline: the human confirms every preview.
          await commitConfirmedOperation(ctx, outcome.operation).catch(() => undefined);
          committed.push(outcome.operation.actionName);
        }
      }
    }
  } catch (err) {
    return {
      outcome: { kind: "error", finalText: String(err), executed, committed, interrupts, fake },
      safetyViolations,
    };
  }
  return {
    outcome: { kind: clarified ? "clarify" : "final", finalText: text, executed, committed, interrupts, fake },
    safetyViolations,
  };
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const selection: ModelClientSelection = {
    llmProvider: (process.env.LLM_PROVIDER as ModelClientSelection["llmProvider"]) ?? "http",
    llmBaseUrl: process.env.LLM_BASE_URL,
    llmApiKey: process.env.LLM_API_KEY,
    llmModel: process.env.LLM_MODEL,
    llmReasoningEffort: process.env.LLM_REASONING_EFFORT,
    geminiModel: process.env.GEMINI_MODEL,
  };

  let modelClient: ModelClient;
  try {
    modelClient = selectModelClient(selection);
    // Two-tier routing experiment: EVAL_PLAN_MODEL handles PLANNING calls (no
    // tool results in the transcript yet) and EVAL_IMPL_MODEL the continuation/
    // implementation calls (any transcript carrying a role:"tool" message —
    // which is also every resume). Eval-only; the product stays single-model.
    const planModel = process.env.EVAL_PLAN_MODEL;
    const implModel = process.env.EVAL_IMPL_MODEL;
    if (planModel && implModel) {
      const plan = selectModelClient({ ...selection, llmModel: planModel });
      const impl = selectModelClient({ ...selection, llmModel: implModel });
      console.log(`mixed-tier routing: plan=${planModel} impl=${implModel}`);
      modelClient = {
        complete: (messages) => plan.complete(messages),
        completeWithTools: (messages, tools) => {
          const continuation = messages.some((m) => m.role === "tool");
          return (continuation ? impl : plan).completeWithTools!(messages, tools);
        },
      };
    }
  } catch (err) {
    console.error(
      `Refusing to run: ${err instanceof Error ? err.message : String(err)}\n` +
        "Set LLM_* in a gitignored env file (e.g. --env-file=.env.server).",
    );
    process.exit(2);
  }
  if (typeof modelClient.completeWithTools !== "function" && !flags.singleTurn) {
    console.error("The agentic eval needs a tool-calling backend (the http provider).");
    process.exit(2);
  }

  const cases = flags.only ? AGENTIC_CASES.filter((c) => c.id.includes(flags.only!)) : AGENTIC_CASES;
  if (cases.length === 0) {
    console.error(`No cases match --only=${flags.only}.`);
    process.exit(2);
  }

  const mode = flags.singleTurn ? "single-turn" : "agentic";
  const modelLabel =
    selection.llmProvider === "gemini-cli" ? `gemini-cli:${selection.geminiModel ?? "router"}` : selection.llmModel ?? "?";
  console.log(
    `Running ${mode} task-completion eval: provider=${selection.llmProvider} model=${modelLabel} ` +
      `cases=${cases.length} repeat=${flags.repeat} concurrency=${flags.concurrency}\n`,
  );

  const units: { c: AgenticCase; run: number }[] = [];
  for (const c of cases) for (let run = 0; run < flags.repeat; run += 1) units.push({ c, run });

  let done = 0;
  const runs = await mapWithConcurrency(units, flags.concurrency, async ({ c }) => {
    const result = flags.singleTurn ? await runSingleTurnCase(modelClient, c) : await runAgenticCase(modelClient, c);
    const reasons = c.check(result.outcome);
    if (result.outcome.kind === "error" && result.outcome.finalText) {
      reasons.push(`error: ${result.outcome.finalText.slice(0, 160)}`);
    }
    done += 1;
    process.stdout.write(`\r  ${done}/${units.length} runs complete`);
    return { caseId: c.id, area: c.area, pass: reasons.length === 0, reasons, safety: result.safetyViolations };
  });
  process.stdout.write("\n\n");

  const byCase = new Map<string, typeof runs>();
  for (const r of runs) {
    const list = byCase.get(r.caseId) ?? [];
    list.push(r);
    byCase.set(r.caseId, list);
  }

  console.log("id (area)                                  pass    sample failure");
  console.log("-".repeat(100));
  const reports = cases.map((c) => {
    const list = byCase.get(c.id) ?? [];
    const passCount = list.filter((r) => r.pass).length;
    const sample = list.find((r) => !r.pass)?.reasons ?? [];
    const flag = passCount === list.length ? "  " : "✗ ";
    console.log(
      `${flag}${`${c.id} (${c.area})`.padEnd(42)} ${`${passCount}/${list.length}`.padEnd(7)} ${sample.join("; ").slice(0, 60)}`,
    );
    return { id: c.id, area: c.area, passCount, repeat: list.length, sampleReasons: sample };
  });

  const totalRuns = runs.length;
  const passRuns = runs.filter((r) => r.pass).length;
  const safetyViolations = runs.flatMap((r) => r.safety.map((s) => `${r.caseId}: ${s}`));

  console.log(
    `\nAGENTIC EVAL (${mode}): ${passRuns}/${totalRuns} (${pct(totalRuns ? passRuns / totalRuns : 0)}) ` +
      `| safety violations: ${safetyViolations.length}`,
  );
  for (const v of safetyViolations) console.log(`  !! SAFETY: ${v}`);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  mkdirSync("eval-results", { recursive: true });
  const outFile = `eval-results/agentic-${mode}-${stamp}.json`;
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        kind: "agentic-task-completion",
        mode,
        provider: selection.llmProvider,
        model: modelLabel,
        repeat: flags.repeat,
        summary: { totalRuns, passRuns, passRate: totalRuns ? passRuns / totalRuns : 0, safetyViolations: safetyViolations.length },
        reports,
      },
      null,
      2,
    ),
  );
  console.log(`\nWrote ${outFile}`);
  if (safetyViolations.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\nEVAL FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
