import { getAction } from "./catalog.js";
import { isAtomicLedger } from "./action.js";
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

  // Idempotency (opt-in per action): if this exact intent was committed within
  // the window, return the prior receipt rather than mutating again. Two paths:
  //  - ATOMIC (the production store-backed ledger wires claim/fill/release): the
  //    claim is taken BEFORE the commit await, so two concurrent confirms of one
  //    intent can't both reach the host (r1-concurrency-races-01).
  //  - LEGACY (a 2-method lookup/record ledger, e.g. tests): the unchanged
  //    lookup→await→record best-effort path.
  const commit = action.commit;
  const semantic = action.idempotencyKey?.(operation);
  const ledger = ctx.idempotency;

  // No idempotency for this action/context — the bare commit (unchanged).
  if (!semantic || !ledger) return runCommit(commit, ctx, operation);

  const scopedKey = idempotencyScopeKey(ctx.workspaceId, ctx.adminUserId, operation, semantic);

  if (!isAtomicLedger(ledger)) {
    // LEGACY PATH — byte-identical to the pre-change behavior for 2-method ledgers.
    const prior = ledger.lookup(scopedKey);
    if (prior) return markReplayed(prior);
    const receipt = await runCommit(commit, ctx, operation);
    if (receipt.ok) ledger.record(scopedKey, receipt);
    return receipt;
  }

  // ATOMIC PATH — the claim is the cross-row serialization point.
  const state = ledger.claim(scopedKey);
  if (state === "replay") {
    const prior = ledger.lookupCompleted(scopedKey);
    return prior ? markReplayed(prior) : commitInProgress(operation.actionName);
  }
  if (state === "in_flight") return commitInProgress(operation.actionName);

  // state === "won": WE OWN THE CLAIM. Commit exactly once; fill on success,
  // release on failure/throw so a legitimate retry can re-claim (a failed commit
  // never blocks the window — the existing "failed commit is retryable" invariant).
  const receipt = await runCommit(commit, ctx, operation);
  if (receipt.ok) {
    ledger.fill(scopedKey, receipt);
  } else {
    ledger.release(scopedKey);
  }
  return receipt;
}

/** Run a commit, mapping a thrown error to an execution_error receipt. Never throws. */
async function runCommit(
  commit: (ctx: ActionContext, operation: ConfirmableOperation) => Promise<SuccessReceipt | ErrorReceipt>,
  ctx: ActionContext,
  operation: ConfirmableOperation,
): Promise<SuccessReceipt | ErrorReceipt> {
  try {
    return await commit(ctx, operation);
  } catch (error) {
    return errorReceipt({
      action: operation.actionName,
      code: "execution_error",
      message: error instanceof Error ? error.message : String(error),
      recovery: { hint: "The action failed during execution.", retryable: true },
    });
  }
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
