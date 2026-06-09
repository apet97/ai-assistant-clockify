/**
 * Planner-eval trend (Phase 7 — metrics). Summarizes the timestamped
 * `eval-results/*.json` that `scripts/eval-planner.ts` writes into one table, so
 * the planner's pass-rate + consistency can be tracked over time (and across
 * models / tool-vs-json mode). Read-only; no network. The eval-results dir is
 * gitignored, so this reflects the runs done on this machine.
 *
 *   npx tsx scripts/eval-trend.ts
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";

interface EvalFile {
  timestamp?: string;
  provider?: string;
  model?: string;
  planMode?: string;
  argContract?: string;
  repeat?: number;
  only?: string | null;
  summary?: { passRate?: number; meanConsistency?: number; cases?: number; stablePass?: number };
}

const DIR = "eval-results";
const pct = (n: number | undefined): string => `${((n ?? 0) * 100).toFixed(1)}%`;

function main(): void {
  if (!existsSync(DIR)) {
    console.log(`No ${DIR}/ directory yet — run scripts/eval-planner.ts first.`);
    return;
  }
  const files = readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (files.length === 0) {
    console.log(`No eval results in ${DIR}/ yet — run scripts/eval-planner.ts first.`);
    return;
  }

  console.log(
    `${"timestamp".padEnd(26)} ${"model".padEnd(18)} ${"mode".padEnd(13)} ${"args".padEnd(4)} ` +
      `${"pass".padEnd(7)} ${"consist".padEnd(8)} ${"cases".padEnd(6)} ${"only".padEnd(14)}`,
  );
  console.log("-".repeat(110));
  for (const file of files) {
    let j: EvalFile;
    try {
      j = JSON.parse(readFileSync(`${DIR}/${file}`, "utf8")) as EvalFile;
    } catch {
      continue;
    }
    const s = j.summary ?? {};
    console.log(
      `${(j.timestamp ?? file).padEnd(26)} ${(j.model ?? "?").padEnd(18)} ${(j.planMode ?? "?").padEnd(13)} ` +
        `${(j.argContract ?? "?").padEnd(4)} ${pct(s.passRate).padEnd(7)} ${pct(s.meanConsistency).padEnd(8)} ` +
        `${String(s.cases ?? "?").padEnd(6)} ${(j.only ?? "all").padEnd(14)}`,
    );
  }
}

main();
