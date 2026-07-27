import { getAction, suggestActionNames } from "./catalog.js";
import {
  clarifyResult,
  isAtomicLedger,
  isPartialCommitResult,
  isPreparedSafeWrite,
  isSafeWriteClarification,
  isSafeWriteNoop,
  mutationPlanContractError,
  OperationPreparationError,
} from "./action.js";
import type {
  ActionContext,
  ActionDefinition,
  ActionResult,
  AtomicIdempotencyLedger,
  ClaimState,
  ConfirmableOperation,
  CommitResult,
  ExternalMutationPlan,
  IdempotencyLedger,
  SafeWriteActionDefinition,
} from "./action.js";
import type { ActionOrigin, RegistryId } from "./action-discriminators.js";
import { buildPreparedSafeWritePreview } from "./durable-safe-write.js";
import { validateAssistantPrimaryMutationPlan } from "./durable-risky-write.js";
import { canRead, canWrite } from "./permissions.js";
import type { FeatureGroup } from "./permissions.js";
import { isSafeWrite, requiresConfirmation } from "./risk.js";
import { errorReceipt, type ErrorReceipt, type SuccessReceipt } from "./receipts.js";
import { idempotencyScopeKey, markCommitReplayed, markReplayed } from "./idempotency.js";
import { formatZodIssues, unknownArgumentPaths } from "./arg-shapes.js";
import { AmbiguousWriteOutcome, DefinitiveWriteFailure } from "../clockify/write-outcome.js";
import { withMutationPlanScope } from "../clockify/rest/core.js";
import { HostCallBudgetExceededError } from "../clockify/request-governor.js";
import { bindMutationPlanHostCalls } from "./safety-limits.js";
import { validateWriteAuthorityOperation } from "./write-authority.js";

/**
 * Action executor — the safety boundary (ARCHITECTURE "The model can propose.
 * The harness decides. The backend executes."). Validates the action name,
 * schema, and policy, then dispatches. Fail-closed: an action executes
 * immediately only when it is an explicit read or an explicit safe_write;
 * anything requiring confirmation returns a preview, and anything unclassified
 * is refused.
 */
export interface ExecuteActionInput {
  actionName: string;
  args: unknown;
  context: ActionContext;
}

export interface ExecuteV2ApiActionInput extends ExecuteActionInput {
  origin: ActionOrigin;
  registryId: RegistryId;
  installationGeneration?: number;
}

/** Strict closed raw-args gate for v2 assistant writes — no v1 capability matcher. */
export function validateV2RawActionArguments(
  action: ActionDefinition,
  rawArgs: unknown,
): ErrorReceipt | undefined {
  if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    if ("provenance" in (rawArgs as Record<string, unknown>)) {
      return errorReceipt({
        action: action.name,
        code: "invalid_args",
        message: "Model-supplied provenance is not allowed.",
        recovery: { hint: "Remove the provenance field and try again.", retryable: false },
      });
    }
  }
  const unknown = unknownArgumentPaths(
    action.schema,
    rawArgs,
    action.argumentAliases,
    action.argumentOpenPaths,
  );
  if (unknown.length > 0) {
    return errorReceipt({
      action: action.name,
      code: "invalid_args",
      message: `Unknown argument${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`,
      recovery: { hint: "Remove unknown fields and try again.", retryable: true },
    });
  }
  return undefined;
}

function invalidWriteAuthorityActionResult(action: string, detail: string): ActionResult {
  return invalidWriteAuthorityResult(action, detail);
}

/**
 * V2 assistant-origin write path: always prepare, never dispatch. Legacy
 * executeAction safe-write immediate execution remains unchanged for v1 rollback.
 */
