import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(resolve(path), "utf8");

describe("DeepSeek release evaluator contract", () => {
  it("fail-closes release mode to Node 22, one immutable clean source, and an external output", () => {
    const evaluator = read("scripts/eval-agentic.ts");
    expect(evaluator).toContain("EVAL_RELEASE_CANDIDATE_SHA");
    expect(evaluator).toContain("assertReleaseNode22");
    expect(evaluator).toContain("assertExternalReleaseOutput");
    expect(evaluator).toContain("assertReleaseSourceUnchanged");
    expect(evaluator).toContain("release DeepSeek evaluation requires an explicit --out");
  });

  it("rejects mixed-tier experiments and records the complete sanitized runtime configuration", () => {
    const evaluator = read("scripts/eval-agentic.ts");
    expect(evaluator).toContain("mixed-tier overrides are forbidden in release mode");
    for (const field of [
      "endpointSha256",
      "concurrency",
      "nodeVersion",
      "timeoutMs",
      "seed",
      "mixedTier",
    ]) expect(evaluator).toContain(field);
  });

  it("routes --only through exact-first case selection", () => {
    const evaluator = read("scripts/eval-agentic.ts");
    expect(evaluator).toContain('import { selectEvalCases } from "./eval/case-filter.js"');
    expect(evaluator).toContain("selectEvalCases(AGENTIC_CASES, flags.only)");
    expect(evaluator).not.toContain("c.id.includes(flags.only");
  });

  it("never persists provider or planner failure text in release reports", () => {
    const evaluator = read("scripts/eval-agentic.ts");
    expect(evaluator).toContain("reports: reports.map(({ id, area, passCount, repeat })");
    expect(evaluator).toContain("sampleReasons: []");
    expect(evaluator).not.toContain("reports,\n        // Secret-free per-case telemetry");
    expect(evaluator).not.toContain("result.outcome.finalText.slice");
    expect(evaluator).not.toContain('sample.join("; ")');
  });
});
