/**
 * C10: the ENGINE-NEUTRAL chat control plane.
 *
 * Everything here is shared verbatim by v1 (`chat-pipeline.ts`) and v2
 * (`v2-chat-pipeline.ts`). Before this module, v2 obtained it by instantiating
 * v1's 2,177-line `createChatPipeline` and spreading the result — so the
 * rollback engine sat on the v2 request path and could not be retired.
 *
 * This module MUST NOT import `./chat-pipeline.js` or `./api.js`.
 *
 * Two shared-instance invariants are load-bearing, and both are the reason this
 * factory returns raw handles alongside its members:
 *
 *   (A) ONE `chatLimiter`. `runResume` (still in chat-pipeline.ts) and the
 *       `chatPreconditions` moved here charge the SAME per-session paid-loop
 *       budget. Constructing a second limiter would silently DOUBLE v1's budget
 *       with no failing test, so chat-pipeline.ts destructures this instance
 *       instead of calling `createSlidingWindowLimiter` again.
 *   (B) ONE `createRouteAuthority` per `apiRouter()`. api.ts destructures the
 *       authority quartet from the single engine-selected pipeline, so one
 *       `roleRechecker` (and its 60-second positive-verdict cache) is shared by
 *       confirmationService, permissionService, undoService and every router.
 *       Exactly one engine arm is constructed per request path.
 *
 * NOTE on `commitConfirmation`: it IS v1-only again, as of the C12 guard.
 * `isV2AssistantPreviewConfirmation` is `isV2PreviewAuthority(record) &&
 * !record.batchId` (harness/confirmations.ts:418-420), and a v2 multi-write
 * preview stamps `batch_id` on every pending row — so a v2 BATCH row used to
 * fail that test and fall through to this function. `routes/confirmations.ts`
 * now rejects batch-owned rows with `batch_confirmation_required` BEFORE the
 * discriminator, and this function has exactly ONE call site
 * (routes/confirmations.ts, the non-v2 branch), so no v2 row can reach it:
 * batch-owned rows are rejected earlier and non-batch v2 rows go to
 * `confirmationService.confirmSingle`.
 *
 * Keep it that way. If a future caller is added, re-verify this before relying
 * on the v1-only property — it is a reachability fact about one call site, not
 * something the type system enforces.
 */
import type { Request, Response } from "express";
import { createHash, randomUUID } from "node:crypto";
import { classifyLoggableError } from "../log-error-class.js";
import {
  createSlidingWindowLimiter,
  DEFAULT_CHAT_RATE_LIMIT_MAX,
  DEFAULT_CHAT_RATE_LIMIT_WINDOW_MS,
  DEFAULT_NEW_CHAT_RATE_LIMIT_MAX,
  DEFAULT_NEW_CHAT_RATE_LIMIT_WINDOW_MS,
  type RateLimitDecision,
} from "./rate-limit.js";
import {
  accessDeniedMessage,
  commitConfirmedOperation,
} from "../harness/actions.js";
import {
  isPartialCommitResult,
  type ActionContext,
  type ActionResult,
  type CommitResult,
  type ConfirmableOperation,
} from "../harness/action.js";
import type { AtomicIdempotencyLedger } from "../harness/idempotency.js";
import { createRunEventViewService } from "../services/run-event-view-service.js";
import { reversibleCreations } from "../harness/undo.js";
import { actionFingerprint, catalogHash} from "../harness/catalog.js";
import { canWrite, type AdminPolicy } from "../harness/permissions.js";
import {
  confirmPending,
  rotatePendingNonce,
} from "../harness/confirmations.js";
import { errorReceipt, type SuccessReceipt, type ErrorReceipt } from "../harness/receipts.js";
import { parseAgentState, type AgentState } from "../assistant/agent-state.js";
import type { Installation} from "../db/store.js";
import type { ActionResultRef, DurableResultLink } from "../db/store.js";
import { CLAIM_TTL_MS } from "../db/store.js";
import type { AppDeps } from "./deps.js";
import { chatBodySchema } from "./request-schemas.js";
import {
  type Claims,
} from "./chat-results.js";
import { IDEMPOTENCY_WINDOW_MS } from "./chat-constants.js";
import { bestEffort } from "./best-effort.js";
import { logOutcomeUnknown } from "../log-outcome-unknown.js";
import { logAlias } from "../log-alias.js";
import {
  createWorkspaceMutationCoordinator,
  WorkspaceMutationRevokedError,
  type WorkspaceMutationLease,
} from "../clockify/workspace-mutation-coordinator.js";
import {
  createRouteAuthority,
  type VerifiedSessionClaims,
  type WriteAuthorityOutcome,
} from "./route-authority.js";


