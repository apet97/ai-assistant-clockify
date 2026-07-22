# AI Assistant for Clockify

An **admin-only** AI assistant embedded inside Clockify. Workspace admins ask for
Clockify work in plain language; the model proposes actions, and a deterministic
**action harness** validates every proposal against per-admin permissions and a
risk policy before anything touches Clockify.

The model never executes anything itself and never sees a secret. It can only
*suggest* named actions from a fixed catalog — the backend decides what (if
anything) runs.

Version 1.0.0 materials describe the historical v1 private-production,
pre-Marketplace release candidate; Marketplace submission did not occur. The
exact-run record in
[`docs/marketplace/evidence/release-candidate.md`](./docs/marketplace/evidence/release-candidate.md)
is v1 rollback/history context only, using
[`MARKETPLACE_READINESS.md`](./MARKETPLACE_READINESS.md) for its historical
acceptance criteria. It cannot establish a v2 conclusion.

The accepted architecture for the future atomic API agent is
[`ADR 001`](./docs/adr/001-api-agent-v2.md). It is an architecture contract, not
evidence that v2 code, release evidence, or deployment exists. V1 remains the
default while v2 is built beside it under `src/assistant-v2/`.
During coexistence, v1 accepts only critical safety, production, and verified Clockify-contract fixes.

The interface and workspace-data criterion is: **English interface; Unicode workspace
data; timezone-aware Intl formatting**.

## Highlights

- **Admin/owner only.** Non-admins are rejected before a session is ever created.
- **Per-admin, per-workspace permissions.** Default is full `read_write` for every
  feature group; each admin manages only their own policy, from inside the chat.
- **Safe writes execute immediately** and return a structured receipt.
- **List completeness is explicit.** Every Clockify list/search receipt carries
  `truncated`; incomplete results add `list_truncated`, and the harness never
  treats a truncated scan as proof that a name is unique or absent.
- **Risky writes require a dry-run preview + a button confirmation.** Typed text
  such as "yes" never executes a risky action. `Confirm all` applies only to the
  exact previewed batch.
- **One-use, time-limited confirmations** (5 min) bound to session + workspace +
  admin, a salted nonce hash, and an operation hash. Policy is re-checked at
  confirm time.
- **Durable, nonce-free retries.** Each executed action has one canonical result;
  chat/history/audit/retry records link to it. A duplicate request hydrates those
  links and rotates a fresh nonce only for a preview that is still pending.
- **The model receives no secrets** — never Clockify tokens, add-on tokens,
  session secrets, the model API key, or raw headers. Tokens are encrypted at
  rest (AES-256-GCM). Clockify-sourced text is treated as untrusted data, not
  instructions.

## How it works

```
Clockify (admin component)
        │  add-on token (X-Addon-Token)
        ▼
Express backend ── session (signed cookie) ── SQLite (policy, installs, confirmations)
        │
        ├─ assistant/   model client + prompt builder + planner (native tool-calling by
        │               default; provider-validated args; JSON + 1 repair as fallback)
        │
        └─ harness/     the safety boundary:
                        catalog · permissions · risk · receipts · confirmations
                        └─ executes validated actions via the Clockify WorkspaceClient port
```

The model only ever sees the action catalog and the current policy. A proposed
plan is schema-validated, permission-checked, and risk-classified. Safe actions
run and return a receipt; risky actions return a preview that the UI confirms
with a button.

### Beyond the basics

The harness pushes every correctness decision into deterministic code so the model
stays a thin, replaceable translator:

- **Native tool-calling** (default): each action is a typed tool whose arguments the
  provider validates against a JSON Schema generated from the same Zod schema the
  harness validates with — so the model stops inventing argument shapes. Unknown
  nested fields are rejected unless that exact dynamic-record path is declared open.
  The intent, Zod, risk, and policy gates remain the server-side trust boundary
  (provider validation is only a convenience).
  Returned tool names are also checked against the exact tools offered in that
  request; an unoffered tool is a terminal provider-protocol error.
- **Server-verified write intent**: before Clockify results reach the main planner,
  an isolated declaration pass cites an exact quote, named admin-authored
  segment, and zero-based occurrence. The server computes UTF-8 spans and binds structured
  literals to catalog-hashed action/path/value aliases. Missing, ambiguous,
  invented, or opposite-polarity evidence denies writes without removing reads.
- **A durable, approval-gated agentic loop** (default on): reads and safe writes
  auto-chain with their receipts fed back to the model; the first risky write
  interrupts into the preview → button-confirm flow, and the confirmed receipt
  resumes the loop across the HTTP round-trip — it can chain another preview, never
  commit inline.
