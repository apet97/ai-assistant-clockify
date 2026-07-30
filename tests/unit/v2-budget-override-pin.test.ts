import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { V2_LIMITS, resolveHostCallCeiling } from "../../src/assistant-v2/budgets.js";

/**
 * Plan B1: `RunAssistantInput.budgetOverrides` is an EVAL-ONLY narrowing
 * override. This pin makes "unreachable from production paths" a checked
 * property, not prose: no production source outside the three files that
 * define/validate/accept it may reference it, so no route, service, config,
 * or environment variable can ever feed it. Combined with the validator
 * rejecting anything above the `V2_LIMITS` default, the override can never
 * widen a production ceiling even if a future caller appears.
 */

const SRC_ROOT = new URL("../../src/", import.meta.url).pathname;

/** The complete definition/validation/acceptance surface of the override. */
const ALLOWED_FILES = new Set([
  "assistant-v2/budgets.ts",
  "assistant-v2/protocol.ts",
  "assistant-v2/runner.ts",
]);

function sourceFilesUnder(directory: string): string[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFilesUnder(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

describe("plan B1: the eval budget override is unreachable from production", () => {
  it("no src file outside its definition surface references budgetOverrides", () => {
    const offenders = sourceFilesUnder(SRC_ROOT)
      .filter((file) => readFileSync(file, "utf8").includes("budgetOverrides"))
      .map((file) => file.slice(SRC_ROOT.length))
      .filter((relative) => !ALLOWED_FILES.has(relative))
      .sort();
    expect(offenders).toEqual([]);
  });

  it("no src file reads an environment variable or config key for it", () => {
    for (const file of sourceFilesUnder(SRC_ROOT)) {
      const content = readFileSync(file, "utf8");
      expect(content, file).not.toMatch(/BUDGET_OVERRIDE|MAX_HOST_CALLS_OVERRIDE/u);
    }
  });

  it("the validator can only ever narrow: the ceiling never exceeds the V2_LIMITS default", () => {
    expect(resolveHostCallCeiling(undefined)).toBe(V2_LIMITS.maxHostCalls);
    expect(() => resolveHostCallCeiling({ maxHostCalls: V2_LIMITS.maxHostCalls + 1 }))
      .toThrow(/invalid_budget_override/);
  });
});
