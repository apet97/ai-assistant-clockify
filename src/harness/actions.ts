import { getAction, suggestActionNames } from "./catalog.js";
import { isAtomicLedger } from "./action.js";
import type {
  ActionContext,
  ActionResult,
  AtomicIdempotencyLedger,
  ClaimState,
  ConfirmableOperation,
  IdempotencyLedger,
} from "./action.js";
import { canRead, canWrite } from "./permissions.js";
import type { FeatureGroup } from "./permissions.js";
import { isSafeWrite, requiresConfirmation } from "./risk.js";
import { errorReceipt, type ErrorReceipt, type SuccessReceipt } from "./receipts.js";
import { idempotencyScopeKey, markReplayed } from "./idempotency.js";
import { formatZodIssues, unknownArgumentPaths } from "./arg-shapes.js";
import { AmbiguousWriteOutcome, DefinitiveWriteFailure } from "../clockify/write-outcome.js";

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

  const unknown = unknownArgumentPaths(action.schema, input.args, action.argumentAliases);
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

  if (isRead) {
    return action.handler(input.context, parsed.data);
  }
  if (isSafeWrite(action.risks)) {
    const authorityError = await input.context.authorizeWrite?.(action.name);
    if (authorityError) return { kind: "receipt", receipt: authorityError };
    let operationId: string | undefined;
    try {
      if (input.context.operationJournal) {
        operationId = input.context.operationJournal.prepare(action.name, parsed.data);
        input.context.operationJournal.markExecuting(operationId);
      }
      const result = await action.handler(input.context, parsed.data);
      settleImmediateOperation(input.context, operationId, result);
      return result;
    } catch (error) {
      const result: ActionResult = { kind: "receipt", receipt: writeFailureReceipt(action.name, error) };
      settleImmediateOperation(input.context, operationId, result);
      return result;
    }
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

function settleImmediateOperation(ctx: ActionContext, operationId: string | undefined, result: ActionResult): void {
  if (!operationId || !ctx.operationJournal) return;
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
  const commit: CommitFn = (commitCtx, commitOperation) =>
    action.commit!(commitCtx, commitOperation);
  const semantic = action.idempotencyKey?.(operation);
  const ledger = ctx.idempotency;

  // No idempotency for this action/context — the bare commit (unchanged).
  if (!semantic || !ledger) return runCommit(commit, ctx, operation);

  const scopedKey = idempotencyScopeKey(ctx.workspaceId, ctx.adminUserId, operation, semantic);

  return isAtomicLedger(ledger)
    ? commitViaAtomicLedger(commit, ctx, operation, ledger, scopedKey)
    : commitViaLegacyLedger(commit, ctx, operation, ledger, scopedKey);
}

/** A committable action's `commit` callback — the signature {@link runCommit} wraps. */
type CommitFn = (
  ctx: ActionContext,
  operation: ConfirmableOperation,
) => Promise<SuccessReceipt | ErrorReceipt>;

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
): Promise<SuccessReceipt | ErrorReceipt> {
  const prior = ledger.lookup(scopedKey);
  if (prior) return markReplayed(prior);
  const receipt = await runCommit(commit, ctx, operation);
  if (receipt.ok) {
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
): Promise<SuccessReceipt | ErrorReceipt> {
  let state: ClaimState;
  try {
    state = ledger.claim(scopedKey);
  } catch {
    return ledgerUnavailable(operation.actionName);
  }
  if (state === "replay") {
    let prior: SuccessReceipt | undefined;
    try {
      prior = ledger.lookupCompleted(scopedKey);
    } catch {
      // The completed row exists but is momentarily unreadable; the prior commit
      // already happened and is recorded — report in-progress, never re-commit.
      return commitInProgress(operation.actionName);
    }
    return prior ? markReplayed(prior) : commitInProgress(operation.actionName);
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
  let receipt: SuccessReceipt | ErrorReceipt;
  try {
    receipt = await runCommit(commit, ctx, operation);
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
  try {
    if (receipt.ok) ledger.fill(scopedKey, receipt);
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
): Promise<SuccessReceipt | ErrorReceipt> {
  try {
    return await commit(ctx, operation);
  } catch (error) {
    return writeFailureReceipt(operation.actionName, error);
  }
}

function writeFailureReceipt(actionName: string, error: unknown): ErrorReceipt {
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
