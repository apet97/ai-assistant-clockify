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
import { dirname } from "node:path";
import type { ModelClientSelection } from "../src/assistant/select-model-client.js";
import type { ModelClient } from "../src/assistant/model-client.js";
import { planConversation, type ModelPlan } from "../src/assistant/planner.js";
import { buildSystemPrompt } from "../src/assistant/prompts.js";
import { catalogForModel, getAction } from "../src/harness/catalog.js";
import { toolsForModel } from "../src/harness/tools.js";
import { selectActionsForMessage } from "../src/harness/tool-select.js";
import { selectEvalModelClient } from "./eval/model-client.js";
import { trackUsage } from "../src/assistant/usage.js";
import { defaultAdminPolicy } from "../src/harness/permissions.js";
import { scoreCase } from "../src/eval/score.js";
import { consistencyStats, mean } from "../src/eval/consistency.js";
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
  /** Apply deterministic tool subsetting per case (measures LLM_TOOL_SELECT's effect). */
  toolSelect: boolean;
  /** Explicit output path (the matrix runner sets this per model); default timestamped. */
  out?: string;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = { repeat: 1, concurrency: 6, noArgs: false, jsonMode: false, toolSelect: false };
  for (const arg of argv) {
    const repeat = arg.match(/^--repeat=(\d+)$/);
    const only = arg.match(/^--only=(.+)$/);
    const conc = arg.match(/^--concurrency=(\d+)$/);
    const out = arg.match(/^--out=(.+)$/);
    if (repeat) flags.repeat = Math.max(1, Number(repeat[1]));
    else if (only) flags.only = only[1];
    else if (conc) flags.concurrency = Math.max(1, Number(conc[1]));
    else if (out) flags.out = out[1];
    else if (arg === "--no-args") flags.noArgs = true;
    else if (arg === "--json-mode") flags.jsonMode = true;
    else if (arg === "--tool-select") flags.toolSelect = true;
  }
  return flags;
}

function riskFor(actionName: string): readonly string[] {
  return getAction(actionName)?.risks ?? [];
}

/** Canonical "action+arg-keys" identity for the consistency metric. */
function planSignature(plan: ModelPlan): string {
  if (plan.kind !== "actions" || !plan.actions?.length) {
    const kind = Array.isArray(plan.kind) ? plan.kind.join(",") : plan.kind;
    return ":" + kind;
  }
  return plan.actions
    .map((a) => `${a.name}(${Object.keys(a.arguments ?? {}).sort().join(",")})`)
    .join(" + ");
}

function describeExpect(c: EvalCase): string {
  const e = c.expect;
  const parts: string[] = [];
  if (e.action) parts.push(e.action);
  if (e.anyAction?.length) parts.push(`anyOf[${e.anyAction.join("|")}]`);
  if (e.kind) parts.push("kind=" + (Array.isArray(e.kind) ? e.kind.join("|") : e.kind));
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
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  usageReported: boolean;
  cachedPromptTokens: number;
  cachedPromptReported: boolean;
}