/** The outcome of one chat turn, shared by the JSON route and the streaming route. */
export type ChatTurnOutcome =
  | {
      ok: true;
      replyKind: string;
      replyText: string;
      results: unknown[];
      resultLinks: DurableResultLink[];
      /** v2 only (closure-plan PR 3): the turn's hydrated run-event page —
       * canonical cards and the freshly rotated pending-confirmation control —
       * delivered on the ORIGINAL turn. v1 never sets it; the routes treat it
       * as absent. */
      runEvents?: import("../assistant-v2/events.js").RunEventPage;
      /** The `after` watermark that page was read from. A continuation turn
       * starts mid-run, so a replay must re-read the SAME window; reading from
       * 0 would return cards the original response never carried. */
      runEventsAfter?: number;
    }
  | { ok: false; code: string; message: string };

/** What `chatPreconditions` returns when a request is cleared to run a turn. */
export type ChatPreconditions = {
  claims: { sessionId: string; workspaceId: string; adminUserId: string };
  installation: Installation;
  message: string;
  requestId: string;
  replay?: { status: number; body: unknown };
  /** v2-only (T14-E). v1 ignores this field — its `executeChatTurn` never reads it. */
  continuationRunId?: string;
};

/** A validated-and-committed confirmation, or the structured rejection to surface. */
export type CommitConfirmationOutcome =
  | { ok: false; status: number; body: { ok: false; code: string; message: string } }
  | {
      ok: true;
      receipt: SuccessReceipt | ErrorReceipt;
      partialResult?: Extract<ActionResult, { kind: "partial" }>;
      undoId: string | undefined;
      agentState: AgentState | undefined;
      installation: Installation | undefined;
      persistenceDegraded?: true;
    };

export interface ChatPipeline {
  loadPolicy: (workspaceId: string, adminUserId: string) => AdminPolicy;
  requireSession: (req: Request, res: Response) => Promise<VerifiedSessionClaims | undefined>;
  verifyWriteAuthority: (
    claims: Claims,
    installation?: Installation,
    signal?: AbortSignal,
  ) => Promise<WriteAuthorityOutcome>;
  /** Per-admin budget for creating fresh sessions (POST /chat/new) — bounds resetting
   *  the per-session paid-loop limit by minting sessions. Keyed by workspace+admin. */
  newChatAllowed: (workspaceId: string, adminUserId: string) => RateLimitDecision;
  actionContext: (
    workspaceId: string,
    adminUserId: string,
    installation: Installation,
    sessionId?: string,
    signal?: AbortSignal,
  ) => ActionContext;
  runResume: (
    claims: Claims,
    installation: Installation | undefined,
    agentState: AgentState | undefined,
    receipt: SuccessReceipt | ErrorReceipt,
    onResult?: (result: unknown) => void,
    onStatus?: (status: { action: string; label: string }) => void,
    signal?: AbortSignal,
  ) => Promise<{ replyKind: string; replyText: string; results: unknown[] } | undefined>;
  commitConfirmation: (
    claims: Claims,
    record: NonNullable<ReturnType<AppDeps["store"]["getPendingConfirmation"]>>,
    nonce: string,
    signal?: AbortSignal,
  ) => Promise<CommitConfirmationOutcome>;
  executeChatTurn: (
    claims: { sessionId: string; workspaceId: string; adminUserId: string },
    installation: Installation,
    message: string,
    onResult?: (result: unknown) => void,
    onStatus?: (status: { action: string; label: string }) => void,
    signal?: AbortSignal,
    requestId?: string,
    continuationRunId?: string,
  ) => Promise<ChatTurnOutcome>;
  chatPreconditions: (req: Request, res: Response) => Promise<ChatPreconditions | undefined>;
}

