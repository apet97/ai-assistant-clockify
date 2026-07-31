#!/usr/bin/env tsx
/**
 * C7: fail the gate on a module nothing imports.
 *
 * `npm run cycles` is `madge --circular` only, so a module that becomes
 * unreachable — the exact state Phase C found in `compose.ts` (166 lines,
 * imported by nothing but its own tests) — shipped silently. `madge --orphans`
 * lists them but always exits 0, so this wrapper is what turns the list into a
 * gate.
 *
 * The allowlist is EXPLICIT and each entry carries the reason it is legitimately
 * unimported. A new orphan fails; a removed orphan also fails, so the list
 * cannot rot into a rubber stamp.
 */
import { execFileSync } from "node:child_process";

/** Every allowed orphan, with why it has no importer. */
const ALLOWED: ReadonlyArray<{ path: string; reason: string }> = [
  {
    path: "server.ts",
    reason: "Process entry point — started by `npm start`, imported by nothing.",
  },
  {
    path: "ui/main.ts",
    reason: "Browser bundle entry point — Vite's input, imported by nothing in src.",
  },
  {
    path: "db/recovery.ts",
    reason: "Operational module reached from scripts/, not from the request path.",
  },
  {
    path: "db/restore-verification.ts",
    reason: "Operational module reached from scripts/ (db:verify-restore), not from src.",
  },
  {
    path: "eval/score.ts",
    reason: "Pure planner scorer reached from scripts/eval-*.ts, not from the request path.",
  },
  {
    path: "eval/consistency.ts",
    reason: "Pure eval statistic reached from scripts/eval-*.ts, not from the request path.",
  },
  {
    path: "harness/api-catalog.generated.ts",
    reason:
      "Generated evidence, deliberately handler-free. Read as TEXT by its inventory check, "
      + "never imported. Regenerate with `npm run generate:api-action-inventory`; never hand-edit.",
  },
  {
    path: "harness/mutation-compatibility.ts",
    reason:
      "Deterministic catalog AUDIT invoked only by tests/unit/mutation-catalog.test.ts. Zero "
      + "production callers BY DESIGN — the runtime write guard is the async-local mutation "
      + "scope in clockify/rest/core.ts. Wiring this into production would be a mistake.",
  },
  {
    path: "assistant-v2/references/entity-reference.ts",
    reason:
      "Entity-reference vertical, DORMANT behind the double lock documented in "
      + "harness/tool-schema.ts. Owner decision 2026-07-31 (C5): keep dormant, not funded for "
      + "this release. Retiring it is a catalog-hash event and must be scheduled, not sneaked.",
  },
];

function orphanModules(): string[] {
  const stdout = execFileSync(
    "npx",
    ["madge", "--orphans", "--json", "--extensions", "ts", "--ts-config", "tsconfig.json", "src"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error("madge_orphans_unexpected_output");
  }
  return [...parsed].sort();
}

function main(): void {
  const found = orphanModules();
  const allowed = new Set(ALLOWED.map((entry) => entry.path));

  const unexpected = found.filter((path) => !allowed.has(path));
  const stale = [...allowed].filter((path) => !found.includes(path)).sort();

  if (unexpected.length === 0 && stale.length === 0) {
    console.log(`orphan check: ${found.length} allowlisted orphan(s), no new ones.`);
    return;
  }

  for (const path of unexpected) {
    console.error(
      `NEW ORPHAN: src/${path} — nothing imports it. Delete it, wire it up, or add it to `
      + "ALLOWED in scripts/check-orphan-modules.ts WITH a reason.",
    );
  }
  for (const path of stale) {
    console.error(
      `STALE ALLOWLIST ENTRY: src/${path} is no longer an orphan (or no longer exists). `
      + "Remove it from ALLOWED so the list keeps discriminating.",
    );
  }
  process.exitCode = 1;
}

main();
