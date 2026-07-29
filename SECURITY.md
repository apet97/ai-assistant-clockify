# Security model — AI Assistant Add-on

How this add-on protects the workspaces it runs in. Companion to `CLAUDE.md` (engineering
source of truth), `PRIVACY.md` (data handling/retention), and `DEPLOYMENT.md`.

## Trust boundary

- **The model only ever *proposes* named actions** from a fixed catalog. A deterministic
  harness (`src/harness/*`) validates every proposal against the action's Zod schema, the
  per-admin permission policy, and a risk policy, and is the **only** thing that calls
  Clockify. The model never executes anything and is never on the write path.
- **Admin-authored write authority is persisted before tool execution.** A constrained
  declaration pass receives only current and unresolved prior admin text plus trusted
  action/catalog metadata and creates an immutable `IntentCapabilityV1`. Raw model
  arguments must match its exact actions, UTF-8 spans, literal constraints, and
  cardinality before Zod preprocessing or server-side id/date resolution. Invalid or
  unavailable declarations deny writes while preserving reads.
- **The model never receives secrets** — no Clockify install token, session secret, model
  API key, or raw headers. The system prompt carries only the action catalog + the admin's
  permission policy. A tripwire test asserts no secret leaks into the persisted
  `agent_state_json` suspension; the install token is encrypted at rest (AES-256-GCM).
- **Risky writes require a dry-run preview + a one-use button confirmation** (5-min TTL,
  bound to session/workspace/admin + a salted nonce hash + operation hash + immutable
  capability id/hash; policy, capability, catalog, and action compatibility are re-checked
  at confirm time). A typed "yes" never executes. The raw nonce lives only in the live
  HTTP response — only its hash is stored.

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
- Fresh-install release proof is minted only by a verified lifecycle callback for a
  workspace with no prior installation row. The store atomically binds a one-way token
  fingerprint and generation to the verified release/server/source/manifest hashes;
  replacement, status churn, tombstone, and uninstall invalidate it. Retrieval requires
  the exact current `X-Addon-Token`; a public HMAC verifier returns no workspace or token.

### Mandatory role recheck (authz-surface-01)

The component JWT bootstraps a session but is not a lasting role verdict. Every
authenticated API surface rechecks the current Clockify role and fails closed on an
outage, malformed response, or non-admin verdict. Only a positive admin/owner verdict may
be cached, for at most `ROLE_RECHECK_TTL_MS` (default 60000 ms). Every write, button
confirmation, undo, primary dispatch, and compensation dispatch bypasses that cache and
checks again immediately before mutation. A member verdict invalidates all of that
admin's sessions, and queued work dispatches no write.

## Mutation integrity and recovery

- Full action outcomes live only in canonical `action_results` rows. Turns, chat history,
  audit, confirmations, undo, operation journals, and retry state retain ordered links and
  bounded summaries instead of independent mutable result copies.
- Every external write durably stores normalized nonsecret operation data, an exact
  mutation plan including the hashed maximum host-call cost, authoritative target/parent
  snapshots where applicable, and step-bound
  reconciliation metadata before dispatch. Where applicable, immediate pre-dispatch
  target verification fails closed on drift. The REST mutation scope rejects unscoped, repeated, excess,
  out-of-order, or incomplete plan execution and allows at most one mutation call per host
  step.
- Primary and compensation effects are journaled as ordered prepared, queued, dispatched,
  and terminal steps, with `queued_at` recorded separately and `dispatched_at` set only
  immediately before the external request begins. A queued step can cancel definitively.
  After dispatch, cancellation waits for truthful settlement. Ambiguous post-dispatch
  outcomes are never automatically retried; they stop later steps. Startup reconciliation
  performs only complete-list or exact-target reads and settles only authoritative
  compatible evidence. It never resumes prepared work or compensates automatically.
- Invoice duplicate suppression is not semantic or payload-level. A replay is bound to
  the persisted durable operation id, exact step journal, and reconciliation evidence; an
  equal payload from a separately authored preview is a separate intentional operation.

## Abuse / cost controls

- **Per-session chat rate limit** (`CHAT_RATE_LIMIT_MAX`, default 30 / 5 min) bounds the paid
  model loop; the confirm-time resume is charged against the same budget.
- **Per-admin new-chat limit** (`NEW_CHAT_RATE_LIMIT_MAX`, default 10 / 5 min) stops minting
  fresh sessions to reset the per-session budget.
- **Per-workspace/admin authenticated API limit** (`API_RATE_LIMIT_MAX`, default 600 / 5 min)
  bounds authorization and database work across every `/api` route. New or reopened chat
  sessions share the same budget; NDJSON streams and artifact downloads count once per HTTP
  request, not once per event or byte.
