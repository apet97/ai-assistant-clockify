/**
 * Planner eval harness (Phase 1A — the meter). Opt-in, planning-only: it drives
 * the REAL planner (`planConversation` + its Zod validation and single repair)
 * over the `EVAL_CASES` corpus and scores each plan with the pure `scoreCase`.
 * It performs NO Clockify writes — the harness/handlers are never invoked, only
 * the model's proposal is scored.
 *
 * Two numbers, because temperature-0 is "mostly" deterministic, not perfectly so:
 *   - pass-rate    — did the planner pick the right action + arg shape?
 *   - consistency  — across --repeat runs, how often did it produce the IDENTICAL
 *                    action+arg-keys? (outcome determinism is the real goal)
 *
 * The model is given ONLY the action catalog + admin policy — never a token,
 * session secret, or raw header. Nothing that could leak a secret is printed.
 *
 * Run (creds come from the env file, never echoed):
 *   npx tsx --env-file=.env.server scripts/eval-planner.ts
 *   npx tsx --env-file=.env.server scripts/eval-planner.ts --repeat=3 --only=compose
 *
 * Flags: --repeat=N (default 1), --only=<area>, --concurrency=N (default 6).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { selectModelClient, type ModelClientSelection } from "../src/assistant/select-model-client.js";
import type { ModelClient } from "../src/assistant/model-client.js";
import { planConversation, type ModelPlan } from "../src/assistant/planner.js";
import { buildSystemPrompt } from "../src/assistant/prompts.js";
import { catalogForModel, getAction } from "../src/harness/catalog.js";
import { defaultAdminPolicy } from "../src/harness/permissions.js";
import { scoreCase } from "../src/eval/score.js";
import { EVAL_CASES, type EvalCase } from "./eval/cases.js";

interface Flags {
  repeat: number;
  only?: string;
  concurrency: number;
  /** A/B baseline: blank every action's arg signature so the model sees no arg
   *  contract (≈ pre-1B). Only affects JSON mode (tool mode carries schemas). */
  noArgs: boolean;
  /** Force the JSON + repair path instead of native tool-calling (Phase 2 A/B). */
  jsonMode: boolean;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { repeat: 1, concurrency: 6, noArgs: false, jsonMode: false };
  for (const arg of argv) {
    const repeat = arg.match(/^--repeat=(\d+)$/);
    const only = arg.match(/^--only=(.+)$/);
    const conc = arg.match(/^--concurrency=(\d+)$/);
    if (repeat) flags.repeat = Math.max(1, Number(repeat[1]));
    else if (only) flags.only = only[1];
    else if (conc) flags.concurrency = Math.max(1, Number(conc[1]));
    else if (arg === "--no-args") flags.noArgs = true;
    else if (arg === "--json-mode") flags.jsonMode = true;
  }
  return flags;
}

function riskFor(actionName: string): readonly string[] {
  return getAction(actionName)?.risks ?? [];
}

/** Canonical "action+arg-keys" identity for the consistency metric. */
function planSignature(plan: ModelPlan): string {
  if (plan.kind !== "actions" || !plan.actions?.length) return `:${plan.kind}`;
  return plan.actions
    .map((a) => `${a.name}(${Object.keys(a.arguments ?? {}).sort().join(",")})`)
    .join(" + ");
}