interface CaseReport {
  id: string;
  area: string;
  expected: string;
  passCount: number;
  repeat: number;
  consistency: number; // modal-signature fraction in [0,1]
  modalSignature: string;
  distinct: number; // # of DIFFERENT signatures seen (1 = stable)
  normalizedEntropy: number; // spread in [0,1] (0 = stable; 1 = every run differed)
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
    llmTimeoutMs: process.env.LLM_TIMEOUT_MS ? Number(process.env.LLM_TIMEOUT_MS) : undefined,
    llmReasoningEffort: process.env.LLM_REASONING_EFFORT,
    llmThinkingMode: process.env.LLM_THINKING_MODE as ModelClientSelection["llmThinkingMode"],
    llmSeed: process.env.LLM_SEED ? Number(process.env.LLM_SEED) : undefined,
    geminiModel: process.env.GEMINI_MODEL,
  };

  let modelClient: ModelClient;
  try {
    modelClient = selectEvalModelClient(selection);
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
      `${flags.toolSelect ? " [tool-select ON]" : ""}` +
      `${flags.jsonMode && flags.noArgs ? " [--no-args: arg contract OFF]" : ""}`,
  );
  console.log(`System prompt: ${systemPrompt.length} chars (~${promptTokensEst} tokens)\n`);

  // Flatten (case × repeat) into independent run units.
  const units: { c: EvalCase; run: number }[] = [];
  for (const c of cases) for (let run = 0; run < flags.repeat; run += 1) units.push({ c, run });

  let done = 0;
  const outcomes = await mapWithConcurrency(units, flags.concurrency, async ({ c }): Promise<RunOutcome> => {
    const messages = [...(c.history ?? []), { role: "user" as const, content: c.message }];
    // --tool-select: mirror the chat route — show the model only the message-relevant
    // actions (+ core), so the eval measures LLM_TOOL_SELECT's effect, not the full catalog.
    const names = flags.toolSelect ? new Set(selectActionsForMessage(c.message)) : undefined;
    let plan: ModelPlan;
    // Per-run latency + token cost: a fresh tracker captures THIS run's model wall-clock
    // and token usage (the same seam the prod chat route uses for turn_telemetry).
    const tracked = trackUsage(modelClient, () => new Date());
    try {
      plan = await planConversation({
        modelClient: tracked.client,
        messages,
        actionCatalog: names ? catalogForModel(names) : actionCatalog,
        tools: names ? toolsForModel(names) : undefined,
        policy,
        useTools: !flags.jsonMode,
      });
    } catch (err) {
      plan = { kind: "clarify", text: `eval-error: ${err instanceof Error ? err.message : String(err)}` };
    }
    const scored = scoreCase(plan, c.expect, { riskFor });
    done += 1;
    process.stdout.write(`\r  ${done}/${units.length} runs complete`);
    return {
      caseId: c.id,
      pass: scored.pass,
      signature: planSignature(plan),
      reasons: scored.reasons,
      latencyMs: tracked.usage.modelMs,
      promptTokens: tracked.usage.promptTokens,
      completionTokens: tracked.usage.completionTokens,
      usageReported: tracked.usage.usageReported,
      cachedPromptTokens: tracked.usage.cachedPromptTokens,
      cachedPromptReported: tracked.usage.cachedPromptReported,
    };
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
    const stats = consistencyStats(sigCounts);
    const sampleReasons = runs.find((r) => !r.pass)?.reasons ?? [];
    return {
      id: c.id,
      area: c.area,
      expected: describeExpect(c),
      passCount,
      repeat: runs.length,
      consistency: stats.modalFraction,
      modalSignature: stats.modal,
      distinct: stats.distinct,
      normalizedEntropy: stats.normalizedEntropy,
      signatures: sigCounts,
      sampleReasons,
    };
  });

  const totalRuns = outcomes.length;
  const passRuns = outcomes.filter((o) => o.pass).length;
  const passRate = totalRuns ? passRuns / totalRuns : 0;
  const meanConsistency = mean(reports.map((r) => r.consistency));
  const meanNormalizedEntropy = mean(reports.map((r) => r.normalizedEntropy));
  const stablePass = reports.filter((r) => r.passCount === r.repeat).length;

  // Latency + cost — the model-performance dimensions, measured alongside accuracy so
  // optimizations (round-trips, reasoning effort, token diet) are provable, not hoped.
  const latencies = outcomes.map((o) => o.latencyMs).sort((a, b) => a - b);
  const percentile = (q: number): number =>
    latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] : 0;
  const latencyP50Ms = percentile(0.5);
  const latencyP95Ms = percentile(0.95);
  const meanPromptTokens = mean(outcomes.map((o) => o.promptTokens));
  const meanCompletionTokens = mean(outcomes.map((o) => o.completionTokens));
  const tokensReported = outcomes.some((o) => o.usageReported);
  const totalPromptTokens = outcomes.reduce((sum, o) => sum + o.promptTokens, 0);
  const totalCachedPromptTokens = outcomes.reduce((sum, o) => sum + o.cachedPromptTokens, 0);
  const cachedPromptReported = outcomes.some((o) => o.cachedPromptReported);
  const cacheHitRate = totalPromptTokens > 0 ? totalCachedPromptTokens / totalPromptTokens : 0;

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
    `\nPLANNER EVAL: ${passRuns}/${totalRuns} (${pct(passRate)}) | consistency ${pct(meanConsistency)} | ` +
      `spread ${meanNormalizedEntropy.toFixed(2)}  ` +
      `[cases=${cases.length} repeat=${flags.repeat} stable-pass=${stablePass}/${cases.length}]`,
  );
  console.log(
    `  PERF: latency p50 ${latencyP50Ms}ms / p95 ${latencyP95Ms}ms | ` +
      `tokens/run ${tokensReported ? `~${Math.round(meanPromptTokens)} prompt + ${Math.round(meanCompletionTokens)} completion` : "(not reported by backend)"}`,
  );
  console.log(
    `  CACHE: ${
      cachedPromptReported
        ? `${totalCachedPromptTokens}/${totalPromptTokens} prompt tokens hit (${pct(cacheHitRate)})`
        : "not reported by backend"
    }`,
  );

  // Persist for trend tracking (gitignored). The matrix runner pins --out per model.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = flags.out ?? `eval-results/${stamp}.json`;
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        provider: selection.llmProvider,
        model: modelLabel,
        planMode,
        toolSelect: flags.toolSelect,
        argContract: flags.jsonMode && flags.noArgs ? "off" : "on",
        repeat: flags.repeat,
        only: flags.only ?? null,
        systemPromptChars: systemPrompt.length,
        systemPromptTokensEst: promptTokensEst,
        summary: {
          totalRuns,
          passRuns,
          passRate,
          meanConsistency,
          meanNormalizedEntropy,
          stablePass,
          cases: cases.length,
          latencyP50Ms,
          latencyP95Ms,
          meanPromptTokens,
          meanCompletionTokens,
          tokensReported,
          totalPromptTokens,
          totalCachedPromptTokens,
          cachedPromptReported,
          cacheHitRate,
        },
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
