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
 * `--only=<exact case id>` selects only that case; otherwise it matches ID fragments.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { runAgentTurn, type AgentTurnResult } from "../src/assistant/agent-loop.js";
import type { AgentState } from "../src/assistant/agent-state.js";
import type { ModelClient, ToolCall } from "../src/assistant/model-client.js";
import { planConversation, runAgentConversation } from "../src/assistant/planner.js";
import type { ModelClientSelection } from "../src/assistant/select-model-client.js";
import type { ActionContext, ActionResult } from "../src/harness/action.js";
import { commitConfirmedOperation, executeAction } from "../src/harness/actions.js";
import { catalogForModel, getAction } from "../src/harness/catalog.js";
import { defaultAdminPolicy } from "../src/harness/permissions.js";
import { errorReceipt } from "../src/harness/receipts.js";
import { requiresConfirmation } from "../src/harness/risk.js";
import { toolsForModel } from "../src/harness/tools.js";
import { selectActionsForMessage } from "../src/harness/tool-select.js";
import { trackUsage, type TurnUsage } from "../src/assistant/usage.js";
import {
  assertProductionDeepSeekConfiguration,
  modelEndpointSha256,
} from "../src/assistant/model-endpoint.js";
import { mean } from "../src/eval/consistency.js";
import { createFakeWorkspace } from "../tests/helpers/fake-clockify.js";
import { AGENTIC_CASES, type AgenticCase, type AgenticOutcome } from "./eval/agentic-cases.js";
import { selectEvalCases } from "./eval/case-filter.js";
import { selectEvalModelClient } from "./eval/model-client.js";
import { runOrderedCohorts } from "./eval/ordered-cohorts.js";
import { persistAndResume } from "./eval/persist-resume.js";

