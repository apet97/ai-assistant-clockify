# AGENTS.md — AI Assistant Add-on

Short map for agents and new contributors. **`CLAUDE.md` is the source of truth** —
read its "Safety & planner invariants" and "Clockify API facts" before touching the
harness or the Clockify adapter. `README.md` is the product overview.

## What this is

A Clockify add-on: an **admin-only** embedded chat backed by an internal,
MCP-shaped action harness. The model proposes named actions; a deterministic
harness validates policy/schema/risk and executes; the backend owns all state and
secrets. `npm run verify` runs both TypeScript projects, zero-warning typed ESLint,
the full test/build suite, and circular-dependency/duplication gates. 139 typed
actions, 16 areas, 3 Clockify hosts. Deployed on Railway (volume-backed SQLite at
`/data`; redeploy = `railway up`; see `DEPLOYMENT.md`). Data handling/retention:
`PRIVACY.md`.

## Non-negotiable invariants

- Admin/owner only. Reject non-admins **before** creating a session.
- Per-admin, per-workspace policy; genuinely new admins default to full
  `read_write`, while groups missing from an existing policy migrate to `off`.
  Admins manage only their own policy.
- Safe writes (reads/creates) execute immediately with a receipt. **Editing
  existing data and every risky write require a dry-run preview + button-only
  confirmation.** Typed "yes" never executes.
- `Confirm all` applies only to the exact stored batch; partial failure is never
  hidden.
- Confirmation is one-use, time-limited (5 min), bound to
  session/workspace/admin + a salted nonce hash + operation hash; policy is
  re-checked at confirm time.
- Every mutation/confirmation/undo performs a fresh role check and fails closed;
  Clockify host writes are single-flight per workspace and are never auto-retried.
- Client cancellation can stop model work or a not-yet-dispatched action, never a
  Clockify mutation after dispatch. Per-session FIFO locks cover route settlement
  and skip disconnected queued requests.
- The model never receives Clockify tokens, add-on tokens, session secrets, the
  model API key, or raw headers. Never log tokens/headers. Tokens are encrypted at
  rest (AES-256-GCM).
- The REST adapter does **I/O only** — no risk/policy/confirmation logic; that
  stays in `src/harness/*`. Secrets never enter a `ConfirmableOperation.payload`.
- Resolve identity (names/numbers → ids, incl. archived) and calendar dates
  server-side, at preview time — never trust model-supplied ids or dates.
- Every public Clockify list/search port returns exact
  `ListResult<T> = { rows, truncated }`. Every list/search receipt includes
  `truncated`; `true` adds `list_truncated`. A truncated scan cannot prove
  absence or uniqueness — require an exact id or narrower filter.
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
  idempotency ledger, undo, audit/metrics, telemetry, durable turn/operation
  journals, canonical action results + ordered replay/history links, short-lived
  artifacts, installations, batched retention + AES-256-GCM token
  encryption/rotation). Full outcomes live only in `action_results`; linked
  summaries are capped at 65,536 bytes. `src/auth/` — admin role check, CSRF,
  signed session cookie.
- `src/addon/` — manifest + Clockify token verification (RS256, one platform key
  built in).
- `src/clockify/` — `client.ts` (the `WorkspaceClient` port, the seam),
  `rest-workspace.ts` (live REST adapter, `X-Addon-Token`; I/O only; per-area
  `rest/*` over `rest/core.ts`; plain/envelope/POST pagination preserves
  `ListResult.truncated`, with shared bounded-page collection in
  `rest/list-pages.ts`; `core.mutate` is the exactly-one-external-mutation
  primitive used by durable workflow steps; shared date normalization in
  `rest/wire-dates.ts`),
  `api-base.ts` (hosts from the install token claims), `service-url.ts` (strict
  Clockify-origin validation), `request-governor.ts` (per-workspace rate,
  concurrency, write, and per-turn host-call bounds).
