import { getAction } from "./catalog.js";
import type { ActionContext, ActionResult, ConfirmableOperation } from "./action.js";
import { canRead, canWrite } from "./permissions.js";
import type { FeatureGroup } from "./permissions.js";
import { isSafeWrite, requiresConfirmation } from "./risk.js";
import { errorReceipt, type ErrorReceipt, type SuccessReceipt } from "./receipts.js";
import { idempotencyScopeKey, markReplayed } from "./idempotency.js";
import { formatZodIssues } from "./arg-shapes.js";

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

export async function executeAction(input: ExecuteActionInput): Promise<ActionResult> {
  const action = getAction(input.actionName);
  if (!action) {
    return {
      kind: "receipt",
      receipt: errorReceipt({
        action: input.actionName,
        code: "unknown_action",
        message: `Unknown action: ${input.actionName}`,
        recovery: { hint: "Use only the actions in the catalog.", retryable: false },
      }),
    };
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
  const isRead = action.risks.length > 0 && action.risks.every((r) => r === "read");
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

  if (requiresConfirmation(action.risks)) {
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
    return result;
  }

  if (isRead || isSafeWrite(action.risks)) {
    return action.handler(input.context, parsed.data);
  }

  // Fail closed: not a read, not a safe_write, not requiring confirmation.
  return {
    kind: "receipt",
    receipt: errorReceipt({
      action: action.name,
      code: "unclassified_action",
      message: "Action risk is not classified as read or safe; refusing to execute.",
      recovery: { hint: "This action needs a clearer risk classification.", retryable: false },
    }),
  };
}

/**
 * Execute a stored operation after a button confirmation (SPEC "Confirmation
 * Rules"). Re-validates current policy at confirm time (safety requirement:
 * "current policy still allows the operation") and runs the action's `commit`.
 * Never throws — a failing commit becomes an error receipt.
 */
export async function commitConfirmedOperation(
  ctx: ActionContext,
  operation: ConfirmableOperation,
): Promise<SuccessReceipt | ErrorReceipt> {
  const action = getAction(operation.actionName);
  if (!action || !action.commit) {
    return errorReceipt({
      action: operation.actionName,
      code: "unknown_action",
      message: `No committable action: ${operation.actionName}`,
      recovery: { hint: "This preview can no longer be executed.", retryable: false },
    });
  }

  const isPermissionChange = operation.risks.includes("permission_change");
  if (!isPermissionChange) {
    const group: FeatureGroup = operation.featureGroup;
    if (!canWrite(ctx.policy, group)) {
      return errorReceipt({
        action: operation.actionName,
        code: "policy_denied",
        message: `Write access to ${group} is disabled in your assistant permissions.`,
        recovery: { hint: `Enable write access for ${group} and run a fresh preview.`, retryable: true },
      });
    }
  }

  // Idempotency (opt-in per action): if this exact intent was committed within the
  // window, return the prior receipt rather than mutating again (no duplicate).
  const semantic = action.idempotencyKey?.(operation);
  let scopedKey: string | undefined;
  if (semantic && ctx.idempotency) {
    scopedKey = idempotencyScopeKey(ctx.workspaceId, ctx.adminUserId, operation, semantic);
    const prior = ctx.idempotency.lookup(scopedKey);
    if (prior) return markReplayed(prior);
  }

  try {
    const receipt = await action.commit(ctx, operation);
    if (receipt.ok && scopedKey && ctx.idempotency) ctx.idempotency.record(scopedKey, receipt);
    return receipt;
  } catch (error) {
    return errorReceipt({
      action: operation.actionName,
      code: "execution_error",
      message: error instanceof Error ? error.message : String(error),
      recovery: { hint: "The action failed during execution.", retryable: true },
    });
  }
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
      message: `${mode === "write" ? "Write" : "Read"} access to ${group} is disabled in your assistant permissions.`,
      recovery: {
        hint: `Ask me to enable ${mode} access for ${group}, or request a different action.`,
        retryable: true,
      },
    }),
  };
}
