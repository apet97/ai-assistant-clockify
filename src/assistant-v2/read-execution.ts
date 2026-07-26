import type { ToolCall } from "../assistant/model-client.js";
import { executeAction } from "../harness/actions.js";
import type { ActionContext, ActionResult } from "../harness/action.js";
import type { ActionRegistry } from "../harness/api-catalog.js";
import { defaultAdminPolicy, type AdminPolicy } from "../harness/permissions.js";
import { errorReceipt, type ErrorReceipt, type SuccessReceipt } from "../harness/receipts.js";
import type { WorkspaceClient } from "../clockify/client.js";
import type { ActionResultRef } from "../db/action-results.js";
import {
  PendingClarificationStoreError,
  type ClarificationScope,
  type CreatePendingClarificationInput,
  type PendingClarificationRecord,
} from "../db/store/pending-clarifications.js";
import type { ReadExecutionOutcome, RunScope } from "./protocol.js";
import { buildV2ActionContext } from "./action-context.js";

export interface ReadExecutionStore {
  recordActionResult(input: {
    workspaceId: string;
    adminUserId: string;
    sessionId?: string;
    actionName: string;
    status: "succeeded" | "definitive_failed" | "outcome_unknown";
    result: unknown;
  }): ActionResultRef;
  getActionResult(id: string): unknown | undefined;
  getAdminPolicy(workspaceId: string, adminUserId: string): AdminPolicy | undefined;
  createPendingClarification(input: CreatePendingClarificationInput): PendingClarificationRecord;
  getActiveClarificationForRun(scope: ClarificationScope): PendingClarificationRecord | undefined;
}

export interface ReadExecutionDeps {
  registry: ActionRegistry;
  clockifyForScope: (scope: RunScope) => WorkspaceClient;
  store: ReadExecutionStore;
  now?: () => Date;
  loadCalendarContext?: (scope: RunScope) => Promise<{ timeZone?: string; weekStartsOn?: number }>;
  saveArtifact?: ActionContext["saveArtifact"];
}

function statusForReceipt(receipt: SuccessReceipt | ErrorReceipt): "succeeded" | "definitive_failed" {
  return receipt.ok ? "succeeded" : "definitive_failed";
}

function persistResult(
  deps: ReadExecutionDeps,
  scope: RunScope,
  actionName: string,
  result: ActionResult,
): ActionResultRef {
  const status = result.kind === "receipt"
    ? statusForReceipt(result.receipt)
    : "definitive_failed";
  return deps.store.recordActionResult({
    workspaceId: scope.workspaceId,
    adminUserId: scope.adminUserId,
    sessionId: scope.sessionId,
    actionName,
    status,
    result,
  });
}

/**
 * CP-A: the ONE runtime producer of `pending_clarifications` rows.
 *
 * `missingField` is the exact raw-argument key the clarify names (`result.field`)
 * so the T14-D resolve side can inject the chosen candidate's `externalId` back
 * into that one argument. A clarify with no single owning argument (a date
 * range, a multi-slot project/task pair) stores the inert `"selection"` marker:
 * exact-option resolve then correctly never matches an argument, and the admin
 * answers by free-text continuation (T14-E) instead.
 *
 * `externalId` is the resolver's grounded option id (a 24-hex Clockify entity
 * id — see `suggestOptions`/`manyMatchClarify` in `workflows/resolve.ts`), which
 * is exactly what the resolve side injects.
 */