- `src/assistant/` — model client (OpenAI-compatible HTTP or `gemini-cli`), prompt
  builder, planner (native tool-calling default, JSON fallback),
  `agent-loop.ts`/`agent-state.ts` (durable agentic loop; provider cancellation and
  bounded selection context survive clarification/confirm resume).
- `src/harness/` — the safety boundary: `action.ts` (contracts +
  `defineRiskyAction`/`defineReadAction`), `actions.ts` (executor +
  `commitConfirmedOperation`), `catalog.ts`, `permissions.ts`, `risk.ts`,
  `receipts.ts` (`listReceipt` is the list/search receipt choke point),
  `confirmations.ts`, `tools.ts`, `tool-select.ts` (deterministic
  tool subsetting on chat + resume; no match/non-ASCII/>3 areas fail open to the
  full catalog; **default ON** via `LLM_TOOL_SELECT`, `=0` rolls back),
  `mutation-workflow.ts` (operation-scoped prepared→executing→terminal primary
  and compensation steps; ambiguity stops later dispatch),
  `durable-safe-write.ts` (the real step-journaled safe-write builder),
  `mutation-compatibility.ts` (explicit phase 4/5
  migration exceptions), `compose.ts` (legacy atomic multi-step/rollback),
  `idempotency.ts` (dedup confirmed commits, including partial replay), `undo.ts`,
  `money.ts` (the one major↔minor mapping, both ways —
  `toMinor`/`fromMinor`), `workflows/*` — name→id/date resolution split across
  `resolve.ts` (entities), `resolve-dates.ts` (calendar + `resolveDateRange`),
  `preview-patch.ts`, all re-exported via `resolve.ts`; plus shared
  `resolveScopeRefs`, `clarifyResult` (`action.ts`), and the `rate.ts`
  rate-preview builder.
- `src/routes/` — `lifecycle.ts`, `component.ts`, `api.ts` (the route handlers for
  chat + stream + confirm + undo + metrics + new chat + history switcher). The
  turn/confirm/commit machinery lives in `chat-pipeline.ts` (`createChatPipeline`),
  pure result transforms + guards in `chat-results.ts`, the never-break-a-turn
  bookkeeping wrapper `best-effort.ts`, session FIFO wrapper in `async-handler.ts`,
  NDJSON-stream setup `ndjson.ts`; shared `deps.ts`. Chat mutations require a client UUID `requestId`; retries replay the
  durable turn from nonce-free result/preview links (only a still-pending preview
  gets a freshly rotated nonce). Terminal confirmations scrub their nonce hash,
  saved agent state, and operation payload. `server.ts` — `createApp(deps)` + `start()`; `/live` is liveness and
  `/health` performs a committed readiness probe.
- `src/ui/` — vanilla TS chat UI (a11y; "New chat" + "Chats ▾" history dropdown);
  HTTP/NDJSON client in `api-client.ts`, composer/stream flows in
  `composer-flow.ts`, rendering in `render.ts`/`shared.ts`, `main.ts` keeps
  `mount()` + a re-export barrel.
  `tests/` — unit + integration (fakes via `tests/helpers/fake-clockify.ts`;
  `tests/helpers/session.ts` mints an admin cookie in-process). `scripts/` — opt-in
  live exercisers (sacrificial workspace only) plus checksum-verified
  `backup-db.ts`/`restore-db.ts` recovery tooling.

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
- Time-off request create is **policy-unit-specific**: a DAYS policy wants bare
  `YYYY-MM-DD` + `period.days`; an HOURS policy wants full ISO datetime
  `period.{start,end}` with **no `days`** (the DAYS body 400s on an HOURS policy).
- Client CREATE silently drops `ccEmails`/`currencyId` (adapter applies them via a
  follow-up PUT); scheduling `publish` is range-scoped, with an optional
  `userFilter` to narrow it to one user.
- Full set + the money/rate/scoping subtleties: `CLAUDE.md` → "Clockify API facts".
