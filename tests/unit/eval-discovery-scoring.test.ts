import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ToolCompletion } from "../../src/assistant/model-client.js";
import { DISCOVERY_META_TOOL_NAME } from "../../src/harness/api-operation.js";
import { scoreRun } from "../../scripts/eval-api-discovery.js";
import { buildDiscoveryEvalCases, type DiscoveryEvalCase } from "../../scripts/eval-v2/api-discovery-cases.js";
import { buildEvalCases, caseByName, type EvalCase } from "../../scripts/eval-v2/case-model.js";
import { runRealAssistantTurn } from "../../scripts/eval-v2/runner-harness.js";
import { scriptedToolModel } from "../helpers/scripted-model.js";

/**
 * M1 fake fidelity: only the provider completions are scripted. Discovery,
 * write preparation, suspension, event journaling, SQLite, and the fake-host
 * workspace are the same real eval-harness composition used by a provider run.
 */

function evalCase(actionName: string): { entry: EvalCase; discovery: DiscoveryEvalCase } {
  const entry = caseByName(buildEvalCases()).get(actionName);
  const discovery = new Map(
    buildDiscoveryEvalCases().map((candidate) => [candidate.actionName, candidate]),
  ).get(actionName);
  if (!entry || !discovery) throw new Error(`missing_eval_case:${actionName}`);
  return { entry, discovery };
}

function scriptFor(entry: EvalCase, finalText?: string): ToolCompletion[] {
  return [
    {
      text: "",
      toolCalls: [
        { id: "tc-find", name: DISCOVERY_META_TOOL_NAME, arguments: { query: entry.canonicalRequest } },
      ],
    },
    { text: "", toolCalls: [{ id: "tc-use", name: entry.actionName, arguments: entry.expectedArguments }] },
    ...(finalText === undefined ? [] : [{ text: finalText, toolCalls: [] }]),
  ];
}

describe("M1: discovery scoring follows real runner use", () => {
  it("scores a discovered and prepared write as used", async () => {
    const { entry, discovery } = evalCase("clockify_projects_create");
    const run = await runRealAssistantTurn({
      seed: entry.fakeSeed,
      request: entry.canonicalRequest,
      runId: randomUUID(),
      modelClient: scriptedToolModel(scriptFor(entry)),
    });

    expect(run.terminalPhase).toBe("awaiting_confirmation");
    expect(run.loadedOperationNames).toContain(entry.actionName);
    expect(run.requestedToolNames).not.toContain(entry.actionName);
    expect(run.preparedWriteActionNames).toEqual([entry.actionName]);
    expect(scoreRun(
      discovery,
      run.loadedOperationNames,
      run.requestedToolNames,
      run.preparedWriteActionNames,
      run.maxLoadedApiTools,
    )).toEqual({ passed: true });
  });

  it("keeps a read-only attempt's score byte-for-byte unchanged", async () => {
    const { entry, discovery } = evalCase("clockify_projects_list");
    const run = await runRealAssistantTurn({
      seed: entry.fakeSeed,
      request: entry.canonicalRequest,
      runId: randomUUID(),
      modelClient: scriptedToolModel(scriptFor(entry, "Here are the projects.")),
    });

    expect(run.terminalPhase).toBe("completed");
    expect(run.requestedToolNames).toContain(entry.actionName);
    expect(run.preparedWriteActionNames).toEqual([]);
    expect(JSON.stringify(scoreRun(
      discovery,
      run.loadedOperationNames,
      run.requestedToolNames,
      run.preparedWriteActionNames,
      run.maxLoadedApiTools,
    ))).toBe('{"passed":true}');
  });
});