function createClarificationRow(
  deps: ReadExecutionDeps,
  scope: RunScope & { runId: string },
  call: ToolCall,
  result: Extract<ActionResult, { kind: "clarify" }>,
): string {
  const clarificationScope: ClarificationScope = {
    sessionId: scope.sessionId,
    runId: scope.runId,
    workspaceId: scope.workspaceId,
    adminUserId: scope.adminUserId,
  };
  try {
    const row = deps.store.createPendingClarification({
      ...clarificationScope,
      originalToolName: call.name,
      partialArguments: call.arguments,
      missingField: result.field ?? "selection",
      candidates: (result.options ?? []).map((option) => ({
        optionId: option.id,
        externalId: option.id,
        label: option.label,
      })),
    });
    return row.id;
  } catch (error) {
    // `idx_pending_clarifications_one_active_per_run` allows exactly one
    // pending/resolving row per run. Two reachable collisions: two ambiguous
    // reads in ONE provider batch (the read pool resolves every call before any
    // outcome suspends the run), and a re-clarify inside `resolveOption` (which
    // holds its row in `resolving`). Both must land on the run's EXISTING open
    // question rather than crash — the caller then suspends on / resets a row
    // that really exists.
    const alreadyActive = error instanceof PendingClarificationStoreError
      && error.code === "clarification_already_active";
    if (!alreadyActive) throw error;
    const existing = deps.store.getActiveClarificationForRun(clarificationScope);
    // Synchronous single-instance SQLite: the row that just rejected the insert
    // cannot have gone terminal between the two statements, so this is
    // unreachable rather than a tolerated race. Rethrow instead of inventing an
    // id the resolve side could never find.
    if (!existing) throw error;
    return existing.id;
  }
}

async function buildContext(scope: RunScope, deps: ReadExecutionDeps): Promise<ActionContext> {
  return buildV2ActionContext({
    scope,
    policy: deps.store.getAdminPolicy(scope.workspaceId, scope.adminUserId) ?? defaultAdminPolicy(),
    clockify: deps.clockifyForScope(scope),
    now: deps.now,
    loadCalendarContext: deps.loadCalendarContext,
    saveArtifact: deps.saveArtifact,
  });
}

export async function executeV2Read(
  call: ToolCall,
  scope: RunScope & { runId: string },
  deps: ReadExecutionDeps,
): Promise<ReadExecutionOutcome> {
  const action = deps.registry.get(call.name);
  if (!action) {
    const result: ActionResult = {
      kind: "receipt",
      receipt: errorReceipt({
        action: call.name,
        code: "unknown_action",
        message: `Unknown action: ${call.name}`,
        recovery: { hint: "Use discovery to load a valid operation.", retryable: false },
      }),
    };
    const ref = persistResult(deps, scope, call.name, result);
    return { kind: "failed", code: "unknown_tool", actionResultId: ref.id };
  }

  const availability = deps.registry.availability(call.name, scope.authClass);
  if (!availability.available) {
    const result: ActionResult = {
      kind: "receipt",
      receipt: errorReceipt({
        action: call.name,
        code: "unavailable_for_auth_class",
        message: "This operation is not available for the current Clockify auth class.",
        recovery: { hint: "Choose an operation available for this installation.", retryable: false },
      }),
    };
    const ref = persistResult(deps, scope, call.name, result);
    return { kind: "denied", code: "unavailable_for_auth_class", actionResultId: ref.id };
  }

  const context = await buildContext(scope, deps);
  const result = await executeAction({
    actionName: call.name,
    args: call.arguments,
    context,
  });

  if (result.kind === "clarify") {
    // Persist the question as a canonical `action_results` row FIRST: it is the
    // sole owner of the admin-visible clarify prose, and the durable
    // `clarification.required` event references it by id.
    const clarifyRef = persistResult(deps, scope, call.name, result);
    return {
      kind: "clarification",
      clarificationId: createClarificationRow(deps, scope, call, result),
      actionResultId: clarifyRef.id,
    };
  }

  const ref = persistResult(deps, scope, call.name, result);

  if (result.kind !== "receipt") {
    return { kind: "failed", code: "unexpected_action_result", actionResultId: ref.id };
  }

  if (result.receipt.ok) {
    return { kind: "succeeded", actionResultId: ref.id };
  }

  const code = result.receipt.code;
  if (code === "invalid_args" || code === "unknown_action") {
    return { kind: "validation_failed", code, actionResultId: ref.id };
  }
  if (code === "policy_denied" || code === "unavailable_for_auth_class") {
    return { kind: "denied", code, actionResultId: ref.id };
  }
  return { kind: "failed", code, actionResultId: ref.id };
}

export function createReadExecutionPort(deps: ReadExecutionDeps): {
  execute(call: ToolCall, scope: RunScope & { runId: string }): Promise<ReadExecutionOutcome>;
} {
  return {
    execute: (call, scope) => executeV2Read(call, scope, deps),
  };
}
