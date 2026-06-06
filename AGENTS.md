# AGENTS.md — AI Assistant Add-on

Agent quick-reference. Read `CLAUDE.md` first; it is the source of truth. This
file is the short map.

## What this is

A Clockify add-on: an **admin-only** embedded chat backed by an internal,
MCP-shaped action harness. The model proposes actions; a deterministic harness
validates policy/schema/risk and executes; the backend owns all state. V1 is
implemented and verified (`npm run verify` green, 156 tests), and every existing
catalog action is wired to live Clockify (`scripts/live-full.ts` → PASS=28,
FAIL=0; `scripts/live-sweep.ts` → 0 leftovers).

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
- `src/assistant/` — model client, prompt builder, validated planner (JSON +
  one repair retry).
- `src/harness/` — the safety boundary: `action.ts` (contracts + `defineAction`),
  `actions.ts` (executor + confirm/batch commit), `catalog.ts`, `permissions.ts`,
  `risk.ts`, `receipts.ts`, `confirmations.ts`, `workflows/*` (time-tracking,
  work-structure, admin/risky, resolve).
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

## Next effort

Full Clockify REST surface parity with `addons-me/goclmcp` (~156 ops), one
feature area per branch — see `slopbranch:API_COVERAGE_PLAN.md`. The full design
doc set (`PRD, SPEC, ARCHITECTURE, DATA_MODEL, SAFETY_AND_PERMISSIONS,
IMPLEMENTATION_PLAN(+_DETAILED), TESTING_AND_ACCEPTANCE, REFERENCES`) lives on
`slopbranch`.
