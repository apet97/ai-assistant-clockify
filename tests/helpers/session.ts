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
 * This mints the same authenticated cookie shape as the component route — a real
 * `chat_sessions` row plus the production `signSessionCookie` and
 * `buildSessionCookie` primitives — with no HTTP, so it cannot flake.
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

/** Extract a session cookie from a response that is itself under test. Unlike the
 * old ternary helpers, absence is an immediate setup/contract failure and can
 * never be converted into an empty Cookie header followed by a misleading 401. */
export function requireSessionSetCookie(
  headers: Record<string, string | string[] | undefined>,
): string {
  const value = headers["set-cookie"];
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const session = values.find((candidate) => candidate.trim().startsWith("ai_assistant_session="));
  const pair = session?.trim().split(";")[0];
  const cookieValue = pair?.slice("ai_assistant_session=".length).trim();
  if (!session || !cookieValue) {
    throw new Error("expected non-empty ai_assistant_session Set-Cookie header");
  }
  return session.trim();
}

export function requireSessionCookie(
  headers: Record<string, string | string[] | undefined>,
): string {
  return requireSessionSetCookie(headers).split(";")[0];
}
