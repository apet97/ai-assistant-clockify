# CLAUDE.md — AI Assistant Add-on

Read this first in every Claude Code session.

## Product Contract

AI Assistant is a Clockify add-on with an admin-only chat UI and an internal
MCP-shaped action harness.

- Only Clockify admins and owners can use the chat.
- Each admin has private assistant permissions per workspace.
- Default permissions are full `read_write` for every feature group.
- Admins may change their own permissions inside chat.
- Owners do not view or manage other admins' assistant permissions.
- Safe writes execute immediately and return receipts.
- Risky writes require dry-run preview plus button confirmation.
- `Confirm all` is allowed only for the exact previewed batch.
- Typed confirmation such as "yes" never executes risky actions.
- The model never receives Clockify tokens, add-on tokens, session secrets, model API keys, or raw secret-bearing headers.
- V1 is not a public Claude connector and not a standalone MCP server.

## Branch layout

- **`main` (this branch, curated):** source under `src/`, tests under `tests/`,
  live scripts under `scripts/`, `README.md`, `NEXT_SESSION_PROMPT.md` (the live
  test/continue kickoff — start a new session from there), and this file + `AGENTS.md`.
- **`slopbranch`:** the full design-doc set and project skills/agents
  (`PRD.md`, `SPEC.md`, `TECH_STACK.md`, `ARCHITECTURE.md`, `DATA_MODEL.md`,
  `SAFETY_AND_PERMISSIONS.md`, `IMPLEMENTATION_PLAN*.md`, `TESTING_AND_ACCEPTANCE.md`,
  `API_COVERAGE_PLAN.md`, `REFERENCES.md`, `.claude/`). Read those there
  (`git show slopbranch:SPEC.md`, etc.) when you need the contracts behind the code.

## Engineering Rules

- Keep the implementation simple: TypeScript, Express, vanilla Vite UI, SQLite, Zod, Vitest, Supertest.
- Do not add React, Next.js, Prisma, queues, Redis, vector databases, workers, or multi-agent runtime unless the user explicitly asks.
- Do not modify sibling repos. You may read sibling repos under `/Users/15x/Downloads/WORKING/addons-me`.
- Prefer small files with one responsibility.
- Write the failing test first, then the minimum implementation to pass.
- Run `npm run verify` before claiming any task complete.
- If a safety test fails, stop and fix it before adding features.

## Secret Handling

- Do not log tokens or raw auth headers.
- Do not paste secrets into docs, tests, prompts, commits, or final reports.
- Use fake tokens in tests.
- Live Clockify tests are opt-in only and must use a sacrificial workspace.

## Current Status

V1 is implemented and verified, and the **full Clockify REST surface parity
effort (`slopbranch:API_COVERAGE_PLAN.md`, Phases 0–16) is COMPLETE** — ~115
typed catalog actions across 16 feature areas and 3 API hosts, each routed
through the existing safe/risky harness.