export async function executeV2ApiAction(input: ExecuteV2ApiActionInput): Promise<ActionResult> {
  if (input.origin !== "assistant") {
    return {
      kind: "receipt",
      receipt: errorReceipt({
        action: input.actionName,
        code: "invalid_origin",
        message: "Only assistant origin may use the v2 preparation path.",
        recovery: { hint: "Use a trusted origin for direct execution.", retryable: false },
      }),
    };
  }
  if (input.registryId !== "v2-api") {
    return {
      kind: "receipt",
      receipt: errorReceipt({
        action: input.actionName,
        code: "invalid_registry",
        message: "The v2 preparation path requires the v2-api registry.",
        recovery: { hint: "Load the current model catalog before retrying.", retryable: false },
      }),
    };
  }

  const action = getAction(input.actionName);
  if (!action) {
    const suggestions = suggestActionNames(input.actionName);
    const hint = suggestions.length
      ? `Did you mean: ${suggestions.join(", ")}? Use only catalog action names.`
      : "Use only the actions in the catalog.";
    return {
      kind: "receipt",
      receipt: errorReceipt({
        action: input.actionName,
        code: "unknown_action",
        message: `Unknown action: ${input.actionName}`,
        recovery: { hint, retryable: suggestions.length > 0 },
      }),
    };
  }

  const rawError = validateV2RawActionArguments(action, input.args);
  if (rawError) return { kind: "receipt", receipt: rawError };

  const parsed = action.schema.safeParse(input.args);
  if (!parsed.success) {
    return {
      kind: "receipt",
      receipt: errorReceipt({
        action: action.name,
        code: "invalid_args",
        message: formatZodIssues(parsed.error) || "Invalid arguments.",
        recovery: { hint: "Fix the arguments and try again.", retryable: true },
      }),
    };
  }

  const group = action.resolveFeatureGroup
    ? action.resolveFeatureGroup(parsed.data)
    : action.featureGroup;
  const kindMatchesRisk = action.kind === "read"
    ? action.risks.length > 0 && action.risks.every((risk) => risk === "read")
    : action.kind === "safe_write"
      ? isSafeWrite(action.risks)
      : action.kind === "risky_write" && requiresConfirmation(action.risks);
  if (!kindMatchesRisk || action.kind === "read") return unclassifiedAction(action.name);

  const isPermissionChange = action.risks.includes("permission_change");
  if (!isPermissionChange && !canWrite(input.context.policy, group)) {
    return policyDenied(action.name, group, "write");
  }

  if (action.kind === "safe_write") {
    let prepared: Awaited<ReturnType<SafeWriteActionDefinition["prepareSafeWrite"]>> | undefined;
    try {
      prepared = await action.prepareSafeWrite(input.context, parsed.data);
    } catch (error) {
      return { kind: "receipt", receipt: writeFailureReceipt(action.name, error) };
    }
    if (isSafeWriteClarification(prepared)) return clarifyResult(prepared);
    if (isSafeWriteNoop(prepared)) return { kind: "receipt", receipt: prepared.receipt };
    if (prepared !== undefined && !isPreparedSafeWrite(prepared)) {
      return invalidSafeWritePreparation(action.name);
    }
    const boundedPrepared = prepared
      ? {
          ...prepared,
          mutationPlan: bindMutationPlanHostCalls(action.name, prepared.operation, prepared.mutationPlan),
        }
      : undefined;
    if (!boundedPrepared) return invalidSafeWritePreparation(action.name);
    const primaryError = validateAssistantPrimaryMutationPlan(action, boundedPrepared.mutationPlan);
    if (primaryError) return invalidWriteAuthorityActionResult(action.name, primaryError);
    const authorityPlanError = validateWriteAuthorityOperation(
      action,
      boundedPrepared.operation,
      boundedPrepared.mutationPlan,
    );
    if (authorityPlanError) return invalidWriteAuthorityActionResult(action.name, authorityPlanError);
    return buildPreparedSafeWritePreview({
      action,
      prepared: boundedPrepared,
      group,
      installationGeneration: input.installationGeneration,
    });
  }

  const result = await action.handler(input.context, parsed.data);
  if (result.kind === "receipt" && result.receipt.ok) {
    return {
      kind: "receipt",
      receipt: errorReceipt({
        action: action.name,
        code: "risky_without_confirmation",
        message: "Risky action attempted to execute without confirmation.",
        recovery: { hint: "This is a bug; the action was blocked.", retryable: false },
      }),
    };
  }
  if (result.kind !== "preview") return result;
  if (result.operation.mutationPlan) {
    result.operation.mutationPlan = bindMutationPlanHostCalls(
      action.name,
      result.operation.payload,
      result.operation.mutationPlan,
    );
    const primaryError = validateAssistantPrimaryMutationPlan(action, result.operation.mutationPlan);
    if (primaryError) return invalidWriteAuthorityActionResult(action.name, primaryError);
    const authorityPlanError = validateWriteAuthorityOperation(
      action,
      result.operation.payload,
      result.operation.mutationPlan,
    );
    if (authorityPlanError) return invalidWriteAuthorityActionResult(action.name, authorityPlanError);
  }
  if (input.installationGeneration !== undefined) {
    result.operation = {
      ...result.operation,
      installationGeneration: input.installationGeneration,
    };
  }
  return result;
}

function hasAuthoritativelyReconciledStep(
  journal: NonNullable<ActionContext["mutationJournal"]>,
  planStepId: string,
): boolean {
  const step = journal.listOperationSteps().find((candidate) =>
    candidate.kind === "primary" && candidate.planStepId === planStepId && candidate.status === "succeeded");
  if (!step || !step.detail || typeof step.detail !== "object" || Array.isArray(step.detail)) return false;
  return (step.detail as Record<string, unknown>).authoritativeReconciliation === true;
}

