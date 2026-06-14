import { signSessionCookie } from "../../src/auth/sessions.js";
import { buildSessionCookie } from "../../src/routes/deps.js";
import type { Store } from "../../src/db/store.js";

/**
 * Deterministically mint an admin session cookie IN-PROCESS, for tests that need
 * an authenticated cookie as SETUP (not those exercising the component route).
 *
 * Why this exists: the integration tests used to mint the cookie by hitting
 * `GET /component/assistant` over supertest and reading its `Set-Cookie`. Under
 * full-suite parallel load (14 forked workers each churning ephemeral
 * `app.listen(0)` servers) that round-trip intermittently failed to yield a
 * capturable `Set-Cookie` — a cross-process supertest/ephemeral-server contention
 * flake, NOT a product bug (a single-process probe of 5000 mint→auth cycles at
 * concurrency 96 under CPU load never reproduced it). The harness's
 * `Array.isArray(setCookie) ? setCookie[0]… : ""` fallback then SILENTLY produced
 * an empty cookie, so the next authenticated request 401'd — surfacing as a flaky
 * "expected 401 to be 200" in whichever test was running.
 *
 * This mints the EXACT cookie the component route issues — a real `chat_sessions`
 * row via `store.createSession` plus the same signed value via the production
 * `signSessionCookie` + `buildSessionCookie` — with no HTTP, so it cannot flake.
 * The component route's own admin/installation gating stays covered by the
 * component tests; here the cookie is pure setup.
 */
export function mintAdminCookie(
  store: Store,
  sessionSecret: string,
  opts: { workspaceId?: string; adminUserId?: string; workspaceRole?: string } = {},
): string {
  const workspaceId = opts.workspaceId ?? "ws-1";
  const adminUserId = opts.adminUserId ?? "admin-1";
  const session = store.createSession({ workspaceId, adminUserId });
  const value = signSessionCookie(
    {
      sessionId: session.id,
      workspaceId,
      adminUserId,
      workspaceRole: opts.workspaceRole ?? "ADMIN",
      expiresAt: session.expiresAt,
    },
    sessionSecret,
  );
  // Reduce the full Set-Cookie string to the `name=value` pair the tests pass to
  // `.set("Cookie", …)` — exactly what `setCookie[0].split(";")[0]` produced.
  return buildSessionCookie(value, false).split(";")[0];
}
