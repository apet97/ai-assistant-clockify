import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ToolCompletion } from "../../src/assistant/model-client.js";
import { DISCOVERY_META_TOOL_NAME } from "../../src/harness/api-operation.js";
import { loadedUnrelatedDestructiveOperations, scoreRun } from "../../scripts/eval-api-discovery.js";
import { buildDiscoveryEvalCases, type DiscoveryEvalCase } from "../../scripts/eval-v2/api-discovery-cases.js";
import { buildEvalCases, caseByName, type EvalCase } from "../../scripts/eval-v2/case-model.js";
import { buildEvalReport } from "../../scripts/eval-v2/report.js";
import { runRealAssistantTurn } from "../../scripts/eval-v2/runner-harness.js";
import { scriptedToolModel } from "../helpers/scripted-model.js";

/**
 * M1/M3 fake fidelity: only the provider completions are scripted. Discovery,
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

function scriptFor(entry: EvalCase, finalText?: string, discoveryQuery = entry.canonicalRequest): ToolCompletion[] {
  return [
    {
      text: "",
      toolCalls: [
        { id: "tc-find", name: DISCOVERY_META_TOOL_NAME, arguments: { query: discoveryQuery } },
      ],
    },
    { text: "", toolCalls: [{ id: "tc-use", name: entry.actionName, arguments: entry.expectedArguments }] },
    ...(finalText === undefined ? [] : [{ text: finalText, toolCalls: [] }]),
  ];
}

const REPORT_IDENTITY = {
  candidateSha: "0".repeat(40),
  catalogHash: "0".repeat(64),
  registryId: "v2-api" as const,
  modelConfiguration: "scripted-test-model",
  cohortOrder: ["canonical"],
};

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
    expect(run.requestedToolNames).toContain(entry.actionName);
    expect(run.preparedWriteActionNames).toEqual([entry.actionName]);
    expect(scoreRun(
      discovery,
      run.loadedOperationNames,
      run.requestedToolNames,
      run.modelCalledToolNames,
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
      run.modelCalledToolNames,
      run.preparedWriteActionNames,
      run.maxLoadedApiTools,
    ))).toBe('{"passed":true}');
  });
});

describe("M3: destructive selection follows model calls", () => {
  it("passes when an unrelated destructive operation was loaded but never called, while reporting the load", async () => {
    const { entry, discovery } = evalCase("clockify_scheduling_user_totals");
    const loadedDestructive = "clockify_groups_remove_user";
    const run = await runRealAssistantTurn({
      seed: entry.fakeSeed,
      request: entry.canonicalRequest,
      runId: randomUUID(),
      // A model searches by operation concept rather than repeating the M5
      // argument-bearing admin request verbatim. This keeps M3's real ranked-set
      // telemetry scenario while the user request supplies its required dates.
      modelClient: scriptedToolModel(scriptFor(entry, "Here are the scheduling totals.", "scheduling user totals")),
    });

    expect(run.loadedOperationNames).toContain(loadedDestructive);
    expect(run.requestedToolNames).not.toContain(loadedDestructive);
    expect(run.modelCalledToolNames).not.toContain(loadedDestructive);
    const scored = scoreRun(
      discovery,
      run.loadedOperationNames,
      run.requestedToolNames,
      run.modelCalledToolNames,
      run.preparedWriteActionNames,
      run.maxLoadedApiTools,
    );
    const loadedTelemetry = loadedUnrelatedDestructiveOperations(discovery, run.loadedOperationNames);
    const report = buildEvalReport({
      kind: "v2_api_discovery",
      identity: REPORT_IDENTITY,
      caseIds: [entry.actionName],
      attempts: [{
        caseId: entry.actionName,
        cohort: "canonical",
        repeat: 0,
        ...scored,
        loadedUnrelatedDestructiveOperations: loadedTelemetry,
      }],
    });

    expect({
      score: scored,
      status: report.status,
      telemetry: report.loadedUnrelatedDestructiveTelemetry,
    }).toEqual({
      score: {
        passed: true,
      },
      status: "passed",
      telemetry: {
        attempts: 1,
        loads: 1,
        operations: [{ actionName: loadedDestructive, loads: 1 }],
      },
    });
  });

  it("fails when the model calls an unrelated destructive operation that the loaded-set guard denies", async () => {
    const { entry, discovery } = evalCase("clockify_projects_list");
    const deniedDestructive = "clockify_invoices_delete";
    const run = await runRealAssistantTurn({
      seed: entry.fakeSeed,
      request: entry.canonicalRequest,
      runId: randomUUID(),
      modelClient: scriptedToolModel([
        {
          text: "",
          toolCalls: [
            { id: "tc-find", name: DISCOVERY_META_TOOL_NAME, arguments: { query: entry.canonicalRequest } },
          ],
        },
        {
          text: "",
          toolCalls: [
            { id: "tc-use", name: entry.actionName, arguments: entry.expectedArguments },
            { id: "tc-denied-delete", name: deniedDestructive, arguments: {} },
          ],
        },
        { text: "Here are the projects.", toolCalls: [] },
      ]),
    });

    expect(run.loadedOperationNames).not.toContain(deniedDestructive);
    expect(run.requestedToolNames).not.toContain(deniedDestructive);
    expect(run.modelCalledToolNames).toContain(deniedDestructive);
    expect(scoreRun(
      discovery,
      run.loadedOperationNames,
      run.requestedToolNames,
      run.modelCalledToolNames,
      run.preparedWriteActionNames,
      run.maxLoadedApiTools,
    )).toEqual({
      passed: false,
      failureCode: `unrelated_destructive_loaded:${deniedDestructive}`,
    });
  });

  it("does not count a denied target call as use of the loaded operation", async () => {
    const { entry, discovery } = evalCase("clockify_projects_list");
    const run = await runRealAssistantTurn({
      seed: entry.fakeSeed,
      request: entry.canonicalRequest,
      runId: randomUUID(),
      modelClient: scriptedToolModel([
        {
          text: "",
          toolCalls: [
            { id: "tc-find", name: DISCOVERY_META_TOOL_NAME, arguments: { query: entry.canonicalRequest } },
          ],
        },
        {
          text: "",
          toolCalls: [
            { id: "tc-refine", name: DISCOVERY_META_TOOL_NAME, arguments: { query: entry.canonicalRequest } },
            { id: "tc-denied-target", name: entry.actionName, arguments: entry.expectedArguments },
          ],
        },
        { text: "I could not run that operation.", toolCalls: [] },
      ]),
    });

    expect(run.terminalPhase).toBe("completed");
    expect(run.loadedOperationNames).toContain(entry.actionName);
    expect(run.requestedToolNames).toEqual([]);
    expect(run.modelCalledToolNames).toContain(entry.actionName);
    expect(run.preparedWriteActionNames).toEqual([]);
    expect(scoreRun(
      discovery,
      run.loadedOperationNames,
      run.requestedToolNames,
      run.modelCalledToolNames,
      run.preparedWriteActionNames,
      run.maxLoadedApiTools,
    )).toEqual({ passed: false, failureCode: "operation_loaded_but_not_used" });
  });
});
