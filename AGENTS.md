# AGENTS.md — AI Assistant Add-on

Short map for agents and new contributors. **`CLAUDE.md` is the source of truth** —
read its "Safety & planner invariants" and "Clockify API facts" before touching the
harness or the Clockify adapter. `README.md` is the product overview.

## What this is

A Clockify add-on: an **admin-only** embedded chat backed by an internal,
MCP-shaped action harness. The model proposes named actions; a deterministic
harness validates policy/schema/risk and executes; the backend owns all state and
secrets. `npm run verify` is green at **1467 tests**, 0 circular deps, and a typed
ESLint gate (`no-floating-promises`/`no-misused-promises` as errors). 139 typed
actions, 16 areas, 3 Clockify hosts. Deployed on Railway (volume-backed SQLite at
`/data`; redeploy = `railway up`; see `DEPLOYMENT.md`). Data handling/retention:
`PRIVACY.md`.

## Non-negotiable invariants

- Admin/owner only. Reject non-admins **before** creating a session.
- Per-admin, per-workspace policy; default full `read_write`; admins manage only
  their own policy.
- Safe writes (reads/creates) execute immediately with a receipt. **Editing
  existing data and every risky write require a dry-run preview + button-only
  confirmation.** Typed "yes" never executes.
- `Confirm all` applies only to the exact stored batch; partial failure is never
  hidden.
- Confirmation is one-use, time-limited (5 min), bound to
  session/workspace/admin + a salted nonce hash + operation hash; policy is
  re-checked at confirm time.
- The model never receives Clockify tokens, add-on tokens, session secrets, the
  model API key, or raw headers. Never log tokens/headers. Tokens are encrypted at
  rest (AES-256-GCM).
- The REST adapter does **I/O only** — no risk/policy/confirmation logic; that
  stays in `src/harness/*`. Secrets never enter a `ConfirmableOperation.payload`.
- Resolve identity (names/numbers → ids, incl. archived) and calendar dates
  server-side, at preview time — never trust model-supplied ids or dates.
- Don't add React/Next/Prisma/Redis/queues/vector DBs. Don't modify sibling repos.
- Verify Clockify behavior against the OpenAPI spec + a live probe, not the code —
  this codebase's API assumptions have repeatedly been wrong. TDD: failing test
  first.

## Commands

```bash
npm install
npm run type-check    # tsc --noEmit
npm test              # vitest run (fakes only, no network)
npm run build         # -> dist/server, dist/ui
npm run lint          # eslint src (typed async-safety rules)
npm run verify        # type-check + lint + cycles + test + build (the gate)
npm run dev           # tsx src/server.ts (needs env)
```

## Layout

- `src/config.ts` — env config (Zod). `src/db/` — SQLite schema; `store.ts` is a
  thin facade composing per-concern builders in `store/` (sessions, confirmations,
  idempotency ledger, undo, audit/metrics, telemetry, installations, retention +
  AES-256-GCM token encryption). `src/auth/` — admin role check, signed session cookie.
- `src/addon/` — manifest + Clockify token verification (RS256, one platform key
  built in).
- `src/clockify/` — `client.ts` (the `WorkspaceClient` port, the seam),
  `rest-workspace.ts` (live REST adapter, `X-Addon-Token`; I/O only; per-area
  `rest/*` over `rest/core.ts`, shared date normalization in `rest/wire-dates.ts`),
  `api-base.ts` (hosts from the install token claims).
- `src/assistant/` — model client (OpenAI-compatible HTTP or `gemini-cli`), prompt
  builder, planner (native tool-calling default, JSON fallback),
  `agent-loop.ts`/`agent-state.ts` (durable agentic loop; stops on client
  disconnect).
- `src/harness/` — the safety boundary: `action.ts` (contracts +
  `defineRiskyAction`/`defineReadAction`), `actions.ts` (executor +
  `commitConfirmedOperation`), `catalog.ts`, `permissions.ts`, `risk.ts`,
  `receipts.ts`, `confirmations.ts`, `tools.ts`, `tool-select.ts` (deterministic
  tool subsetting — the model sees only the message-relevant actions + a core, on the
  chat turn and its resume; **default ON** via `LLM_TOOL_SELECT`, `=0` rolls back),
  `compose.ts` (atomic multi-step/rollback), `idempotency.ts` (dedup confirmed
  commits), `undo.ts`, `money.ts` (the one major↔minor mapping, both ways —
  `toMinor`/`fromMinor`), `workflows/*` — name→id/date resolution split across
  `resolve.ts` (entities), `resolve-dates.ts` (calendar + `resolveDateRange`),
  `preview-patch.ts`, all re-exported via `resolve.ts`; plus shared
  `resolveScopeRefs`, `clarifyResult` (`action.ts`), and the `rate.ts`
  rate-preview builder.
- `src/routes/` — `lifecycle.ts`, `component.ts`, `api.ts` (the route handlers for
  chat + stream + confirm + undo + metrics + new chat + history switcher). The
  turn/confirm/commit machinery lives in `chat-pipeline.ts` (`createChatPipeline`),
  pure result transforms + guards in `chat-results.ts`, the never-break-a-turn
  bookkeeping wrapper `best-effort.ts`, NDJSON-stream setup `ndjson.ts`; shared
  `deps.ts`. `server.ts` — `createApp(deps)` + `start()`.
- `src/ui/` — vanilla TS chat UI (a11y; "New chat" + "Chats ▾" history dropdown);
  HTTP/NDJSON client in `api-client.ts`, composer/stream flows in
  `composer-flow.ts`, rendering in `render.ts`/`shared.ts`, `main.ts` keeps
  `mount()` + a re-export barrel.
  `tests/` — unit + integration (fakes via `tests/helpers/fake-clockify.ts`;
  `tests/helpers/session.ts` mints an admin cookie in-process). `scripts/` — opt-in
  live exercisers (sacrificial workspace only).

## Live request-shape gotchas (encoded in the adapter + unit tests)

- `GET /webhooks` → `{workspaceWebhookCount, webhooks:[…]}`; `GET /expenses` →
  `{expenses:{expenses:[…],count}, …}` — both envelopes, not arrays.
- Time-entry update is GET-then-PUT (PUT replaces and requires `start`).
- Invoice `issuedDate`/`dueDate` and expense `date` need full ISO datetimes.
- Expense create/update is `multipart/form-data` and requires `userId`.
- Webhook create requires `webhookEvent` + HTTPS url + a trigger source.
- A task delete is **project-scoped**: `deleteEntity` for a `task` needs its
  `projectId` (it routes to the typed `deleteTask`), so an undo of a created task
  carries `projectId` on the `EntityRef`.
- Full set + the money/rate/scoping subtleties: `CLAUDE.md` → "Clockify API facts".