- **Recall-safe tool selection** (default on): focused ASCII requests see a small
  relevant tool set; no match, non-ASCII, or more than three areas fail open to the
  full catalog. Clarification context survives terse follow-ups and confirm resumes.
- **Durable multi-step composition** — every host step is journaled. A definitive
  failure after a known effect is reported as partial; an ambiguous effect stops
  later dispatches. Eligible compensation is best-effort, not a global rollback
  guarantee.
- **Scoped idempotency** — exact operation replay is safe. Semantic deduplication
  is limited to the documented setup actions; invoice safety is based on the
  persisted operation journal and reconciliation evidence, not payload equality.
- **Scoped undo** — an eligible recent creation can expose a one-click Undo action.
  Its compensation is separately journaled and may fail or remain unknown.
- **Constraint surfacing** — known platform limits (e.g. an invoice needing a configured
  item type) are shown *in the preview*, so a surprising outcome never happens after
  confirm; clarifications offer concrete options, never "give me the ID".
- **Curated intent actions** — high-level jobs (`period_report`, `onboard_user`) the model
  reaches for instead of scrambling across the 140-action catalog.
- **Operational metrics** (`GET /api/metrics`, including per-turn token/latency
  telemetry) and **eval harnesses** (`scripts/eval-planner.ts`,
  `scripts/eval-agentic.ts`) that score planner accuracy, write safety, latency,
  cache-hit tokens, and run-to-run consistency. Historical v1 release evidence
  binds the configured DeepSeek result to its exact v1 candidate; it is not valid
  for a v2 conclusion or a substitute for fresh v2 evidence.
- **Historical v1 DeepSeek release configuration on an OpenAI-compatible client** —
  the version 1.0.0 v1 release kept DeepSeek through `LLM_BASE_URL`/`LLM_MODEL`; provider quirks
  (DeepSeek `reasoning_content` and optional `thinking`, Gemini 3.x
  `thought_signature`, and `reasoning_effort`) are handled in one place and inert
  elsewhere. Backend configurability remains available to self-hosters, but version
  1.0.0 includes no provider migration and requires fresh safety evidence after any
  provider change.
- **Full-path DeepSeek release gate** — each candidate reasoning setting must pass
  12 cases across five ordered cohorts (60 runs), including a provider-facing
  declaration → immutable capability → filtered tools → raw authority match →
  exactly-one fake mutation path. Release evidence also records cache-hit tokens
  and fails closed on any missing cohort or write-safety regression.
