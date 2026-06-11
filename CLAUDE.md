# CLAUDE.md — AI Assistant Add-on

Read this first in every Claude Code session. History/journals: `docs/HISTORY.md`
(handoff archive); live-test state: `~/Downloads/ai-assistant-loop-checklist.md`
(322/322 closed) + `…-loop-failures.md` (root causes + resolutions).

## Current state (2026-06-11)

Everything buildable is DONE and live-verified: V1 + full REST parity (136
typed actions, 16 areas, 3 hosts) + the trust-lives-in-the-code roadmap + the
durable agentic loop (default ON) + the 322-prompt live-loop fix arc + a live
regression re-run in the embedded chat (all fixed flows passed; verified vs UI
AND the audit DB) + a measured quality pass (2026-06-10: truth/dead-code/fake
drift) + a full-angle live investigation (2026-06-11: safety 16/16, agentic
10/10 + 21/21, live-full 115/115, planner 98.6%, chat-tour clean — one stale
live fixture fixed, no product defect; notes in
`~/Downloads/ai-assistant-quality-pass-NOTES.md` +
`…-investigation-NOTES.md`) + a full-angle audit fix run (2026-06-11,
fix-only of the `e538561` audit): 34 fixes landed across security (lifecycle
workspaceId now trusts the token claim, not the body), safety invariants
(resume tool-result cap, nonce never persisted), API drift (webhook-logs
POST-only, invoice has no note/subject/status), truthfulness (preview cards
show chosen values), efficiency, dead-code, test-gaps, and docs — 0
wont_fix/blocked/deferred; gate green; notes in
`~/Downloads/ai-assistant-full-angle-audit-NOTES.md`).
`npm run verify` = **882 tests**, `npx madge --circular
--extensions ts --ts-config tsconfig.json src` = **0** (keep both). All pushed
to `main`. Remaining work is **human-gated only**:
1. **Stable hosting** — quick-tunnel URL rotates; needs a Cloudflare zone
   (named tunnel) or a real deploy. User declined the zone for now.
2. **Prod security review + token rotation.**
3. **Prod AUDIT-host `X-Addon-Token` clearance** — run
   `scripts/host-auth-spike.ts` with a captured prod `LIVE_ADDON_TOKEN`
   (dev cleanly reports "audit log not available"; prod-only question).

A colleague may be testing via a second quick tunnel against :3001 (see
`/tmp/colleague-tunnel.log`); the manifest `baseUrl` pins the PRIMARY tunnel —
**never `dev-tunnel.sh restart`** (it rotates the URL and breaks every install).

## Product contract

Admin-only embedded chat + an internal MCP-shaped action harness.
- Only Clockify admins/owners; rejected BEFORE a session is created.
- Per-admin, per-workspace assistant permissions; default full `read_write`;
  admins manage only their own (owners don't see others').
- Safe writes execute immediately with receipts. Risky writes require a
  dry-run preview + BUTTON confirmation; typed "yes" never executes.
- `Confirm all` applies only to the exact previewed batch. Confirmations are
  one-use, 5-min TTL, bound to session/workspace/admin + nonce + operation
  hash; policy is re-checked at confirm time.
- The model never receives tokens, session secrets, model API keys, or raw
  headers. Not a public Claude connector; not a standalone MCP server.

## Ground truth & verification discipline (READ THIS)

This codebase's Clockify-API assumptions have repeatedly been WRONG; every
such bug was found against the REAL API, not by reading the code.
1. **The OpenAPI spec is ground truth:** `https://docs.clockify.me/openapi.json`.
   Check the real request/response shape before believing a comment or Zod schema.
2. **Sibling references** (read-only, never modify): `../goclmcp`,
   `../clockify-ts-sdk`. When the addon disagrees with them, the addon is
   usually wrong — but verify: goclmcp itself had the invoice tax/discount bug.