interface Flags {
  repeat: number;
  only?: string;
  concurrency: number;
  singleTurn: boolean;
  /** Apply deterministic tool subsetting per case (measures LLM_TOOL_SELECT's effect). */
  toolSelect: boolean;
  /** Explicit output path (the matrix runner sets this per model); default timestamped. */
  out?: string;
  /** Stop at the first risky preview; used for the release write-preview latency gate. */
  previewOnly: boolean;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {
    repeat: 1,
    concurrency: 4,
    singleTurn: false,
    toolSelect: false,
    previewOnly: false,
  };
  for (const arg of argv) {
    const repeat = arg.match(/^--repeat=(\d+)$/);
    const only = arg.match(/^--only=(.+)$/);
    const conc = arg.match(/^--concurrency=(\d+)$/);
    const out = arg.match(/^--out=(.+)$/);
    if (repeat) flags.repeat = Math.max(1, Number(repeat[1]));
    else if (only) flags.only = only[1];
    else if (conc) flags.concurrency = Math.max(1, Number(conc[1]));
    else if (out) flags.out = out[1];
    else if (arg === "--single-turn") flags.singleTurn = true;
    else if (arg === "--tool-select") flags.toolSelect = true;
    else if (arg === "--preview-only") flags.previewOnly = true;
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
  /** Proposed non-read actions, including denied or previewed writes. */
  writeActionCount: number;
  /** Per-case-run model telemetry: round-trips, prompt tokens, model wall-clock. */
  usage: TurnUsage;
  /** Subsetting actually NARROWED the menu (a domain intent matched, not just core),
   *  so a recall miss — and thus the escape hatch — is possible for this run. */
  narrowed: boolean;
  /** The full-catalog escape hatch fired (a narrowed turn produced nothing). */
  escapeHatchFired: boolean;
}

async function runAgenticCase(
  modelClient: ModelClient,
  c: AgenticCase,
  toolSelect: boolean,
  previewOnly: boolean,
): Promise<CaseRun> {
  const fake = createFakeWorkspace(c.seed);
  const ctx = makeContext(fake);
  const executed: string[] = [];
  const committed: string[] = [];
  const safetyViolations: string[] = [];
  let writeActionCount = 0;
  let interrupts = 0;
  let escapeHatchFired = false;

  // Tool subsetting (mirrors chat-pipeline.ts executeChatTurn): compute the subset
  // ONCE from the first user message and reuse it on the initial turn AND every
  // resume — so the eval measures exactly the production subset path (including the
  // resume-subset of STEP 6). The harness still validates + gates every proposed call.
  const subsetNames = toolSelect ? new Set(selectActionsForMessage(c.message)) : undefined;
  const subsetTools = subsetNames ? toolsForModel(subsetNames) : undefined;
  const narrowed = subsetNames !== undefined && subsetNames.size < toolsForModel().length;
  // Production's selector already fails open to the full catalog for recall-risk
  // inputs, so the selected tools can be reused verbatim on resume.
  const resumeTools = toolSelect && subsetTools ? subsetTools : toolsForModel();

  // One usage tracker per case-run captures wall-clock + token cost across the
  // initial turn, the escape-hatch retry, and every resume round-trip (the same
  // seam the prod chat route uses for turn_telemetry).
  const tracked = trackUsage(modelClient, () => new Date());

  const runAction = async (call: ToolCall): Promise<ActionResult> => {
    if (getAction(call.name)?.kind !== "read") writeActionCount += 1;
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
      modelClient: tracked.client,
      messages: [{ role: "user", content: c.message }],
      policy: ctx.policy,
      tools: subsetTools,
      runAction,
    });
    // Recall escape hatch (mirrors chat-pipeline.ts): a NARROWED turn that executed
    // NOTHING may have had the needed tool hidden — retry ONCE with the full catalog.
    // Side-effect-free (guarded on executed.length === 0); a risky write would have
    // INTERRUPTED (not final/exhausted), so this never re-runs a write. Counting its
    // fire-rate makes the net (savings-on-hits − tax-on-misses) measured, not assumed.
    if (narrowed && executed.length === 0 && (turn.kind === "final" || turn.kind === "exhausted")) {
      escapeHatchFired = true;
      turn = await runAgentConversation({
        modelClient: tracked.client,
        messages: [{ role: "user", content: c.message }],
        policy: ctx.policy,
        runAction,
      });
    }
    const maxConfirms = previewOnly ? 0 : c.maxConfirms ?? 3;
    let confirms = 0;
    while (turn.kind === "interrupt" && confirms < maxConfirms) {
      confirms += 1;
      interrupts += 1;
      // The human clicks Confirm: the REAL commit choke point, then resume.
      const receipt = await commitConfirmedOperation(ctx, turn.operation);
      committed.push(turn.operation.actionName);
      const state: AgentState = { transcript: turn.transcript, call: { id: turn.call.id, name: turn.call.name } };
      // Route the resume through the PRODUCTION suspension boundary
      // (capAgentState → JSON persist → parseAgentState), not the live in-memory
      // state — so persistence-schema drift (a stripped thoughtSignature, any
      // future contract field) fails the eval here instead of only in prod.
      const messages = persistAndResume(state, receipt);
      if (!messages) break; // production would not resume → the turn stays interrupted (a failure)
      turn = await runAgentTurn({
        modelClient: tracked.client,
        messages,
        // Subset on resume too (STEP 6's production shape); recall-risk inputs
        // already produced a full-catalog `resumeTools` value above.
        tools: resumeTools,
        runAction,
      });
    }
    const kind: AgenticOutcome["kind"] =
      turn.kind === "interrupt"
        ? "interrupted"
        : turn.kind === "final"
          ? "final"
          : turn.kind === "aborted"
            ? "error" // eval passes no abort signal, so this is unreachable here; keep the type sound
            : turn.kind;
    if (turn.kind === "interrupt") interrupts += 1;
    const finalText =
      turn.kind === "final" || turn.kind === "exhausted" ? turn.text : turn.kind === "clarify" ? turn.message : "";
    return {
      outcome: { kind, finalText, executed, committed, interrupts, fake },
      safetyViolations,
      writeActionCount,
      usage: tracked.usage,
      narrowed,
      escapeHatchFired,
    };
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
      writeActionCount,
      usage: tracked.usage,
      narrowed,
      escapeHatchFired,
    };
  }
}