export async function executeAction(input: ExecuteActionInput): Promise<ActionResult> {
  const action = getAction(input.actionName);
  if (!action) {
    // "Did you mean" (Phase 3): name the closest real actions so a weak model that
    // typos/scrambles a name self-corrects on the next step instead of dead-ending.
    // Mark retryable only when we actually have a lead to offer.
    const suggestions = suggestActionNames(input.actionName);
    const hint = suggestions.length
      ? `Did you mean: ${suggestions.join(", ")}? Use only catalog action names.`
      : "Use only the actions in the catalog.";
    return {
      kind: "receipt",
      receipt: errorReceipt({
        action: input.actionName,
        code: "unknown_action",
        message: `Unknown action: ${input.actionName}`,
        recovery: { hint, retryable: suggestions.length > 0 },
      }),
    };
  }

  const unknown = unknownArgumentPaths(
    action.schema,
    input.args,
    action.argumentAliases,
    action.argumentOpenPaths,
  );
  if (unknown.length > 0) {
    return {
      kind: "receipt",
      receipt: errorReceipt({
        action: action.name,
        code: "invalid_args",
        message: `Unknown argument${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`,
        recovery: { hint: "Remove unknown fields and try again.", retryable: true },
      }),
    };
  }

  const writeAction = action.kind !== "read";
  const externalWrite = action.name.startsWith("clockify_") && writeAction;
  if (writeAction && input.context.authorizeWriteArguments) {
    if (!action.writeAuthority) {
      return {
        kind: "receipt",
        receipt: errorReceipt({
          action: action.name,
          code: "intent_capability_denied",
          message: "This write has no declared authority contract.",
          recovery: { hint: "Refresh the action catalog before retrying.", retryable: false },
        }),
      };
    }
    const denied = await input.context.authorizeWriteArguments({
      actionName: action.name,
      rawArgs: input.args,
      authority: action.writeAuthority,
    });
    if (denied) return { kind: "receipt", receipt: denied };
  }

  const parsed = action.schema.safeParse(input.args);
  if (!parsed.success) {
    return {
      kind: "receipt",
      receipt: errorReceipt({
        action: action.name,
        code: "invalid_args",
        // Field-path-prefixed so the agent loop can self-correct ("assigneeIds:
        // Expected array, received string" — not just the bare Zod message).
        message: formatZodIssues(parsed.error) || "Invalid arguments.",
        recovery: { hint: "Fix the arguments and try again.", retryable: true },
      }),
    };
  }

  const { policy } = input.context;
  const group = action.resolveFeatureGroup
    ? action.resolveFeatureGroup(parsed.data)
    : action.featureGroup;
  const kindMatchesRisk = action.kind === "read"
    ? action.risks.length > 0 && action.risks.every((risk) => risk === "read")
    : action.kind === "safe_write"
      ? isSafeWrite(action.risks)
      : action.kind === "risky_write" && requiresConfirmation(action.risks);
  if (!kindMatchesRisk) return unclassifiedAction(action.name);
  const isRead = action.kind === "read";
  const isPermissionChange = action.risks.includes("permission_change");

  // Managing one's own assistant permissions is not gated by a Clockify feature
  // group (it is not a Clockify write). Everything else is policy-gated.
  if (!isPermissionChange) {
    if (isRead) {
      if (!canRead(policy, group)) return policyDenied(action.name, group, "read");
    } else if (!canWrite(policy, group)) {
      return policyDenied(action.name, group, "write");
    }
  }

  if (action.kind === "risky_write") {
    const result = await action.handler(input.context, parsed.data);
    // A risky action must never execute on first proposal: a success receipt
    // here would mean it mutated without confirmation.
    if (result.kind === "receipt" && result.receipt.ok) {
      return {
        kind: "receipt",
        receipt: errorReceipt({
          action: action.name,
          code: "risky_without_confirmation",
          message: "Risky action attempted to execute without confirmation.",
          recovery: { hint: "This is a bug; the action was blocked.", retryable: false },
        }),
      };
    }
    if (result.kind === "preview" && externalWrite && result.operation.mutationPlan) {
      result.operation.mutationPlan = bindMutationPlanHostCalls(
        action.name,
        result.operation.payload,
        result.operation.mutationPlan,
      );
      const authorityPlanError = validateWriteAuthorityOperation(
        action,
        result.operation.payload,
        result.operation.mutationPlan,
      );
      if (authorityPlanError) return invalidWriteAuthorityResult(action.name, authorityPlanError);
    }
    return result;
  }

  if (action.kind === "read") {
    return action.handler(input.context, parsed.data);
  }
  if (action.kind === "safe_write") {
    let prepared: Awaited<ReturnType<typeof action.prepareSafeWrite>> | undefined;
    try {
      prepared = await action.prepareSafeWrite(input.context, parsed.data);
    } catch (error) {
      return { kind: "receipt", receipt: writeFailureReceipt(action.name, error) };
    }
    if (isSafeWriteClarification(prepared)) return clarifyResult(prepared);
    if (isSafeWriteNoop(prepared)) return { kind: "receipt", receipt: prepared.receipt };
    if (prepared !== undefined && !isPreparedSafeWrite(prepared)) {
      return {
        kind: "receipt",
        receipt: errorReceipt({
          action: action.name,
          code: "invalid_safe_write_preparation",
          message: "Safe-write preparation returned an invalid result.",
          recovery: { hint: "Correct the action's prepare contract before retrying.", retryable: false },
        }),
      };
    }
    const boundedPrepared = prepared
      ? {
          ...prepared,
          mutationPlan: bindMutationPlanHostCalls(action.name, prepared.operation, prepared.mutationPlan),
        }
      : undefined;
    if (boundedPrepared) {
      const authorityPlanError = validateWriteAuthorityOperation(
        action,
        boundedPrepared.operation,
        boundedPrepared.mutationPlan,
      );
      if (authorityPlanError) return invalidWriteAuthorityResult(action.name, authorityPlanError);
    }
    const authorityError = await input.context.authorizeWrite?.(action.name);
    if (authorityError) return { kind: "receipt", receipt: authorityError };
    let operationId: string | undefined;
    try {
      if (input.context.operationJournal) {
        operationId = input.context.operationJournal.prepare(
          action.name,
          boundedPrepared?.operation ?? parsed.data,
          boundedPrepared?.mutationPlan,
        );
        input.context.operationJournal.markExecuting(operationId);
      }
      const executionContext = operationId && input.context.operationJournal
        ? {
            ...input.context,
            mutationJournal: input.context.operationJournal.scope(operationId),
          }
        : input.context;
      if (!boundedPrepared) return settleImmediateOperation(input.context, operationId, invalidSafeWritePreparation(action.name));
      const executed = executionContext.mutationJournal
        ? await withMutationPlanScope({
            actionName: action.name,
            plan: boundedPrepared.mutationPlan,
            authorizeDispatch: () => input.context.authorizeWrite?.(action.name),
            onDispatch: (step) => markScopedStepDispatched(executionContext.mutationJournal!, step.id, step.kind),
            authoritativelyReconciled: (stepId) =>
              hasAuthoritativelyReconciledStep(executionContext.mutationJournal!, stepId),
            requiresComplete: commitResultRequiresComplete,
          }, () => action.executeSafeWrite(executionContext, boundedPrepared))
        : await action.executeSafeWrite(executionContext, boundedPrepared);
      const result: ActionResult = isPartialCommitResult(executed)
        ? executed
        : { kind: "receipt", receipt: executed };
      return settleImmediateOperation(input.context, operationId, result);
    } catch (error) {
      if (error instanceof OperationPreparationError) operationId = error.operationId;
      const result: ActionResult = { kind: "receipt", receipt: writeFailureReceipt(action.name, error) };
      return settleImmediateOperation(input.context, operationId, result);
    }
  }

  // Fail closed: not a read, not a safe_write, not requiring confirmation.
  return unclassifiedAction(input.actionName);
}

