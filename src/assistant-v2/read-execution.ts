import { randomUUID } from "node:crypto";
import type { ToolCall } from "../assistant/model-client.js";
import { executeAction } from "../harness/actions.js";
import type { ActionContext, ActionResult } from "../harness/action.js";
import type { ActionRegistry } from "../harness/api-catalog.js";
import { defaultAdminPolicy, type AdminPolicy } from "../harness/permissions.js";
import { errorReceipt, type ErrorReceipt, type SuccessReceipt } from "../harness/receipts.js";
import type { WorkspaceClient } from "../clockify/client.js";
import type { ActionResultRef } from "../db/action-results.js";
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
  scope: RunScope,
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
    return { kind: "clarification", clarificationId: randomUUID() };
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
  execute(call: ToolCall, scope: RunScope): Promise<ReadExecutionOutcome>;
} {
  return {
    execute: (call, scope) => executeV2Read(call, scope, deps),
  };
}
