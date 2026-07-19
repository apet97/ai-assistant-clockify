import type { Request, Response } from "express";
import { createRoleRechecker } from "../auth/role-recheck.js";
import type { SessionClaims } from "../auth/sessions.js";
import type { Installation } from "../db/store.js";
import type { ActionContext } from "../harness/action.js";
import { defaultAdminPolicy, type AdminPolicy } from "../harness/permissions.js";
import { errorReceipt } from "../harness/receipts.js";
import { resolveSession, type AppDeps } from "./deps.js";

export interface AuthorityClaims {
  sessionId: string;
  workspaceId: string;
  adminUserId: string;
}

export interface VerifiedSessionClaims extends SessionClaims {
  /** Installation generation used by the completed current-role check. */
  installationGeneration: number;
}

export type WriteAuthorityOutcome =
  | { ok: true; installationGeneration: number }
  | {
      ok: false;
      status: 403 | 409 | 503;
      code: "admin_required" | "installation_changed" | "role_verification_unavailable";
      message: string;
    };

export interface RouteAuthority {
  loadPolicy: (workspaceId: string, adminUserId: string) => AdminPolicy;
  requireSession: (req: Request, res: Response) => Promise<VerifiedSessionClaims | undefined>;
  verifyWriteAuthority: (
    claims: AuthorityClaims,
    installation?: Installation,
    signal?: AbortSignal,
  ) => Promise<WriteAuthorityOutcome>;
  actionContext: (
    workspaceId: string,
    adminUserId: string,
    installation: Installation,
    sessionId?: string,
    signal?: AbortSignal,
  ) => ActionContext;
}

/**
 * Current-role and installation-generation choke point shared by ordinary API
 * authentication, action dispatch, confirmations, and undo. Keeping this out of
 * the planner pipeline makes the authorization boundary independently reviewable.
 */