**Live end-to-end PROVEN (2026-06-08):** the add-on was registered + installed on
a sacrificial Clockify dev workspace and driven through the real embedded chat —
install → **sidebar** component → DeepSeek planner → harness → Clockify REST
(dev host, `X-Addon-Token`) → receipt. A tag was created and a detailed report
fetched live. Getting there fixed several real defects (see the auth/host + cookie
notes under "Runtime & Known Constraints"):
  - **Install verification:** the Clockify add-on token-signing **public key is one
    fixed platform key** (published at `{apiUrl}/api/auth/public-key`), now embedded
    as the built-in default (`src/addon/clockify-public-key.ts`); `CLOCKIFY_ADDON_PUBLIC_KEY_PEM`
    is optional. `/lifecycle/installed` requires only `authToken`+`workspaceId`.
  - **UI surface:** the component is a **`sidebar`** entry (not an activity tab) and
    ships an `iconPath` (`/icon.svg`) — a sidebar with no icon doesn't render.
  - **Host resolution:** call the host from the install context, not hardcoded —
    `apiUrl`+`/v1` for the api host, the `reportsUrl` claim+`/v1` for reports
    (`src/clockify/api-base.ts`; captured at component load into `installations.reports_url`).
    The audit host has **no claim** (the only URL claims are
    backendUrl/reportsUrl/locationsUrl/screenshotsUrl/ptoUrl) and is derived prod-only
    (`resolveClockifyAuditBase`) — see the AUDIT note below.
  - **Embedded session:** the session cookie is `SameSite=None; Secure; Partitioned`
    (required inside Clockify's cross-site iframe).
  - **Resilience:** the chat route guards async errors → a failed action returns an
    error receipt instead of crashing the process.

**Risky-write confirm flow PROVEN live (2026-06-08):** `scripts/live-confirm-flow.ts`
drove the never-before-browser-verified button-confirm safety mechanism over HTTP
against the real server + DeepSeek + dev host (`PASS=16 FAIL=0`): a risky prompt
returns a dry-run preview and executes nothing; typed "yes" never executes; a wrong
nonce is rejected; a nonce is bound to its own preview (cross-batch confirm rejected
— this is what scopes `Confirm all`); the correct button nonce executes exactly once
and the tag is really gone; the one-use nonce cannot be replayed; **policy is
re-checked at confirm time** (lowering a group after preview → `policy_denied`).
Expiry (5-min TTL) stays covered by `tests/unit/confirmations.test.ts` +
`tests/integration/risky-preview.test.ts`.

- `npm run verify` is green (**447 tests**: type-check + Vitest + build).
- The REST `WorkspaceClient` adapter is composed from a multi-host core
  (`src/clockify/rest/core.ts`: api / reports / audit hosts) plus one typed REST
  module per area (`src/clockify/rest/<area>.ts`), assembled in
  `src/clockify/rest-workspace.ts`. Each area also has a port slice
  (`src/clockify/ports/<area>.ts`) and a workflow module
  (`src/harness/workflows/<area>.ts`). The generic `manage_*`/`prepare_*` actions
  were superseded by typed per-area actions (invoices, expenses, time-off,
  schedule, webhooks).
- The exhaustive live exerciser drives every action through the **real harness**
  (preview→confirm→commit) against a sacrificial workspace:
  `scripts/live-full.ts` → `PASS=115 PREVIEW_OK=28 FAIL=0 SKIP=4`, and
  `scripts/live-sweep.ts` → 0 leftovers. Risky writes that need live preconditions
  or have high blast radius (time-off/approvals/scheduling-publish/user role &
  invite & deactivate) are **preview-only** in the live run by design; their
  request shapes are pinned by mocked-fetch unit tests.
- Live API facts worth knowing (encoded in code + tests): list endpoints often
  return envelopes (`{webhooks:[…]}`, `{expenses:{expenses:[…]}}`, `{invoices:[…]}`,
  `{total,requests:[…]}`) not arrays; several single-GETs 405 so the item is read
  from the list (invoice items, custom fields, holidays, scheduling assignments,
  approvals, groups); the time-entry/expense/holiday/scheduling PUTs replace and
  need the full body; amounts are minor units on the wire for invoices/payments
  but **major** for expenses; the webhook `authToken` secret is never accepted nor
  returned; reports run on the reports host (`POST /reports/{summary|detailed|
  weekly}`); audit search runs on the audit host (`POST /audit-log`).
- **Reports host (Phase 14): cleared on the X-Addon-Token.** The reports host
  (`reports.api.clockify.me/v1`) authenticates with the production add-on token —
  the multi-host core sends it over the same host-routing + auth-header path as the
  api host (the dev API key works too). No remaining gate for reports.
- **AUDIT host (Phase 15) — resolved for non-prod; prod clearance still unconfirmed.**
  Clockify publishes **no audit URL claim** (confirmed by the docs *and* by decoding
  the live install + user tokens: the only URL claims are
  backendUrl/reportsUrl/locationsUrl/screenshotsUrl/ptoUrl). The audit log lives only
  on the `auditlog-api.api.<tenant>` subdomain of `api.<tenant>` (prod/regional)
  hosts, so it is derived prod-only by `resolveClockifyAuditBase`; on the dev/path
  host (`developer.clockify.me/api`) there is no audit host, and the core now returns
  a clean **"Audit log is not available in this Clockify environment"** error receipt
  instead of the old raw `fetch failed` (verified live — server stays up). What
  remains unconfirmed is the production X-Addon-Token **clearance** for the audit host
  when it *does* exist: `POST /audit-log` + the experimental entity-changes feed 400'd
  on the earlier spike (shapes pinned by unit tests). Re-run `scripts/host-auth-spike.ts`
  with a captured prod `LIVE_ADDON_TOKEN` to settle that. The add-on-token install
  path (`scripts/addon-smoke.ts`) is also human-gated.
- **Deferred:** Phase 17 (raw `clockify_api_get`/`api_request` fallback) — omitted
  from V1 (letting the model propose arbitrary paths conflicts with "the harness
  decides, not the model"); requires a safety review before ever building.
- **Known live planner quirks (open — see `NEXT_SESSION_PROMPT.md`):** the embedded
  chat was exercised live (reads, permissions, safe write, risky write→preview→
  button-confirm, audit clean-error — all good). Two DeepSeek-planner gaps remain:
  (1) **"create a project AND start a timer on it" in ONE turn starts a BARE timer**
  (`entry.projectId` empty) — the planner can't reference the not-yet-created project
  id same-turn; a follow-up turn (id in history) attaches it correctly. (2)
  **`clockify_tags_delete` sometimes drops its `id`** → `invalid_args`, so no preview
  fires; needs firmer planner guidance or name-resolution in the handler. Both are
  planner/prompting issues, not harness bugs (the harness correctly rejects malformed
  calls). Also: Clockify **reserves a project name even after archive-then-delete**.

## Build, Test, Run

```bash
npm install            # first time
npm run type-check     # tsc --noEmit
npm test               # vitest run (fakes only; no network)
npm run build          # tsc + vite -> dist/server, dist/ui
npm run verify         # type-check + test + build (the gate)
npm run dev            # tsx src/server.ts (needs env, see below)
```

## Local dev hosting (tunnel)

The embedded add-on must be reachable over HTTPS for Clockify to load it. For dev
we use a **Cloudflare quick tunnel** to `:3001`. Its `*.trycloudflare.com` URL is
**random per `cloudflared` start** (no Cloudflare account/domain needed, but the URL
is not fixed). Manage the tunnel + server as one unit with `scripts/dev-tunnel.sh`:

```bash
scripts/dev-tunnel.sh up       # start tunnel+server, write BASE_URL into .env.server, print URL
scripts/dev-tunnel.sh status   # tunnel URL, BASE_URL match, server health
scripts/dev-tunnel.sh sync     # tunnel up but BASE_URL stale -> rewrite + restart server
scripts/dev-tunnel.sh restart  # rotate the tunnel (NEW url) + resync
scripts/dev-tunnel.sh down     # stop both
```

`up` is **idempotent**: a healthy managed tunnel is reused (URL does NOT rotate), so
the URL stays fixed for the life of that `cloudflared` process. When the URL *does*
change (first start, or after `restart`/a crash), the script rewrites `BASE_URL` and
restarts the server automatically — but you must still **re-register the manifest URL
in the dev console** (Clockify pins the component `baseUrl` at install time): open
developer.clockify.me → workspace settings → Add-ons, paste `<url>/manifest` into
"Insert link", and (uninstall then) INSTALL. A truly fixed URL needs the
named-tunnel-on-a-domain route instead (Cloudflare zone + `cloudflared tunnel
login`/`create`/`route dns`).

## Runtime & Known Constraints

- **Node:** use Node 20+. On this machine only **Node 26** runs (the brew
  `node@22` binary is broken), so `better-sqlite3` is pinned to **^12** (v11 has
  no Node-26 prebuild). Do not downgrade it unless the runtime changes.
- **Clockify seam:** all Clockify I/O goes through the `WorkspaceClient` port
  (`src/clockify/client.ts`). Production uses the REST adapter
  (`src/clockify/rest-workspace.ts`) with `X-Addon-Token` auth, wired in
  `server.ts` (`liveClockifyForWorkspace`). Tests use
  `tests/helpers/fake-clockify.ts`. The legacy `clockify-sdk-ts-115` wrapper is
  unbuilt and **not on the request path**. The adapter does **I/O only** — all
  risk/policy/confirmation logic stays in `src/harness/*`.
- **Auth model:** the add-on authenticates with the installation **add-on token**
  (`X-Addon-Token`), never an API key. `createWorkspaceClockifyClient` must never
  pass `apiKey` (enforced by test).
- **Token verification key (install fix):** inbound Clockify add-on JWTs (the
  component `auth_token` and the `x-addon-lifecycle-token`) are RS256-signed by
  Clockify with **one platform-wide public key**, published at
  `{apiUrl}/api/auth/public-key` — it is **not** a per-add-on/dev-console key. It
  is embedded as the built-in default in `src/addon/clockify-public-key.ts`
  (SPKI sha256 `0cebc449…`, pinned by `tests/unit/clockify-public-key.test.ts`),
  so install/lifecycle verification works out of the box. `CLOCKIFY_ADDON_PUBLIC_KEY_PEM`
  is now **optional** and only overrides the key for non-prod Clockify
  environments/regions. `/lifecycle/installed` requires only `authToken` +
  `workspaceId` (addonId falls back to the token claims; `addonUserId` optional),
  matching the real INSTALLED payload — covered by `tests/integration/lifecycle.test.ts`.

## Live Testing (opt-in, sacrificial workspace only)

Live tests are disabled by default and target a throwaway workspace. They read a
gitignored `.env`. Never commit or paste these values.

```bash
# Exhaustive harness exerciser (API-key adapter): every action through
# preview→confirm→commit, self-cleaning AIASSIST_SMOKE_* resources.
LIVE_CLOCKIFY=1 LIVE_CLOCKIFY_API_KEY=... LIVE_WORKSPACE_ID=... \
  npx tsx scripts/live-full.ts

# Safety-net sweep: removes any leftover AIASSIST_SMOKE_* (must report 0).
LIVE_CLOCKIFY=1 npx tsx scripts/live-sweep.ts

# Smaller no-install dev smoke (read + safe write + one risky round-trip).
LIVE_CLOCKIFY=1 npx tsx scripts/live-smoke.ts

# Live model round-trip (planner only; sends the model only catalog + policy).
npx tsx scripts/chat-smoke.ts            # needs LLM_BASE_URL / LLM_API_KEY / LLM_MODEL

# Production add-on-token path (needs a captured installation token).
LIVE_CLOCKIFY=1 npx tsx scripts/addon-smoke.ts   # needs LIVE_ADDON_TOKEN / LIVE_BACKEND_URL

# Risky-write confirm flow, proven over HTTP against the running add-on (needs an
# active install in the store + a live tunnel/server + DeepSeek). It mints a user
# token via the installation->user token exchange (OWNER_USER_ID = the workspace
# owner's member id, NOT the install token's `user` claim), or pass USER_TOKEN /
# USER_TOKEN_FILE from the live iframe. PASS=16 against the dev sandbox.
npx tsx --env-file=.env.server scripts/live-confirm-flow.ts
```

The add-on's own request path uses the REST `WorkspaceClient` adapter with the
installation add-on token (`X-Addon-Token`). The API-key scripts are dev-only and
NOT the production auth model.
