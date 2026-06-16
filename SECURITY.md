# Security model — AI Assistant Add-on

How this add-on protects the workspaces it runs in. Companion to `CLAUDE.md` (engineering
source of truth), `PRIVACY.md` (data handling/retention), and `DEPLOYMENT.md`.

## Trust boundary

- **The model only ever *proposes* named actions** from a fixed catalog. A deterministic
  harness (`src/harness/*`) validates every proposal against the action's Zod schema, the
  per-admin permission policy, and a risk policy, and is the **only** thing that calls
  Clockify. The model never executes anything and is never on the write path.
- **The model never receives secrets** — no Clockify install token, session secret, model
  API key, or raw headers. The system prompt carries only the action catalog + the admin's
  permission policy. A tripwire test asserts no secret leaks into the persisted
  `agent_state_json` suspension; the install token is encrypted at rest (AES-256-GCM).
- **Risky writes require a dry-run preview + a one-use button confirmation** (5-min TTL,
  bound to session/workspace/admin + a salted nonce hash + an operation hash; policy is
  re-checked at confirm time). A typed "yes" never executes. The raw nonce lives only in
  the live HTTP response — only its hash is stored.

## Authentication & authorization

- **Admin/owner only.** Non-admins are rejected *before* a session is created
  (`src/auth/roles.ts`, checked at component load).
- **Signed session cookie** (`src/auth/sessions.ts`): `HttpOnly; SameSite=None; Secure;
  Partitioned` (required for the cross-site Clockify iframe; `Partitioned`/CHIPS keys it to
  the embedding site). Expiry is verified on every request.
- **Per-admin, per-workspace permission policy**, re-checked at confirm time, so lowering a
  policy after a preview denies the commit cleanly (auditable `policy_denied` receipt).
- **Chat-history switcher is IDOR-guarded**: opening a past session re-cookies only to a
  LIVE session owned by the same workspace+admin; a foreign/unknown id returns 404 and sets
  no cookie.

### Role-staleness window (authz-surface-01) — accepted design

The workspace **role** is read from the Clockify add-on JWT at component load and baked into
the signed session cookie; it is **not** re-fetched from Clockify on every API request (that
would add a Clockify call to the hot path). Consequently, **an admin demoted to member keeps
assistant access until their session expires.** That window is bounded by the session TTL:

- **`SESSION_TTL_HOURS` (default 2h)** — the session lifetime *and* the role-staleness bound.
  When the session expires the component re-mints it, which re-reads the role from a fresh
  Clockify JWT, so the demotion takes effect within the window.
- This TTL is also coupled to the **history switcher**, which lists only *live* sessions — a
  shorter TTL tightens revocation but shows fewer past chats. Raise `SESSION_TTL_HOURS` for a
  longer history window at the cost of a longer staleness window.

If near-real-time revocation is ever required (compliance), the stronger option is a
per-request role re-check against Clockify behind a short cache — deliberately not enabled by
default to keep the request path dependency-free.

## Abuse / cost controls

- **Per-session chat rate limit** (`CHAT_RATE_LIMIT_MAX`, default 30 / 5 min) bounds the paid
  model loop; the confirm-time resume is charged against the same budget.
- **Per-admin new-chat limit** (`NEW_CHAT_RATE_LIMIT_MAX`, default 10 / 5 min) stops minting
  fresh sessions to reset the per-session budget.
- **Bounded model input**: a 12-message history window, a 24 KB cap per tool result fed to the
  model, a 256 KB cap on the persisted suspension (dropped, not truncated, if exceeded), an
  abort timeout on every model request, and a 6-step agentic loop budget. The request body is
  capped at 32 KB.

## Data handling

- Installation tokens encrypted at rest (AES-256-GCM); never logged. Lifecycle logging is
  structured and secret-free.
- Chat transcripts + the audit log are retained `RETENTION_DAYS` (default 90, min 30) and
  swept hourly; uninstall erases the workspace's data immediately. See `PRIVACY.md`.

## Reporting

Report suspected vulnerabilities privately to the maintainer (see the repo owner). Do not file
public issues for security reports.
