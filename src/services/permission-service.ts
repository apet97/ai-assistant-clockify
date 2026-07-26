import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { SessionClaims } from "../auth/sessions.js";
import type { Store } from "../db/store.js";
import {
  FEATURE_GROUPS,
  applyPolicyPatch,
  defaultAdminPolicy,
  type AdminPolicy,
  type FeatureGroup,
  type PermissionLevel,
} from "../harness/permissions.js";
import { successReceipt, type SuccessReceipt } from "../harness/receipts.js";
import type { PermissionsPreviewView, PermissionsView } from "../shared/contracts.js";

/**
 * PermissionService (T16-E): the assistant-policy read/preview/confirm flow.
 *
 * A permission change is preview-first: `preview` computes current-vs-next and
 * mints a five-minute HMAC preview token bound to the caller's exact scope
 * (workspace + admin + session), the canonical hash of the CURRENT policy, and
 * the exact patch. `confirm` accepts ONLY that token — never a replacement
 * groups object — so what the admin's confirmation button applies is exactly
 * what was previewed. Applying the patch changes the base-policy hash, so a
 * replayed token for an effective change fails closed as stale.
 */
export const PERMISSION_PREVIEW_TTL_MS = 5 * 60 * 1000;

const TOKEN_DOMAIN = "permission-preview-v1";

export type GroupsPatch = Partial<Record<FeatureGroup, PermissionLevel>>;

interface PreviewTokenPayload {
  v: 1;
  workspaceId: string;
  adminUserId: string;
  sessionId: string;
  baseHash: string;
  groups: GroupsPatch;
  expiresAt: string;
}

/** Canonical policy fingerprint: version + groups in sorted key order, so the
 * hash is stable regardless of object construction order. */
function policyHash(policy: AdminPolicy): string {
  const groups = Object.fromEntries(
    Object.keys(policy.groups).sort().map((key) => [key, policy.groups[key as FeatureGroup]]),
  );
  return createHash("sha256").update(JSON.stringify({ version: policy.version, groups })).digest("hex");
}

function sign(payloadB64: string, sessionSecret: string): string {
  return createHmac("sha256", sessionSecret).update(`${TOKEN_DOMAIN}.${payloadB64}`).digest("base64url");
}

function mintToken(payload: PreviewTokenPayload, sessionSecret: string): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${payloadB64}.${sign(payloadB64, sessionSecret)}`;
}

function verifyToken(token: string, sessionSecret: string): PreviewTokenPayload | undefined {
  const parts = token.split(".");
  if (parts.length !== 2) return undefined;
  const [payloadB64, signature] = parts;
  const expected = sign(payloadB64, sessionSecret);
  const provided = Buffer.from(signature, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  if (provided.byteLength !== wanted.byteLength || !timingSafeEqual(provided, wanted)) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as PreviewTokenPayload;
    if (parsed.v !== 1) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export type PermissionPreviewResult =
  | { ok: true; view: PermissionsPreviewView }
  | { ok: false; status: 400; code: "invalid_args"; message: string };

export type PermissionConfirmResult =
  | { ok: true; receipt: SuccessReceipt; policy: AdminPolicy }
  | { ok: false; status: 400 | 409; code: string; message: string };

export interface PermissionServiceDeps {
  store: Pick<
    Store,
    "getAdminPolicy" | "upsertAdminPolicy" | "recordActionResult" | "addAuditEvent" | "getInstallation"
  >;
  loadPolicy: (workspaceId: string, adminUserId: string) => AdminPolicy;
  sessionSecret: string;
  now(): Date;
}

export function createPermissionService(deps: PermissionServiceDeps) {
  function view(claims: SessionClaims): PermissionsView {
    const existing = deps.store.getAdminPolicy(claims.workspaceId, claims.adminUserId);
    return {
      policy: existing ?? defaultAdminPolicy(),
      firstRun: !existing,
      featureGroups: FEATURE_GROUPS,
    };
  }

  function preview(claims: SessionClaims, groups: GroupsPatch): PermissionPreviewResult {
    const base = deps.loadPolicy(claims.workspaceId, claims.adminUserId);
    let next: AdminPolicy;
    try {
      next = applyPolicyPatch(base, { groups });
    } catch {
      return { ok: false, status: 400, code: "invalid_args", message: "Invalid permission change." };
    }
    const expiresAt = new Date(deps.now().getTime() + PERMISSION_PREVIEW_TTL_MS).toISOString();
    const previewToken = mintToken({
      v: 1,
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      sessionId: claims.sessionId,
      baseHash: policyHash(base),
      groups,
      expiresAt,
    }, deps.sessionSecret);
    return {
      ok: true,
      view: {
        current: base,
        next,
        changedGroups: Object.keys(groups) as FeatureGroup[],
        previewToken,
        expiresAt,
      },
    };
  }

  function confirm(
    claims: SessionClaims,
    previewToken: string,
    installationGeneration: number,
  ): PermissionConfirmResult {
    const payload = verifyToken(previewToken, deps.sessionSecret);
    if (
      !payload ||
      payload.workspaceId !== claims.workspaceId ||
      payload.adminUserId !== claims.adminUserId ||
      payload.sessionId !== claims.sessionId ||
      Date.parse(payload.expiresAt) <= deps.now().getTime()
    ) {
      return {
        ok: false,
        status: 400,
        code: "invalid_preview_token",
        message: "The permission preview expired or is invalid. Review the change again.",
      };
    }
    const base = deps.loadPolicy(claims.workspaceId, claims.adminUserId);
    if (policyHash(base) !== payload.baseHash) {
      return {
        ok: false,
        status: 409,
        code: "stale_preview",
        message: "Your permissions changed after this preview was created. Review the change again.",
      };
    }
    let next: AdminPolicy;
    try {
      next = applyPolicyPatch(base, { groups: payload.groups });
    } catch {
      return { ok: false, status: 400, code: "invalid_args", message: "Invalid permission change." };
    }
    // The caller awaited Clockify for the role recheck. No await may occur
    // between this final durable generation check and the synchronous policy/
    // result/audit writes below, so uninstall cannot recreate erased rows.
    const installation = deps.store.getInstallation(claims.workspaceId);
    if (!installation || installation.status !== "active" || installation.generation !== installationGeneration) {
      return {
        ok: false,
        status: 409,
        code: "installation_changed",
        message: "The Clockify installation changed before this request could be saved. No change was made.",
      };
    }
    deps.store.upsertAdminPolicy(claims.workspaceId, claims.adminUserId, next);
    const receipt = successReceipt({
      action: "assistant_update_permissions",
      entity: "assistant_policy",
      data: { policy: next },
    });
    const resultRef = deps.store.recordActionResult({
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      sessionId: claims.sessionId,
      actionName: "assistant_update_permissions",
      status: "succeeded",
      result: { kind: "receipt", receipt },
    });
    deps.store.addAuditEvent({
      workspaceId: claims.workspaceId,
      adminUserId: claims.adminUserId,
      sessionId: claims.sessionId,
      actionName: "assistant_update_permissions",
      risk: ["permission_change"],
      resultRef,
    });
    return { ok: true, receipt, policy: next };
  }

  return { view, preview, confirm };
}

export type PermissionService = ReturnType<typeof createPermissionService>;
