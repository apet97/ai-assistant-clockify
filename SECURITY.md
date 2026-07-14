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
- Authenticated/component responses are `private, no-store`. Mutations require a
  same-origin `Origin`/Fetch-Metadata signal or the HMAC CSRF token returned by `/api/me`.
- Stored and token-claimed Clockify service origins are validated before persistence and
  before use; token-bearing requests reject redirects.

### Role-staleness window (authz-surface-01)

The component JWT is still the session bootstrap, with `SESSION_TTL_HOURS` (default 2h)
bounding read-only access when `ROLE_RECHECK=0`. The mutation boundary is stricter:
immediately before every write, button confirmation, and undo, the backend fetches the
current role from Clockify without using the read cache. A member verdict invalidates that
admin's sessions; an outage or malformed verdict fails closed with `503` and dispatches no
write. `ROLE_RECHECK=1` additionally enables cached role checks for authenticated reads
(`ROLE_RECHECK_TTL_MS`, default 60000).

## Abuse / cost controls

- **Per-session chat rate limit** (`CHAT_RATE_LIMIT_MAX`, default 30 / 5 min) bounds the paid
  model loop; the confirm-time resume is charged against the same budget.
- **Per-admin new-chat limit** (`NEW_CHAT_RATE_LIMIT_MAX`, default 10 / 5 min) stops minting
  fresh sessions to reset the per-session budget.
- **Bounded model input**: a 12-message history window, a 24 KB cap per tool result fed to the
  model, a 256 KB cap on the persisted suspension (dropped, not truncated, if exceeded), an
  abort timeout on every model request, and a 6-step agentic loop budget. The request body is
  capped at 32 KB.
- **Bounded Clockify traffic**: per workspace, 10 requests/second, burst 10, concurrency 4,
  one host mutation at a time, 60 host calls per turn, and adaptive `429` cooldown. Writes
  are not automatically retried after dispatch.

## Data handling

- Installation tokens encrypted at rest (AES-256-GCM); never logged. Lifecycle logging is
  structured and secret-free.
- Chat transcripts + the audit log are retained `RETENTION_DAYS` (default 90, min 30) and
  swept in bounded batches; uninstall hard-deletes the workspace's data and installation
  metadata immediately. See `PRIVACY.md`.

## Reporting

Report suspected vulnerabilities privately to the maintainer (see the repo owner). Do not file
public issues for security reports.