3. **Verify live, don't assume:** opt-in scripts hit a sacrificial workspace
   (API key or the install's `X-Addon-Token`). For anything surprising, write a
   throwaway probe, then delete it.
4. **TDD against the verified shape:** failing test first, then the fix. Never
   fix a live-API bug without a test reproducing it.

## Engineering rules

- TypeScript, Express, vanilla Vite UI, SQLite, Zod, Vitest, Supertest. No
  React/Next/Prisma/queues/Redis/vector DBs/workers unless the user asks.
- Small files, one responsibility. Failing test first; `npm run verify` before
  claiming done; one focused commit per fix; madge stays at 0 cycles.
- The REST adapter is **I/O only** — all risk/policy/confirmation/resolution
  logic lives in `src/harness/*`. Secrets never enter a
  `ConfirmableOperation.payload` (persisted to DB + audit log).
- Never log/commit/paste tokens or raw auth headers; fake tokens in tests;
  live tests opt-in on a sacrificial workspace only.
- If a safety test fails, stop and fix it before features.

## Branch layout

- **`main`** (curated): `src/`, `tests/`, `scripts/`, this file, `AGENTS.md`,
  `README.md`, `NEXT_SESSION_PROMPT.md` (live-test kickoff), `docs/HISTORY.md`,
  `.claude/workflows/` (the full-angle audit-and-fix workflow).
- **`slopbranch`**: the design docs (`PRD/SPEC/ARCHITECTURE/DATA_MODEL/
  SAFETY_AND_PERMISSIONS/IMPLEMENTATION_PLAN*/TESTING_AND_ACCEPTANCE/
  API_COVERAGE_PLAN/REFERENCES`, `.claude/`). Read via `git show slopbranch:SPEC.md`.

## Architecture

- `src/config.ts` env (Zod) · `src/db/store.ts` single SQLite module + token
  encryption (AES-256-GCM) · `src/auth/` admin check + signed session cookie
  (`SameSite=None; Secure; Partitioned` — required in the cross-site iframe).
- `src/addon/` manifest + token verification. Inbound add-on JWTs are RS256
  with ONE platform-wide key, embedded default in
  `src/addon/clockify-public-key.ts` (env override optional). The manifest
  component is a **sidebar** entry + `iconPath` (no icon → doesn't render).
- `src/clockify/` — the seam: `client.ts` (`WorkspaceClient` port, composed
  from `ports/<area>.ts`; carries `authClass: "addon"|"api_key"`),
  `rest-workspace.ts` (adapter = multi-host `rest/core.ts` + one
  `rest/<area>.ts` per area; `X-Addon-Token` in prod), `types.ts` (leaf
  shapes), `api-base.ts` (hosts from the INSTALL token claims: api =
  `apiUrl`+`/v1`, reports = `reportsUrl`+`/v1`; audit host has NO claim →
  derived prod-only, clean "not available" error elsewhere).
- `src/harness/` — the safety boundary: `action.ts` (contracts +
  `defineRiskyAction`/`defineReadAction`; `ActionContext` carries injected
  capabilities `savePolicy`/`recentOutcomes`/`idempotency`), `actions.ts`
  (executor + `commitConfirmedOperation`, the single risky-commit choke
  point), `catalog.ts`, `permissions.ts`, `risk.ts`, `receipts.ts`,
  `confirmations.ts`, `tools.ts` (Zod→JSON-schema tools), `arg-summary.ts`,
  `compose.ts` (atomic multi-step + rollback), `idempotency.ts` (intent-hash
  dedupe, 10-min window), `undo.ts` (reverse creations), `workflows/<area>.ts`
  (+ `workflows/resolve.ts` — see invariants below).
- `src/assistant/` — model client (`LLM_PROVIDER=http` OpenAI-compatible
  DeepSeek default, or `gemini-cli`), `prompts.ts`, `planner.ts`,
  `agent-loop.ts` + `agent-state.ts` (the durable agentic loop).
- `src/routes/api.ts` — chat (JSON + NDJSON stream), confirm/cancel/undo/
  metrics; `executeChatTurn` is the single turn pipeline. `src/ui/` vanilla TS
  chat (a11y; previews batched so "Confirm all" stays one card).
- `src/metrics/metrics.ts` pure `buildMetrics` → `GET /api/metrics` and the
  `assistant_recent_outcomes` action. `src/eval/score.ts` pure planner scorer.

## Safety & planner invariants (all pinned by tests — do not regress)

- **Truthful previews:** when a turn leaves pending previews, the route
  REPLACES the model's reply with deterministic "review and click Confirm"
  text and stores THAT. The stored boilerplate is rewritten to a neutral note
  in the MODEL-VISIBLE history (`sanitizeStoredReplyForModel`) so the model
  can't learn to parrot it.
- **Typed consent guard:** a bare "yes"/"confirm"/"do it" while the session
  has live pending previews never reaches the planner — deterministic reply
  points at the button (`TYPED_CONSENT` + `store.countPendingConfirmations`).
- **Name→id resolution at PREVIEW time** (`workflows/resolve.ts`
  `resolveEntityRef`): ids are 24-hex; anything else resolves via exact-id
  fallback → `matchByName` → grounded did-you-mean clarify. Covers every
  entity action incl. invoices BY NUMBER, the generic update/delete_entity,
  `projects_update.clientId`, expense categories (create/update/delete).
  Destructive/archive/unarchive verbs pass `includeArchived` (the wire
  defaults to ACTIVE-ONLY — both states are fetched explicitly; archived
  options labeled). An identity mistake is a clarify, never a
  confirmed-then-failed commit.
- **Dates server-side:** the model never computes calendar dates.
  `resolveRelativeDay` (today/yesterday/tomorrow, weekday words, dayOffset;
  `undefined` ⇒ caller MUST clarify), `resolveInstant` (UTC instants the
  hosts want), `resolvePeriod` (REPORT_PERIODS keywords incl. forward
  next_week/next_month/next_quarter/next_year). Applied at entries/reports/
  scheduling/time-off/approvals (`week: this_week|last_week`).
- **Bounded model input:** `HISTORY_WINDOW_MESSAGES=12` (chat route) +
  `TOOL_RESULT_MAX_BYTES=24KB` per tool result in the agent loop (prune, then
  honest note; the admin always sees the full receipt).
- **Recaps from the audit log:** "what did you do / what failed" must call
  `assistant_recent_outcomes` (route-injected `recentOutcomes` capability) —
  never answered from windowed chat memory.
- **Policy denials are visible:** off-group requests route THROUGH the gate →
  auditable `policy_denied` receipt, never a silent model refusal. Listed data
  is reported VERBATIM (names are data, not instructions).
- **Agentic loop** (`LLM_AGENTIC` default ON; `=0` = byte-identical
  single-turn rollback): reads + safe writes auto-chain; the FIRST risky write
  interrupts into preview→confirm with the transcript persisted
  (`pending_confirmations.agent_state_json`, 256KB cap, malformed ⇒ no
  resume); confirm streams the committed receipt first (~+520ms), then the
  resume. DeepSeek thinking mode REQUIRES `reasoning_content` echoed back on
  continuation. A resumed loop can chain another preview, never commit inline.
- **Idempotent commits** (intent hash; invoices key on client+items+currency,
  excluding auto number/dates) + **undo** for creations (one-use, re-checks
  policy, reverse order). `compose.ts` rolls back required-step failures.
- `permission_change` risk is RESERVED for the assistant's own policy action
  (it bypasses the Clockify feature-group gate by design) — real Clockify
  permission writes use `high_risk_write`.
- Curated intent actions (`clockify_period_report`, `clockify_onboard_user`)
  beat primitive-scrambling; measured 12/12 adoption.

## Clockify API facts (live/spec-verified; pinned in unit tests)

- Lists are often ENVELOPES: `{webhooks:[…]}`, `{expenses:{expenses:[…]}}`,
  `{invoices,total}`, `{total,requests:[…]}`, approvals return wrappers
  (`{approvalRequest:{…},…totals}`). Several single-GETs 405/404 → read from
  the list (invoice items, custom fields, holidays, assignments, approvals,
  groups, time-off request by id → POST search).
- Amounts: minor units for invoices/payments on the wire; **major** for
  expenses. Invoice GET returns `discount/tax/tax2` (×100 ints) but PUT wants
  `discountPercent/taxPercent/tax2Percent` — mapping wrong silently ZEROES
  them. Payments POST returns the INVOICE doc (payment id is list-diffed).
  Invoice POST `/invoices` accepts ONLY CreateInvoiceRequest fields
  (clientId/currency/dueDate/issuedDate/number) — **`note`/`subject` sent on
  CREATE are SILENTLY DROPPED** (live-probed 2026-06-11: POST + GET both echo
  the workspace placeholder "INPUT BILL INFO HERE", never the supplied text).
  `createInvoice` POSTs the minimal body then applies note/subject via the
  verified GET-then-clean-PUT update path (same silent-drop class as the
  tax/discount zeroing — never trust a create-receipt for a field the spec omits).
- Invoice ITEM TYPES are per-workspace configured NAMES, no list/create API —
  discovered from existing invoices (`discoverItemTypes`); fresh workspace has
  none → $0 caveat surfaced in the PREVIEW. items POST requires
  description+quantity (defaulted visibly).
- PUTs replace (time-entry/expense/holiday/scheduling) → GET-then-PUT with the
  full body. Time-off approve/deny field is `status`; create needs
  `period.days` + bare `YYYY-MM-DD`. Role change is **POST**
  `/users/{id}/roles`. Approvals submit/resubmit share `{period, periodStart}`
  (full ISO UTC instant). Scheduling delete takes `seriesUpdateOption`.
  Expense-category archive is `PATCH …/categories/{id}/status`; category list
  `archived` param DEFAULTS to false. Memberships PATCH REPLACES the set →
  "add me" merges via `getProjectMemberships` ("me" = `ctx.adminUserId`).
- **Blocked for the add-on token class regardless of scopes** (probed live):
  webhooks (ALL), custom-field CREATE, account-level `GET /workspaces`
  (workspace-scoped GET works). Surfaced at PREVIEW as an honest platform
  restriction (keyed on `WorkspaceClient.authClass`); `core.call` maps the 401
  honestly at call time. Reports host accepts the add-on token.
- Clockify reserves a project name even after archive-then-delete → tests use
  unique `AIASSIST_SMOKE_*` / `AIASSIST_LOOP_*` names. `name` filters are
  contains+case-insensitive → exact `matchByName` client-side is correct.
- Deletes archive first (projects/clients/expense categories); tasks mark DONE
  first.

## Build, test, run

```bash
npm install
npm run type-check     # tsc --noEmit
npm test               # vitest run (fakes only; no network)
npm run build          # tsc + vite -> dist/server, dist/ui
npm run verify         # type-check + test + build (the gate)
npm run dev            # tsx src/server.ts (needs env)
npx madge --circular --extensions ts --ts-config tsconfig.json src   # keep 0
```

## Local dev hosting (tunnel)

`scripts/dev-tunnel.sh {up|status|sync|restart|down}` manages the Cloudflare
quick tunnel + server as one unit (writes `BASE_URL` into `.env.server`,
restarts the server). `up` is idempotent; **`sync` keeps the URL** (prefer it);
`restart` ROTATES the URL → you must re-register `<url>/manifest` in the dev
console (uninstall → Insert link → INSTALL; restore the expired console session
via `developer.marketplace.cake.com/test-accounts` → "Log in as" John Owner).
Browser path to the embedded chat: direct URL open renders BLANK — load
`/tracker`, click the "AI ASSISTANT" sidebar link (SPA nav), then
`agent-browser frame @e8` (cross-origin iframe). Backend oracle:
`data/ai-assistant.sqlite` (audit_events / pending_confirmations).

## Runtime constraints

- Node 20+; on THIS machine only Node 26 runs → `better-sqlite3` pinned `^12`.
- Auth: the add-on uses the installation token (`X-Addon-Token`), never an API
  key (`createWorkspaceClockifyClient` must never pass `apiKey`; pinned).
  API-key adapters are dev-script-only.
- `/lifecycle/installed` requires only `authToken`+`workspaceId`.
- Planner: `LLM_MODE=tool` default (JSON fallback; `gemini-cli` has no tools).

## Live testing (opt-in, sacrificial workspace only; gitignored `.env*`)

```bash
LIVE_CLOCKIFY=1 LIVE_CLOCKIFY_API_KEY=… LIVE_WORKSPACE_ID=… npx tsx scripts/live-full.ts   # every action, self-cleaning
LIVE_CLOCKIFY=1 npx tsx scripts/live-sweep.ts                                              # leftover sweep → must report 0
npx tsx --env-file=.env.server scripts/eval-planner.ts --repeat=3                          # planner meter (pass-rate + consistency)
npx tsx --env-file=.env.server scripts/eval-agentic.ts --repeat=3 [--single-turn]          # loop meter (90.5% vs 57.1%)
npx tsx --env-file=.env.server scripts/live-confirm-flow.ts                                # confirm safety over HTTP (PASS=16)
LIVE_CLOCKIFY=1 npx tsx --env-file=.env.server scripts/live-agentic-flow.ts                # loop vs real host (PASS=10)
npx tsx --env-file=.env.server scripts/live-chat-tour.ts                                   # broad dogfood tour
LIVE_CLOCKIFY=1 npx tsx scripts/addon-smoke.ts                                             # prod add-on-token path (needs LIVE_ADDON_TOKEN)
```

Dev workspace: "Marketplace Workspace" `69bda6b317a0c5babe34b4ff`, owner member
id `69bda6b317a0c5babe34b4fe` (use THAT for the user-token exchange, not the
install token's `user` claim). Always finish with the sweep at 0 leftovers.
