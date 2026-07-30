import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ToolCompletion } from "../../src/assistant/model-client.js";
import { DISCOVERY_META_TOOL_NAME } from "../../src/harness/api-operation.js";
import { buildEvalCases, caseByName, type EvalCase } from "../../scripts/eval-v2/case-model.js";
import { terminalCohortByName } from "../../scripts/eval-v2/assistant-terminal-cases.js";
import { runRealAssistantTurn } from "../../scripts/eval-v2/runner-harness.js";
import { runTerminalEvaluation } from "../../scripts/eval-assistant-terminal.js";
import { scriptedToolModel } from "../helpers/scripted-model.js";

/**
 * Plan B1: `HarnessOptions.maxHostCalls` was declared but silently dropped —
 * `scenarioOptions("budget_exhaustion") => { maxHostCalls: 0 }` constrained
 * nothing, so the cohort's `expectedTerminal: "failed"` was unreachable with
 * any model at any cost. These tests drive the REAL eval harness (real SQLite
 * store, real runner, real fake workspace) with the scripted model-client
 * override — zero provider calls — and pin that the override now reaches the
 * physical host-call charge boundary.
 */

/** The EXACT representative case the budget_exhaustion cohort scores. */
function budgetExhaustionCase(): EvalCase {
  const cohort = terminalCohortByName().get("budget_exhaustion");
  if (!cohort) throw new Error("missing budget_exhaustion cohort");
  const entry = caseByName(buildEvalCases()).get(cohort.actionNames[0] ?? "");
  if (!entry) throw new Error("missing budget_exhaustion representative case");
  return entry;
}

/** Discovery then the case's own read, exactly as the eval expects a model to
 * behave. Without `finalText` the scripted client repeats the read forever —
 * the shape of a model that keeps retrying a denied call. */
function scriptFor(entry: EvalCase, finalText?: string): ToolCompletion[] {
  return [
    {
      text: "",
      toolCalls: [
        { id: "tc-find", name: DISCOVERY_META_TOOL_NAME, arguments: { query: entry.canonicalRequest } },
      ],
    },
    { text: "", toolCalls: [{ id: "tc-read", name: entry.actionName, arguments: entry.expectedArguments }] },
    ...(finalText !== undefined ? [{ text: finalText, toolCalls: [] }] : []),
  ];
}

describe("B1: the eval harness host-call budget override is real", () => {
  it("maxHostCalls: 0 exhausts the budget before any dispatch and the run terminates failed", async () => {
    const entry = budgetExhaustionCase();
    const model = scriptedToolModel(scriptFor(entry));
    const run = await runRealAssistantTurn({
      seed: entry.fakeSeed,
      request: entry.canonicalRequest,
      runId: randomUUID(),
      modelClient: model,
      maxHostCalls: 0,
    });
    // The operation was discovered and requested, so the ONLY blocker is the
    // budget: the run must settle terminal `failed`, never `completed`.
    expect(run.loadedOperationNames).toContain(entry.actionName);
    expect(run.requestedToolNames).toContain(entry.actionName);
    expect(run.terminalPhase).toBe("failed");
    expect(run.outcome.kind).toBe("failed");
    if (run.outcome.kind === "failed") {
      expect(run.outcome.code).toMatch(/budget/i);
    }
  });

  it("the same drive under the production default ceiling completes", async () => {
    const entry = budgetExhaustionCase();
    const model = scriptedToolModel(scriptFor(entry, "Here is what I found."));
    const run = await runRealAssistantTurn({
      seed: entry.fakeSeed,
      request: entry.canonicalRequest,
      runId: randomUUID(),
      modelClient: model,
    });
    expect(run.requestedToolNames).toContain(entry.actionName);
    expect(run.terminalPhase).toBe("completed");
    expect(run.outcome.kind).toBe("completed");
  });

  it.each([[-1], [0.5], [61], [Number.NaN]])(
    "rejects the invalid override %s instead of silently widening or dropping it",
    async (maxHostCalls) => {
      const entry = budgetExhaustionCase();
      const model = scriptedToolModel(scriptFor(entry, "done"));
      await expect(
        runRealAssistantTurn({
          seed: entry.fakeSeed,
          request: entry.canonicalRequest,
          runId: randomUUID(),
          modelClient: model,
          maxHostCalls,
        }),
      ).rejects.toThrow(/invalid_budget_override/);
    },
  );
});

describe("B1: the terminal eval's gate is isReleasableReport, not a dead threshold", () => {
  it("a credential-less run reports releasable: false and carries no dead threshold field", async () => {
    const saved = {
      LLM_PROVIDER: process.env.LLM_PROVIDER,
      LLM_BASE_URL: process.env.LLM_BASE_URL,
      LLM_API_KEY: process.env.LLM_API_KEY,
      LLM_MODEL: process.env.LLM_MODEL,
    };
    delete process.env.LLM_PROVIDER;
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_MODEL;
    try {
      const report = await runTerminalEvaluation();
      expect(report.status).toBe("not_evaluated_missing_credentials");
      expect(report.releasable).toBe(false);
      // The effect-dead TERMINAL_AGGREGATE_THRESHOLD is deleted, not decorative.
      expect(Object.hasOwn(report, "aggregateThreshold")).toBe(false);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
