# AGENTS.md — AI Assistant Add-on

Agent quick-reference. Read `CLAUDE.md` first; it is the source of truth. This
file is the short map. Handoff journals: `docs/HISTORY.md`.

> **Taking over?** Read **`CLAUDE.md` → "Current state"** first — everything
> buildable is DONE; only human-gated launch items remain.

## What this is

A Clockify add-on: an **admin-only** embedded chat backed by an internal,
MCP-shaped action harness. The model proposes actions; a deterministic harness
validates policy/schema/risk and executes; the backend owns all state. `npm run
verify` is green at **1095 tests**, 0 circular deps. Done + on `main`:
- **Full Clockify REST parity** (137 typed catalog actions, 16 areas, 3 hosts).
- **"Trust lives in the code" roadmap** (eval harness; native tool-calling default;
  atomic composition; grounding; idempotency+undo; curated actions; metrics; a11y;
  NDJSON streaming).
- **Durable approval-gated agentic loop, default ON** (`LLM_AGENTIC`, `=0` rolls
  back): reads + safe-writes auto-chain; a risky write interrupts → button-confirm →
  durable **resume** across the HTTP round-trip (the confirm streams the resume so the
  button never blocks). `src/assistant/agent-loop.ts` + `agent-state.ts`.
- **Backend-agnostic model client, measured at 100%** (2026-06-13): planner eval
  162/162 on DeepSeek v4-pro AND 108/108 on gemini-3.1-flash-lite(low) AND
  gemini-3.5-flash(low); agentic eval 7/7 on all three, 0 safety violations. The
  client speaks Gemini 3.x (per-tool-call `thought_signature` echo on
  continuations, `LLM_REASONING_EFFORT`) — both inert for DeepSeek, pinned. A
  backend swap is env-only (`LLM_MODEL` + `LLM_REASONING_EFFORT`); prod stays
  DeepSeek until the user decides.
- **Ground-truth adapter audit + the 322-prompt live-loop fix arc** — every wire
  shape and every loop failure closed (name→id resolution incl. archived,
  server-side dates incl. forward ranges, bounded model input, audit-log recaps,
  typed-consent guard, preview-time platform restrictions), then re-verified live
  in the embedded chat. `CLAUDE.md` → "Safety & planner invariants" +
  "Clockify API facts"; journals in `docs/HISTORY.md`.

**Ground truth, not the code:** this codebase was built fast and its Clockify-API
assumptions have repeatedly been WRONG (invoice item types, instant formats, host
routing). Before trusting/extending any Clockify code, verify against the **OpenAPI
spec** (`https://docs.clockify.me/openapi.json`), the read-only sibling refs
(`../goclmcp`, `../clockify-ts-sdk`), and a **live probe** on a sacrificial workspace.
See `CLAUDE.md` → "Ground truth & verification discipline."

**DEPLOYED on Railway** (2026-06-12, `https://ai-assistant-production-c2e6.up.railway.app`,
SQLite on a `/data` volume) and installed + working in Clockify — stable hosting is
SOLVED. What remains is human-gated (prod security review + token rotation, prod
AUDIT-host clearance) — `CLAUDE.md` → "Current state"; deploy checklist in
`DEPLOYMENT.md`.

**Live end-to-end PROVEN (2026-06-08):** installed on a real Clockify dev
workspace and driven through the embedded chat — sidebar component → DeepSeek →
harness → Clockify dev host (`X-Addon-Token`) → receipt (created a tag, fetched a
detailed report). Key facts that made it work, all in `CLAUDE.md`:
- The token-signing **public key is one fixed platform key**, embedded as the
  built-in default (`src/addon/clockify-public-key.ts`); the env var is optional.
- The component is a **`sidebar`** entry with an `iconPath` (`/icon.svg`).
- **Call hosts from the install context**, never hardcoded: api = `apiUrl`+`/v1`,
  reports = `reportsUrl` claim+`/v1` (`src/clockify/api-base.ts`, captured at
  component load). The lifecycle token omits these claims; the user token has them.
