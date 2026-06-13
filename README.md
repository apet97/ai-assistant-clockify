# AI Assistant for Clockify

An **admin-only** AI assistant embedded inside Clockify. Workspace admins ask for
Clockify work in plain language; the model proposes actions, and a deterministic
**action harness** validates every proposal against per-admin permissions and a
risk policy before anything touches Clockify.

The model never executes anything itself and never sees a secret. It can only
*suggest* named actions from a fixed catalog — the backend decides what (if
anything) runs.

## Highlights

- **Admin/owner only.** Non-admins are rejected before a session is ever created.
- **Per-admin, per-workspace permissions.** Default is full `read_write` for every
  feature group; each admin manages only their own policy, from inside the chat.
- **Safe writes execute immediately** and return a structured receipt.
- **Risky writes require a dry-run preview + a button confirmation.** Typed text
  such as "yes" never executes a risky action. `Confirm all` applies only to the
  exact previewed batch.
- **One-use, time-limited confirmations** (5 min) bound to session + workspace +
  admin, a salted nonce hash, and an operation hash. Policy is re-checked at
  confirm time.
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
  harness validates with — so the model stops inventing argument shapes. The Zod +
  risk/policy gate is still the trust boundary (provider validation is convenience).
- **A durable, approval-gated agentic loop** (default on): reads and safe writes
  auto-chain with their receipts fed back to the model; the first risky write
  interrupts into the preview → button-confirm flow, and the confirmed receipt
  resumes the loop across the HTTP round-trip — it can chain another preview, never
  commit inline.
- **Atomic multi-step composition** — a multi-entity request either completes or rolls
  back what it created; no orphans.
- **Idempotency** — re-confirming the same intent can't create a duplicate (e.g. a
  second invoice).
- **Undo** — the last reversible action (a creation) can be undone with one click.
- **Constraint surfacing** — known platform limits (e.g. an invoice needing a configured
  item type) are shown *in the preview*, so a surprising outcome never happens after
  confirm; clarifications offer concrete options, never "give me the ID".
- **Curated intent actions** — high-level jobs (`period_report`, `onboard_user`) the model
  reaches for instead of scrambling 136 primitives.
- **Operational metrics** (`GET /api/metrics`, incl. per-turn token/latency
  telemetry) and **eval harnesses** (`scripts/eval-planner.ts`,
  `scripts/eval-agentic.ts`) that score planner accuracy *and* run-to-run
  consistency over a real corpus — measured at 100% on three backends
  (DeepSeek v4-pro, gemini-3.1-flash-lite, gemini-3.5-flash).
- **Backend-agnostic model client** — any OpenAI-compatible endpoint via
  `LLM_BASE_URL`/`LLM_MODEL`; provider quirks (DeepSeek `reasoning_content`,
  Gemini 3.x `thought_signature`, `reasoning_effort`) are handled in one place
  and inert elsewhere. Swapping backends is an env change, not a code change.
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

Requires Node 20+.

```bash
npm install
cp .env.example .env     # then fill in real values
```

### Verify, build, run

```bash
npm run type-check       # tsc --noEmit
npm test                 # vitest run (fakes only; no network)
npm run build            # -> dist/server, dist/ui
npm run verify           # type-check + test + build (the gate)
npm run dev              # tsx src/server.ts (needs .env)
```

CI runs `npm run verify` + a circular-dependency check (madge) on every push and
PR (`.github/workflows/ci.yml`). Production deploys to Railway with the SQLite
database on a persistent volume — see [`DEPLOYMENT.md`](./DEPLOYMENT.md).

`GET /manifest` serves the admin-only Clockify add-on manifest — a **sidebar**
component (`/component/assistant`) plus an add-on icon at `/icon.svg`. It installs
and runs end-to-end on real Clockify workspaces (verified on a dev workspace:
install → sidebar → chat → action → receipt).

### Environment

See [`.env.example`](./.env.example) for the full list. Key variables: `PORT`,
`BASE_URL`, `CLOCKIFY_ADDON_KEY`, `SESSION_SECRET`, `DATA_ENCRYPTION_KEY`
(32-byte key for token encryption), `DATABASE_PATH`, and `LLM_BASE_URL` /
`LLM_API_KEY` / `LLM_MODEL` for the OpenAI-compatible model endpoint.
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
- `scripts/addon-smoke.ts` — exercises the production add-on-token request path.
  Prerequisite: run `scripts/capture-addon-token.ts` first to copy the encrypted
  installation token from the store into the gitignored `.env` as
  `LIVE_ADDON_TOKEN` (the token is never printed, only its length).
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
and risky writes can only execute through an explicit button confirmation. See
the inline documentation in `src/harness/` for the enforcement details.