function invalidSafeWritePreparation(actionName: string): ActionResult {
  return {
    kind: "receipt",
    receipt: errorReceipt({
      action: actionName,
      code: "invalid_safe_write_preparation",
      message: "Safe-write preparation returned an invalid result.",
      recovery: { hint: "Correct the action's prepare contract before retrying.", retryable: false },
    }),
  };
}

function unclassifiedAction(actionName: string): ActionResult {
  return {
    kind: "receipt",
    receipt: errorReceipt({
      action: actionName,
      code: "unclassified_action",
      message: "Action kind and risk classification are inconsistent; refusing to execute.",
      recovery: { hint: "This action needs a valid discriminated risk classification.", retryable: false },
    }),
  };
}

function settleImmediateOperation(ctx: ActionContext, operationId: string | undefined, result: ActionResult): ActionResult {
  if (!operationId || !ctx.operationJournal) return result;
  const status = result.kind === "partial"
    ? "partial"
    : result.kind === "receipt" && result.receipt.ok
      ? "succeeded"
      : result.kind === "receipt" && !result.receipt.ok && result.receipt.code === "commit_outcome_unknown"
        ? "outcome_unknown"
        : "definitive_failed";
  try {
    ctx.operationJournal.settle(operationId, status, result);
  } catch (error) {
    console.error(
      "operation journal settlement failed:",
      error instanceof Error ? error.message : String(error),
    );
  }
  return { ...result, operationId };
}

export interface ExecuteTrustedDirectV2Input extends ExecuteActionInput {
  origin: ActionOrigin;
  registryId: RegistryId;
  installationGeneration?: number;
}

/**
 * Trusted-origin immediate safe write: explicit origin is required and only
 * reviewed safe_write actions may dispatch without a pending confirmation row.
 */
export async function executeTrustedDirectV2SafeWrite(
  input: ExecuteTrustedDirectV2Input,
): Promise<ActionResult> {
  if (input.origin === "assistant" || !["direct_ui", "system", "live_test"].includes(input.origin)) {
    return {
      kind: "receipt",
      receipt: errorReceipt({
        action: input.actionName,
        code: "invalid_origin",
        message: "Trusted direct execution requires an explicit direct_ui, system, or live_test origin.",
        recovery: { hint: "Pass the caller origin explicitly.", retryable: false },
      }),
    };
  }
  if (input.registryId !== "v2-api" && input.registryId !== "v2-local") {
    return {
      kind: "receipt",
      receipt: errorReceipt({
        action: input.actionName,
        code: "invalid_registry",
        message: "Trusted direct execution requires the v2-api or v2-local registry.",
        recovery: { hint: "Load the current registry before retrying.", retryable: false },
      }),
    };
  }

  const action = getAction(input.actionName);
  if (!action || action.kind !== "safe_write") {
    return {
      kind: "receipt",
      receipt: errorReceipt({
        action: input.actionName,
        code: "incompatible_action",
        message: "Only reviewed safe writes may execute through the trusted direct path.",
        recovery: { hint: "Use preview confirmation for risky writes.", retryable: false },
      }),
    };
  }

  const rawError = validateV2RawActionArguments(action, input.args);
  if (rawError) return { kind: "receipt", receipt: rawError };

  const parsed = action.schema.safeParse(input.args);
  if (!parsed.success) {
    return {
      kind: "receipt",
      receipt: errorReceipt({
        action: action.name,
        code: "invalid_args",
        message: formatZodIssues(parsed.error) || "Invalid arguments.",
        recovery: { hint: "Fix the arguments and try again.", retryable: true },
      }),
    };
  }

  const group = action.resolveFeatureGroup
    ? action.resolveFeatureGroup(parsed.data)
    : action.featureGroup;
  if (!canWrite(input.context.policy, group)) {
    return policyDenied(action.name, group, "write");
  }

  let prepared: Awaited<ReturnType<SafeWriteActionDefinition["prepareSafeWrite"]>> | undefined;
  try {
    prepared = await action.prepareSafeWrite(input.context, parsed.data);
  } catch (error) {
    return { kind: "receipt", receipt: writeFailureReceipt(action.name, error) };
  }
  if (isSafeWriteClarification(prepared)) return clarifyResult(prepared);
  if (isSafeWriteNoop(prepared)) return { kind: "receipt", receipt: prepared.receipt };
  if (prepared !== undefined && !isPreparedSafeWrite(prepared)) {
    return invalidSafeWritePreparation(action.name);
  }
  const boundedPrepared = prepared
    ? {
        ...prepared,
        mutationPlan: bindMutationPlanHostCalls(action.name, prepared.operation, prepared.mutationPlan),
      }
    : undefined;
  if (!boundedPrepared) return invalidSafeWritePreparation(action.name);
  const primaryError = validateAssistantPrimaryMutationPlan(action, boundedPrepared.mutationPlan);
  if (primaryError) return invalidWriteAuthorityActionResult(action.name, primaryError);
  const authorityPlanError = validateWriteAuthorityOperation(
    action,
    boundedPrepared.operation,
    boundedPrepared.mutationPlan,
  );
  if (authorityPlanError) return invalidWriteAuthorityActionResult(action.name, authorityPlanError);

  const authorityError = await input.context.authorizeWrite?.(action.name);
  if (authorityError) return { kind: "receipt", receipt: authorityError };

  const executed = input.context.mutationJournal
    ? await withMutationPlanScope({
        actionName: action.name,
        plan: boundedPrepared.mutationPlan,
        authorizeDispatch: () => input.context.authorizeWrite?.(action.name),
        onDispatch: (step) => markScopedStepDispatched(input.context.mutationJournal!, step.id, step.kind),
        authoritativelyReconciled: (stepId) =>
          hasAuthoritativelyReconciledStep(input.context.mutationJournal!, stepId),
        requiresComplete: commitResultRequiresComplete,
      }, () => action.executeSafeWrite!(input.context, boundedPrepared))
    : await action.executeSafeWrite!(input.context, boundedPrepared);

  return isPartialCommitResult(executed)
    ? executed
    : { kind: "receipt", receipt: executed };
}