- **Streaming** — `POST /api/chat/stream` streams the harness's results as they execute
  (never the model's narration, which would conflict with the safety override).

## Tech stack

TypeScript · Express · vanilla Vite UI · SQLite (`better-sqlite3`) · Zod ·
Vitest · Supertest. No React/Next/Prisma/Redis/queues — kept deliberately small.

## Project structure

```
src/
  config.ts            env config (Zod-validated)
  db/                  SQLite schema, store, token encryption
  auth/                admin role check, signed session cookie
  addon/               manifest + Clockify token verification
  clockify/            WorkspaceClient port + REST adapter (X-Addon-Token)
  assistant/           model client, prompt/tool builder, planner (tool-calling + JSON)
  harness/             action contracts, executor, catalog, permissions, risk,
                       receipts, confirmations, tools, arg-summary, compose,
                       idempotency, undo, workflows/*
  eval/                pure planner scorer (the meter)
  metrics/             operational metrics aggregation
  routes/              lifecycle, component, api (+ chat/stream, undo, metrics)
  server.ts            createApp(deps) + start()
  ui/                  vanilla TS chat UI (a11y + streaming)
tests/                 unit + integration (fakes only, no network)
scripts/               opt-in live smokes (sacrificial workspace)
```

## Getting started

Requires Node 22.x (matches `package.json` `engines` and the Railway runtime).

```bash
npm install
cp .env.example .env     # then fill in real values
```

### Verify, build, run

```bash
npm run type-check       # tsc --noEmit
npm test                 # build exact server + served UI artifact, then Vitest; no unmocked network
npm run build            # -> dist/server, dist/ui
npm run lint             # eslint src (typed async-safety rules)
npm run verify           # both type-checks + lint + cycles + duplication + test/build
npm run test:e2e         # Chromium + Firefox + WebKit product/browser matrix
npm run dev              # tsx src/server.ts (needs .env)
```

CI runs the production audit/license policy, `npm run verify`, browser E2E,
dependency review, secret scan, and CodeQL. Production deploys to Railway with
SQLite on a persistent volume. Deployment is deliberately not a one-line quick
start: follow the backup/restore and exact-source checked transaction in
[`DEPLOYMENT.md`](./DEPLOYMENT.md); never run a bare `railway up` from a mutable
working tree.

`GET /manifest` serves the admin-only Clockify add-on manifest - a **sidebar**
component (`/component/assistant`) plus an add-on icon at `/icon.svg`. Current
private-deployment and live-flow status belongs in the exact-run evidence record;
an older dev run or a prose claim is not release evidence.

### Environment

See [`.env.example`](./.env.example) for the full list. Key variables: `PORT`,
`BASE_URL`, `CLOCKIFY_ADDON_KEY`, `SESSION_SECRET`, `DATA_ENCRYPTION_KEY`
(32-byte key for token encryption), `DATABASE_PATH`, and `LLM_BASE_URL` /
`LLM_API_KEY` / `LLM_MODEL` for the OpenAI-compatible model endpoint.
The v1 DeepSeek V4 runtime keeps HTTP tool mode with `LLM_AGENTIC=1`,
`LLM_TOOL_SELECT=1`, and the thinking setting selected by the historical final-source
`deepseek-release-binding.json`. Set `LLM_THINKING_MODE=disabled` exactly when
that binding reports `modelConfiguration.thinkingMode: "disabled"`; otherwise
leave it absent. The five-run safety, latency, and cache comparison is
machine-bound and fail-closed for v1 only; historical context is in
[`evidence/performance/deepseek-v4-pro-2026-07-18.md`](./evidence/performance/deepseek-v4-pro-2026-07-18.md).
`CLOCKIFY_ADDON_PUBLIC_KEY_PEM` is **optional** — Clockify's fixed platform
token-signing key is built in; only set it to target a non-production Clockify
environment. The Clockify API/reports hosts are read from the install token (never
hardcoded), so the add-on works across dev/regional environments unchanged.

## Live testing (opt-in)

Tests run entirely against fakes by default — no network, no credentials. Live
checks are opt-in and **must target a throwaway workspace**. They are gated by
env (`LIVE_CLOCKIFY=1`, plus the relevant tokens/IDs):

- `scripts/live-full.ts` — exhaustive, self-cleaning exerciser: runs every
  typed action against a throwaway workspace and cleans up after itself.
- `scripts/live-sweep.ts` — leftover sweep; **must end at 0 leftovers** before
  any run is considered clean.
- `scripts/live-smoke.ts` — drives the real harness (read + safe write + risky
  preview→confirm→commit) via a personal-API-key adapter; self-cleaning.
- `scripts/live-scope-probe.ts` and `scripts/host-auth-spike.ts` — secret-free,
  release-bound production add-on-token aggregate scope reachability and explicit
  AUDIT-host clearance probes. The scope result does not claim per-scope necessity.
  Deploy the exact candidate, freshly reinstall it, then run
  `scripts/capture-addon-token.ts` to copy the encrypted
  installation token from the store into the gitignored `.env` as
  `LIVE_ADDON_TOKEN` (the token is never printed, only its length). The probe fetches
  and remotely verifies the server-minted fresh-install envelope; no operator-authored
  install-event JSON is accepted.
- `scripts/chat-smoke.ts` — live model round-trip (the model is sent only the
  action catalog + policy, never a token).

The **full opt-in battery** (eval meters `eval-planner.ts` / `eval-agentic.ts`,
the HTTP confirm-flow and agentic-flow live checks, the broad chat tour, plus
the exact env vars each one needs) is the canonical list in
[`CLAUDE.md` → "Live testing"](./CLAUDE.md); this section is the headline subset.
Always finish a live run with the sweep at 0 leftovers.

Never commit or paste live credentials.

## Security

The model is treated as untrusted: it proposes, the harness disposes. Secrets
never reach the model or the logs, installation tokens are encrypted at rest,
retired tokens are blocked by a workspace-unlinked anti-replay fingerprint; a bounded
hashed-workspace lifecycle lineage also blocks never-before-seen older callbacks after
uninstall erasure/restart, and
risky writes can only execute through an explicit button confirmation. See
the inline documentation in `src/harness/` for the enforcement details.

What data is stored, retention windows (chat + audit log default 90 days), and how
to have a workspace's data erased are documented in [`PRIVACY.md`](./PRIVACY.md).
The complete trust model, deployment/recovery procedure, and safe support intake are
documented in [`SECURITY.md`](./SECURITY.md), [`DEPLOYMENT.md`](./DEPLOYMENT.md),
[`SUPPORT.md`](./SUPPORT.md), and [`TERMS.md`](./TERMS.md).
