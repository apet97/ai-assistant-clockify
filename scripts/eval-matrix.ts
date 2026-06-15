/**
 * Weak-model eval MATRIX (Phase 0 — the meter that makes "consistent across
 * stupid LLMs" a number, not a hope). It runs the EXISTING, proven planner +
 * agentic evals across a list of models and prints one comparison table:
 *
 *   model              planner            agentic
 *                      pass / consist / spread   pass / safety
 *
 * It spawns the eval scripts as SUBPROCESSES (one model at a time) with that
 * model's creds injected via env and a pinned `--out` path — so the proven
 * scripts are untouched and each model runs in an isolated process. The per-model
 * JSON is read back and aggregated into one matrix file.
 *
 * The model list is a GITIGNORED config (default `eval-models.json`; never commit
 * keys). Shape:
 *   [
 *     { "label": "deepseek-v4-pro",
 *       "env": { "LLM_BASE_URL": "https://…", "LLM_API_KEY": "…", "LLM_MODEL": "deepseek-v4-pro" } },
 *     { "label": "flash-lite-3.1",
 *       "env": { "LLM_BASE_URL": "https://…/openai", "LLM_API_KEY": "…",
 *                "LLM_MODEL": "gemini-3.1-flash-lite", "LLM_REASONING_EFFORT": "none" } }
 *   ]
 *
 * Run (the matrix itself needs no creds — each child gets them from `env`):
 *   npx tsx scripts/eval-matrix.ts --repeat=5
 *   npx tsx scripts/eval-matrix.ts --models=eval-models.json --repeat=5 --planner-only
 *   npx tsx scripts/eval-matrix.ts --dry-run            # print the plan, spawn nothing
 *
 * Flags: --models=<path> (default eval-models.json), --repeat=N (default 5),
 *        --concurrency=N (passed to each eval), --planner-only, --agentic-only,
 *        --single-turn (agentic baseline), --dry-run.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";

interface ModelEntry {
  label: string;
  env: Record<string, string>;
}

interface Flags {
  models: string;
  repeat: number;
  concurrency?: number;
  plannerOnly: boolean;
  agenticOnly: boolean;
  singleTurn: boolean;
  dryRun: boolean;
}

function parseFlags(argv: string[]): Flags {
  const flags: Flags = {
    models: "eval-models.json",
    repeat: 5,
    plannerOnly: false,
    agenticOnly: false,
    singleTurn: false,
    dryRun: false,
  };
  for (const arg of argv) {
    const models = arg.match(/^--models=(.+)$/);
    const repeat = arg.match(/^--repeat=(\d+)$/);
    const conc = arg.match(/^--concurrency=(\d+)$/);
    if (models) flags.models = models[1];
    else if (repeat) flags.repeat = Math.max(1, Number(repeat[1]));
    else if (conc) flags.concurrency = Math.max(1, Number(conc[1]));
    else if (arg === "--planner-only") flags.plannerOnly = true;
    else if (arg === "--agentic-only") flags.agenticOnly = true;
    else if (arg === "--single-turn") flags.singleTurn = true;
    else if (arg === "--dry-run") flags.dryRun = true;
  }
  return flags;
}

const TEMPLATE = `[
  {
    "label": "deepseek-v4-pro",
    "env": { "LLM_PROVIDER": "http", "LLM_BASE_URL": "https://…", "LLM_API_KEY": "…", "LLM_MODEL": "deepseek-v4-pro" }
  },
  {
    "label": "flash-lite-3.1",
    "env": { "LLM_PROVIDER": "http", "LLM_BASE_URL": "https://…/openai", "LLM_API_KEY": "…", "LLM_MODEL": "gemini-3.1-flash-lite", "LLM_REASONING_EFFORT": "none" }
  }
]`;

function loadModels(path: string): ModelEntry[] {
  if (!existsSync(path)) {
    console.error(
      `No model list at "${path}". Create it (gitignored — never commit keys) with this shape:\n\n${TEMPLATE}\n`,
    );
    process.exit(2);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`Could not parse ${path}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    console.error(`${path} must be a non-empty JSON array of { label, env } entries.`);
    process.exit(2);
  }
  return parsed.map((m, i) => {
    const entry = m as Partial<ModelEntry>;
    if (!entry.label || typeof entry.env !== "object" || entry.env === null) {
      console.error(`Entry #${i} in ${path} needs a "label" string and an "env" object.`);
      process.exit(2);
    }
    return { label: entry.label, env: entry.env as Record<string, string> };
  });
}

/** Spawn one eval script with the model's env + a pinned --out; resolve to its exit code. */
function runEval(script: string, args: string[], env: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", script, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

function readSummary(path: string): Record<string, unknown> | null {
  try {
    const json = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return json;
  } catch {
    return null;
  }
}

function pct(n: unknown): string {
  return typeof n === "number" ? `${(n * 100).toFixed(1)}%` : "—";
}
function num(n: unknown, digits = 2): string {
  return typeof n === "number" ? n.toFixed(digits) : "—";
}

interface PlannerCaseReport {
  id: string;
  passCount: number;
  repeat: number;
  consistency: number;
  normalizedEntropy: number;
}

/** The worst cases for a model: lowest pass-rate, then highest spread. */
function worstPlannerCases(result: Record<string, unknown> | null, take = 3): PlannerCaseReport[] {
  const reports = (result?.reports as PlannerCaseReport[] | undefined) ?? [];
  return [...reports]
    .sort(
      (a, b) =>
        a.passCount / a.repeat - b.passCount / b.repeat ||
        (b.normalizedEntropy ?? 0) - (a.normalizedEntropy ?? 0),
    )
    .slice(0, take);
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const models = loadModels(flags.models);
  const runPlanner = !flags.agenticOnly;
  const runAgentic = !flags.plannerOnly;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = `eval-results/matrix-${stamp}`;
  const concArgs = flags.concurrency ? [`--concurrency=${flags.concurrency}`] : [];

  console.log(
    `MATRIX: ${models.length} model(s) × repeat=${flags.repeat} ` +
      `[${[runPlanner && "planner", runAgentic && "agentic"].filter(Boolean).join(" + ")}]` +
      `${flags.dryRun ? "  (dry-run)" : ""}\n`,
  );

  const rows: {
    label: string;
    planner: Record<string, unknown> | null;
    agentic: Record<string, unknown> | null;
    worst: PlannerCaseReport[];
  }[] = [];

  for (const model of models) {
    const plannerOut = `${outDir}/${model.label}-planner.json`;
    const agenticOut = `${outDir}/${model.label}-agentic.json`;
    console.log(`── ${model.label} (LLM_MODEL=${model.env.LLM_MODEL ?? "?"}) ──`);

    if (flags.dryRun) {
      if (runPlanner) console.log(`  would run: eval-planner --repeat=${flags.repeat} --out=${plannerOut}`);
      if (runAgentic) {
        const st = flags.singleTurn ? " --single-turn" : "";
        console.log(`  would run: eval-agentic --repeat=${flags.repeat}${st} --out=${agenticOut}`);
      }
      rows.push({ label: model.label, planner: null, agentic: null, worst: [] });
      continue;
    }

    mkdirSync(outDir, { recursive: true });
    if (runPlanner) {
      const code = await runEval(
        "scripts/eval-planner.ts",
        [`--repeat=${flags.repeat}`, `--out=${plannerOut}`, ...concArgs],
        model.env,
      );
      if (code !== 0) console.error(`  ⚠ planner eval exited ${code} for ${model.label}`);
    }
    if (runAgentic) {
      const agArgs = [`--repeat=${flags.repeat}`, `--out=${agenticOut}`, ...concArgs];
      if (flags.singleTurn) agArgs.push("--single-turn");
      const code = await runEval("scripts/eval-agentic.ts", agArgs, model.env);
      if (code !== 0) console.error(`  ⚠ agentic eval exited ${code} for ${model.label}`);
    }

    const planner = runPlanner ? readSummary(plannerOut) : null;
    const agentic = runAgentic ? readSummary(agenticOut) : null;
    rows.push({ label: model.label, planner, agentic, worst: worstPlannerCases(planner) });
    console.log("");
  }

  if (flags.dryRun) {
    console.log("\n(dry-run: no evals spawned, no results read)");
    return;
  }

  // Comparison table — the headline of the whole phase.
  console.log("\n=== MATRIX RESULTS ===");
  console.log("model                  planner: pass / consist / spread   agentic: pass / safety");
  console.log("-".repeat(92));
  for (const r of rows) {
    const ps = (r.planner?.summary as Record<string, unknown>) ?? {};
    const as = (r.agentic?.summary as Record<string, unknown>) ?? {};
    const planner = runPlanner
      ? `${pct(ps.passRate).padEnd(7)} ${pct(ps.meanConsistency).padEnd(8)} ${num(ps.meanNormalizedEntropy)}`
      : "—";
    const agentic = runAgentic
      ? `${pct(as.passRate).padEnd(7)} ${typeof as.safetyViolations === "number" ? as.safetyViolations : "—"}`
      : "—";
    console.log(`${r.label.padEnd(22)} ${planner.padEnd(33)} ${agentic}`);
    for (const w of r.worst) {
      if (w.passCount === w.repeat && (w.normalizedEntropy ?? 0) === 0) continue;
      console.log(
        `    ↳ ${w.id.padEnd(30)} ${w.passCount}/${w.repeat} pass, spread ${num(w.normalizedEntropy)}`,
      );
    }
  }

  const matrixFile = `${outDir}/matrix.json`;
  writeFileSync(
    matrixFile,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        repeat: flags.repeat,
        models: rows.map((r) => ({
          label: r.label,
          planner: r.planner?.summary ?? null,
          agentic: r.agentic?.summary ?? null,
          worstPlannerCases: r.worst,
        })),
      },
      null,
      2,
    ),
  );
  console.log(`\nWrote ${matrixFile}`);
}

main().catch((err) => {
  console.error("\nMATRIX FAILED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