/**
 * Execute a persisted v2 assistant preview using only the stored bounded
 * preparation or confirmable operation — never re-resolve names/dates or
 * re-run prepareSafeWrite/handler preview paths.
 */
export async function executeStoredV2Write(
  ctx: ActionContext,
  operation: ConfirmableOperation & { mutationPlan: ExternalMutationPlan },
  executorKind: "prepared_safe_write" | "risky_commit",
): Promise<CommitResult> {
  const action = getAction(operation.actionName);
  if (!action) {
    return errorReceipt({
      action: operation.actionName,
      code: "unknown_action",
      message: `No committable action: ${operation.actionName}`,
      recovery: { hint: "This preview can no longer be executed.", retryable: false },
    });
  }

  if (executorKind === "prepared_safe_write") {
    if (action.kind !== "safe_write" || !action.executeSafeWrite) {
      return errorReceipt({
        action: operation.actionName,
        code: "incompatible_executor",
        message: "The stored executor does not match this action's safe-write contract.",
        recovery: { hint: "Create a fresh preview.", retryable: false },
      });
    }
    const planError = mutationPlanContractError(action.mutationContract, operation.mutationPlan);
    if (planError) {
      return errorReceipt({
        action: operation.actionName,
        code: "invalid_mutation_plan",
        message: "The stored host mutation plan is incompatible with this action's durable contract.",
        recovery: { hint: "Create a fresh preview.", retryable: false },
      });
    }
    const authorityPlanError = validateWriteAuthorityOperation(
      action,
      operation.payload,
      operation.mutationPlan,
    );
    if (authorityPlanError) {
      return errorReceipt({
        action: operation.actionName,
        code: "intent_capability_denied",
        message: "The stored operation exceeds this action's reviewed write authority.",
        recovery: { hint: "Create a fresh preview.", retryable: false },
      });
    }
    const prepared = {
      operation: operation.payload,
      mutationPlan: operation.mutationPlan,
    };
    const commit = () => action.executeSafeWrite!(ctx, prepared);
    return ctx.mutationJournal
      ? withMutationPlanScope({
          actionName: action.name,
          plan: operation.mutationPlan,
          authorizeDispatch: () => ctx.authorizeWrite?.(action.name),
          onDispatch: (step) => markScopedStepDispatched(ctx.mutationJournal!, step.id, step.kind),
          authoritativelyReconciled: (stepId) =>
            hasAuthoritativelyReconciledStep(ctx.mutationJournal!, stepId),
          requiresComplete: commitResultRequiresComplete,
        }, commit)
      : commit();
  }

  if (executorKind === "risky_commit") {
    if (action.kind !== "risky_write") {
      return errorReceipt({
        action: operation.actionName,
        code: "incompatible_executor",
        message: "The stored executor does not match this action's risky-write contract.",
        recovery: { hint: "Create a fresh preview.", retryable: false },
      });
    }
    return commitConfirmedOperation(ctx, operation);
  }

  return errorReceipt({
    action: operation.actionName,
    code: "incompatible_executor",
    message: "The stored executor kind is not supported for v2 confirmation.",
    recovery: { hint: "Create a fresh preview.", retryable: false },
  });
}

/**
 * Execute a stored operation after a button confirmation (SPEC "Confirmation
 * Rules"). Re-validates current policy at confirm time (safety requirement:
 * "current policy still allows the operation") and runs the action's `commit`.
 * Never throws — a failing commit becomes an error receipt.
 */
