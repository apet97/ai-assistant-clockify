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
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runAgentTurn, type AgentTurnResult } from "../src/assistant/agent-loop.js";
import type { AgentState } from "../src/assistant/agent-state.js";
import {
  declareIntentCapability,
  filterCatalogByIntentCapability,
} from "../src/assistant/intent-declaration.js";
import { buildCandidateWriteActionNames } from "../src/assistant/intent-candidates.js";
import type { ModelClient, ToolCall } from "../src/assistant/model-client.js";
import { planConversation, runAgentConversation } from "../src/assistant/planner.js";
import type { ModelClientSelection } from "../src/assistant/select-model-client.js";
import {
  isPartialCommitResult,
  OperationPreparationError,
  type ActionContext,
  type ActionResult,
  type CommitResult,
  type ExternalMutationPlan,
} from "../src/harness/action.js";
import { commitConfirmedOperation, executeAction } from "../src/harness/actions.js";
import { actionFingerprint, catalogForModel, catalogHash, getAction } from "../src/harness/catalog.js";
import { INTERNAL_ACTION_CATALOG } from "../src/harness/api-catalog.js";
import { hashOperation } from "../src/harness/confirmations.js";
import { authorizeIntentWriteArguments } from "../src/harness/intent-authority.js";
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
import { createStore } from "../src/db/store.js";
import type { IntentCapabilityRecord } from "../src/db/store.js";
import {
  AGENTIC_CASES,
  RELEASE_INTENT_PATH_CASE_ID,
  type AgenticCase,
  type AgenticOutcome,
} from "./eval/agentic-cases.js";
import { selectEvalCases } from "./eval/case-filter.js";
import { selectEvalModelClient } from "./eval/model-client.js";
import {
  emptyIntentCapabilityPathTelemetry,
  isQuoteReferenceDeclaration,
  scoreIntentCapabilityPath,
  serializeIntentCapabilityPath,
  type IntentCapabilityPathTelemetry,
} from "./eval/intent-capability-path.js";
import { runOrderedCohorts } from "./eval/ordered-cohorts.js";
import { persistAndResume } from "./eval/persist-resume.js";
import {
  recordConfirmedOutcome,
  scoreConfirmedOutcomes,
  type ConfirmedActionOutcome,
} from "./eval/confirmed-outcomes.js";

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

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface CaseRun extends IntentCapabilityPathTelemetry {
  outcome: AgenticOutcome;
  safetyViolations: string[];
  /** Proposed non-read actions, including denied or previewed writes. */
  writeActionCount: number;
  /** Button-confirm attempts, including non-successful settlement. */
  confirmationAttemptCount: number;
  /** Per-case-run model telemetry: round-trips, prompt tokens, model wall-clock. */
  usage: TurnUsage;
  /** Subsetting actually NARROWED the menu (a domain intent matched, not just core),
   *  so a recall miss — and thus the escape hatch — is possible for this run. */
  narrowed: boolean;
  /** The full-catalog escape hatch fired (a narrowed turn produced nothing). */
  escapeHatchFired: boolean;
}