/** The seven `ChatPipeline` members every engine shares. Each engine supplies
 *  its own `runResume` and `executeChatTurn`. */
export type ControlPlaneMembers = Omit<ChatPipeline, "runResume" | "executeChatTurn">;

export interface ControlPlane {
  members: ControlPlaneMembers;
  now: () => Date;
  chatLimiter: ReturnType<typeof createSlidingWindowLimiter>;
  mutationCoordinator: ReturnType<typeof createWorkspaceMutationCoordinator>;
  intentCapabilitiesEnforced: boolean;
  recordUndoIfReversible: (
    claims: { sessionId: string; workspaceId: string; adminUserId: string },
    installationGeneration: number,
    receipt: SuccessReceipt | ErrorReceipt,
  ) => string | undefined;
}

export function createControlPlane(deps: AppDeps): ControlPlane {
  const now = deps.now ?? (() => new Date());
  const mutationCoordinator = deps.mutationCoordinator ?? createWorkspaceMutationCoordinator();
  const intentCapabilitiesEnforced = deps.config.nodeEnv !== "test" ||
    deps.enforceIntentCapabilitiesInTests === true;
  // Per-SESSION chat rate limit — each turn drives a paid model loop, and
  // nothing else bounds it (confirm/cancel/undo are button-driven + one-use).
  const chatLimiter = createSlidingWindowLimiter(
    deps.config.chatRateLimitMax ?? DEFAULT_CHAT_RATE_LIMIT_MAX,
    deps.config.chatRateLimitWindowMs ?? DEFAULT_CHAT_RATE_LIMIT_WINDOW_MS,
  );
  // Per-ADMIN session-creation limiter (POST /chat/new): the chat limiter above is
  // keyed by sessionId, so minting fresh sessions resets its budget — this bounds that.
  const newChatLimiter = createSlidingWindowLimiter(
    deps.config.newChatRateLimitMax ?? DEFAULT_NEW_CHAT_RATE_LIMIT_MAX,
    deps.config.newChatRateLimitWindowMs ?? DEFAULT_NEW_CHAT_RATE_LIMIT_WINDOW_MS,
  );
  const newChatAllowed = (workspaceId: string, adminUserId: string): RateLimitDecision =>
    newChatLimiter.check(`${workspaceId}:${adminUserId}`, now().getTime());

  const {
    loadPolicy,
    requireSession,
    verifyWriteAuthority,
    actionContext,
  } = createRouteAuthority(deps, now);

  // T07: the scoped v2 replay reconstructor. A v2 turn's persisted envelope
  // carries only its bare `runId` (never hydrated events or a plaintext
  // nonce — `finishTurnRun` strips both); a same-requestId JSON/stream
  // replay rebuilds the event page fresh, through the SAME hydrator that
  // rotates the live confirmation nonce on the original turn.
  const v2ReplayEventViews = createRunEventViewService(deps.store, {
    sessionSecret: deps.config.sessionSecret,
    now,
  });

  /** Record a one-use undo for a successful reversible creation; return its id. */
  function recordUndoIfReversible(
    claims: { sessionId: string; workspaceId: string; adminUserId: string },
    installationGeneration: number,
    receipt: SuccessReceipt | ErrorReceipt,
  ): string | undefined {
    if (!receipt.ok) return undefined;
    // An idempotent replay returns the ORIGINAL commit's receipt (with a replay
    // warning) — its changed.created survives, but that first commit ALREADY minted
    // an undo record. Minting a second here would give one entity two live undo
    // handles. Suppress on replay (markReplayed tags the warning).
    if (receipt.warnings?.some((w) => w.code === "idempotent_replay")) return undefined;
    const reversal = reversibleCreations(receipt);
    if (reversal.length === 0) return undefined;
    return deps.store.recordUndoable({
      sessionId: claims.sessionId,
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      actionName: receipt.action,
      installationGeneration,
      reversal,
    });
  }

  /**
   * Validate + commit a confirmed risky write through the single choke point.
   * Returns the structured error (with its HTTP status) when validation/policy/
   * the one-use claim rejects — BEFORE any commit, so a denied confirm never
   * burns the nonce — or the committed receipt + undo + (valid) agent state for
   * the resume. Mirrors the exact ordering the safety review verified.
   */
  async function commitConfirmation(
    claims: Claims,
    record: NonNullable<ReturnType<typeof deps.store.getPendingConfirmation>>,
    nonce: string,
    signal?: AbortSignal,
  ): Promise<CommitConfirmationOutcome> {
    const validation = confirmPending({
      record,
      sessionId: claims.sessionId,
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      nonce,
      sessionSecret: deps.config.sessionSecret,
      now: now(),
      expectedActionFingerprint: actionFingerprint((record.operation as ConfirmableOperation).actionName),
      expectedCatalogHash: catalogHash(),
    });
    if (!validation.ok) {
      if (validation.code === "expired") deps.store.expireConfirmation(record.id);
      return { ok: false, status: 400, body: { ok: false, code: validation.code, message: validation.message } };
    }

    const operation = record.operation as ConfirmableOperation;
    const installation = deps.store.getInstallation(claims.workspaceId);
    if (!installation || installation.status !== "active") {
      return {
        ok: false,
        status: 503,
        body: {
          ok: false,
          code: "role_verification_unavailable",
          message: "The add-on is not active for this workspace. No change was made.",
        },
      };
    }
    if (!Number.isSafeInteger(record.installationGeneration) ||
        record.installationGeneration !== installation.generation ||
        operation.installationGeneration !== record.installationGeneration) {
      return {
        ok: false,
        status: 409,
        body: {
          ok: false,
          code: "installation_changed",
          message: "The Clockify installation changed after this preview was created. Create a fresh preview.",
        },
      };
    }
    let capabilityScope: Parameters<typeof deps.store.consumeIntentCapabilityForOperation>[0] | undefined;
    if (intentCapabilitiesEnforced) {
      if (!record.capabilityId || !record.capabilityHash) {
        return {
          ok: false,
          status: 400,
          body: {
            ok: false,
            code: "incompatible_confirmation",
            message: "This preview predates the current intent-safety contract. Create a fresh preview.",
          },
        };
      }
      capabilityScope = {
        operationId: record.operationId,
        workspaceId: claims.workspaceId,
        adminUserId: claims.adminUserId,
        sessionId: claims.sessionId,
        capabilityId: record.capabilityId,
        capabilityHash: record.capabilityHash,
        expectedCatalogHash: catalogHash(),
        expectedActionName: operation.actionName,
      };
      try {
        deps.store.getIntentCapabilityForOperation(capabilityScope);
      } catch {
        return {
          ok: false,
          status: 400,
          body: {
            ok: false,
            code: "incompatible_confirmation",
            message: "This preview's intent authority is no longer compatible. Create a fresh preview.",
          },
        };
      }
    }

    // Re-check current policy BEFORE consuming the one-use preview, so a policy
    // that was lowered after the preview denies cleanly without burning it
    // (commitConfirmedOperation re-checks again as defense in depth).
    if (!operation.risks.includes("permission_change")) {
      const policy = loadPolicy(claims.workspaceId, claims.adminUserId);
      if (!canWrite(policy, operation.featureGroup)) {
        return {
          ok: false,
          status: 400,
          body: {
            ok: false,
            code: "policy_denied",
            message: accessDeniedMessage(operation.featureGroup, "write"),
          },
        };
      }
    }

    const authority = await verifyWriteAuthority(claims, installation, signal);
    if (!authority.ok) {
      return {
        ok: false,
        status: authority.status,
        body: { ok: false, code: authority.code, message: authority.message },
      };
    }

    let mutationLease: WorkspaceMutationLease;
    try {
      mutationLease = mutationCoordinator.acquire(
        claims.workspaceId,
        installation.generation,
        signal,
      );
    } catch (error) {
      if (!(error instanceof WorkspaceMutationRevokedError)) throw error;
      return {
        ok: false,
        status: 409,
        body: { ok: false, code: "installation_changed", message: error.message },
      };
    }
    if (mutationLease.signal.aborted) {
      mutationLease.release();
      return {
        ok: false,
        status: 409,
        body: {
          ok: false,
          code: "request_cancelled",
          message: "The confirmation was cancelled before dispatch. No change was made.",
        },
      };
    }

    // Atomic one-use claim: only the caller that transitions pending → executing wins.
    if (!deps.store.markConfirmationExecuting(record.id)) {
      mutationLease.release();
      return { ok: false, status: 409, body: { ok: false, code: "already_used", message: "This preview was already used." } };
    }

    try {
    // ALL confirmed operations go through the SAME commit path. The action's own
    // `commit` does the work; for a permission change that commit persists the new
    // policy itself via the `savePolicy` capability the context carries.
    let commitResult: CommitResult;
    const consumed = capabilityScope
      ? deps.store.consumeIntentCapabilityForOperation(capabilityScope)
      : undefined;
    if (consumed?.state === "denied") {
      commitResult = errorReceipt({
        action: operation.actionName,
        code: "intent_capability_denied",
        message: "This write exceeds the exact admin-authored intent capability.",
        recovery: { hint: "Create a fresh request and preview.", retryable: false },
      });
    } else {
      // A store-backed ATOMIC idempotency ledger (10-min window) so re-confirming
      // the same intent (e.g. the same invoice) can't create a duplicate — even
      // under CONCURRENT confirms: claim is taken before the commit await, so two
      // simultaneous confirms reach the host at most once (r1-concurrency-races-01).
      const idempotency: AtomicIdempotencyLedger = {
        lookup: (key) => deps.store.lookupIdempotency(
          key,
          claims.workspaceId,
          claims.adminUserId,
          now().getTime() - IDEMPOTENCY_WINDOW_MS,
        ),
        // The atomic path never calls legacy record; canonical persistence owns fill.
        record: () => undefined,
        claim: (key) => {
          const state = deps.store.claimIdempotency(
            key,
            claims.workspaceId,
            claims.adminUserId,
            now().getTime(),
            now().getTime() - IDEMPOTENCY_WINDOW_MS,
            now().getTime() - CLAIM_TTL_MS,
          );
          if (state === "won") {
            try {
              deps.store.bindConfirmationIdempotencyKey(record.id, key);
            } catch (error) {
              deps.store.releaseIdempotency(key, claims.workspaceId, claims.adminUserId);
              throw error;
            }
          }
          return state;
        },
        lookupCompleted: (key) => deps.store.claimIdempotencyReceipt(key, claims.workspaceId, claims.adminUserId),
        // The claim was bound before dispatch; settleConfirmation fills it in
        // the same transaction as the canonical result + confirmation scrub.
        fill: () => undefined,
        release: (key) => deps.store.releaseConfirmationIdempotencyKey(record.id, key),
        // Heartbeat a long multi-call commit's live claim so it is never swept
        // mid-flight and double-committed (r1-concurrency-races-01 follow-up).
        touch: (key) => deps.store.touchIdempotencyClaim(key, claims.workspaceId, claims.adminUserId, now().getTime()),
      };
      const authorizedContext = {
        ...actionContext(
          claims.workspaceId,
          claims.adminUserId,
          installation,
          undefined,
          mutationLease.signal,
        ),
        mutationJournal: deps.store.mutationStepJournal(record.operationId),
      };
      // Keep authorizeWrite on the context: the exact mutation scope invokes it
      // again immediately before every primary/compensation network dispatch.
      commitResult = operation.mutationPlan
        ? await commitConfirmedOperation(
            { ...authorizedContext, idempotency },
            { ...operation, mutationPlan: operation.mutationPlan },
          )
        : await commitConfirmedOperation({ ...authorizedContext, idempotency }, operation);
    }

    let partialResult: Extract<ActionResult, { kind: "partial" }> | undefined;
    let receipt: SuccessReceipt | ErrorReceipt;
    if (isPartialCommitResult(commitResult)) {
      partialResult = commitResult;
      receipt = commitResult.receipt;
    } else {
      receipt = commitResult;
    }

    // The host dispatch already happened. Retry only the synchronous SQLite
    // settlement (never the Clockify mutation), then return the truthful host
    // receipt even if persistence remains degraded. Claim-time persistence has
    // already scrubbed dispatch material and bound the one unknown result that
    // startup recovery will reuse if final settlement never persists.
    const terminalStatus = partialResult
      ? "partial"
      : receipt.ok
        ? "succeeded"
      : receipt.code === "commit_outcome_unknown"
        ? "outcome_unknown"
        : "definitive_failed";
    if (terminalStatus === "outcome_unknown") {
      logOutcomeUnknown({
        action: operation.actionName,
        operationId: record.operationId,
        workspaceAlias: logAlias(deps.config.sessionSecret, "workspace", claims.workspaceId),
      });
    }
    let resultRef: ActionResultRef | undefined;
    let settlementError: unknown;
    for (let attempt = 0; attempt < 2 && !resultRef; attempt += 1) {
      try {
        resultRef = deps.store.settleConfirmedOperation(
          record.id,
          terminalStatus,
          operation.actionName,
          partialResult ?? receipt,
        );
      } catch (error) {
        settlementError = error;
      }
    }
    if (!resultRef) {
      console.error(
        `canonical action-result persistence degraded (change already applied; receipt preserved): ${classifyLoggableError(settlementError)}`,
      );
    }
    if (resultRef) {
      bestEffort("post-commit audit failed", () => {
        deps.store.addAuditEvent({
          workspaceId: claims.workspaceId,
          adminUserId: claims.adminUserId,
          sessionId: claims.sessionId,
          actionName: operation.actionName,
          risk: operation.risks,
          resultRef: resultRef!,
        });
      });
    }
    let undoId: string | undefined;
    bestEffort("post-commit undo bookkeeping failed", () => {
      undoId = recordUndoIfReversible(claims, installation.generation, receipt);
    });
    const agentState = receipt.ok && !partialResult ? parseAgentState(record.agentState) : undefined;
    return {
      ok: true,
      receipt,
      ...(partialResult ? { partialResult } : {}),
      undoId,
      agentState,
      installation,
      ...(!resultRef ? { persistenceDegraded: true as const } : {}),
    };
    } finally {
      mutationLease.release();
    }
  }

  async function chatPreconditions(req: Request, res: Response): Promise<ChatPreconditions | undefined> {
    const claims = await requireSession(req, res);
    if (!claims) return undefined;
    // Rate-limit BEFORE parsing/persisting anything — a limited turn never
    // stores the user message nor opens the NDJSON stream.
    const limited = chatLimiter.check(claims.sessionId, now().getTime());
    if (!limited.allowed) {
      res.setHeader("Retry-After", String(Math.ceil(limited.retryAfterMs / 1000)));
      res.status(429).json({
        ok: false,
        code: "rate_limited",
        message: "You're sending messages too quickly — please wait a moment and try again.",
      });
      return undefined;
    }
    const parsed = chatBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, code: "invalid_args", message: "A message is required." });
      return undefined;
    }
    if (!parsed.data.requestId && deps.config.nodeEnv !== "test") {
      res.status(400).json({ ok: false, code: "invalid_args", message: "A client-generated requestId UUID is required." });
      return undefined;
    }
    const installation = deps.store.getInstallation(claims.workspaceId);
    if (!installation || installation.status !== "active") {
      res.status(409).json({ ok: false, code: "not_installed", message: "The add-on is not active for this workspace." });
      return undefined;
    }
    const requestId = parsed.data.requestId ?? randomUUID();
    const intentHash = createHash("sha256").update(parsed.data.message).digest("hex");
    const claim = deps.store.claimTurnRun({
      requestId,
      sessionId: claims.sessionId,
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      intentHash,
    });
    if (claim.state === "conflict") {
      res.status(409).json({
        ok: false,
        code: "operation_id_conflict",
        message: "This requestId was already used for a different chat intent.",
      });
      return undefined;
    }
    if (claim.state === "in_flight") {
      res.status(409).json({
        ok: false,
        code: "operation_in_progress",
        message: "This request is already in progress.",
      });
      return undefined;
    }
    if (claim.state === "outcome_unknown") {
      res.status(409).json({
        ok: false,
        code: "operation_outcome_unknown",
        message: "The prior request was interrupted and its outcome is unknown.",
      });
      return undefined;
    }
    if (claim.state === "replay") {
      const storedResponse = claim.response as { status: number; body: unknown };
      const storedBody = storedResponse.body && typeof storedResponse.body === "object"
        ? storedResponse.body as Record<string, unknown>
        : undefined;
      // T07: a v2 envelope's marker is its bare `runId` (v1 never persists
      // one). The stored envelope carries no `runEvents`/`results` —
      // `finishTurnRun` strips both — so this is the ONLY reconstruction
      // path; there is nothing v1-shaped left to fall through to for a v2 row.
      const v2RunId = storedBody && typeof storedBody.runId === "string" ? storedBody.runId : undefined;
      if (v2RunId) {
        const v2Scope = {
          sessionId: claims.sessionId,
          workspaceId: claims.workspaceId,
          adminUserId: claims.adminUserId,
          installationGeneration: installation.generation,
          authClass: "addon" as const,
        };
        let v2ReplayBody: Record<string, unknown> = { ...storedBody, results: [] };
        try {
          // `.list()` re-runs the SAME hydrator the original turn used, which
          // rotates any live pending-confirmation nonce and updates its
          // stored hash — never persisting the plaintext nonce or the
          // hydrated page itself.
          // The ORIGINAL window, not the whole run: a continuation turn's page
          // began at the sequence that turn started from, so replaying from 0
          // would hand back events the admin never saw in that response.
          const storedAfter = storedBody?.runEventsAfter;
          const replayAfter = typeof storedAfter === "number" && Number.isSafeInteger(storedAfter) && storedAfter >= 0
            ? storedAfter
            : 0;
          const page = v2ReplayEventViews.list({ scope: v2Scope, runId: v2RunId, after: replayAfter, limit: 200 });
          if (page.events.length > 0) {
            v2ReplayBody = { ...v2ReplayBody, runEvents: page };
          } else {
            console.error(`[v2-replay] event=run_event_page_unavailable run_id=${v2RunId}`);
          }
        } catch (error) {
          // The page is gone: preserve the stored reply, omit controls and
          // results, never reuse a stale nonce or invent a result.
          console.error(`[v2-replay] event=run_event_page_unavailable ${classifyLoggableError(error)}`);
        }
        return {
          claims,
          installation,
          message: parsed.data.message,
          requestId,
          replay: { ...storedResponse, body: v2ReplayBody },
        };
      }
      const storedResults = Array.isArray(storedBody?.results) ? storedBody.results : [];
      const replayResults: unknown[] = [];
      for (const result of storedResults) {
        const previewId = result && typeof result === "object" && (result as { kind?: unknown }).kind === "preview"
          ? (result as { previewId?: unknown }).previewId
          : undefined;
        if (typeof previewId !== "string") {
          replayResults.push(result);
          continue;
        }
        const record = deps.store.getPendingConfirmation(previewId);
        if (
          !record ||
          record.status !== "pending" ||
          record.sessionId !== claims.sessionId ||
          record.workspaceId !== claims.workspaceId ||
          record.adminUserId !== claims.adminUserId
        ) {
          continue;
        }
        const rotated = rotatePendingNonce({
          record,
          sessionId: claims.sessionId,
          workspaceId: claims.workspaceId,
          adminUserId: claims.adminUserId,
          sessionSecret: deps.config.sessionSecret,
          now: now(),
        });
        if (!rotated.ok) {
          if (rotated.code === "expired") deps.store.expireConfirmation(record.id);
          continue;
        }
        if (!deps.store.updateConfirmationNonceHash(record.id, rotated.record.nonceHash)) continue;
        replayResults.push({ ...result as object, nonce: rotated.nonce });
      }
      return {
        claims,
        installation,
        message: parsed.data.message,
        requestId,
        replay: storedBody
          ? { ...storedResponse, body: { ...storedBody, results: replayResults } }
          : storedResponse,
      };
    }
    deps.store.markTurnRunExecuting(claims.sessionId, requestId);
    return {
      claims,
      installation,
      message: parsed.data.message,
      requestId,
      ...(parsed.data.continuationRunId ? { continuationRunId: parsed.data.continuationRunId } : {}),
    };
  }

  return {
    members: {
      loadPolicy,
      requireSession,
      verifyWriteAuthority,
      newChatAllowed,
      actionContext,
      commitConfirmation,
      chatPreconditions,
    },
    now,
    chatLimiter,
    mutationCoordinator,
    intentCapabilitiesEnforced,
    recordUndoIfReversible,
  };
}