- **Bounded model input**: a 12-message history window, a 24 KB cap per tool result fed to the
  model, a 256 KB cap on the persisted suspension (dropped, not truncated, if exceeded), an
  abort timeout on every model request, and a 6-step agentic loop budget. The request body is
  capped at 32 KB.
- **Bounded Clockify traffic**: per workspace, 10 requests/second, burst 10, concurrency 4,
  one host mutation at a time, 60 host calls per turn, and adaptive `429` cooldown. Writes
  are not automatically retried after dispatch.
- **V2 run budgets are durable**: the v2 engine additionally enforces per-run ceilings
  (6 model calls, 2 discovery searches, 12 logical API calls with writes counted, 60
  physical host calls charged against a PERSISTED per-run ledger whose reservation is
  checked in the dispatch-granting transaction and survives restart, 300 s active
  wall-clock, 64k tokens). Provider retry attempts are charged, including when both fail.

## Data handling

- Installation tokens encrypted at rest (AES-256-GCM); never logged. Lifecycle logging is
  structured and secret-free.
- Release attestation envelopes are secret-free, domain-separated HMACs derived from
  `SESSION_SECRET`; the database retains only token/workspace hashes, not another token.
- Exact same-token install callback retries are idempotent even while the installation
  is inactive; only a verified `STATUS ACTIVE` callback may reactivate that token. Replacement and
  uninstall atomically add the outgoing token to a separate-domain, workspace-unlinked
  SHA-256 denylist before authority changes. This prevents a delayed signed callback
  from rotating back to or resurrecting a retired token, including after process restart.
  Because a delayed token may never have been persisted, a separate-domain hashed-workspace
  lineage retains the highest issuer time, state, and generation for 24 hours + 2 minutes + 1 second
  after the latest accepted event, including after workspace erasure/restart.
- Every component/lifecycle JWT requires a finite `exp`; lifecycle JWTs additionally
  require a bounded finite `iat`. Each accepted installation generation persists that
  issuer-clock watermark, and older INSTALLED/STATUS_CHANGED/DELETED callbacks are
  acknowledged without changing current authority. Migrated rows use the reference
  30-second installed-time grace until their first watermarked event. Clockify exposes
  only whole-second `iat` and no installation correlation id. Equal-time authority therefore
  fails closed with `DELETED > INACTIVE > ACTIVE`; a different-token INSTALLED callback must
  be strictly newer, while an exact-token delivery retry remains authority-neutral.
- Component load never authorizes from the JWT's cached `workspaceRole` alone. After the
  active-install gate it forces the shared live Clockify role check before session reuse
  or creation; demotion invalidates existing sessions, and lookup uncertainty returns
  503 without a cookie.
- Every post-await state-creation boundary rechecks the exact active installation
  generation synchronously. In particular, new-chat session creation and permission
  policy/result/audit persistence cannot recreate rows after uninstall erasure.
- Chat transcripts + the audit log are retained `RETENTION_DAYS` (default 90, min 30) and
  swept in bounded batches with persisted deleted/expired/backlog/duration and passive-WAL
  evidence. Uninstall immediately blocks work and wipes the persisted token, drains only
  already-dispatched settlement, and then erases workspace data; startup completes an
  interrupted deletion tombstone. Terminal confirmations and recovery scrub nonce hashes,
  saved agent state, and executable operation payloads. See `PRIVACY.md`.

## Automated evidence and human gates

The exact local automated gates are `npm run verify`, `npm run audit:prod`,
`npm run license:prod`, and `npm run eval:smoke`. Push/PR CI retains the CycloneDX SBOM
and deterministic production-license report. Scheduled/manual live smoke uses a named
sacrificial GitHub environment, serialized execution, an always-run bounded cleanup job,
and secret-free count/status artifacts. The manual release-evidence workflow records the
exact commit SHA and machine conclusions. Workflow files do not evaluate deployment,
configured DeepSeek governance, private browser operation, recovery approval, or
Marketplace submission.

Those workflow definitions are automated controls, not proof that a remote run,
production drill, deployment, or review occurred. Engineering results belong in the
release-candidate evidence record. After that record is green, only the three admin
packages in `MARKETPLACE_READINESS.md` may remain.

## Reporting

Report suspected vulnerabilities only through the monitored private security route
published in the Marketplace listing and deployed Security page. Supplying that route and
enabling private vulnerability reporting is admin package 2. Do not file public issues or
send credentials, tokens, prompts, customer content, or raw headers in a report.