- Session cookie is `SameSite=None; Secure; Partitioned` (cross-site iframe).
- The chat route guards async errors → failed action = error receipt, no crash.

The risky-write **button-confirm safety flow is now also proven live** over HTTP
(`scripts/live-confirm-flow.ts`, `PASS=16`): preview-not-execute, typed-"yes"
no-op, wrong/cross-batch/replayed nonce rejected, one-shot execute, policy
re-checked at confirm. The embedded chat was also exercised live (reads,
permissions, safe write, risky write, audit clean-error — all good).

**Hosting:** prod runs on Railway (above) — the tunnel is LOCAL DEV ONLY.
`scripts/dev-tunnel.sh {up|status|sync|restart|down}` manages the Cloudflare quick
tunnel + server as one unit (writes `BASE_URL`, restarts the server; `up` is
idempotent, prefer `sync` — `restart` ROTATES the URL). On a URL change, re-register
the manifest in the dev console (restore the session via
`developer.marketplace.cake.com/test-accounts` → "Log in as" John Owner). **To
continue/test in a fresh session, start from `NEXT_SESSION_PROMPT.md`.**

**Planner quirks RESOLVED + proven live (`scripts/live-planner-quirks.ts`, PASS=9):**
(1) one-turn "create a project AND start a timer on it" now attaches the timer —
`clockify_create_work_package` gained `startTimer` (resolves the new project id
server-side) and accepts the shapes the planner actually emits (`startTimer: true`,
flat `projectName`/bare strings, folded by a `z.preprocess`). (2) `clockify_tags_delete`
accepts an exact `name` and resolves it to an id (no `invalid_args` dead-end). The
planner prompt was reworded to match. See `CLAUDE.md` → "Current state".

**Honest state / what's NOT a model problem:** native tool-calling is the default
(`LLM_MODE=tool`) — the provider validates args against schemas generated from the
SAME Zod the harness re-validates with, so arg-shape guessing is gone; identity
(names/numbers→ids, incl. archived) and calendar math resolve server-side at
preview. Invoice amounts still need a workspace-configured invoice item type
(Clockify UI only, no API — surfaced in the preview). Risky-action
"Done/Confirmed" hallucinations are neutralized deterministically (truthful
previews + boilerplate filtered from model-visible history); a typed "yes" at a
pending preview never reaches the planner. Swapping the LLM fixes none of the
remaining platform constraints.

Pending/deferred: the AUDIT host has **no token claim** (the URL claims are
backendUrl/reportsUrl/locationsUrl/screenshotsUrl/ptoUrl), so it's derived prod-only
(`resolveClockifyAuditBase`); on dev/non-audit environments audit actions now return
a clean "audit log not available" error receipt instead of `fetch failed`. The prod
audit-host X-Addon-Token clearance is still unconfirmed. Phase 17 (raw-API fallback)
is deferred. See `CLAUDE.md` → "Current state".

## Non-negotiable invariants

- Admin/owner only. Reject non-admins **before** creating a session.
- Per-admin, per-workspace policy; default full `read_write`; admins manage only
  their own policy.
- Safe writes execute immediately with a receipt. **Risky writes require a
  dry-run preview + button-only confirmation.** Typed "yes" never executes.
- `Confirm all` applies only to the exact stored batch; partial failure is never
  hidden.
- Confirmation is one-use, time-limited (5 min), bound to session/workspace/admin
  + a salted nonce hash + operation hash; policy is re-checked at confirm time.
- The model never receives Clockify tokens, add-on tokens, session secrets, the
  model API key, or raw headers. Never log tokens/headers. Tokens are encrypted
  at rest (AES-256-GCM).
- The REST adapter does **I/O only** — no risk/policy/confirmation logic; that
  stays in `src/harness/*`. Secrets never enter a `ConfirmableOperation.payload`
  (it is persisted to the DB + audit log).
- Don't add React/Next/Prisma/Redis/queues/vector DBs. Don't modify sibling repos.

## Commands

```bash
npm install
npm run type-check    # tsc --noEmit
npm test              # vitest run (fakes only, no network)
npm run build         # -> dist/server, dist/ui
npm run verify        # type-check + test + build (the gate)
npm run dev           # tsx src/server.ts (needs env)
```

