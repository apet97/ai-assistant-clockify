import { Router } from "express";
import type { PermissionService } from "../services/permission-service.js";
import { groupsPatchSchema, permissionConfirmBodySchema } from "./request-schemas.js";
import { asyncHandler } from "./async-handler.js";
import type { RequireSession, WrappedHandler } from "./route-ports.js";

/**
 * Assistant permission routes (T16-E/T16-G): transport-only delegation to
 * `PermissionService`. Confirm accepts ONLY the preview token — the authority
 * recheck runs BEFORE body decoding so a denied admin is refused identically
 * whatever the body carries (pinned by role-recheck.test.ts).
 */
export function permissionsRouter(options: {
  requireSession: RequireSession;
  verifyWriteAuthority: (claims: Parameters<PermissionService["confirm"]>[0]) => Promise<
    { ok: true; installationGeneration: number } | { ok: false; status: number; code: string; message: string }
  >;
  permissions: PermissionService;
  sessionAsyncHandler: WrappedHandler;
}): Router {
  const router = Router();

  router.get("/permissions", asyncHandler(async (req, res) => {
    const claims = await options.requireSession(req, res);
    if (!claims) return;
    res.json({ ok: true, ...options.permissions.view(claims) });
  }));

  router.post("/permissions/preview", asyncHandler(async (req, res) => {
    const claims = await options.requireSession(req, res);
    if (!claims) return;
    const parsed = groupsPatchSchema.safeParse((req.body as { groups?: unknown } | undefined)?.groups);
    if (!parsed.success) {
      res.status(400).json({ ok: false, code: "invalid_args", message: "Invalid permission groups." });
      return;
    }
    const preview = options.permissions.preview(claims, parsed.data ?? {});
    if (!preview.ok) {
      res.status(preview.status).json({ ok: false, code: preview.code, message: preview.message });
      return;
    }
    res.json({ ok: true, preview: preview.view });
  }));

  router.post("/permissions/confirm", options.sessionAsyncHandler(async (req, res) => {
    const claims = await options.requireSession(req, res);
    if (!claims) return;
    const authority = await options.verifyWriteAuthority(claims);
    if (!authority.ok) {
      return res.status(authority.status).json({ ok: false, code: authority.code, message: authority.message });
    }
    const parsed = permissionConfirmBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        code: "invalid_args",
        message: "A permission preview token is required.",
      });
    }
    const confirmed = options.permissions.confirm(claims, parsed.data.previewToken, authority.installationGeneration);
    if (!confirmed.ok) {
      return res.status(confirmed.status).json({ ok: false, code: confirmed.code, message: confirmed.message });
    }
    return res.json({ ok: true, receipt: confirmed.receipt, policy: confirmed.policy });
  }));

  return router;
}