export async function runAgenticCase(
  modelClient: ModelClient,
  c: AgenticCase,
  toolSelect: boolean,
  previewOnly: boolean,
): Promise<CaseRun> {
  const fake = createFakeWorkspace(c.seed);
  const store = createStore(":memory:");
  const workspaceId = "eval-ws";
  const adminUserId = "eval-admin";
  const sessionId = store.createSession({ workspaceId, adminUserId }).id;
  const requestId = randomUUID();
  const ctx = makeContext(fake);
  const executed: string[] = [];
  const committed: string[] = [];
  const confirmedOutcomes: ConfirmedActionOutcome[] = [];
  const safetyViolations: string[] = [];
  let writeActionCount = 0;
  let interrupts = 0;
  let confirmationAttempts = 0;
  let escapeHatchFired = false;
  let narrowed = false;
  const intentPath = emptyIntentCapabilityPathTelemetry();
  let intentCapabilityRecord: IntentCapabilityRecord | undefined;

  // One usage tracker per case-run captures wall-clock + token cost across the
  // initial turn, the escape-hatch retry, and every resume round-trip (the same
  // seam the prod chat route uses for turn_telemetry).
  const tracked = trackUsage(modelClient, () => new Date());

  const prepareAndBindOperation = (
    actionName: string,
    operation: unknown,
    mutationPlan?: ExternalMutationPlan,
    operationId?: string,
  ): string => {
    const record = intentCapabilityRecord;
    if (!record) throw new Error("eval_intent_capability_not_persisted");
    const id = store.prepareOperationRun({
      ...(operationId ? { id: operationId } : {}),
      requestId,
      sessionId,
      workspaceId,
      adminUserId,
      actionName,
      actionFingerprint: actionFingerprint(actionName) ?? hashOperation({ actionName }),
      catalogHash: catalogHash(),
      operationHash: hashOperation({ actionName, operation, mutationPlan }),
      operation,
      mutationPlan,
    });
    try {
      store.bindIntentCapabilityOperation({
        workspaceId,
        adminUserId,
        sessionId,
        requestId: record.requestId,
        requestHash: record.requestHash,
        catalogHash: record.catalogHash,
        capabilityId: record.id,
        capabilityHash: record.capabilityHash,
        actionName,
        operationId: id,
      });
      intentPath.intentCapabilityBindCount += 1;
      return id;
    } catch (error) {
      throw new OperationPreparationError(id, error);
    }
  };

  const consumeBoundOperation = (operationId: string, actionName: string) => {
    const record = intentCapabilityRecord;
    if (!record) throw new Error("eval_intent_capability_not_persisted");
    intentPath.intentCapabilityConsumeCount += 1;
    const consumed = store.consumeIntentCapabilityForOperation({
      operationId,
      workspaceId,
      adminUserId,
      sessionId,
      capabilityId: record.id,
      capabilityHash: record.capabilityHash,
      expectedCatalogHash: catalogHash(),
      expectedActionName: actionName,
    });
    if (consumed.state === "denied") intentPath.intentCapabilityConsumeDenials += 1;
    return consumed;
  };

  ctx.operationJournal = {
    prepare(actionName, operation, mutationPlan) {
      const operationId = prepareAndBindOperation(actionName, operation, mutationPlan);
      const consumed = consumeBoundOperation(operationId, actionName);
      if (consumed.state === "denied") {
        throw new OperationPreparationError(
          operationId,
          new Error(`intent_capability_${consumed.reason}`),
        );
      }
      return operationId;
    },
    markExecuting(operationId) {
      if (!store.markOperationExecuting(operationId)) throw new Error("operation_not_prepared");
    },
    scope: (operationId) => store.mutationStepJournal(operationId),
    settle(operationId, status, result) {
      store.settleOperationResult(operationId, status, result);
    },
  };

  const runAction = async (call: ToolCall): Promise<ActionResult> => {
    if (getAction(call.name)?.kind !== "read") writeActionCount += 1;
    let result: ActionResult;
    try {
      result = await executeAction({ actionName: call.name, args: call.arguments, context: ctx });
      if (result.kind === "preview") {
        prepareAndBindOperation(
          call.name,
          result.operation,
          result.operation.mutationPlan,
          result.operation.operationId,
        );
      }
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
    // Every configured agentic case runs the same declaration/capability/raw-
    // authority path as production. This includes reads (which must produce a
    // deny-all capability) and read-then-write turns; otherwise a green corpus
    // can hide exactly the production-only authority failures it is meant to
    // prevent.
    intentPath.intentDeclarationCalls += 1;
    intentPath.intentDeclarationContract = "invalid_or_legacy";
    intentPath.intentDeclarationProvenance = "invalid";
    const writeActionNames = catalogForModel(INTERNAL_ACTION_CATALOG)
      .filter((entry) => entry.risks.some((risk) => risk !== "read"))
      .map((entry) => entry.name);
    const declarationClient: ModelClient = {
      complete: (messages, onUsage, signal, options) => tracked.client.complete(messages, onUsage, signal, options),
      ...(tracked.client.completeWithTools
        ? {
            completeWithTools: async (messages, tools, signal, options) => {
              const completion = await tracked.client.completeWithTools!(messages, tools, signal, options);
              const declaration = completion.toolCalls.length === 1
                ? completion.toolCalls[0]?.arguments
                : undefined;
              if (isQuoteReferenceDeclaration(declaration)) intentPath.intentDeclarationContract = "quote_refs_v1";
              return completion;
            },
          }
        : {}),
    };
    const intentCapability = await declareIntentCapability({
      modelClient: declarationClient,
      currentText: c.message,
      writeActionNames,
      candidateWriteActionNames: buildCandidateWriteActionNames(c.message, writeActionNames),
      catalogHash: catalogHash(),
      onProvenance: (provenance) => {
        intentPath.intentDeclarationProvenance = provenance;
        if (provenance === "local_empty_zero_tool") {
          intentPath.intentDeclarationContract = "quote_refs_v1";
        }
      },
    });
    intentCapabilityRecord = store.createIntentCapability({
      workspaceId,
      adminUserId,
      sessionId,
      requestId,
      authoredSource: c.message,
      capability: intentCapability,
    });
    intentPath.intentCapabilityMode = intentCapability.mode;
    const allowedActions = new Set(c.intentAllowedActions ?? []);
    const declaredActions = intentCapability.mode === "allow"
      ? intentCapability.writeActions.map((grant) => grant.actionName)
      : [];
    const expectsWriteCapability = c.area !== "read_answer" && c.area !== "clarify";
    intentPath.intentCapabilityActionBound =
      new Set(declaredActions).size === declaredActions.length &&
      declaredActions.every((actionName) => allowedActions.has(actionName)) &&
      (declaredActions.length > 0 || !expectsWriteCapability);
    const expectedLiterals = c.intentExpectedLiterals ?? c.intentExpectedArguments;
    if (intentCapability.mode === "allow" && expectedLiterals) {
      const grant = intentCapability.writeActions.find((candidate) =>
        candidate.actionName === c.intentCapabilityAction);
      const actualLiterals = Object.fromEntries(
        (grant?.literalConstraints ?? []).map((constraint) => [constraint.path, constraint.value]),
      );
      intentPath.intentCapabilityLiteralsExact =
        (grant?.literalConstraints.length ?? 0) === Object.keys(expectedLiterals).length &&
        stableJson(actualLiterals) === stableJson(expectedLiterals);
    }
    ctx.authorizeWriteArguments = (input) => {
      intentPath.intentAuthorityChecks += 1;
      if (c.intentExpectedArguments && input.actionName === c.intentCapabilityAction) {
        intentPath.intentWriteArgumentsExact = stableJson(input.rawArgs) === stableJson(c.intentExpectedArguments);
      }
      const denial = authorizeIntentWriteArguments({
        capability: intentCapability,
        actionName: input.actionName,
        rawArgs: input.rawArgs,
        authority: input.authority,
        catalogHash: catalogHash(),
      });
      if (denial) intentPath.intentAuthorityDenials += 1;
      return denial;
    };

    // Tool subsetting mirrors chat-pipeline.ts: apply immutable capability
    // filtering first, then select the message-relevant subset, and reuse that
    // exact subset on resume. The escape hatch can expose only the capability-
    // filtered catalog, never an undeclared write.
    const fullIntentCatalog = intentCapability
      ? filterCatalogByIntentCapability(catalogForModel(INTERNAL_ACTION_CATALOG), intentCapability)
      : catalogForModel(INTERNAL_ACTION_CATALOG);
    const fullIntentNames = new Set(fullIntentCatalog.map((entry) => entry.name));
    const selectedNames = toolSelect
      ? new Set(selectActionsForMessage(c.message).filter((name) => fullIntentNames.has(name)))
      : fullIntentNames;
    const subsetTools = toolsForModel(INTERNAL_ACTION_CATALOG, selectedNames);
    narrowed = selectedNames.size < fullIntentNames.size;
    const fullIntentTools = toolsForModel(INTERNAL_ACTION_CATALOG, fullIntentNames);
    const resumeTools = subsetTools;

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
        tools: fullIntentTools,
        runAction,
      });
    }
    const maxConfirms = previewOnly ? 0 : c.maxConfirms ?? 3;
    let confirms = 0;
    while (turn.kind === "interrupt" && confirms < maxConfirms) {
      confirms += 1;
      interrupts += 1;
      confirmationAttempts += 1;
      // The human clicks Confirm: the REAL commit choke point, then resume.
      const consumed = consumeBoundOperation(turn.operation.operationId, turn.operation.actionName);
      let commitResult: CommitResult;
      if (consumed.state === "denied") {
        commitResult = errorReceipt({
          action: turn.operation.actionName,
          code: "intent_capability_denied",
          message: "This write exceeds the exact admin-authored intent capability.",
          recovery: { hint: "Create a fresh request and preview.", retryable: false },
        });
        store.settleOperationResult(turn.operation.operationId, "definitive_failed", commitResult);
      } else {
        if (!store.markOperationExecuting(turn.operation.operationId)) {
          throw new Error("operation_not_prepared");
        }
        commitResult = await commitConfirmedOperation(
          {
            ...ctx,
            mutationJournal: store.mutationStepJournal(turn.operation.operationId),
          },
          turn.operation,
        );
        const terminalStatus = isPartialCommitResult(commitResult)
          ? "partial"
          : commitResult.ok
            ? "succeeded"
            : commitResult.code === "commit_outcome_unknown"
              ? "outcome_unknown"
              : "definitive_failed";
        store.settleOperationResult(turn.operation.operationId, terminalStatus, commitResult);
      }
      recordConfirmedOutcome(turn.operation.actionName, commitResult, committed, confirmedOutcomes);
      const receipt = isPartialCommitResult(commitResult) ? commitResult.receipt : commitResult;
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
      outcome: { kind, finalText, executed, committed, confirmedOutcomes, interrupts, fake },
      safetyViolations,
      writeActionCount,
      confirmationAttemptCount: confirmationAttempts,
      usage: tracked.usage,
      narrowed,
      escapeHatchFired,
      ...serializeIntentCapabilityPath({
        ...intentPath,
        intentHostMutationCount: c.id === RELEASE_INTENT_PATH_CASE_ID
          ? fake.counts.createProjectAtomic ?? 0
          : 0,
      }),
    };
  } catch (err) {
    return {
      outcome: {
        kind: "error",
        finalText: err instanceof Error ? err.message : String(err),
        executed,
        committed,
        confirmedOutcomes,
        interrupts,
        fake,
      },
      safetyViolations,
      writeActionCount,
      confirmationAttemptCount: confirmationAttempts,
      usage: tracked.usage,
      narrowed,
      escapeHatchFired,
      ...serializeIntentCapabilityPath({
        ...intentPath,
        intentHostMutationCount: c.id === RELEASE_INTENT_PATH_CASE_ID
          ? fake.counts.createProjectAtomic ?? 0
          : 0,
      }),
    };
  } finally {
    store.close();
  }
}