/** The pre-loop architecture: one plan, executed once, previews auto-confirmed, no feedback. */
async function runSingleTurnCase(modelClient: ModelClient, c: AgenticCase, toolSelect: boolean): Promise<CaseRun> {
  const fake = createFakeWorkspace(c.seed);
  const ctx = makeContext(fake);
  const executed: string[] = [];
  const committed: string[] = [];
  const safetyViolations: string[] = [];
  let writeActionCount = 0;
  let interrupts = 0;
  let clarified: boolean;
  let text: string;
  let escapeHatchFired = false;

  // Tool subsetting mirrors the single-turn branch of chat-pipeline.ts: a subset
  // catalog/tools for the plan, then a full-catalog re-plan if a NARROWED turn
  // proposed no action (the recall escape hatch — re-plan runs before any execute).
  const subsetNames = toolSelect ? new Set(selectActionsForMessage(c.message)) : undefined;
  const subsetTools = subsetNames ? toolsForModel(subsetNames) : undefined;
  const subsetCatalog = subsetNames ? catalogForModel(subsetNames) : catalogForModel();
  const narrowed = subsetNames !== undefined && subsetNames.size < toolsForModel().length;
  const tracked = trackUsage(modelClient, () => new Date());

  try {
    let plan = await planConversation({
      modelClient: tracked.client,
      messages: [{ role: "user", content: c.message }],
      actionCatalog: subsetCatalog,
      tools: subsetTools,
      policy: ctx.policy,
      useTools: true,
    });
    if (narrowed && plan.kind !== "actions") {
      escapeHatchFired = true;
      plan = await planConversation({
        modelClient: tracked.client,
        messages: [{ role: "user", content: c.message }],
        actionCatalog: catalogForModel(),
        policy: ctx.policy,
        useTools: true,
      });
    }
    text = plan.text ?? "";
    clarified = plan.kind === "clarify";
    if (plan.kind === "actions" && plan.actions) {
      for (const a of plan.actions) {
        if (getAction(a.name)?.kind !== "read") writeActionCount += 1;
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
        } else if (outcome.kind === "partial") {
          executed.push(a.name);
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
      writeActionCount,
      usage: tracked.usage,
      narrowed,
      escapeHatchFired,
    };
  }
  return {
    outcome: { kind: clarified ? "clarify" : "final", finalText: text, executed, committed, interrupts, fake },
    safetyViolations,
    writeActionCount,
    usage: tracked.usage,
    narrowed,
    escapeHatchFired,
  };
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

interface ReleaseSourceIdentity {
  gitCommitSha: string;
  workingTreeClean: true;
}

function assertReleaseNode22(): void {
  if (process.versions.node.split(".")[0] !== "22") {
    throw new Error("release DeepSeek evaluation requires Node 22");
  }
}

function assertExternalReleaseOutput(out: string | undefined): string | undefined {
  if (!process.env.EVAL_RELEASE_CANDIDATE_SHA) return out;
  if (!out) throw new Error("release DeepSeek evaluation requires an explicit --out");
  if (!isAbsolute(out)) throw new Error("release DeepSeek evaluation output must be an absolute external path");
  const worktree = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const resolvedOutput = resolve(out);
  const fromWorktree = relative(worktree, resolvedOutput);
  if (fromWorktree === "" || (!fromWorktree.startsWith("..") && !isAbsolute(fromWorktree))) {
    throw new Error("release DeepSeek evaluation output must be outside the Git worktree");
  }
  return resolvedOutput;
}

function releaseSourceIdentity(): ReleaseSourceIdentity | undefined {
  const expected = process.env.EVAL_RELEASE_CANDIDATE_SHA?.trim();
  if (!expected) return undefined;
  assertReleaseNode22();
  if (!/^[0-9a-f]{40}$/.test(expected)) {
    throw new Error("EVAL_RELEASE_CANDIDATE_SHA must be a full lowercase commit SHA");
  }
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (head !== expected) throw new Error("EVAL_RELEASE_CANDIDATE_SHA does not match the checked-out commit");
  if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) {
    throw new Error("release DeepSeek evaluation requires a clean checkout");
  }
  return { gitCommitSha: head, workingTreeClean: true };
}

function assertReleaseSourceUnchanged(source: ReleaseSourceIdentity | undefined): void {
  if (!source) return;
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const status = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();
  if (head !== source.gitCommitSha || status !== "") {
    throw new Error("release DeepSeek evaluation source changed while the provider run was in progress");
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const releaseOutput = assertExternalReleaseOutput(flags.out);
  if (flags.previewOnly && flags.singleTurn) {
    console.error("--preview-only is available only for the agentic eval");
    process.exit(2);
  }
  const source = releaseSourceIdentity();
  const startedAt = new Date().toISOString();
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
  const releaseMode = source !== undefined;
  if (releaseMode) {
    if (process.env.EVAL_PLAN_MODEL || process.env.EVAL_IMPL_MODEL) {
      throw new Error("mixed-tier overrides are forbidden in release mode");
    }
    if (
      flags.singleTurn
      || flags.concurrency !== 4
      || !flags.toolSelect
      || process.env.LLM_MODE !== "tool"
      || process.env.LLM_AGENTIC !== "1"
      || process.env.LLM_TOOL_SELECT !== "1"
      || selection.llmReasoningEffort !== undefined
      || selection.llmSeed !== undefined
      || (selection.llmTimeoutMs !== undefined && selection.llmTimeoutMs !== 120_000)
    ) {
      throw new Error("release DeepSeek evaluation runtime does not match the approved configuration");
    }
    assertProductionDeepSeekConfiguration({
      provider: selection.llmProvider,
      baseUrl: selection.llmBaseUrl,
      model: selection.llmModel,
    });
  }

  let modelClient: ModelClient;
  try {
    modelClient = selectEvalModelClient(selection);
    // Two-tier routing experiment: EVAL_PLAN_MODEL handles PLANNING calls (no
    // tool results in the transcript yet) and EVAL_IMPL_MODEL the continuation/
    // implementation calls (any transcript carrying a role:"tool" message —
    // which is also every resume). Eval-only; the product stays single-model.
    const planModel = process.env.EVAL_PLAN_MODEL;
    const implModel = process.env.EVAL_IMPL_MODEL;
    if (planModel && implModel) {
      const plan = selectEvalModelClient({ ...selection, llmModel: planModel });
      const impl = selectEvalModelClient({ ...selection, llmModel: implModel });
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

  const cases = selectEvalCases(AGENTIC_CASES, flags.only);
  if (cases.length === 0) {
    console.error(`No cases match --only=${flags.only}.`);
    process.exit(2);
  }

  const mode = flags.singleTurn ? "single-turn" : flags.previewOnly ? "agentic-preview" : "agentic";
  const modelLabel =
    selection.llmProvider === "gemini-cli" ? `gemini-cli:${selection.geminiModel ?? "router"}` : selection.llmModel ?? "?";
  const effectiveThinkingMode = process.env.EVAL_DEEPSEEK_THINKING_MODE
    ?? selection.llmThinkingMode
    ?? null;
  console.log(
    `Running ${mode} task-completion eval: provider=${selection.llmProvider} model=${modelLabel} ` +
      `cases=${cases.length} repeat=${flags.repeat} concurrency=${flags.concurrency}` +
      `${flags.toolSelect ? " [tool-select ON]" : ""}\n`,
  );

  let done = 0;
  const runs = await runOrderedCohorts(
    cases,
    flags.repeat,
    flags.concurrency,
    async ({ value: c, cohortIndex, caseIndex }) => {
      const result = flags.singleTurn
        ? await runSingleTurnCase(modelClient, c, flags.toolSelect)
        : await runAgenticCase(modelClient, c, flags.toolSelect, flags.previewOnly);
      const reasons = flags.previewOnly
        ? [
            ...(result.outcome.kind === "interrupted" ? [] : [`expected a risky preview, got ${result.outcome.kind}`]),
            ...(result.outcome.interrupts === 1 ? [] : [`expected exactly one preview, got ${result.outcome.interrupts}`]),
            ...(result.outcome.committed.length === 0 ? [] : ["preview-only mode must not commit"]),
          ]
        : c.check(result.outcome);
      if (result.outcome.kind === "error" && result.outcome.finalText) {
        reasons.push(`error: ${result.outcome.finalText.slice(0, 160)}`);
      }
      done += 1;
      process.stdout.write(`\r  ${done}/${cases.length * flags.repeat} runs complete`);
      return {
        cohortIndex,
        caseIndex,
        caseId: c.id,
        area: c.area,
        pass: reasons.length === 0,
        reasons,
        safety: result.safetyViolations,
        outcomeKind: result.outcome.kind,
        previewCount: result.outcome.interrupts,
        commitCount: result.outcome.committed.length,
        writeActionCount: result.writeActionCount,
        usage: result.usage,
        narrowed: result.narrowed,
        escapeHatchFired: result.escapeHatchFired,
      };
    },
  );
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

  // PERF — the model-performance dimensions, measured per case-run so subset OFF vs
  // ON is a comparison, not a hope. A "turn" here is the WHOLE case-run: the initial
  // turn + any escape-hatch retry + every resume round-trip (trackUsage sums them).
  //   - round-trips/turn  = paid model calls (DEFAULT_MAX_STEPS bounds each leg)
  //   - prompt-tokens/turn = total prompt cost of the turn (~99% of the bill)
  //   - prompt-tokens/round-trip = the schema-driven per-call number (≈ the planner
  //     baseline), so subsetting's per-call shrink is directly visible
  //   - latency p50/p95   = model wall-clock summed over the turn's calls
  const turnLatencies = runs.map((r) => r.usage.modelMs).sort((a, b) => a - b);
  const percentile = (q: number): number =>
    turnLatencies.length ? turnLatencies[Math.min(turnLatencies.length - 1, Math.floor(q * turnLatencies.length))] : 0;
  const latencyP50Ms = percentile(0.5);
  const latencyP95Ms = percentile(0.95);
  const meanRoundTrips = mean(runs.map((r) => r.usage.modelCalls));
  const meanPromptTokens = mean(runs.map((r) => r.usage.promptTokens));
  const meanCompletionTokens = mean(runs.map((r) => r.usage.completionTokens));
  const totalPromptTokens = runs.reduce((sum, r) => sum + r.usage.promptTokens, 0);
  const totalCachedPromptTokens = runs.reduce((sum, r) => sum + r.usage.cachedPromptTokens, 0);
  const meanCachedPromptTokens = mean(runs.map((r) => r.usage.cachedPromptTokens));
  const perCall = runs.filter((r) => r.usage.modelCalls > 0).map((r) => r.usage.promptTokens / r.usage.modelCalls);
  const meanPromptTokensPerRoundTrip = mean(perCall);
  const tokensReported = runs.some((r) => r.usage.usageReported);
  const cachedPromptReported = runs.some((r) => r.usage.cachedPromptReported);
  const cacheHitRate = totalPromptTokens > 0 ? totalCachedPromptTokens / totalPromptTokens : 0;
  // Escape-hatch fire-rate (tool-select only): of the NARROWED runs (a domain intent
  // matched, so a recall miss is possible), how often did the full-catalog retry fire?
  // That retry is the tax-on-misses that nets against the savings-on-hits.
  const narrowedRuns = runs.filter((r) => r.narrowed).length;
  const escapeHatchFires = runs.filter((r) => r.escapeHatchFired).length;

  console.log(
    `\nAGENTIC EVAL (${mode}${flags.toolSelect ? ", tool-select" : ""}): ${passRuns}/${totalRuns} ` +
      `(${pct(totalRuns ? passRuns / totalRuns : 0)}) | safety violations: ${safetyViolations.length}`,
  );
  for (const v of safetyViolations) console.log(`  !! SAFETY: ${v}`);
  console.log(
    `  PERF: round-trips/turn ${meanRoundTrips.toFixed(2)} | latency p50 ${latencyP50Ms}ms / p95 ${latencyP95Ms}ms | ` +
      `tokens/turn ${
        tokensReported
          ? `~${Math.round(meanPromptTokens)} prompt (${Math.round(meanPromptTokensPerRoundTrip)}/round-trip) + ${Math.round(meanCompletionTokens)} completion`
          : "(not reported by backend)"
      }`,
  );
  console.log(
    `  CACHE: ${
      cachedPromptReported
        ? `${totalCachedPromptTokens}/${totalPromptTokens} prompt tokens hit (${pct(cacheHitRate)}); mean ${Math.round(meanCachedPromptTokens)}/turn`
        : "not reported by backend"
    }`,
  );
  if (flags.toolSelect) {
    console.log(
      `  ESCAPE HATCH: fired ${escapeHatchFires}/${narrowedRuns} narrowed run(s)` +
        `${narrowedRuns ? ` (${pct(escapeHatchFires / narrowedRuns)})` : ""}` +
        ` — full-catalog retries (the tax-on-misses)`,
    );
  }

  const completedAt = new Date().toISOString();
  assertReleaseSourceUnchanged(source);
  const stamp = completedAt.replace(/[:.]/g, "-");
  const outFile = releaseOutput ?? `eval-results/agentic-${mode}-${stamp}.json`;
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        startedAt,
        completedAt,
        kind: "agentic-task-completion",
        mode,
        provider: selection.llmProvider,
        model: modelLabel,
        toolSelect: flags.toolSelect,
        repeat: flags.repeat,
        source,
        runtimeConfiguration: {
          provider: selection.llmProvider,
          model: modelLabel,
          endpointSha256: selection.llmBaseUrl ? modelEndpointSha256(selection.llmBaseUrl) : null,
          mode: process.env.LLM_MODE ?? "tool",
          agentic: !flags.singleTurn,
          toolSelect: flags.toolSelect,
          reasoningEffort: selection.llmReasoningEffort ?? null,
          thinkingMode: effectiveThinkingMode,
          concurrency: flags.concurrency,
          nodeVersion: process.version,
          timeoutMs: selection.llmTimeoutMs ?? 120_000,
          seed: selection.llmSeed ?? null,
          mixedTier: Boolean(process.env.EVAL_PLAN_MODEL || process.env.EVAL_IMPL_MODEL),
        },
        summary: {
          totalRuns,
          passRuns,
          passRate: totalRuns ? passRuns / totalRuns : 0,
          safetyViolations: safetyViolations.length,
          meanRoundTrips,
          latencyP50Ms,
          latencyP95Ms,
          meanPromptTokens,
          meanPromptTokensPerRoundTrip,
          meanCompletionTokens,
          tokensReported,
          totalPromptTokens,
          totalCachedPromptTokens,
          meanCachedPromptTokens,
          cachedPromptReported,
          cacheHitRate,
          narrowedRuns,
          escapeHatchFires,
          escapeHatchFireRate: narrowedRuns ? escapeHatchFires / narrowedRuns : 0,
        },
        reports,
        // Secret-free per-case telemetry makes release aggregation exact across
        // several consecutive corpus runs. Do not persist model text, arguments,
        // fake workspace state, or provider request bodies here.
        runTelemetry: runs.map((run) => ({
          cohortIndex: run.cohortIndex,
          caseIndex: run.caseIndex,
          caseId: run.caseId,
          area: run.area,
          pass: run.pass,
          safetyViolations: run.safety.length,
          outcomeKind: run.outcomeKind,
          previewCount: run.previewCount,
          commitCount: run.commitCount,
          writeActionCount: run.writeActionCount,
          modelCalls: run.usage.modelCalls,
          modelMs: run.usage.modelMs,
          promptTokens: run.usage.promptTokens,
          completionTokens: run.usage.completionTokens,
          cachedPromptTokens: run.usage.cachedPromptTokens,
          usageReported: run.usage.usageReported,
          cachedPromptReported: run.usage.cachedPromptReported,
          narrowed: run.narrowed,
          escapeHatchFired: run.escapeHatchFired,
        })),
      },
      null,
      2,
    ),
  );
  console.log(`\nWrote ${outFile}`);
  if (passRuns !== totalRuns || safetyViolations.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\nEVAL FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