## Layout

- `src/config.ts` — env config (Zod). `src/db/` — SQLite schema, store (single DB
  module), token encryption.
- `src/auth/` — admin role check, signed session cookie. `src/addon/` — manifest,
  Clockify token verification.
- `src/clockify/client.ts` — the Clockify `WorkspaceClient` port (the seam).
  `src/clockify/rest-workspace.ts` — the live REST adapter (`X-Addon-Token` or
  API-key auth); I/O only.
- `src/assistant/` — model client (HTTP OpenAI-compatible **or** the `gemini-cli`
  backend via `LLM_PROVIDER`; handles Gemini 3.x `thought_signature` +
  `LLM_REASONING_EFFORT`, both inert elsewhere), prompt builder, planner (native
  tool-calling default, JSON + one repair retry as fallback),
  `agent-loop.ts`/`agent-state.ts` (durable agentic loop).
- `src/harness/` — the safety boundary: `action.ts` (contracts + `defineAction`),
  `actions.ts` (executor + confirm/batch commit), `catalog.ts`, `permissions.ts`,
  `risk.ts`, `receipts.ts`, `confirmations.ts`, `tools.ts` (Zod→JSON-schema tools for
  native tool-calling), `arg-summary.ts`, `compose.ts` (atomic multi-step / rollback),
  `idempotency.ts` (dedup confirmed commits), `undo.ts` (reverse the last creation),
  `money.ts` (the one major↔minor amount mapping), `workflows/*` (time-tracking,
  work-structure, admin/risky, resolve). Shared day-spans: `src/durations.ts`.
- `src/routes/` — `lifecycle.ts`, `component.ts`, `api.ts`, shared `deps.ts`.
  `src/server.ts` — `createApp(deps)` + `start()`.
- `src/ui/` — vanilla TS chat UI. `tests/` — unit + integration (fakes via
  `tests/helpers/fake-clockify.ts`). `scripts/` — opt-in live exercisers.

## Runtime constraints

- Node 20+ (this machine: only Node 26 runs → `better-sqlite3` is pinned `^12`).
- Live Clockify is wired via the REST adapter `src/clockify/rest-workspace.ts`
  (the `WorkspaceClient` port over the REST API, `X-Addon-Token` in production).
  Tests use the fake. Live checks are opt-in against a sacrificial workspace:
  `scripts/live-full.ts` (exhaustive, API key), `scripts/live-sweep.ts` (cleanup),
  `scripts/live-smoke.ts` (small), `scripts/addon-smoke.ts` (production add-on
  token), `scripts/chat-smoke.ts` (live model). See `CLAUDE.md` → Live Testing.

## Live request-shape gotchas (encoded in the adapter + unit tests)

- `GET /webhooks` → `{workspaceWebhookCount, webhooks:[…]}`; `GET /expenses` →
  `{expenses:{expenses:[…],count}, …}` — both are envelopes, not arrays.
- Time-entry update is GET-then-PUT (PUT replaces and requires `start`).
- Invoice `issuedDate`/`dueDate` and expense `date` need full ISO datetimes.
- Expense create/update is `multipart/form-data` and requires `userId`.
- Webhook create requires `webhookEvent` + HTTPS url + a trigger source
  (defaults to the workspace).

## Status: REST parity COMPLETE

The full Clockify REST surface parity effort (Phases 0–16 of
`slopbranch:API_COVERAGE_PLAN.md`) is done and merged to local `main`. Below is
the original framing, kept for context.

Full Clockify REST surface parity with `addons-me/goclmcp` (~156 ops), one
feature area per branch — see `slopbranch:API_COVERAGE_PLAN.md`. The full design
doc set (`PRD, SPEC, ARCHITECTURE, DATA_MODEL, SAFETY_AND_PERMISSIONS,
IMPLEMENTATION_PLAN(+_DETAILED), TESTING_AND_ACCEPTANCE, REFERENCES`) lives on
`slopbranch`.