export function createRouteAuthority(
  deps: AppDeps,
  now: () => Date = deps.now ?? (() => new Date()),
): RouteAuthority {
  const roleRechecker = createRoleRechecker(
    deps.config.roleRecheckTtlMs ?? 60_000,
    () => now().getTime(),
  );

  const loadPolicy = (workspaceId: string, adminUserId: string): AdminPolicy =>
    deps.store.getAdminPolicy(workspaceId, adminUserId) ?? defaultAdminPolicy();

  const verifyWriteAuthority = async (
    claims: AuthorityClaims,
    suppliedInstallation?: Installation,
    signal?: AbortSignal,
  ): Promise<WriteAuthorityOutcome> => {
    // Never authorize from a context-captured installation. Reload the durable
    // row and reject generation drift before the next host dispatch.
    const installation = deps.store.getInstallation(claims.workspaceId);
    if (!installation || installation.status !== "active") {
      return {
        ok: false,
        status: 503,
        code: "role_verification_unavailable",
        message: "Your current Clockify admin role could not be verified. No change was made.",
      };
    }
    if (suppliedInstallation && suppliedInstallation.generation !== installation.generation) {
      return {
        ok: false,
        status: 409,
        code: "installation_changed",
        message: "The Clockify installation changed before this action could run. No change was made.",
      };
    }
    const verdict = await roleRechecker.check(
      claims.workspaceId,
      claims.adminUserId,
      deps.clockifyForWorkspace(installation, signal ? { signal } : undefined),
      { force: true, generation: installation.generation },
    );
    if (verdict === "admin") {
      const currentInstallation = deps.store.getInstallation(claims.workspaceId);
      if (!currentInstallation || currentInstallation.status !== "active" ||
        currentInstallation.generation !== installation.generation) {
        return {
          ok: false,
          status: 409,
          code: "installation_changed",
          message: "The Clockify installation changed during role verification. No change was made.",
        };
      }
      if (claims.sessionId) {
        const currentSession = deps.store.getSession(claims.sessionId);
        if (!currentSession || currentSession.workspaceId !== claims.workspaceId ||
          currentSession.adminUserId !== claims.adminUserId) {
          return {
            ok: false,
            status: 403,
            code: "admin_required",
            message: "The authenticated admin session ended during role verification. No change was made.",
          };
        }
      }
      return { ok: true, installationGeneration: installation.generation };
    }
    if (verdict === "non_admin") {
      deps.store.invalidateAdminSessions(claims.workspaceId, claims.adminUserId);
      return {
        ok: false,
        status: 403,
        code: "admin_required",
        message: "Clockify admin or owner access is required. Your assistant sessions were ended.",
      };
    }
    return {
      ok: false,
      status: 503,
      code: "role_verification_unavailable",
      message: "Your current Clockify admin role could not be verified. No change was made.",
    };
  };

  return {
    loadPolicy,

    async requireSession(req, res) {
      const claims = resolveSession(req, deps);
      if (!claims) {
        res.status(401).json({ ok: false, code: "unauthorized", message: "No valid session." });
        return undefined;
      }
      const installation = deps.store.getInstallation(claims.workspaceId);
      if (!installation || installation.status !== "active") {
        res.status(503).json({
          ok: false,
          code: "role_verification_unavailable",
          message: "Your current Clockify admin role could not be verified.",
        });
        return undefined;
      }
      const live = await roleRechecker.check(
        claims.workspaceId,
        claims.adminUserId,
        deps.clockifyForWorkspace(installation),
        { generation: installation.generation },
      );
      if (live === "non_admin") {
        deps.store.invalidateAdminSessions(claims.workspaceId, claims.adminUserId);
        res.status(403).json({ ok: false, code: "forbidden", message: "Admin access is required." });
        return undefined;
      }
      if (live !== "admin") {
        res.status(503).json({
          ok: false,
          code: "role_verification_unavailable",
          message: "Your current Clockify admin role could not be verified.",
        });
        return undefined;
      }
      // The role lookup awaited external I/O. Uninstall/token replacement can
      // finish during that gap, so revalidate both durable authorities before a
      // route is allowed to read or recreate workspace-scoped state.
      const currentInstallation = deps.store.getInstallation(claims.workspaceId);
      const currentClaims = resolveSession(req, deps);
      if (!currentInstallation || currentInstallation.status !== "active" ||
        currentInstallation.generation !== installation.generation ||
        !currentClaims || currentClaims.sessionId !== claims.sessionId ||
        currentClaims.workspaceId !== claims.workspaceId || currentClaims.adminUserId !== claims.adminUserId) {
        res.status(503).json({
          ok: false,
          code: "role_verification_unavailable",
          message: "Your Clockify installation or assistant session changed during verification.",
        });
        return undefined;
      }
      return {
        ...currentClaims,
        installationGeneration: currentInstallation.generation,
      };
    },

    verifyWriteAuthority,

    actionContext(workspaceId, adminUserId, installation, sessionId, signal) {
      return {
        workspaceId,
        adminUserId,
        policy: loadPolicy(workspaceId, adminUserId),
        clockify: deps.clockifyForWorkspace(installation, signal ? { signal } : undefined),
        ...(signal ? { signal } : {}),
        now,
        savePolicy: (policy) => deps.store.upsertAdminPolicy(workspaceId, adminUserId, policy),
        recentOutcomes: (sinceIso) => ({
          outcomes: deps.store.listActionOutcomes(workspaceId, adminUserId, sinceIso),
          confirmationStatuses: deps.store.listConfirmationOutcomes(workspaceId, adminUserId, sinceIso),
        }),
        authorizeWrite: async (actionName) => {
          const verdict = await verifyWriteAuthority(
            { workspaceId, adminUserId, sessionId: sessionId ?? "" },
            installation,
            signal,
          );
          return verdict.ok
            ? undefined
            : errorReceipt({
                action: actionName,
                code: verdict.code,
                message: verdict.message,
                recovery: {
                  hint: "Restore admin access or retry after Clockify is reachable.",
                  retryable: verdict.status === 503,
                },
              });
        },
        ...(sessionId
          ? {
              saveArtifact: (artifact: { contentType: string; filename: string; bytes: Uint8Array }) =>
                deps.store.createArtifact({
                  workspaceId,
                  adminUserId,
                  sessionId,
                  ...artifact,
                }),
            }
          : {}),
      };
    },
  };
}