export function commitConfirmedOperation(
  ctx: ActionContext,
  operation: ConfirmableOperation & { mutationPlan: ExternalMutationPlan },
): Promise<CommitResult>;
export function commitConfirmedOperation(
  ctx: ActionContext,
  operation: ConfirmableOperation,
): Promise<SuccessReceipt | ErrorReceipt>;
export async function commitConfirmedOperation(
  ctx: ActionContext,
  operation: ConfirmableOperation,
): Promise<CommitResult> {
  const action = getAction(operation.actionName);
  if (!action || action.kind !== "risky_write") {
    return errorReceipt({
      action: operation.actionName,
      code: "unknown_action",
      message: `No committable action: ${operation.actionName}`,
      recovery: { hint: "This preview can no longer be executed.", retryable: false },
    });
  }

  const planError = action.mutationWorkflow === "durable"
    ? mutationPlanContractError(action.mutationContract, operation.mutationPlan)
    : undefined;
  if (planError) {
    return errorReceipt({
      action: operation.actionName,
      code: "invalid_mutation_plan",
      message: "The stored host mutation plan is incompatible with this action's durable contract.",
      recovery: { hint: "Create a fresh preview after the action contract is corrected.", retryable: false },
    });
  }
  const externalWrite = action.name.startsWith("clockify_");
  const authorityPlanError = externalWrite
    ? validateWriteAuthorityOperation(action, operation.payload, operation.mutationPlan)
    : undefined;
  if (authorityPlanError) {
    return errorReceipt({
      action: operation.actionName,
      code: "intent_capability_denied",
      message: "The stored operation exceeds this action's reviewed write authority.",
      recovery: { hint: "Create a fresh preview after the action contract is corrected.", retryable: false },
    });
  }

  const authorityError = await ctx.authorizeWrite?.(operation.actionName);
  if (authorityError) return authorityError;

  const isPermissionChange = operation.risks.includes("permission_change");
  if (!isPermissionChange) {
    const group: FeatureGroup = operation.featureGroup;
    if (!canWrite(ctx.policy, group)) {
      // Confirm-time denial: same shared message stem as the proposal-time gate,
      // but its OWN recovery hint (the one-use preview/nonce is consumed, so the
      // admin must run a FRESH preview) and the bare ErrorReceipt shape this
      // function returns (NOT a `{ kind: "receipt" }` ActionResult).
      return errorReceipt({
        action: operation.actionName,
        code: "policy_denied",
        message: accessDeniedMessage(group, "write"),
        recovery: { hint: `Enable write access for ${group} and run a fresh preview.`, retryable: true },
      });
    }
  }

  // Idempotency (opt-in per action): if this exact intent was committed within
  // the window, return the prior receipt rather than mutating again. Two paths:
  //  - ATOMIC (the production store-backed ledger wires claim/fill/release): the
  //    claim is taken BEFORE the commit await, so two concurrent confirms of one
  //    intent can't both reach the host (r1-concurrency-races-01).
  //  - LEGACY (a 2-method lookup/record ledger, e.g. tests): the unchanged
  //    lookup→await→record best-effort path.
  const commit: CommitFn = (commitCtx, commitOperation) => commitOperation.mutationPlan && commitCtx.mutationJournal
    ? withMutationPlanScope({
        actionName: action.name,
        plan: commitOperation.mutationPlan,
        authorizeDispatch: () => commitCtx.authorizeWrite?.(action.name),
        onDispatch: (step) => markScopedStepDispatched(commitCtx.mutationJournal!, step.id, step.kind),
        authoritativelyReconciled: (stepId) =>
          hasAuthoritativelyReconciledStep(commitCtx.mutationJournal!, stepId),
        requiresComplete: commitResultRequiresComplete,
        compensationEligible: (stepId) => {
          const steps = commitCtx.mutationJournal?.listOperationSteps() ?? [];
          const compensation = steps.find((step) =>
            step.kind === "compensation" && step.planStepId === stepId && step.status === "executing");
          return compensation?.compensatesStepId !== undefined && steps.some((step) =>
            step.id === compensation.compensatesStepId && step.kind === "primary" && step.status === "compensating");
        },
      }, () => action.commit(commitCtx, commitOperation))
    : action.commit(commitCtx, commitOperation);
  const semantic = action.idempotencyKey?.(operation);
  const ledger = ctx.idempotency;

  // No idempotency for this action/context — the bare commit (unchanged).
  if (!semantic || !ledger) return runCommit(commit, ctx, operation);

  const scopedKey = idempotencyScopeKey(ctx.workspaceId, ctx.adminUserId, operation, semantic);

  return isAtomicLedger(ledger)
    ? commitViaAtomicLedger(commit, ctx, operation, ledger, scopedKey)
    : commitViaLegacyLedger(commit, ctx, operation, ledger, scopedKey);
}

function invalidWriteAuthorityResult(action: string, detail: string): ActionResult {
  return {
    kind: "receipt",
    receipt: errorReceipt({
      action,
      code: "intent_capability_denied",
      message: "The normalized operation exceeds this action's reviewed write authority.",
      recovery: { hint: `Create a fresh request after the action contract is corrected (${detail}).`, retryable: false },
    }),
  };
}

/** A committable action's `commit` callback — the signature {@link runCommit} wraps. */
type CommitFn = (
  ctx: ActionContext,
  operation: ConfirmableOperation,
) => Promise<CommitResult>;

function commitResultRequiresComplete(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const commitResult = result as CommitResult;
  return !isPartialCommitResult(commitResult) && commitResult.ok === true;
}

