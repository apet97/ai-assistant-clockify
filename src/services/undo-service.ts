import type { SessionClaims } from "../auth/sessions.js";
import type { Installation, Store } from "../db/store.js";
import type { ActionContext } from "../harness/action.js";
import { firstDeniedGroup } from "../harness/undo.js";
import type { AdminPolicy } from "../harness/permissions.js";
import { withHostCallBudget } from "../clockify/request-governor.js";
import {
  WorkspaceMutationRevokedError,
  type WorkspaceMutationCoordinator,
  type WorkspaceMutationLease,
} from "../clockify/workspace-mutation-coordinator.js";
import { bestEffort } from "../routes/best-effort.js";
import type { ConfirmationService } from "./confirmation-service.js";

/**
 * UndoService (T16-E): the one-use reverse-creation flow extracted from
 * `routes/api.ts`. Policy is re-checked BEFORE consuming the one-use record;
 * the write-authority role recheck and the workspace mutation lease guard the
 * dispatch; the reversal itself goes through `ConfirmationService`'s undo
 * commit (the sole dispatch seam). A transient audit failure never converts a
 * known reversal into a 500 — the receipt is preserved with a degradation
 * marker instead.
 */
export type UndoAuthorityOutcome =
  | { ok: true; installationGeneration: number }
  | { ok: false; status: 403 | 409 | 503; code: string; message: string };

export interface UndoServiceDeps {
  store: Pick<Store, "getUndoRecord" | "getInstallation" | "addAuditEvent">;
  loadPolicy: (workspaceId: string, adminUserId: string) => AdminPolicy;
  verifyWriteAuthority: (
    claims: SessionClaims,
    installation?: Installation,
    signal?: AbortSignal,
  ) => Promise<UndoAuthorityOutcome>;
  actionContext: (
    workspaceId: string,
    adminUserId: string,
    installation: Installation,
    sessionId?: string,
    signal?: AbortSignal,
  ) => ActionContext;
  mutationCoordinator: WorkspaceMutationCoordinator;
  undoCommits: Pick<ConfirmationService, "executeUndoCommit">;
}

export interface UndoExecuteResult {
  status: number;
  body: Record<string, unknown>;
}

export function createUndoService(deps: UndoServiceDeps) {
  async function execute(
    claims: SessionClaims,
    undoId: string,
    signal: AbortSignal,
  ): Promise<UndoExecuteResult> {
    const record = deps.store.getUndoRecord(undoId);
    if (!record || record.workspaceId !== claims.workspaceId || record.adminUserId !== claims.adminUserId) {
      return { status: 404, body: { ok: false, code: "not_found", message: "No such undoable action." } };
    }
    if (record.status !== "available") {
      const expired = record.status === "expired";
      return {
        status: 409,
        body: {
          ok: false,
          code: expired ? "undo_expired" : "undo_not_available",
          message: expired ? "This undo window expired after 30 minutes." : "This undo is no longer available.",
        },
      };
    }

    // Re-check write policy BEFORE consuming the one-use record, so a lowered policy
    // denies cleanly without burning it (reverseCreationDurably re-checks as defense in depth).
    const denied = firstDeniedGroup(deps.loadPolicy(claims.workspaceId, claims.adminUserId), record.reversal);
    if (denied) {
      return {
        status: 400,
        body: {
          ok: false,
          code: "policy_denied",
          message: `Undo needs write access to ${denied}, which is disabled in your assistant permissions.`,
        },
      };
    }

    const installation = deps.store.getInstallation(claims.workspaceId);
    if (!installation || installation.status !== "active") {
      return { status: 400, body: { ok: false, code: "not_installed", message: "The add-on is not active for this workspace." } };
    }
    if (!Number.isSafeInteger(record.installationGeneration) ||
        record.installationGeneration !== installation.generation) {
      return {
        status: 409,
        body: {
          ok: false,
          code: "installation_changed",
          message: "The Clockify installation changed after this undo was created. Run the action again before undoing it.",
        },
      };
    }

    const authority = await deps.verifyWriteAuthority(claims, installation, signal);
    if (!authority.ok) {
      return { status: authority.status, body: { ok: false, code: authority.code, message: authority.message } };
    }

    let mutationLease: WorkspaceMutationLease;
    try {
      mutationLease = deps.mutationCoordinator.acquire(
        claims.workspaceId,
        installation.generation,
        signal,
      );
    } catch (error) {
      if (!(error instanceof WorkspaceMutationRevokedError)) throw error;
      return { status: 409, body: { ok: false, code: "installation_changed", message: error.message } };
    }
    if (mutationLease.signal.aborted) {
      mutationLease.release();
      return {
        status: 409,
        body: {
          ok: false,
          code: "request_cancelled",
          message: "The undo was cancelled before dispatch. No change was made.",
        },
      };
    }

    try {
      const undoContext = deps.actionContext(
        claims.workspaceId,
        claims.adminUserId,
        installation,
        claims.sessionId,
        mutationLease.signal,
      );
      const undo = await withHostCallBudget(() => deps.undoCommits.executeUndoCommit({
        claims,
        undoId: record.id,
        record,
        context: undoContext,
        signal: mutationLease.signal,
      }));
      if (!undo.operationId) {
        return { status: 409, body: { ok: false, code: "undo_not_available", message: "This undo is no longer available." } };
      }
      const { receipt, resultRef: undoResultRef } = undo;
      // The reversal already happened (and the one-use claim is executing). A
      // transient audit-write failure must NOT surface as a 500 — the admin
      // would retry and hit already_undone (409), believing it failed when it succeeded.
      // Mirror commitConfirmation: best-effort audit, message-only log, return the receipt.
      if (undoResultRef) bestEffort("undo bookkeeping", () => {
        deps.store.addAuditEvent({
          workspaceId: claims.workspaceId,
          adminUserId: claims.adminUserId,
          sessionId: claims.sessionId,
          actionName: "undo",
          risk: ["destructive"],
          resultRef: undoResultRef,
        });
      });
      return {
        status: receipt.ok ? 200 : 400,
        body: {
          ok: receipt.ok,
          receipt,
          ...(!undoResultRef ? { persistenceDegraded: true } : {}),
        },
      };
    } finally {
      mutationLease.release();
    }
  }

  return { execute };
}

export type UndoService = ReturnType<typeof createUndoService>;
