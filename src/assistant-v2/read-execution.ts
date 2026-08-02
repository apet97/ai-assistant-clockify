import type { ToolCall } from "../assistant/model-client.js";
import { executeAction } from "../harness/actions.js";
import type { ActionContext, ActionResult } from "../harness/action.js";
import type { ActionRegistry } from "../harness/api-catalog.js";
import { defaultAdminPolicy, type AdminPolicy } from "../harness/permissions.js";
import { errorReceipt, type ErrorReceipt, type SuccessReceipt } from "../harness/receipts.js";
import { capToolResultForModel } from "../assistant/tool-results.js";
import type { WorkspaceClient } from "../clockify/client.js";
import type { ActionResultRef } from "../db/action-results.js";
import {
  PendingClarificationStoreError,
  type ClarificationScope,
  type CreatePendingClarificationInput,
  type PendingClarificationRecord,
} from "../db/store/pending-clarifications.js";
import type { ReadExecutionOutcome, RunScope } from "./protocol.js";
import { boundedDenialCode } from "./observations.js";
import { asTerminalReason } from "./terminal-reason.js";
import { classifyLoggableError } from "../log-error-class.js";
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
export function createClarificationRow(
  deps: Pick<ReadExecutionDeps, "store">,
  scope: RunScope & { runId: string },
  call: { name: string; arguments: Record<string, unknown> },
  result: Extract<ActionResult, { kind: "clarify" }>,
): string | undefined {
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
    // holds its row in `resolving`).
    //
    // This must NOT adopt the winning row's id: the caller pairs the returned
    // clarificationId with THIS read's clarify prose, so adopting another read's
    // row would render one read's question above the other read's chips and
    // resolve the wrong action (pre-T18 review, MEDIUM). Returning `undefined`
    // makes this read a truthful non-clarification; the ordered outcome loop
    // still suspends the run on the read that really owns the open question.
    const alreadyActive = error instanceof PendingClarificationStoreError
      && error.code === "clarification_already_active";
    if (!alreadyActive) throw error;
    return undefined;
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

  // Closure-plan PR 5 (F03): a read NEVER throws out of this port. A Clockify
  // transport error, timeout, malformed response, or handler bug becomes a
  // typed `failed` outcome with a bounded canonical failure result — the run
  // settles instead of stranding the session at `executing_reads`.
  let result: ActionResult;
  try {
    const context = await buildContext(scope, deps);
    result = await executeAction({
      actionName: call.name,
      args: call.arguments,
      context,
      // PR 10 (F16): execute the SAME injected registry entry the metadata
      // checks used — never a same-named global definition.
      definition: action,
    });
  } catch (error) {
    // The sweep's other hit. Unlike the six admin-visible sites, this code
    // never reaches an admin — the receipt below is deterministic and
    // `asTerminalReason` closes the route field — but it DID write a raw
    // thrown string into the model-visible observation and the durable event,
    // bounded in length by `boundedDenialCode` and never in content.
    //
    // It is not flattened outright because real reasons genuinely arrive
    // here: `requestGovernorFor` throws `installation_changed`
    // (`v2-chat-pipeline.ts:49`), and that distinction is worth keeping.
    // So: pass through anything the closed contract already recognizes, and
    // give everything else the same treatment as the other sites — one
    // bounded code plus a classified operator log, which this site alone was
    // missing.
    // A DECLARED `code` beats the prose message. `HostCallBudgetExceededError`
    // and `HostRequestCancelledError` both carry one, and their `message` is an
    // English sentence — passing that sentence through is how the budget
    // failure used to arrive here as prose that `asTerminalReason` then
    // collapsed to `internal_error` at the route.
    const declared = error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
    const thrown = declared ?? (error instanceof Error && error.message.length > 0 ? error.message : "read_failed");
    // `asTerminalReason(x) === x` is the recognizer with no cast: it is the
    // exact predicate the route applies. `invalid_*` is admitted alongside it
    // because that family maps to its own constant there, not to a fallback.
    const recognized = asTerminalReason(thrown) === thrown || thrown.startsWith("invalid_");
    if (!recognized) {
      console.error(`[v2-run] event=read_failed ${classifyLoggableError(error)}`);
    }
    const code = boundedDenialCode(recognized ? thrown : "read_failed");
    const failure: ActionResult = {
      kind: "receipt",
      receipt: errorReceipt({
        action: call.name,
        code: "read_failed",
        message: "The read did not complete.",
        recovery: { hint: "Try again, or narrow the request.", retryable: true },
      }),
    };
    const ref = persistResult(deps, scope, call.name, failure);
    return { kind: "failed", code, actionResultId: ref.id };
  }

  if (result.kind === "clarify") {
    // Persist the question as a canonical `action_results` row FIRST: it is the
    // sole owner of the admin-visible clarify prose, and the durable
    // `clarification.required` event references it by id.
    const clarifyRef = persistResult(deps, scope, call.name, result);
    const clarificationId = createClarificationRow(deps, scope, call, result);
    if (clarificationId === undefined) {
      // The run already owns an open question (another read in this same batch,
      // or the one being resolved). Report this read truthfully rather than
      // attaching its question to someone else's row.
      return { kind: "failed", code: "clarification_already_active", actionResultId: clarifyRef.id };
    }
    return { kind: "clarification", clarificationId, actionResultId: clarifyRef.id };
  }

  const ref = persistResult(deps, scope, call.name, result);

  if (result.kind !== "receipt") {
    return { kind: "failed", code: "unexpected_action_result", actionResultId: ref.id };
  }

  if (result.receipt.ok) {
    // The canonical row keeps the full receipt; the model gets the byte-capped
    // copy so it can actually answer the admin from what was read.
    return {
      kind: "succeeded",
      actionResultId: ref.id,
      modelSummary: capToolResultForModel(result.receipt),
    };
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