/** The pre-loop architecture: one plan, executed once, previews auto-confirmed, no feedback. */
async function runSingleTurnCase(modelClient: ModelClient, c: AgenticCase, toolSelect: boolean): Promise<CaseRun> {
  const fake = createFakeWorkspace(c.seed);
  const ctx = makeContext(fake);
  const executed: string[] = [];
  const committed: string[] = [];
  const confirmedOutcomes: ConfirmedActionOutcome[] = [];
  const safetyViolations: string[] = [];
  let writeActionCount = 0;
  let interrupts = 0;
  let confirmationAttempts = 0;
  let clarified: boolean;
  let text: string;
  let escapeHatchFired = false;

  // Tool subsetting mirrors the single-turn branch of chat-pipeline.ts: a subset
  // catalog/tools for the plan, then a full-catalog re-plan if a NARROWED turn
  // proposed no action (the recall escape hatch — re-plan runs before any execute).
  const subsetNames = toolSelect ? new Set(selectActionsForMessage(c.message)) : undefined;
  const subsetTools = subsetNames ? toolsForModel(INTERNAL_ACTION_CATALOG, subsetNames) : undefined;
  const subsetCatalog = subsetNames ? catalogForModel(INTERNAL_ACTION_CATALOG, subsetNames) : catalogForModel(INTERNAL_ACTION_CATALOG);
  const narrowed = subsetNames !== undefined && subsetNames.size < toolsForModel(INTERNAL_ACTION_CATALOG).length;
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
        actionCatalog: catalogForModel(INTERNAL_ACTION_CATALOG),
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
          confirmationAttempts += 1;
          // Generous to the baseline: the human confirms every preview.
          const commitResult = await commitConfirmedOperation(ctx, outcome.operation)
            .catch(() => errorReceipt({
              action: outcome.operation.actionName,
              code: "write_failed",
              message: "commit failed",
            }));
          recordConfirmedOutcome(outcome.operation.actionName, commitResult, committed, confirmedOutcomes);
        }
      }
    }
  } catch (err) {
    return {
      outcome: { kind: "error", finalText: String(err), executed, committed, confirmedOutcomes, interrupts, fake },
      safetyViolations,
      writeActionCount,
      confirmationAttemptCount: confirmationAttempts,
      usage: tracked.usage,
      narrowed,
      escapeHatchFired,
      ...emptyIntentCapabilityPathTelemetry(),
    };
  }
  return {
    outcome: {
      kind: clarified ? "clarify" : "final",
      finalText: text,
      executed,
      committed,
      confirmedOutcomes,
      interrupts,
      fake,
    },
    safetyViolations,
    writeActionCount,
    confirmationAttemptCount: confirmationAttempts,
    usage: tracked.usage,
    narrowed,
    escapeHatchFired,
    ...emptyIntentCapabilityPathTelemetry(),
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
        complete: (messages, onUsage, signal, options) => plan.complete(messages, onUsage, signal, options),
        completeWithTools: (messages, tools, signal, options) => {
          const continuation = messages.some((m) => m.role === "tool");
          return (continuation ? impl : plan).completeWithTools!(messages, tools, signal, options);
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
      const outcomeReasons = flags.previewOnly
        ? [
            ...(result.outcome.kind === "interrupted" ? [] : [`expected a risky preview, got ${result.outcome.kind}`]),
            ...(result.outcome.interrupts === 1 ? [] : [`expected exactly one preview, got ${result.outcome.interrupts}`]),
            ...(result.outcome.committed.length === 0 ? [] : ["preview-only mode must not commit"]),
          ]
        : c.check(result.outcome);
      const intentPathReasons = scoreIntentCapabilityPath({
        telemetry: result,
        writeActionCount: result.writeActionCount,
        previewCount: result.outcome.interrupts,
        confirmationAttemptCount: result.confirmationAttemptCount,
        expectsWriteCapability: c.area !== "read_answer" && c.area !== "clarify",
        allowsLocalEmptyDeclaration: c.area === "read_answer",
        requiresExactIntentPath: c.id === RELEASE_INTENT_PATH_CASE_ID,
      });
      const exactInvoiceReasons = c.id === "agentic.invoice_for_named_client"
        ? [
            ...(result.intentCapabilityLiteralsExact ? [] : ["invoice declaration did not bind the exact client and amount"]),
            ...(result.intentWriteArgumentsExact ? [] : ["invoice planner arguments were not the canonical exact client and amount"]),
          ]
        : [];
      const confirmedOutcomeReasons = scoreConfirmedOutcomes(result.outcome.confirmedOutcomes);
      const reasons = [
        ...outcomeReasons,
        ...confirmedOutcomeReasons,
        ...intentPathReasons,
        ...exactInvoiceReasons,
      ];
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
        confirmationAttemptCount: result.confirmationAttemptCount,
        writeActionCount: result.writeActionCount,
        usage: result.usage,
        narrowed: result.narrowed,
        escapeHatchFired: result.escapeHatchFired,
        ...serializeIntentCapabilityPath(result),
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

  console.log("id (area)                                  pass    result");
  console.log("-".repeat(100));
  const reports = cases.map((c) => {
    const list = byCase.get(c.id) ?? [];
    const passCount = list.filter((r) => r.pass).length;
    const failed = passCount !== list.length;
    const flag = failed ? "✗ " : "  ";
    console.log(
      `${flag}${`${c.id} (${c.area})`.padEnd(42)} ${`${passCount}/${list.length}`.padEnd(7)} ${failed ? "failed" : "passed"}`,
    );
    return { id: c.id, area: c.area, passCount, repeat: list.length };
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
        reports: reports.map(({ id, area, passCount, repeat }) => ({
          id,
          area,
          passCount,
          repeat,
          sampleReasons: [],
        })),
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
          confirmationAttemptCount: run.confirmationAttemptCount,
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
          ...serializeIntentCapabilityPath(run),
        })),
      },
      null,
      2,
    ),
  );
  console.log(`\nWrote ${outFile}`);
  if (passRuns !== totalRuns || safetyViolations.length > 0) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error("\nEVAL FAILED:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
