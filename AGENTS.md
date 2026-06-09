# AGENTS.md — AI Assistant Add-on

Agent quick-reference. Read `CLAUDE.md` first; it is the source of truth. This
file is the short map.

## What this is

A Clockify add-on: an **admin-only** embedded chat backed by an internal,
MCP-shaped action harness. The model proposes actions; a deterministic harness
validates policy/schema/risk and executes; the backend owns all state. V1 is
implemented and verified (`npm run verify` green, **618 tests**), and the **full
Clockify REST surface parity effort (Phases 0–16) is COMPLETE** — ~115 typed
catalog actions across 16 feature areas + 3 hosts.

**Planner eval + native tool-calling (Phases 1–2, 2026-06-09):** quality is now a
measured number. `scripts/eval-planner.ts` scores the real planner over
`scripts/eval/cases.ts` (pure scorer `src/eval/score.ts`) and reports pass-rate **plus
a consistency metric** (`--repeat=N`). **Phase 2 made native tool-calling the default**
(`LLM_MODE=tool`): the model calls typed tools whose args the provider validates against
JSON schemas generated from the Zod schemas (`src/harness/tools.ts`, `zod-to-json-schema`),
killing the arg-shape-guessing class. The harness still re-validates every call (Zod +
risk/policy) — provider validation is convenience, not the trust boundary; risky still
preview→confirm. Measured on deepseek-v4-pro (repeat=3): tool-calling **95.2% pass / 92.9%
consistency** vs JSON 88.9% / 91.3%. JSON is the fallback (and automatic for `gemini-cli`).
See `CLAUDE.md` → Current Status + `NEXT_SESSION_PLAN.md`.

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

**Live dev hosting:** `scripts/dev-tunnel.sh {up|status|sync|restart|down}` manages
the Cloudflare quick tunnel + server as one unit (writes `BASE_URL`, restarts the
server; `up` is idempotent). The quick-tunnel URL is random per `cloudflared` start —
on a URL change, re-register the manifest in the dev console (restore the session via
`developer.marketplace.cake.com/test-accounts` → "Log in as" John Owner). **To
continue/test in a fresh session, start from `NEXT_SESSION_PROMPT.md`.**

**Planner quirks RESOLVED + proven live (`scripts/live-planner-quirks.ts`, PASS=9):**
(1) one-turn "create a project AND start a timer on it" now attaches the timer —
`clockify_create_work_package` gained `startTimer` (resolves the new project id
server-side) and accepts the shapes the planner actually emits (`startTimer: true`,
flat `projectName`/bare strings, folded by a `z.preprocess`). (2) `clockify_tags_delete`
accepts an exact `name` and resolves it to an id (no `invalid_args` dead-end). The
planner prompt was reworded to match. See `CLAUDE.md` → Current Status.

**Honest state / what's NOT a model problem (see `CLAUDE.md` → "Known limitations & next
steps"):** the planner is never sent action input schemas, so it guesses arg shapes — we
band-aid per action (forgiving Zod + server defaults + name→id). The real next step is
feeding arg schemas/examples to the model (or native tool-calling), NOT swapping the LLM.
Invoice amounts need a workspace-configured invoice item type (Clockify UI only, no API).
Risky-action "Done/Confirmed" hallucinations are neutralized deterministically by the
route (truthful previews). `deepseek-v4-pro` and `gemini-cli` behave alike here.

Pending/deferred: the AUDIT host has **no token claim** (the URL claims are
backendUrl/reportsUrl/locationsUrl/screenshotsUrl/ptoUrl), so it's derived prod-only
(`resolveClockifyAuditBase`); on dev/non-audit environments audit actions now return
a clean "audit log not available" error receipt instead of `fetch failed`. The prod
audit-host X-Addon-Token clearance is still unconfirmed. Phase 17 (raw-API fallback)
is deferred. See `CLAUDE.md` → Current Status.

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
  backend via `LLM_PROVIDER`, `gemini-cli-client.ts`), prompt builder, validated planner (JSON +
  one repair retry).
- `src/harness/` — the safety boundary: `action.ts` (contracts + `defineAction`),
  `actions.ts` (executor + confirm/batch commit), `catalog.ts`, `permissions.ts`,
  `risk.ts`, `receipts.ts`, `confirmations.ts`, `tools.ts` (Zod→JSON-schema tools for
  native tool-calling), `arg-summary.ts`, `compose.ts` (atomic multi-step / rollback),
  `idempotency.ts` (dedup confirmed commits), `undo.ts` (reverse the last creation),
  `workflows/*` (time-tracking, work-structure, admin/risky, resolve).
- `src/routes/` — `lifecycle.ts`, `component.ts`, `api.ts`, shared `deps.ts`.
  `src/server.ts` — `createApp(deps)` + `start()`.
- `src/ui/` — vanilla TS chat UI. `tests/` — unit + integration (fakes via
  `tests/helpers/fake-clockify.ts`). `scripts/` — opt-in live exercisers.

## Runtime constraints

- Node 20+ (this machine: only Node 26 runs → `better-sqlite3` is pinned `^12`).
- Live Clockify is wired via the REST adapter `src/clockify/rest-workspace.ts`
  (the `WorkspaceClient` port over the REST API, `X-Addon-Token` in production).
  The `clockify-sdk-ts-115` wrapper is unbuilt and not on the request path.
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