function markScopedStepDispatched(
  journal: NonNullable<ActionContext["mutationJournal"]>,
  planStepId: string,
  kind: "primary" | "compensation",
): void {
  const row = journal.listOperationSteps().find((candidate) =>
    candidate.planStepId === planStepId && candidate.kind === kind);
  if (!row || !journal.markOperationStepDispatched(row.id)) {
    throw new Error(`dispatch_journal_unavailable:${planStepId}`);
  }
}

/**
 * LEGACY PATH (2-method ledgers, tests only — the route always wires the atomic
 * ledger). Backs the documented 2-method ledger contract. `record` runs AFTER
 * the commit, so it is best-effort for the same reason as the atomic `fill`: the
 * host write already happened, and a ledger write hiccup must not discard the
 * receipt. Never throws.
 */
async function commitViaLegacyLedger(
  commit: CommitFn,
  ctx: ActionContext,
  operation: ConfirmableOperation,
  ledger: IdempotencyLedger,
  scopedKey: string,
): Promise<CommitResult> {
  const prior = ledger.lookup(scopedKey);
  if (prior) return markReplayed(prior);
  const receipt = await runCommit(commit, ctx, operation);
  if (!isPartialCommitResult(receipt) && receipt.ok) {
    try {
      ledger.record(scopedKey, receipt);
    } catch (error) {
      logLedgerBookkeepingFailure(error);
    }
  }
  return receipt;
}

/**
 * ATOMIC PATH — the claim is the cross-row serialization point. Every ledger op
 * is a synchronous DB write that CAN throw a transient SQLITE_BUSY (the hourly
 * retention prune txn or scripts/erase-workspace.ts holding the /data write
 * lock past busy_timeout). {@link commitConfirmedOperation} is documented
 * "Never throws", and a ledger hiccup must never escalate to a 500: pre-commit
 * it fails closed (no host write happened yet), post-commit it is best-effort
 * (the host write has already happened, so the receipt is the source of truth
 * and MUST survive — dropping it would leave an applied, money-moving change
 * with no receipt, no audit entry, and no undo handle, the nonce already burned).
 */