function describeExpect(c: EvalCase): string {
  const e = c.expect;
  const parts: string[] = [];
  if (e.action) parts.push(e.action);
  if (e.anyAction?.length) parts.push(`anyOf[${e.anyAction.join("|")}]`);
  if (e.kind) parts.push(`kind=${e.kind}`);
  if (e.noDestructive) parts.push("noDestructive");
  if (e.args) {
    const a = e.args;
    const bits = [
      ...(a.present ?? []).map((k) => k),
      ...(a.presentAny ?? []).map((k) => `${k}?`),
      ...Object.keys(a.equals ?? {}).map((k) => `${k}=`),
    ];
    if (bits.length) parts.push(`args{${bits.join(",")}}`);
  }
  return parts.join(" ");
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

interface RunOutcome {
  caseId: string;
  pass: boolean;
  signature: string;
  reasons: string[];
}

interface CaseReport {
  id: string;
  area: string;
  expected: string;
  passCount: number;
  repeat: number;
  consistency: number; // modal-signature fraction in [0,1]
  modalSignature: string;
  signatures: Record<string, number>;
  sampleReasons: string[];
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
  } catch (err) {
    console.error(
      `Refusing to run: ${err instanceof Error ? err.message : String(err)}\n` +
        "Set LLM_* in a gitignored env file (e.g. --env-file=.env.server).",
    );
    process.exit(2);
  }

  const cases = flags.only ? EVAL_CASES.filter((c) => c.area === flags.only) : EVAL_CASES;
  if (cases.length === 0) {
    console.error(`No cases for --only=${flags.only}. Areas: ${[...new Set(EVAL_CASES.map((c) => c.area))].join(", ")}`);
    process.exit(2);
  }

  const actionCatalog = flags.noArgs
    ? catalogForModel().map((e) => ({ ...e, args: "" }))
    : catalogForModel();
  const policy = defaultAdminPolicy();
  const modelLabel =
    selection.llmProvider === "gemini-cli" ? `gemini-cli:${selection.geminiModel ?? "router"}` : selection.llmModel ?? "?";

  // Record the system-prompt size (Phase 1B token delta is read from here).
  const systemPrompt = buildSystemPrompt({ actionCatalog, policy });
  const promptTokensEst = Math.round(systemPrompt.length / 4);

  const planMode = flags.jsonMode ? "json" : "tool-calling";
  console.log(
    `Running planner eval: provider=${selection.llmProvider} model=${modelLabel} mode=${planMode} ` +
      `cases=${cases.length} repeat=${flags.repeat} concurrency=${flags.concurrency}` +
      `${flags.jsonMode && flags.noArgs ? " [--no-args: arg contract OFF]" : ""}`,
  );
  console.log(`System prompt: ${systemPrompt.length} chars (~${promptTokensEst} tokens)\n`);

  // Flatten (case × repeat) into independent run units.
  const units: { c: EvalCase; run: number }[] = [];
  for (const c of cases) for (let run = 0; run < flags.repeat; run += 1) units.push({ c, run });

  let done = 0;
  const outcomes = await mapWithConcurrency(units, flags.concurrency, async ({ c }): Promise<RunOutcome> => {
    const messages = [...(c.history ?? []), { role: "user" as const, content: c.message }];
    let plan: ModelPlan;
    try {
      plan = await planConversation({ modelClient, messages, actionCatalog, policy, useTools: !flags.jsonMode });
    } catch (err) {
      plan = { kind: "clarify", text: `eval-error: ${err instanceof Error ? err.message : String(err)}` };
    }
    const scored = scoreCase(plan, c.expect, { riskFor });
    done += 1;
    process.stdout.write(`\r  ${done}/${units.length} runs complete`);
    return { caseId: c.id, pass: scored.pass, signature: planSignature(plan), reasons: scored.reasons };
  });
  process.stdout.write("\n\n");

  // Aggregate per case.
  const byCase = new Map<string, RunOutcome[]>();
  for (const o of outcomes) {
    const list = byCase.get(o.caseId) ?? [];
    list.push(o);
    byCase.set(o.caseId, list);
  }

  const reports: CaseReport[] = cases.map((c) => {
    const runs = byCase.get(c.id) ?? [];
    const passCount = runs.filter((r) => r.pass).length;
    const sigCounts: Record<string, number> = {};
    for (const r of runs) sigCounts[r.signature] = (sigCounts[r.signature] ?? 0) + 1;
    const modal = Object.entries(sigCounts).sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
    const sampleReasons = runs.find((r) => !r.pass)?.reasons ?? [];
    return {
      id: c.id,
      area: c.area,
      expected: describeExpect(c),
      passCount,
      repeat: runs.length,
      consistency: runs.length ? modal[1] / runs.length : 0,
      modalSignature: modal[0],
      signatures: sigCounts,
      sampleReasons,
    };
  });

  const totalRuns = outcomes.length;
  const passRuns = outcomes.filter((o) => o.pass).length;
  const passRate = totalRuns ? passRuns / totalRuns : 0;
  const meanConsistency = reports.length ? reports.reduce((s, r) => s + r.consistency, 0) / reports.length : 0;
  const stablePass = reports.filter((r) => r.passCount === r.repeat).length;

  // Failures / variance table (worst first).
  const ranked = [...reports].sort(
    (a, b) => a.passCount / a.repeat - b.passCount / b.repeat || a.consistency - b.consistency,
  );
  console.log("id (area)                              pass    consist  expected → most-common-got");
  console.log("-".repeat(110));
  for (const r of ranked) {
    const got = r.modalSignature || "(none)";
    const flag = r.passCount === r.repeat ? "  " : "✗ ";
    const line =
      `${flag}${r.id.padEnd(34)} ${`${r.passCount}/${r.repeat}`.padEnd(7)} ` +
      `${pct(r.consistency).padEnd(8)} ${r.expected} → ${got}`;
    console.log(line.length > 160 ? `${line.slice(0, 159)}…` : line);
    if (r.passCount !== r.repeat && r.sampleReasons.length) {
      console.log(`     ↳ ${r.sampleReasons.join("; ")}`);
    }
  }

  console.log(
    `\nPLANNER EVAL: ${passRuns}/${totalRuns} (${pct(passRate)}) | consistency ${pct(meanConsistency)}  ` +
      `[cases=${cases.length} repeat=${flags.repeat} stable-pass=${stablePass}/${cases.length}]`,
  );

  // Persist for trend tracking (gitignored).
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = "eval-results";
  mkdirSync(outDir, { recursive: true });
  const outFile = `${outDir}/${stamp}.json`;
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        provider: selection.llmProvider,
        model: modelLabel,
        planMode,
        argContract: flags.jsonMode && flags.noArgs ? "off" : "on",
        repeat: flags.repeat,
        only: flags.only ?? null,
        systemPromptChars: systemPrompt.length,
        systemPromptTokensEst: promptTokensEst,
        summary: { totalRuns, passRuns, passRate, meanConsistency, stablePass, cases: cases.length },
        reports,
      },
      null,
      2,
    ),
  );
  console.log(`\nWrote ${outFile}`);
}

main().catch((err) => {
  console.error("\nEVAL FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