async function commitViaAtomicLedger(
  commit: CommitFn,
  ctx: ActionContext,
  operation: ConfirmableOperation,
  ledger: AtomicIdempotencyLedger,
  scopedKey: string,
): Promise<CommitResult> {
  let state: ClaimState;
  try {
    state = ledger.claim(scopedKey);
  } catch {
    return ledgerUnavailable(operation.actionName);
  }
  if (state === "replay") {
    let prior: CommitResult | undefined;
    try {
      prior = ledger.lookupCompleted(scopedKey);
    } catch {
      // The completed row exists but is momentarily unreadable; the prior commit
      // already happened and is recorded — report in-progress, never re-commit.
      return commitInProgress(operation.actionName);
    }
    return prior ? markCommitReplayed(prior) : commitInProgress(operation.actionName);
  }
  if (state === "in_flight") return commitInProgress(operation.actionName);
  // A crash-orphaned claim within the dedup window: a prior commit died between
  // the host write and `fill`, so the host-side outcome is UNKNOWN. Never re-run
  // it (that could duplicate a money write) — surface "verify in Clockify".
  if (state === "stale_unknown") return commitOutcomeUnknown(operation.actionName);

  // state === "won": WE OWN THE CLAIM. Commit exactly once; fill on success,
  // release on failure so a legitimate retry can re-claim (a failed commit never
  // blocks the window — the existing "failed commit is retryable" invariant). By
  // the time fill/release run the host write has ALREADY happened, so a throw
  // here is bookkept best-effort and the committed receipt is returned regardless.
  //
  // Heartbeat the claim while the commit is in flight (r1-concurrency-races-01
  // follow-up): a single createInvoice commit issues POST+GET+PUT+tax+N item
  // POSTs, each bounded only PER-CALL by COMMIT_TIMEOUT_MS — their SUM can exceed
  // the dead-claim CLAIM_TTL_MS, so without a heartbeat a concurrent re-confirm
  // could sweep the still-LIVE claim and double-commit (a duplicate invoice).
  // Refreshing claimed_at on CLAIM_HEARTBEAT_MS keeps a live claim from aging
  // out; a crashed process stops heartbeating, so a genuinely dead claim still
  // ages out on the CLAIM_TTL clock (crash recovery preserved). The interval is
  // unref'd (never keeps the process alive) and cleared in finally.
  const heartbeat = ledger.touch
    ? setInterval(() => {
        try {
          ledger.touch?.(scopedKey);
        } catch {
          // Best-effort: a failed heartbeat only risks a sweep, never a crash.
        }
      }, CLAIM_HEARTBEAT_MS)
    : undefined;
  heartbeat?.unref?.();
  let receipt: CommitResult;
  try {
    receipt = await runCommit(commit, ctx, operation);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
  try {
    // Partial proves that at least one host effect happened. Fill the claim so
    // in-memory ledgers can replay it; production defers this fill and atomically
    // binds the canonical result during confirmation settlement.
    if (isPartialCommitResult(receipt)) ledger.fill(scopedKey, receipt);
    else if (receipt.ok) ledger.fill(scopedKey, receipt);
    else if (receipt.code !== "commit_outcome_unknown") ledger.release(scopedKey);
  } catch (error) {
    logLedgerBookkeepingFailure(error);
  }
  return receipt;
}

/**
 * Heartbeat cadence (ms) for refreshing a live idempotency claim during a long
 * multi-call commit. Must stay comfortably below the store's CLAIM_TTL_MS (5
 * min) so a live claim is refreshed well before the dead-claim sweep would fire
 * — pinned `< CLAIM_TTL_MS` by tests/unit/idempotency-store.test.ts.
 */
export const CLAIM_HEARTBEAT_MS = 90_000;

/** Log a post-commit ledger write failure (message only — never secrets). */
function logLedgerBookkeepingFailure(error: unknown): void {
  console.error(
    "idempotency ledger bookkeeping failed (commit already applied; receipt preserved):",
    error instanceof Error ? error.message : String(error),
  );
}

/**
 * A PRE-commit ledger failure (the claim itself threw): nothing was sent to the
 * host, so fail closed to a retryable error rather than a 500. Generic message —
 * a storage hiccup is infra, not an actionable action error, and carries no
 * action detail worth surfacing to the model/admin.
 */
function ledgerUnavailable(actionName: string): ErrorReceipt {
  return errorReceipt({
    action: actionName,
    code: "commit_unavailable",
    message: "The change could not be started due to a temporary storage issue — nothing was applied. Please try again in a moment.",
    recovery: { hint: "Try again in a moment.", retryable: true },
  });
}

/** Run a commit, mapping a thrown error to an execution_error receipt. Never throws. */
async function runCommit(
  commit: CommitFn,
  ctx: ActionContext,
  operation: ConfirmableOperation,
): Promise<CommitResult> {
  try {
    return await commit(ctx, operation);
  } catch (error) {
    return writeFailureReceipt(operation.actionName, error);
  }
}

function writeFailureReceipt(actionName: string, error: unknown): ErrorReceipt {
  if (error instanceof HostCallBudgetExceededError) {
    return errorReceipt({
      action: actionName,
      code: error.code,
      message: error.message,
      recovery: { hint: "Start a fresh request with a smaller batch.", retryable: true },
    });
  }
  if (error instanceof AmbiguousWriteOutcome) {
    return errorReceipt({
      action: actionName,
      code: "commit_outcome_unknown",
      message:
        "Clockify did not provide a definitive response, so this change may or may not have been applied. I will not retry it automatically.",
      recovery: {
        hint: "Check Clockify for the intended change before deciding whether to try again.",
        retryable: false,
      },
    });
  }
  if (error instanceof DefinitiveWriteFailure) {
    return errorReceipt({
      action: actionName,
      code: "definitive_write_failure",
      message: error.message,
      recovery: { hint: "Correct the request or permissions, then run a fresh attempt.", retryable: false },
    });
  }
  return errorReceipt({
    action: actionName,
    code: "execution_error",
    message: error instanceof Error ? error.message : String(error),
    recovery: { hint: "The action failed during execution.", retryable: true },
  });
}

/**
 * Benign result for the loser of a concurrent confirm while the winner's commit
 * is genuinely in flight (claim held, receipt not yet filled). Honest about the
 * live-vs-resolve ambiguity — it asserts NO completion (the winner may still
 * fail and release, in which case a later confirm re-claims and commits for real).
 */
function commitInProgress(actionName: string): ErrorReceipt {
  return errorReceipt({
    action: actionName,
    code: "commit_in_progress",
    message:
      "This change is currently being applied in another request; nothing was duplicated — re-check in a moment or run a fresh preview.",
    recovery: { hint: "Wait a moment, then re-check or run a fresh preview.", retryable: true },
  });
}

/**
 * crash-before-fill residual: a claim whose process DIED between the host write
 * and `fill` (no heartbeat for CLAIM_TTL_MS) is found again within the dedup
 * window. The host-side outcome is genuinely UNKNOWN — the write may or may not
 * have landed — so re-running the commit could duplicate a money write. Refuse to
 * re-run and tell the admin to verify in Clockify. After the dedup window the
 * orphaned claim is swept and a deliberate re-issue commits normally (recovery is
 * bounded, not permanent). This can't be made fully airtight without Clockify
 * create-idempotency, but it converts a SILENT duplicate into an honest prompt.
 */
function commitOutcomeUnknown(actionName: string): ErrorReceipt {
  return errorReceipt({
    action: actionName,
    code: "commit_outcome_unknown",
    message:
      "A previous attempt to apply this change was interrupted, so its result is unknown — it may or may not have gone through. Please check Clockify before retrying; I won't re-run it automatically, to avoid creating a duplicate.",
    recovery: {
      hint: "Check Clockify to see whether the change applied; if it didn't, try again in a few minutes.",
      retryable: true,
    },
  });
}

/**
 * The single shared "{Read|Write} access to {group} is disabled in your
 * assistant permissions." message stem. Lives once here so the proposal-time
 * gate ({@link policyDenied}), the confirm-time gate in
 * {@link commitConfirmedOperation}, and the route's pre-consume re-check
 * (chat-pipeline.ts) all read identically. Each caller keeps its OWN recovery
 * hint and result shape — only the message text is shared.
 */
export function accessDeniedMessage(group: string, mode: "read" | "write"): string {
  return `${mode === "write" ? "Write" : "Read"} access to ${group} is disabled in your assistant permissions.`;
}

function policyDenied(
  actionName: string,
  group: string,
  mode: "read" | "write",
): ActionResult {
  return {
    kind: "receipt",
    receipt: errorReceipt({
      action: actionName,
      code: "policy_denied",
      message: accessDeniedMessage(group, mode),
      recovery: {
        hint: `Ask me to enable ${mode} access for ${group}, or request a different action.`,
        retryable: true,
      },
    }),
  };
}
